/**
 * Policy system for @contextio/redact.
 *
 * A policy is a JSON document that describes what to redact and how.
 * Policies can extend built-in presets and add custom rules.
 *
 * Policy JSON format:
 * {
 *   "extends": "secrets",           // built-in preset: "secrets" | "pii" | "strict"
 *   "rules": [                      // additional rules (merged with preset)
 *     {
 *       "id": "employee-id",
 *       "pattern": "EMP-\\d{5}",
 *       "replacement": "[EMPLOYEE_ID]",
 *       "context": ["employee", "staff"]
 *     }
 *   ],
 *   "allowlist": {
 *     "strings": ["support@company.com"],
 *     "patterns": ["test-\\d+@example\\.com"]
 *   },
 *   "paths": {
 *     "only": ["messages[*].content", "system"],
 *     "skip": ["model", "metadata"]
 *   }
 * }
 */

import fs from "node:fs";

import { PRESETS, type PresetName } from "./presets.js";
import type { RedactionRule } from "./rules.js";

// --- Policy JSON schema types ---

export interface PolicyRuleJson {
  /** Unique identifier for this rule. */
  id: string;
  /** Regex pattern as a string. Compiled with the global flag. */
  pattern: string;
  /** Replacement string. */
  replacement: string;
  /**
   * Context words. If provided, the rule only fires when at least one
   * context word appears within a window around the match.
   */
  context?: string[];
  /** Window size in characters to search for context words. Default: 100. */
  contextWindow?: number;
}

export interface PolicyAllowlistJson {
  /** Exact strings that should never be redacted. */
  strings?: string[];
  /** Regex patterns for strings that should never be redacted. */
  patterns?: string[];
}

export interface PolicyPathsJson {
  /**
   * If set, only redact values at these JSON paths.
   * Supports simple dot notation and [*] for array wildcard.
   * Example: ["messages[*].content", "system"]
   */
  only?: string[];
  /**
   * Skip redaction for values at these JSON paths.
   * Checked before "only". Example: ["model", "metadata"]
   */
  skip?: string[];
}

export interface PolicyJson {
  /** Extend a built-in preset. Rules are merged (policy rules come after preset rules). */
  extends?: PresetName;
  /** Additional redaction rules. */
  rules?: PolicyRuleJson[];
  /** Allowlist configuration. */
  allowlist?: PolicyAllowlistJson;
  /** JSON path scoping. */
  paths?: PolicyPathsJson;
}

// --- Compiled policy (ready for the engine) ---

export interface CompiledPolicy {
  rules: RedactionRule[];
  allowlist: {
    strings: Set<string>;
    patterns: RegExp[];
  };
  paths: {
    only: PathMatcher[] | null;
    skip: PathMatcher[];
  };
}

export interface PathMatcher {
  /** Original path string for debugging. */
  source: string;
  /** Segments to match against. "*" matches any array index or key. */
  segments: string[];
}

// --- Compilation ---

/**
 * Strip // comments and trailing commas from JSON-with-comments.
 * Good enough for config files; not a full JSONC parser.
 */
function stripJsonComments(text: string): string {
  // Remove single-line comments (// ...) that aren't inside strings.
  // Simple heuristic: only strip // that appears after a newline or at start,
  // with optional whitespace before it. Won't handle // inside strings perfectly,
  // but works for config files where comments are on their own lines.
  let result = text.replace(/^\s*\/\/.*$/gm, "");
  // Remove trailing commas before } or ]
  result = result.replace(/,\s*([\]}])/g, "$1");
  return result;
}

/**
 * Parse a path string into segments.
 * "messages[*].content" -> ["messages", "*", "content"]
 */
function parsePath(path: string): PathMatcher {
  const segments = path
    .replace(/\[\*\]/g, ".*.")
    .split(".")
    .filter(Boolean);
  return { source: path, segments };
}

/**
 * Compile a JSON rule into an internal RedactionRule with context support.
 *
 * Patterns can start with (?i) to request case-insensitive matching.
 * This is converted to the "i" flag since JS doesn't support inline flags.
 */
function compileRule(json: PolicyRuleJson): RedactionRule {
  let flags = "g";
  let source = json.pattern;

  // Convert (?i) prefix to the "i" flag
  if (source.startsWith("(?i)")) {
    flags += "i";
    source = source.slice(4);
  }

  const pattern = new RegExp(source, flags);

  const rule: RedactionRule = {
    name: json.id,
    pattern,
    replacement: json.replacement,
  };

  if (json.context && json.context.length > 0) {
    rule.context = json.context.map((w) => w.toLowerCase());
    rule.contextWindow = json.contextWindow ?? 100;
  }

  return rule;
}

/**
 * Compile a PolicyJson into a CompiledPolicy ready for the redaction engine.
 */
export function compilePolicy(json: PolicyJson): CompiledPolicy {
  // Start with preset rules if extending
  let rules: RedactionRule[] = [];
  if (json.extends) {
    const preset = PRESETS[json.extends];
    if (!preset) {
      throw new Error(
        `Unknown preset: "${json.extends}". Available: ${Object.keys(PRESETS).join(", ")}`,
      );
    }
    rules = [...preset];
  }

  // Append custom rules
  if (json.rules) {
    for (const r of json.rules) {
      rules.push(compileRule(r));
    }
  }

  // Compile allowlist
  const allowlistStrings = new Set(json.allowlist?.strings ?? []);
  const allowlistPatterns = (json.allowlist?.patterns ?? []).map(
    (p) => new RegExp(p),
  );

  // Compile paths
  const pathsOnly = json.paths?.only
    ? json.paths.only.map(parsePath)
    : null;
  const pathsSkip = (json.paths?.skip ?? []).map(parsePath);

  return {
    rules,
    allowlist: { strings: allowlistStrings, patterns: allowlistPatterns },
    paths: { only: pathsOnly, skip: pathsSkip },
  };
}

/**
 * Load a policy from a JSON file path. Supports // comments and trailing commas.
 */
export function loadPolicyFile(filePath: string): CompiledPolicy {
  const raw = fs.readFileSync(filePath, "utf8");
  const cleaned = stripJsonComments(raw);
  const json: PolicyJson = JSON.parse(cleaned);
  return compilePolicy(json);
}

/**
 * Create a compiled policy from a preset name with no customizations.
 */
export function fromPreset(preset: PresetName): CompiledPolicy {
  return compilePolicy({ extends: preset });
}
