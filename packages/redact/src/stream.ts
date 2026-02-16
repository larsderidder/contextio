/**
 * Streaming rehydration for SSE responses.
 *
 * The challenge: placeholders like `[EMAIL_1]` can be split across
 * multiple SSE events (the LLM might stream "[EMA" in one chunk and
 * "IL_1]" in the next). This module handles that by:
 *
 * 1. Extracting text content from SSE `data:` lines (provider-agnostic)
 * 2. Buffering content when a partial placeholder is detected (trailing "[")
 * 3. Replacing complete placeholders with originals from the ReplacementMap
 * 4. Preserving the JSON structure of each SSE event
 *
 * When no placeholders are present in a chunk, it passes through unchanged
 * (zero allocation fast path).
 */

import type { ReplacementMap } from "./mapping.js";

/** Escape a string for safe embedding inside a JSON string value. */
function jsonEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Result of extracting text content from a JSON SSE event.
 *
 * Contains the text value plus enough context to reconstruct the
 * original line with modified content.
 */
interface Extracted {
  /** The extracted text content (JSON-unescaped). */
  text: string;
  /** The full matched substring (e.g. `"text":"hello"`) for string replacement. */
  fullMatch: string;
  /** The field key prefix (e.g. `"text":"`) for reconstructing the line. */
  prefix: string;
}

/**
 * Extract text content from a JSON SSE event line.
 *
 * Recognizes content fields from all three providers:
 * - Anthropic: `text_delta` events with `"text"` field
 * - Anthropic: `thinking_delta` events with `"thinking"` field
 * - OpenAI: `delta` objects with `"content"` field
 * - Gemini: `parts` arrays with `"text"` field
 *
 * @returns Extracted text and match context, or null for non-content events.
 */
function extractContent(json: string): Extracted | null {
  let m: RegExpMatchArray | null;

  if (json.includes("text_delta")) {
    m = json.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return { text: m[1], fullMatch: m[0], prefix: m[0].slice(0, m[0].indexOf(m[1])) };
  }
  if (json.includes("thinking_delta")) {
    m = json.match(/"thinking"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return { text: m[1], fullMatch: m[0], prefix: m[0].slice(0, m[0].indexOf(m[1])) };
  }
  if (json.includes('"delta"') && json.includes('"content"')) {
    m = json.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return { text: m[1], fullMatch: m[0], prefix: m[0].slice(0, m[0].indexOf(m[1])) };
  }
  if (json.includes('"parts"') && json.includes('"text"')) {
    m = json.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return { text: m[1], fullMatch: m[0], prefix: m[0].slice(0, m[0].indexOf(m[1])) };
  }
  return null;
}

/**
 * Create a stateful stream rehydrator for one session.
 *
 * Call `onChunk()` for each SSE chunk from the upstream. It buffers
 * partial lines and partial placeholders, replacing complete ones with
 * originals. Call `onEnd()` when the stream finishes to flush any
 * remaining buffered content.
 *
 * @param map - The session's replacement map (original <-> placeholder).
 * @returns Chunk and end handlers.
 */
export function createStreamRehydrator(map: ReplacementMap): {
  onChunk: (chunk: Buffer) => Buffer;
  onEnd: () => Buffer | null;
} {
  let lineBuf = "";       // Incomplete line from previous chunk
  let contentBuf = "";    // Accumulated text content (may span SSE events)
  let held: { line: string; extracted: Extracted | null }[] = [];  // Buffered lines awaiting placeholder resolution
  let outputParts: string[] = [];  // Completed output lines ready to emit

  /**
   * Check if contentBuf ends with a partial placeholder (has "[" without
   * a closing "]"). If so, we need to buffer more content before
   * attempting replacement.
   */
  function hasTrailingPartial(): boolean {
    const i = contentBuf.lastIndexOf("[");
    if (i === -1) return false;
    return contentBuf.indexOf("]", i) === -1;
  }

  /**
   * Flush held lines to output. When `force` is false, only flushes if
   * there's no trailing partial placeholder. When `force` is true, flushes
   * everything regardless.
   *
   * If placeholders were replaced, all rehydrated text goes into the first
   * content line; subsequent content lines get emptied. This avoids
   * producing duplicate text when a placeholder spans multiple events.
   */
  function flushHeld(force: boolean): void {
    if (held.length === 0) return;
    if (!force && hasTrailingPartial()) return;

    const rehydrated = map.rehydrate(contentBuf);

    if (rehydrated === contentBuf) {
      // No placeholders found; pass through unchanged
      for (const h of held) outputParts.push(h.line);
    } else {
      // Placeholders were replaced. Put all rehydrated text into the
      // first content line (preserving its JSON structure) and pass
      // subsequent content lines with empty text.
      let first = true;
      for (const h of held) {
        if (h.extracted === null) {
          // Non-content line (empty separator, etc.); pass through
          outputParts.push(h.line);
          continue;
        }
        if (first) {
          first = false;
          // Replace the content value in this line with all rehydrated text
          const newMatch = h.extracted.prefix + jsonEscape(rehydrated) + '"';
          outputParts.push(h.line.replace(h.extracted.fullMatch, newMatch));
        } else {
          // Empty out subsequent content lines
          const newMatch = h.extracted.prefix + '"';
          outputParts.push(h.line.replace(h.extracted.fullMatch, newMatch));
        }
      }
    }

    contentBuf = "";
    held = [];
  }

  function processLine(line: string): void {
    if (!line.startsWith("data: ")) {
      // Empty lines must not force flush (placeholders span events).
      if (line.trim().length > 0) {
        flushHeld(true);
      }
      held.push({ line, extracted: null });
      flushHeld(false);
      return;
    }

    const json = line.slice(6);
    const extracted = extractContent(json);

    if (extracted === null) {
      // Non-content data line; force flush and pass through
      flushHeld(true);
      outputParts.push(line);
      return;
    }

    contentBuf += extracted.text;
    held.push({ line, extracted });
    flushHeld(false);
  }

  function drain(): string {
    const result = outputParts.join("\n");
    outputParts = [];
    return result;
  }

  return {
    onChunk(chunk: Buffer): Buffer {
      if (map.size === 0) return chunk;

      const text = lineBuf + chunk.toString("utf8");
      lineBuf = "";
      const lines = text.split("\n");
      if (!text.endsWith("\n")) {
        lineBuf = lines.pop() ?? "";
      }

      for (const line of lines) processLine(line);
      return Buffer.from(drain(), "utf8");
    },

    onEnd(): Buffer | null {
      if (lineBuf.length > 0) {
        processLine(lineBuf);
        lineBuf = "";
      }
      flushHeld(true);
      const out = drain();
      return out.length > 0 ? Buffer.from(out, "utf8") : null;
    },
  };
}
