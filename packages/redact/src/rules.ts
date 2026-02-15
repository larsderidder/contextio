/**
 * Redaction rule type.
 *
 * Rules are the atomic unit of the redaction engine. Each rule has a
 * regex pattern and a replacement string. Rules can optionally specify
 * context words: the pattern only matches when at least one context
 * word appears within a character window around the match.
 */

export interface RedactionRule {
  /** Unique identifier for logging and policy references. */
  name: string;
  /** Pattern to match. Must have the global flag. */
  pattern: RegExp;
  /** Replacement string. Can use $1, $2, etc. for capture groups. */
  replacement: string;
  /**
   * Context words (lowercase). If provided, the rule only fires when
   * at least one of these words appears within `contextWindow` characters
   * of the match. This reduces false positives for ambiguous patterns
   * like phone numbers and credit cards.
   */
  context?: string[];
  /** Characters to search around a match for context words. Default: 100. */
  contextWindow?: number;
}
