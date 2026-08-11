/**
 * @contextio/redact - Privacy and redaction layer for LLM API calls.
 *
 * Proxy plugin that strips PII, secrets, and API keys from request
 * bodies before they reach the LLM provider.
 *
 * Supports built-in presets (secrets, pii, strict), custom rules,
 * context-word gating, allowlists, and JSON path filtering.
 *
 * When `reversible` is enabled, the plugin tracks redacted values per
 * session and restores them in the LLM response, making redaction fully
 * transparent to the client.
 *
 * ```typescript
 * import { createRedactPlugin } from '@contextio/redact';
 *
 * // One-way: strip and forget
 * const redact = createRedactPlugin({ preset: "pii" });
 *
 * // Reversible: strip on request, restore on response
 * const redact = createRedactPlugin({ preset: "pii", reversible: true });
 * ```
 */

import type {
  ProxyPlugin,
  RequestContext,
  ResponseContext,
} from "@contextio/core";

import fs from "node:fs";
import { ReplacementMap } from "./mapping.js";
import type { CompiledPolicy, PolicyJson } from "./policy.js";
import { compilePolicy, fromPreset, loadPolicyFile } from "./policy.js";
import type { PresetName } from "./presets.js";
import { buildRedactMetaPayload, buildFullRedactionMetadata, createStats, recordMatch, redactWithPolicy, type MatchEntry, type RedactionMetadata, type RedactionStats } from "./redact.js";
import { createStreamRehydrator } from "./stream.js";
import type {
  Detector,
  DetectorConfig,
  DetectionResult,
  DetectedSpan,
  DetectorMode,
  RedactDetectorConfig,
  DetectorPipelineConfig,
} from "./detector.js";
import type { RuleDetectorConfig } from "./ruleDetector.js";
import type { GlinerOnnxConfig } from "./glinerDetector.js";
import { detectorRegistry, registerDetector, createDetector } from "./detector.js";
import { createRuleDetector } from "./ruleDetector.js";
import { createDetectorPipeline, createHybridDetector, mergeDetectionResults } from "./detectorPipeline.js";
// GLiNER detector is loaded lazily to avoid onnxruntime-node in Next.js static build

/** Configuration for {@link createRedactPlugin}. */
export interface RedactPluginConfig {
  /** Built-in preset to use. Default: "pii". */
  preset?: PresetName;
  /** Path to a policy JSON(C) file. Overrides `preset`. */
  policyFile?: string;
  /** Pre-compiled policy object. Overrides both `preset` and `policyFile`. */
  policy?: CompiledPolicy;
  /**
   * Detection mode:
   * - "rules": rule-based only (default, fast, deterministic)
   * - "llm": LLM-based only (semantic understanding, slower)
   * - "hybrid": rules first for high-confidence patterns, LLM for ambiguous PII
   * - "auto": automatically choose based on content characteristics
   * Default: "rules"
   */
  detectorMode?: DetectorMode;
  /**
   * LLM detector configuration. Used when detectorMode is "llm", "hybrid", or "auto".
   */
  detectorConfig?: RedactDetectorConfig;
  /**
   * Enable reversible redaction. When true, the plugin tracks
   * original values per session and restores them in LLM responses.
   * The LLM sees `[EMAIL_1]`; the client sees the original.
   *
   * Requires session IDs in the URL path (set automatically by the CLI).
   * Default: false (one-way, strip and forget).
   */
  reversible?: boolean;
  /**
   * How long to keep a session's replacement map after its last request,
   * in milliseconds. Only used when `reversible` is true.
   * Default: 30 minutes.
   */
  sessionTtlMs?: number;
  /** Log redaction stats to stderr after each request. */
  verbose?: boolean;
  /**
   * Optional callback invoked after each redaction pass with the complete
   * metadata record. The plugin computes all fields and passes them here
   * instead of writing .redact-meta.json sidecar files.
   * The callback is responsible for persisting metadata (e.g., to SQLite).
   */
  onRedactionMetadata?: (metadata: RedactionMetadata) => void;
}

/** Per-session state for reversible mode: mapping table + stream rehydrator. */
interface SessionState {
  map: ReplacementMap;
  rehydrator: ReturnType<typeof createStreamRehydrator>;
  lastSeen: number;
}

/** Detector pipeline state (lazy initialized). */
interface DetectorState {
  pipeline: Detector | null;
  initialized: boolean;
  initializing: Promise<void> | null;
}

