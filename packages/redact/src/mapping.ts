/**
 * Replacement mapping for reversible redaction.
 *
 * Tracks original -> placeholder mappings so that redacted values in LLM
 * responses can be rehydrated back to the original text before returning
 * to the client.
 *
 * Mappings persist for the lifetime of the plugin instance (one proxy run),
 * so the same value always maps to the same placeholder across requests.
 */

/**
 * A single mapping entry.
 */
export interface MappingEntry {
  /** The original sensitive value. */
  original: string;
  /** The placeholder token sent to the LLM, such as "[EMAIL_1]". */
  placeholder: string;
  /** The rule that triggered this mapping, such as "email". */
  ruleId: string;
}

/**
 * Bidirectional mapping between original values and placeholders.
 *
 * Thread-safe for single-threaded Node: no concurrent mutation concerns,
 * but multiple requests in flight can read/write safely because JS is
 * single-threaded within the event loop.
 */
export class ReplacementMap {
  /** original -> placeholder */
  private forward = new Map<string, string>();
  /** placeholder -> original */
  private reverse = new Map<string, string>();
  /** ruleId -> next counter (for generating [EMAIL_1], [EMAIL_2], etc.) */
  private counters = new Map<string, number>();
  /** All entries in insertion order. */
  private entries: MappingEntry[] = [];

  /**
   * Get or create a placeholder for the given original value.
   *
   * If the same original was seen before (even from a different rule),
   * returns the existing placeholder. Otherwise generates a new one.
   *
   * The ruleId is used to generate the placeholder label:
   *   "email" -> [EMAIL_1], [EMAIL_2], ...
   *   "ssn"   -> [SSN_1], [SSN_2], ...
   */
  getOrCreate(original: string, ruleId: string): string {
    const existing = this.forward.get(original);
    if (existing) return existing;

    const count = (this.counters.get(ruleId) ?? 0) + 1;
    this.counters.set(ruleId, count);

    const label = ruleId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const placeholder = `[${label}_${count}]`;

    this.forward.set(original, placeholder);
    this.reverse.set(placeholder, original);
    this.entries.push({ original, placeholder, ruleId });

    return placeholder;
  }

  /**
   * Look up the original value for a placeholder.
   * Returns undefined if the placeholder is unknown.
   */
  getOriginal(placeholder: string): string | undefined {
    return this.reverse.get(placeholder);
  }

  /**
   * Replace all known placeholders in a string with their originals.
   *
   * Iterates all known placeholders and does a global string replace.
   * Longest placeholders are tried first to avoid partial matches
   * (e.g. [EMAIL_10] before [EMAIL_1]).
   */
  rehydrate(text: string): string {
    if (this.reverse.size === 0) return text;

    // Sort placeholders longest-first to avoid partial replacement
    const sorted = [...this.reverse.entries()].sort(
      (a, b) => b[0].length - a[0].length,
    );

    let result = text;
    for (const [placeholder, original] of sorted) {
      // Simple split-join is safe and avoids regex escaping issues
      result = result.split(placeholder).join(original);
    }
    return result;
  }

  /**
   * Number of unique mappings stored.
   */
  get size(): number {
    return this.forward.size;
  }

  /**
   * All mapping entries in insertion order.
   */
  allEntries(): readonly MappingEntry[] {
    return this.entries;
  }

  /**
   * All placeholders as an array (useful for building streaming matchers).
   */
  allPlaceholders(): string[] {
    return [...this.reverse.keys()];
  }
}
