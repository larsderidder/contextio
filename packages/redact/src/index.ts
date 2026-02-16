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

import type { ProxyPlugin, RequestContext, ResponseContext } from "@contextio/core";

import { ReplacementMap } from "./mapping.js";
import type { CompiledPolicy } from "./policy.js";
import { compilePolicy, fromPreset, loadPolicyFile } from "./policy.js";
import type { PresetName } from "./presets.js";
import { createStats, redactWithPolicy } from "./redact.js";
import { createStreamRehydrator } from "./stream.js";

/** Configuration for {@link createRedactPlugin}. */
export interface RedactPluginConfig {
  /** Built-in preset to use. Default: "pii". */
  preset?: PresetName;
  /** Path to a policy JSON(C) file. Overrides `preset`. */
  policyFile?: string;
  /** Pre-compiled policy object. Overrides both `preset` and `policyFile`. */
  policy?: CompiledPolicy;
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
}

/** Per-session state for reversible mode: mapping table + stream rehydrator. */
interface SessionState {
  map: ReplacementMap;
  rehydrator: ReturnType<typeof createStreamRehydrator>;
  lastSeen: number;
}

/** Resolve effective policy: explicit policy > policy file > preset (default: "pii"). */
function resolvePolicy(config?: RedactPluginConfig): CompiledPolicy {
  if (config?.policy) return config.policy;
  if (config?.policyFile) return loadPolicyFile(config.policyFile);
  return fromPreset(config?.preset ?? "pii");
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
            console.error(`[redact] Evicted idle session ${k} (${s.map.size} mapping(s))`);
          }
        }
      }
    }

    return state;
  }

  return {
    name: "redact",

    onRequest(ctx: RequestContext): RequestContext {
      if (!ctx.body) return ctx;

      const map = reversible ? getSession(ctx.sessionId).map : null;
      const stats = createStats();
      const redacted = redactWithPolicy(ctx.body, policy, stats, [], map);

      // Reset stream rehydrator for this session (new response coming)
      if (reversible) {
        const session = getSession(ctx.sessionId);
        session.rehydrator = createStreamRehydrator(session.map);
      }

      if (stats.totalReplacements > 0) {
        if (verbose) {
          const details = Object.entries(stats.byRule)
            .map(([name, count]) => `${name}=${count}`)
            .join(", ");
          const sid = ctx.sessionId ? ` [${ctx.sessionId}]` : "";
          console.error(
            `[redact]${sid} Redacted ${stats.totalReplacements} match(es): ${details}`,
          );
          if (map) {
            console.error(`[redact]${sid} Tracking ${map.size} unique value(s) for rehydration`);
          }
        }

        return {
          ...ctx,
          body: redacted as Record<string, any>,
        };
      }

      return ctx;
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
            console.error(`[redact]${sid} Rehydrated response (${session.map.size} mapping(s) active)`);
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
export { PRESETS } from "./presets.js";
export type { PolicyJson, PolicyRuleJson, CompiledPolicy } from "./policy.js";
export { compilePolicy, loadPolicyFile, fromPreset } from "./policy.js";
export type { RedactionStats } from "./redact.js";
export { redactWithPolicy, redactValue, createStats } from "./redact.js";
export type { MappingEntry } from "./mapping.js";
export { ReplacementMap } from "./mapping.js";