/**
 * Apply detector spans to a string, returning the redacted string and
 * updating stats/map for reversible mode.
 */
function applyDetectorSpans(
  input: string,
  spans: DetectedSpan[],
  ruleName: string,
  stats: ReturnType<typeof createStats>,
  map: ReplacementMap | null,
  placeholderAllowlist: Set<string>,
  currentPath: string[] = [],
): string {
  if (spans.length === 0) return input;

  // Sort spans by start position (descending) to apply replacements in reverse
  const sortedSpans = [...spans].sort((a, b) => b.start - a.start);

  let result = input;
  for (const span of sortedSpans) {
    const match = input.slice(span.start, span.end);
    // Skip if match is a known placeholder token (prevent re-redaction)
    if (placeholderAllowlist.has(match)) continue;
    const replacement = map ? map.getOrCreate(match, ruleName) : `[${span.label}_${Date.now()}]`;
    stats.totalReplacements++;
    stats.byRule[ruleName] = (stats.byRule[ruleName] || 0) + 1;
    // Record the match for metadata (matchEntry structure: ruleId, preValue, postValue, path)
    recordMatch(stats, ruleName, match, replacement, currentPath);
    result = result.slice(0, span.start) + replacement + result.slice(span.end);
  }
  return result;
}

/**
 * Walk a JSON value and apply detector-based redaction to string leaves.
 * Returns the redacted value and optionally runs rule-based redaction as well.
 */
async function redactWithDetector(
  value: unknown,
  policy: CompiledPolicy,
  detector: Detector,
  detectorMode: DetectorMode,
  stats: ReturnType<typeof createStats>,
  currentPath: string[] = [],
  map: ReplacementMap | null = null,
): Promise<unknown> {
  if (typeof value === "string") {
    // Check path filtering
    if (policy.paths.only !== null || policy.paths.skip.length > 0) {
      const { shouldRedactPath } = await import("./redact.js");
      if (!shouldRedactPath(currentPath, policy.paths.only, policy.paths.skip)) {
        return value;
      }
    }

    // Run detector on this string
    const detectionResult = await detector.detect(value);
    let redacted = value;

    // Apply detector spans
    if (detectionResult.spans.length > 0) {
      redacted = applyDetectorSpans(
        value,
        detectionResult.spans,
        detector.name,
        stats,
        map,
        policy.placeholderAllowlist,
        currentPath,
      );
    }

    // In hybrid mode, also apply rule-based redaction
    if (detectorMode === "hybrid") {
      const { redactString, shouldRedactPath } = await import("./redact.js");
      // Check path filtering
      if (policy.paths.only !== null || policy.paths.skip.length > 0) {
        if (!shouldRedactPath(currentPath, policy.paths.only, policy.paths.skip)) {
          return value;
        }
      }
      redacted = redactString(
        redacted,
        policy.rules,
        policy.allowlist.strings,
        policy.allowlist.patterns,
        policy.placeholderAllowlist,
        stats,
        map,
        currentPath,
      );
    }

    return redacted;
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) =>
      redactWithDetector(item, policy, detector, detectorMode, stats, [...currentPath, "*"], map)
    ));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = await redactWithDetector(val, policy, detector, detectorMode, stats, [...currentPath, key], map);
    }
    return result;
  }

  return value;
}

/** Resolve effective policy: explicit policy > policy file > preset (default: "pii"). */
function resolvePolicy(config?: RedactPluginConfig): CompiledPolicy {
  if (config?.policy) return config.policy;
  if (config?.policyFile) {
    const loaded = loadPolicyFile(config.policyFile);
    if (loaded) return loaded;
    // Fall through to preset if policy file doesn't exist
  }
  return fromPreset(config?.preset ?? "pii");
}

