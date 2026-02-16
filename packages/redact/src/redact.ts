/**
 * Redaction engine.
 *
 * Recursively walks a JSON value, applying redaction rules to string
 * leaves. Supports context-word gating and JSON path filtering.
 * Preserves structure; does not mutate the original.
 */

import type { ReplacementMap } from "./mapping.js";
import type { CompiledPolicy } from "./policy.js";
import type { RedactionRule } from "./rules.js";

export interface RedactionStats {
  /** Total number of replacements made across all rules. */
  totalReplacements: number;
  /** Per-rule replacement counts. Only includes rules that matched. */
  byRule: Record<string, number>;
}

/**
 * Create fresh stats for a redaction pass.
 */
export function createStats(): RedactionStats {
  return { totalReplacements: 0, byRule: {} };
}

// --- Context word matching ---

/**
 * Check if any context word appears within `window` characters of a match.
 *
 * This is how context-gated rules work: a pattern like SSN (XXX-XX-XXXX)
 * only fires when words like "ssn" or "social security" appear nearby.
 */
function hasContextNearby(
  text: string,
  start: number,
  end: number,
  contextWords: string[],
  window: number,
): boolean {
  const windowStart = Math.max(0, start - window);
  const windowEnd = Math.min(text.length, end + window);
  const region = text.slice(windowStart, windowEnd).toLowerCase();
  for (const word of contextWords) {
    if (region.includes(word)) return true;
  }
  return false;
}

/** Check if a matched value is in the allowlist (exact string or regex pattern). */
function isAllowlisted(
  match: string,
  allowlistStrings: Set<string>,
  allowlistPatterns: RegExp[],
): boolean {
  if (allowlistStrings.has(match)) return true;
  for (const pat of allowlistPatterns) {
    pat.lastIndex = 0;
    if (pat.test(match)) return true;
  }
  return false;
}

// --- JSON path matching ---

/**
 * Check if a JSON path matches a path matcher pattern.
 * Segments must match exactly, except "*" which matches any single segment.
 * Both arrays must be the same length.
 */
function pathMatches(segments: string[], matcher: string[]): boolean {
  if (segments.length !== matcher.length) return false;
  for (let i = 0; i < segments.length; i++) {
    if (matcher[i] === "*") continue;
    if (segments[i] !== matcher[i]) return false;
  }
  return true;
}

/** Determine if a value at this JSON path should be redacted, per "only"/"skip" config. */
function shouldRedactPath(
  path: string[],
  onlyMatchers: { segments: string[] }[] | null,
  skipMatchers: { segments: string[] }[],
): boolean {
  // Check skip first
  for (const m of skipMatchers) {
    if (pathMatches(path, m.segments)) return false;
  }
  // If "only" is set, path must match at least one
  if (onlyMatchers !== null) {
    for (const m of onlyMatchers) {
      if (pathMatches(path, m.segments)) return true;
    }
    return false;
  }
  return true;
}

// --- String redaction ---

/**
 * Resolve the replacement string for a matched value.
 *
 * When a ReplacementMap is provided, generates a numbered placeholder
 * and records the mapping for later rehydration. Otherwise uses the
 * rule's static replacement.
 */
function resolveReplacement(
  match: string,
  rule: RedactionRule,
  map: ReplacementMap | null,
): string {
  if (map) return map.getOrCreate(match, rule.name);
  return rule.replacement;
}

/**
 * Apply redaction rules to a single string, respecting context words
 * and allowlists.
 */
function redactString(
  input: string,
  rules: RedactionRule[],
  allowlistStrings: Set<string>,
  allowlistPatterns: RegExp[],
  stats: RedactionStats,
  map: ReplacementMap | null,
): string {
  let result = input;
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;

    if (rule.context && rule.context.length > 0) {
      // Context-gated: use exec loop to check context per match
      const window = rule.contextWindow ?? 100;
      const matches: { start: number; end: number; match: string }[] = [];
      let m: RegExpExecArray | null;
      rule.pattern.lastIndex = 0;
      while ((m = rule.pattern.exec(result)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length, match: m[0] });
      }

      // Apply replacements in reverse order to preserve indices
      for (let i = matches.length - 1; i >= 0; i--) {
        const { start, end, match } = matches[i];
        if (isAllowlisted(match, allowlistStrings, allowlistPatterns)) continue;
        if (!hasContextNearby(result, start, end, rule.context, window)) continue;
        stats.totalReplacements++;
        stats.byRule[rule.name] = (stats.byRule[rule.name] || 0) + 1;
        const replacement = resolveReplacement(match, rule, map);
        result = result.slice(0, start) + replacement + result.slice(end);
      }
    } else {
      // No context gating: simple replace
      result = result.replace(rule.pattern, (match) => {
        if (isAllowlisted(match, allowlistStrings, allowlistPatterns)) return match;
        stats.totalReplacements++;
        stats.byRule[rule.name] = (stats.byRule[rule.name] || 0) + 1;
        return resolveReplacement(match, rule, map);
      });
    }
  }
  return result;
}

// --- Recursive walker ---

/**
 * Recursively walk a JSON value and apply redaction rules to string leaves.
 *
 * Preserves the original structure; returns a new object tree with
 * sensitive strings replaced. Respects path filtering ("only" and "skip")
 * when configured in the policy.
 *
 * When `map` is provided (reversible mode), redacted values are tracked
 * so they can be restored in the response. The same original always maps
 * to the same placeholder within a map.
 *
 * @param value - The value to redact (string, object, array, or primitive).
 * @param policy - Compiled redaction policy with rules and path config.
 * @param stats - Mutable stats object; updated with replacement counts.
 * @param currentPath - Current JSON path segments (used internally for recursion).
 * @param map - Optional replacement map for reversible mode.
 * @returns A new value with sensitive strings replaced. Primitives pass through unchanged.
 */
export function redactWithPolicy(
  value: unknown,
  policy: CompiledPolicy,
  stats: RedactionStats,
  currentPath: string[] = [],
  map: ReplacementMap | null = null,
): unknown {
  if (typeof value === "string") {
    // Check path filtering
    if (
      policy.paths.only !== null ||
      policy.paths.skip.length > 0
    ) {
      if (!shouldRedactPath(currentPath, policy.paths.only, policy.paths.skip)) {
        return value;
      }
    }
    return redactString(
      value,
      policy.rules,
      policy.allowlist.strings,
      policy.allowlist.patterns,
      stats,
      map,
    );
  }

  if (Array.isArray(value)) {
    return value.map((item, i) =>
      redactWithPolicy(item, policy, stats, [...currentPath, "*"], map),
    );
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactWithPolicy(val, policy, stats, [...currentPath, key], map);
    }
    return result;
  }

  // Numbers, booleans, null: pass through
  return value;
}

// --- Legacy API (backward compatible) ---

/**
 * Simple redaction without path filtering or context words.
 *
 * Applies all rules to every string leaf in the value tree. Provided
 * for backward compatibility; new code should use {@link redactWithPolicy}.
 */
export function redactValue(
  value: unknown,
  rules: RedactionRule[],
  allowlist: Set<string>,
  stats: RedactionStats,
): unknown {
  if (typeof value === "string") {
    return redactString(value, rules, allowlist, [], stats, null);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, rules, allowlist, stats));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactValue(val, rules, allowlist, stats);
    }
    return result;
  }

  return value;
}
