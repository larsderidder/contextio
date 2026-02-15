/**
 * Streaming rehydration for SSE responses.
 *
 * Replaces placeholders like [EMAIL_1] with original values in SSE
 * streams. Works with any provider by extracting text content from
 * JSON fields, detecting split placeholders across events, and
 * replacing in-place when possible.
 *
 * When no placeholders are present, original lines pass through
 * unchanged. When rehydration occurs, the first content line's
 * structure is preserved and used as the template for the output.
 */

import type { ReplacementMap } from "./mapping.js";

/** Escape a string for embedding inside a JSON string value. */
function jsonEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Content extraction result. */
interface Extracted {
  text: string;
  /** The full regex match string (e.g. `"text":"hello"`) for replacement. */
  fullMatch: string;
  /** Just the field key portion (e.g. `"text":"`). */
  prefix: string;
}

/**
 * Try to extract LLM text content from a JSON string.
 * Returns the extracted text and match info, or null.
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

export function createStreamRehydrator(map: ReplacementMap): {
  onChunk: (chunk: Buffer) => Buffer;
  onEnd: () => Buffer | null;
} {
  let lineBuf = "";
  let contentBuf = "";
  let held: { line: string; extracted: Extracted | null }[] = [];
  let outputParts: string[] = [];

  function hasTrailingPartial(): boolean {
    const i = contentBuf.lastIndexOf("[");
    if (i === -1) return false;
    return contentBuf.indexOf("]", i) === -1;
  }

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