/** Load detector config from policy file or plugin config. */
function resolveDetectorConfig(config?: RedactPluginConfig): RedactDetectorConfig | undefined {
  // Start with plugin config
  const detectorConfig = config?.detectorConfig ?? {};

  // If policy file has detector settings, merge them (plugin config takes precedence)
  if (config?.policyFile) {
    try {
      const raw = fs.readFileSync(config.policyFile, "utf8");
      const cleaned = raw.replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([\]}])/g, "$1");
      const json = JSON.parse(cleaned) as PolicyJson & { detector?: RedactDetectorConfig & { modelDir?: string; threshold?: number; labels?: string[] } };
      if (json.detector) {
        const policyDetector = json.detector;
        // Merge: plugin config values override policy file values
        // Map policy file field names to RedactDetectorConfig field names
        return {
          mode: policyDetector.mode,
          llmModel: policyDetector.llmModel,
          modelPath: policyDetector.modelPath ?? policyDetector.modelDir, // Map modelDir -> modelPath
          options: policyDetector.options,
          llmThreshold: policyDetector.llmThreshold ?? policyDetector.threshold, // Map threshold -> llmThreshold
          llmLabels: policyDetector.llmLabels ?? policyDetector.labels, // Map labels -> llmLabels
          ...detectorConfig, // Plugin config takes precedence
        } as RedactDetectorConfig;
      }
    } catch {
      // Ignore policy file read/parse errors
    }
  }
  return Object.keys(detectorConfig).length > 0 ? detectorConfig : undefined;
}

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Create a redact plugin.
 *
 * The plugin's onRequest hook walks the JSON request body and applies
 * the policy's redaction rules. The body sent to the upstream provider
 * will have sensitive data replaced with placeholder tokens.
 *
 * When `reversible` is true, the plugin also hooks onResponse and
 * onStreamChunk to replace placeholders back with the original values.
 * Each session (identified by the session ID in the URL path) gets its
 * own replacement map.
 */
export function createRedactPlugin(config?: RedactPluginConfig): ProxyPlugin {
  const policy = resolvePolicy(config);
  const verbose = config?.verbose ?? false;
  const reversible = config?.reversible ?? false;
  const sessionTtlMs = config?.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

  // Per-session state (only used in reversible mode)
  const sessions = new Map<string, SessionState>();
  let lastEviction = Date.now();

  /**
   * Get or create session state. Uses "__default__" for requests
   * without a session ID. Also evicts stale sessions periodically
   * (at most once per minute) to prevent unbounded memory growth.
   */
  function getSession(sessionId: string | null): SessionState {
    const key = sessionId ?? "__default__";
    let state = sessions.get(key);
    if (!state) {
      const map = new ReplacementMap();
      state = {
        map,
        rehydrator: createStreamRehydrator(map),
        lastSeen: Date.now(),
      };
      sessions.set(key, state);
    }
    state.lastSeen = Date.now();

    // Evict stale sessions periodically (at most once per minute)
    const now = Date.now();
    if (now - lastEviction > 60_000) {
      lastEviction = now;
      for (const [k, s] of sessions) {
        if (now - s.lastSeen > sessionTtlMs) {
          sessions.delete(k);
          if (verbose) {
            console.error(
              `[redact] Evicted idle session ${k} (${s.map.size} mapping(s))`,
            );
          }
        }
      }
    }

    return state;
  }

  // Detector pipeline state (lazy initialized)
  const detectorState: DetectorState = {
    pipeline: null,
    initialized: false,
    initializing: null,
  };

  // Resolve detector config: plugin config overrides policy file config
  const resolvedDetectorConfig = resolveDetectorConfig(config);
  const detectorMode = resolvedDetectorConfig?.mode ?? config?.detectorMode ?? "rules";
  const detectorConfig = resolvedDetectorConfig ?? {};

  /**
   * Initialize the detector pipeline based on detectorMode and detectorConfig.
   * Called lazily on first request that needs it.
   */
  async function ensureDetectorInitialized(): Promise<Detector | null> {
    if (detectorMode === "rules") return null;
    if (detectorState.initialized) return detectorState.pipeline;
    if (detectorState.initializing) {
      await detectorState.initializing;
      return detectorState.pipeline;
    }

    detectorState.initializing = (async () => {
      try {
        // Create rule detector
        const ruleDetector = await createRuleDetector({
          name: "rules",
          rules: policy.rules,
          allowlistStrings: Array.from(policy.allowlist.strings),
          allowlistPatterns: Array.from(policy.allowlist.patterns).map((r) => r.source),
          placeholderAllowlist: Array.from(policy.placeholderAllowlist),
        });

        let pipeline: Detector;

        if (detectorMode === "llm") {
          // LLM-only mode: use GLiNER detector
          const glinerConfig = detectorConfig as RedactDetectorConfig;
          if (!glinerConfig.modelPath) {
            throw new Error("LLM detector requires detectorConfig.modelPath to be set");
          }
          // Lazy load GLiNER module to avoid onnxruntime-node in Next.js static build
          const { createGlinerOnnxDetector: createGLiner } = await getGlinerDetector();
          const llmDetector = await createGLiner({
            name: "gliner-onnx",
            modelDir: glinerConfig.modelPath,
            threshold: glinerConfig.llmThreshold ?? 0.5,
            labels: glinerConfig.llmLabels,
          });
          pipeline = await createDetectorPipeline({
            detectors: [llmDetector],
            mergeStrategy: "union",
          });
        } else if (detectorMode === "hybrid" || detectorMode === "auto") {
          // Hybrid mode: rules + GLiNER with priority merge
          const glinerConfig = detectorConfig as RedactDetectorConfig;
          let llmDetector: Detector | null = null;
          if (glinerConfig.modelPath) {
            // Lazy load GLiNER module to avoid onnxruntime-node in Next.js static build
            const { createGlinerOnnxDetector: createGLiner } = await getGlinerDetector();
            llmDetector = await createGLiner({
              name: "gliner-onnx",
              modelDir: glinerConfig.modelPath,
              threshold: glinerConfig.llmThreshold ?? 0.5,
              labels: glinerConfig.llmLabels,
            });
          } else {
            // No GLiNER model configured - fall back to rules-only with a warning
            console.warn(
              `[redact] detectorMode="${detectorMode}" requires GLiNER model (detectorConfig.modelPath), falling back to rules-only mode`,
            );
          }

          // In auto mode, we still use hybrid but could add logic to skip LLM for simple cases
          if (llmDetector) {
            const pipelineConfig = createHybridDetector(ruleDetector, llmDetector, {
              priorityOrder: ["rules", "gliner-onnx"],
            });
            pipeline = await createDetectorPipeline(pipelineConfig);
          } else {
            // Fall back to rules-only
            pipeline = ruleDetector;
          }
        } else {
          // Default to rules only
          pipeline = ruleDetector;
        }

        detectorState.pipeline = pipeline;
        detectorState.initialized = true;
        if (verbose) {
          console.error(`[redact] Initialized detector pipeline (mode: ${detectorMode})`);
        }
      } catch (err) {
        console.error(`[redact] Failed to initialize detector pipeline:`, err);
        detectorState.pipeline = null;
        throw err;
      } finally {
        detectorState.initializing = null;
      }
    })();

    await detectorState.initializing;
    return detectorState.pipeline;
  }

  return {
    name: "redact",

  async onRequest(ctx: RequestContext): Promise<RequestContext> {
    if (!ctx.body) return ctx;

    const map = reversible ? getSession(ctx.sessionId).map : null;
    const stats = createStats();

    // Check if we should use detector-based redaction
    if (detectorMode !== "rules") {
      const detector = await ensureDetectorInitialized();
      if (detector) {
        const redacted = await redactWithDetector(ctx.body, policy, detector, detectorMode, stats, [], map);
        // Reset stream rehydrator for this session (new response coming)
        if (reversible) {
          const session = getSession(ctx.sessionId);
          session.rehydrator = createStreamRehydrator(session.map);
        }

        // Call onRedactionMetadata callback if configured
        if (config?.onRedactionMetadata && ctx.captureId) {
          const metadata = buildFullRedactionMetadata(ctx.captureId, {
            provider: ctx.provider,
            sessionId: ctx.sessionId,
            targetUrl: ctx.targetUrl,
            source: ctx.source,
          }, stats);
          config.onRedactionMetadata(metadata);
        }

        if (stats.totalReplacements > 0 && verbose) {
          const details = Object.entries(stats.byRule)
          .map(([name, count]) => `${name}=${count}`)
          .join(", ");
          const sid = ctx.sessionId ? ` [${ctx.sessionId}]` : "";
          console.error(
            `[redact]${sid} Redacted ${stats.totalReplacements} match(es): ${details}`,
          );
          if (map) {
            console.error(
              `[redact]${sid} Tracking ${map.size} unique value(s) for rehydration`,
            );
          }
        }

        return {
          ...ctx,
          redactionStats: buildRedactMetaPayload(stats),
          body: redacted as Record<string, any>,
        };
      }
      // Fall through to rule-based if detector initialization failed
    }

    // Rule-based redaction (default)
    const redacted = redactWithPolicy(ctx.body, policy, stats, [], map);
    // Reset stream rehydrator for this session (new response coming)
    if (reversible) {
      const session = getSession(ctx.sessionId);
      session.rehydrator = createStreamRehydrator(session.map);
    }

    // Call onRedactionMetadata callback if configured
    if (config?.onRedactionMetadata && ctx.captureId) {
      const metadata = buildFullRedactionMetadata(ctx.captureId, {
        provider: ctx.provider,
        sessionId: ctx.sessionId,
        targetUrl: ctx.targetUrl,
        source: ctx.source,
      }, stats);
      config.onRedactionMetadata(metadata);
    }

    if (stats.totalReplacements > 0 && verbose) {
      const details = Object.entries(stats.byRule)
      .map(([name, count]) => `${name}=${count}`)
      .join(", ");
      const sid = ctx.sessionId ? ` [${ctx.sessionId}]` : "";
      console.error(
        `[redact]${sid} Redacted ${stats.totalReplacements} match(es): ${details}`,
      );
      if (map) {
        console.error(
          `[redact]${sid} Tracking ${map.size} unique value(s) for rehydration`,
        );
      }
    }

    return {
      ...ctx,
      redactionStats: buildRedactMetaPayload(stats),
      body: redacted as Record<string, any>,
    };
  },

    // Rehydrate placeholders in non-streaming responses.
    onResponse: reversible
      ? (ctx: ResponseContext): ResponseContext => {
          const session = getSession(ctx.sessionId);
          if (session.map.size === 0) return ctx;

          const rehydrated = session.map.rehydrate(ctx.body);
          if (rehydrated === ctx.body) return ctx;

          if (verbose) {
            const sid = ctx.sessionId ? ` [${ctx.sessionId}]` : "";
            console.error(
              `[redact]${sid} Rehydrated response (${session.map.size} mapping(s) active)`,
            );
          }

          return { ...ctx, body: rehydrated };
        }
      : undefined,

    // Rehydrate placeholders in streaming SSE chunks.
    onStreamChunk: reversible
      ? (chunk: Buffer, sessionId: string | null): Buffer => {
          const session = getSession(sessionId);
          if (session.map.size === 0) return chunk;
          return session.rehydrator.onChunk(chunk);
        }
      : undefined,

    // Flush any buffered partial placeholder at end of stream.
    onStreamEnd: reversible
      ? (sessionId: string | null): Buffer | null => {
          const session = getSession(sessionId);
          return session.rehydrator.onEnd();
        }
      : undefined,
  };
}

// Public API
export type { RedactionRule } from "./rules.js";
export type { PresetName } from "./presets.js";
export { PRESETS, getAllPlaceholderTokens, getPlaceholderPatterns } from "./presets.js";
export type { PolicyJson, PolicyRuleJson, CompiledPolicy } from "./policy.js";
export { compilePolicy, loadPolicyFile, fromPreset } from "./policy.js";
export type { RedactionStats, RedactionMetadata, MatchEntry } from "./redact.js";
export { redactWithPolicy, redactValue, createStats, redactString, buildFullRedactionMetadata } from "./redact.js";
export type { MappingEntry } from "./mapping.js";
export { ReplacementMap } from "./mapping.js";

// Detector API
export type {
  Detector,
  DetectorConfig,
  DetectionResult,
  DetectedSpan,
  DetectorMode,
  RedactDetectorConfig,
  DetectorPipelineConfig,
  DetectorFactory,
} from "./detector.js";
export { detectorRegistry, registerDetector, createDetector } from "./detector.js";
export type { RuleDetectorConfig } from "./ruleDetector.js";
export { RuleDetector, createRuleDetector } from "./ruleDetector.js";
export type { GlinerOnnxConfig } from "./glinerDetector.js";
export type { PresidioTsConfig } from "./presidioTsDetector.js";
export { PresidioTsDetector, createPresidioTsDetector } from "./presidioTsDetector.js";

// Lazy export for GLiNER detector to avoid loading onnxruntime-node in environments
// where native modules are not available (e.g., Next.js static generation on Alpine)
let _glinerModule: typeof import("./glinerDetector.js") | null = null;
async function loadGlinerModule() {
  if (!_glinerModule) {
    _glinerModule = await import("./glinerDetector.js");
  }
  return _glinerModule;
}

export async function getGlinerDetector() {
  const mod = await loadGlinerModule();
  return { GlinerOnnxDetector: mod.GlinerOnnxDetector, createGlinerOnnxDetector: mod.createGlinerOnnxDetector, prepareGlinerModel: mod.prepareGlinerModel };
}

export { DetectorPipeline, createDetectorPipeline, createHybridDetector, mergeDetectionResults } from "./detectorPipeline.js";
export { createRedactPluginFactory } from "./factory.js";
