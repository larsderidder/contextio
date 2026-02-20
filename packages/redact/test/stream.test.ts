import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createStreamRehydrator } from "../dist/stream.js";
import { ReplacementMap } from "../dist/mapping.js";

// --- Helpers ---

function toBuffer(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

function toString(b: Buffer | null): string {
  return b ? b.toString("utf8") : "";
}

/** Build an SSE text_delta line (with trailing \n). */
function sseTextDelta(text: string, index = 0): string {
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `data: {"type":"content_block_delta","index":${index},"delta":{"type":"text_delta","text":"${escaped}"}}\n`;
}

/** Build an SSE thinking_delta line (with trailing \n). */
function sseThinkingDelta(thinking: string, index = 0): string {
  const escaped = thinking.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `data: {"type":"content_block_delta","index":${index},"delta":{"type":"thinking_delta","thinking":"${escaped}"}}\n`;
}

/** Build an OpenAI-style SSE line. */
function openaiDelta(content: string, finishReason: string | null = null): string {
  const escaped = content.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const finish = finishReason ? `,"finish_reason":"${finishReason}"` : ',"finish_reason":null';
  return `data: {"choices":[{"index":0,"delta":{"content":"${escaped}"}${finish}}]}\n`;
}

/** Build a Gemini-style SSE line. */
function geminiDelta(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `data: {"candidates":[{"content":{"parts":[{"text":"${escaped}"}]}}]}\n`;
}

/** Stream all chunks through a rehydrator and return combined output. */
function streamAll(
  map: ReplacementMap,
  chunks: (string | Buffer)[],
): string {
  const stream = createStreamRehydrator(map);
  let out = "";
  for (const c of chunks) {
    const chunk = typeof c === "string" ? toBuffer(c) : c;
    out += toString(stream.onChunk(chunk));
  }
  out += toString(stream.onEnd());
  return out;
}

/** Extract all text content from SSE output. */
function extractContent(sse: string): string {
  let result = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const obj = JSON.parse(line.slice(6));
      if (obj.delta?.text) result += obj.delta.text;
      if (obj.delta?.thinking) result += obj.delta.thinking;
      if (obj.choices?.[0]?.delta?.content) result += obj.choices[0].delta.content;
      if (obj.candidates?.[0]?.content?.parts) {
        for (const part of obj.candidates[0].content.parts) {
          if (typeof part.text === "string") result += part.text;
        }
      }
    } catch {
      // not JSON; ignore
    }
  }
  return result;
}

// --- Chunking Edge Cases ---

describe("stream rehydration edge cases", () => {
  describe("chunking boundaries", () => {
    it("handles multiple SSE events in a single chunk", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");
      map.getOrCreate("jane@test.com", "email");

      const chunk = sseTextDelta("Hello [EMAIL_1]") + sseTextDelta(" and [EMAIL_2]");
      const sse = streamAll(map, [chunk]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
      assert.ok(text.includes("jane@test.com"), `got: ${text}`);
      assert.ok(!text.includes("[EMAIL_1]"), `got: ${text}`);
      assert.ok(!text.includes("[EMAIL_2]"), `got: ${text}`);
    });

    it("handles empty chunks between valid events", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const sse = streamAll(map, [
        sseTextDelta("Hello "),
        "",
        "",
        sseTextDelta("[EMAIL_1]"),
        "",
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
    });

    it("handles chunk split between data: prefix and JSON", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const fullLine = sseTextDelta("Hello [EMAIL_1]");
      // Split mid-word: "dat" | "a: {...}" instead of the trivial "data: " | "{...}"
      const splitAt = fullLine.indexOf("data:") + 3;
      
      const sse = streamAll(map, [
        fullLine.slice(0, splitAt),
        fullLine.slice(splitAt),
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
    });

    it("handles chunk split inside JSON field name", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const line = sseTextDelta("[EMAIL_1]");
      // Use lastIndexOf to hit the content-bearing "text" field, not "text_delta"
      const splitAt = line.lastIndexOf('"text"') + 3;
      
      const sse = streamAll(map, [
        line.slice(0, splitAt),
        line.slice(splitAt),
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
    });

    it("handles chunk split at newline boundary", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const chunk1 = sseTextDelta("Hello [EMAIL_1]").slice(0, -1); // Without trailing \n
      const sse = streamAll(map, [
        chunk1,
        "\n", // Newline in separate chunk
        sseTextDelta(" world"),
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
      assert.ok(text.includes(" world"), `got: ${text}`);
    });

    it("handles multi-byte UTF-8 character split across chunks", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      // Emoji (4 bytes in UTF-8): \xF0\x9F\x91\x8B
      const emoji = "👋";
      const text = `Hello ${emoji} [EMAIL_1]`;
      const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const line = `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${escaped}"}}\n`;
      
      // Find a split point inside the emoji bytes
      const buf = Buffer.from(line, "utf8");
      const emojiBytes = Buffer.from(emoji, "utf8");
      const emojiIndex = buf.indexOf(emojiBytes);
      assert.ok(emojiIndex > 0, "emoji found in buffer");
      
      // Split inside the emoji (after first 2 bytes of the 4-byte sequence)
      const splitPoint = emojiIndex + 2;
      
      const sse = streamAll(map, [
        buf.slice(0, splitPoint),
        buf.slice(splitPoint),
      ]);
      
      const result = extractContent(sse);
      // Emoji corruption on mid-byte split is acceptable; the important thing
      // is the placeholder after the emoji is still rehydrated
      assert.ok(result.includes("john@test.com"), `email rehydrated despite mid-emoji split, got: ${result}`);
    });

    it("handles PII email split at @ symbol across chunks", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      // First chunk has placeholder start, second has the rest
      const sse = streamAll(map, [
        sseTextDelta("Email: [EMA"),
        sseTextDelta("IL_1] is valid"),
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
      assert.ok(!text.includes("[EMAIL_1]"), `got: ${text}`);
    });
  });

  describe("provider-specific edge cases", () => {
    it("handles OpenAI null content deltas", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const sse = streamAll(map, [
        'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n',
        openaiDelta("[EMAIL_1]"),
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
    });

    it("handles OpenAI [DONE] sentinel", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const sse = streamAll(map, [
        openaiDelta("Email: [EMAIL_1]"),
        "data: [DONE]\n",
      ]);
      
      assert.ok(sse.includes("[DONE]"), "DONE sentinel preserved");
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
    });

    it("handles OpenAI finish_reason with content", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const sse = streamAll(map, [
        openaiDelta("See [EMAIL_1]", "stop"),
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
      assert.ok(sse.includes('"finish_reason":"stop"'), "finish_reason preserved");
    });

    it("handles Anthropic content_block_start followed by deltas", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const sse = streamAll(map, [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        sseTextDelta("[EMAIL_", 0),
        sseTextDelta("1] here", 0),
        'data: {"type":"content_block_stop","index":0}\n\n',
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
      assert.ok(sse.includes("content_block_start"), "start event preserved");
      assert.ok(sse.includes("content_block_stop"), "stop event preserved");
    });

    it("handles Gemini response wrapper format", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const escaped = "[EMAIL_1]".replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      // The stream handler looks for "parts" and "text" combination
      const sse = streamAll(map, [
        `data: {"candidates":[{"content":{"parts":[{"text":"${escaped}"}]}}]}\n`,
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
    });

    it("handles multiple providers in one stream", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");
      map.getOrCreate("jane@test.com", "email");

      const sse = streamAll(map, [
        sseTextDelta("[EMAIL_1] "), // Anthropic
        openaiDelta("[EMAIL_2]"),    // OpenAI
        geminiDelta("done"),          // Gemini
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
      assert.ok(text.includes("jane@test.com"), `got: ${text}`);
    });
  });

  describe("reversible round-trip edge cases", () => {
    it("handles same placeholder multiple times across chunks", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const sse = streamAll(map, [
        sseTextDelta("[EMAIL_1] "),
        sseTextDelta("[EMAIL_1] "),
        sseTextDelta("[EMAIL_1]"),
      ]);
      
      const text = extractContent(sse);
      const matches = text.match(/john@test\.com/g);
      assert.equal(matches?.length, 3, `expected 3 occurrences, got: ${text}`);
    });

    it("handles placeholder at very start of chunk", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const sse = streamAll(map, [
        sseTextDelta("[EMAIL_1]"),
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.startsWith("john@test.com"), `got: ${text}`);
    });

    it("handles placeholder at very end of chunk", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const sse = streamAll(map, [
        sseTextDelta("Email: [EMAIL_1]"),
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.endsWith("john@test.com"), `got: ${text}`);
    });

    it("handles nested brackets in text", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const sse = streamAll(map, [
        sseTextDelta("[[EMAIL_1]]"),
      ]);

      // The stream handler uses map.rehydrate which does string replacement
      // [[EMAIL_1]] will become [john@test.com] after rehydration
      const text = extractContent(sse);
      // The inner placeholder should be rehydrated
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
    });

    it("handles placeholder split with intervening non-content events", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const sse = streamAll(map, [
        sseTextDelta("[EMA"),
        'data: {"type":"ping"}\n',
        sseTextDelta("IL_1]"),
      ]);
      
      const text = extractContent(sse);
      // The ping event forces flush, so placeholder won't be rehydrated
      // This is expected behavior - non-content events force flush
      assert.ok(sse.includes("ping"), "ping event preserved");
      assert.ok(!text.includes("john@test.com"), "placeholder not rehydrated when flush forced mid-split");
    });
  });

  describe("malformed input handling", () => {
    it("handles missing data: prefix gracefully", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const sse = streamAll(map, [
        '{"type":"content_block_delta","delta":{"text":"[EMAIL_1]"}}\n',
      ]);
      
      // Lines without data: prefix should be passed through
      assert.ok(sse.includes("[EMAIL_1]"), "unprefixed line passed through unchanged");
    });

    it("handles invalid JSON in data field", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const sse = streamAll(map, [
        'data: {invalid json here}\n',
        sseTextDelta("[EMAIL_1]"),
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
      assert.ok(sse.includes("invalid json"), "invalid JSON passed through");
    });

    it("handles incomplete JSON at stream end", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const stream = createStreamRehydrator(map);
      // Complete event followed by incomplete data
      stream.onChunk(toBuffer(sseTextDelta("[EMAIL_1]")));
      stream.onChunk(toBuffer('data: {"incomplete')); // Incomplete line
      const endResult = stream.onEnd();
      
      // Stream should flush properly, including incomplete data
      const text = toString(endResult);
      // The incomplete data should be flushed on end
      assert.ok(text.includes('data: {"incomplete'), `got: ${text}`);
    });

    it("handles unexpected event types", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const sse = streamAll(map, [
        'data: {"type":"unknown_event","data":"something"}\n',
        sseTextDelta("[EMAIL_1]"),
        'data: {"type":"another_unknown","nested":{"value":123}}\n',
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
      assert.ok(sse.includes("unknown_event"), "unknown event preserved");
    });

    it("handles connection drop mid-placeholder", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const stream = createStreamRehydrator(map);
      stream.onChunk(toBuffer(sseTextDelta("[EMAIL_"))); // Incomplete placeholder
      const endResult = stream.onEnd();
      
      // Partial placeholder is flushed verbatim on stream end, not rehydrated
      const text = toString(endResult);
      assert.ok(text.includes("[EMAIL_"), "partial placeholder flushed verbatim");
      assert.ok(!text.includes("john@test.com"), "incomplete placeholder not rehydrated");
    });

    it("handles extremely long lines", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const longText = "a".repeat(10000) + "[EMAIL_1]" + "b".repeat(10000);
      const sse = streamAll(map, [sseTextDelta(longText)]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `long text handled`);
      assert.ok(text.length > 20000, `text length preserved`);
    });

    it("handles escaped control characters in content", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      // Mix of valid text and escaped control characters
      const text = "Hello [EMAIL_1]\\u0000world";
      const line = `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}\n`;
      
      const sse = streamAll(map, [line]);
      
      const result = extractContent(sse);
      assert.ok(result.includes("john@test.com"), `got: ${result}`);
    });
  });

  describe("buffer management", () => {
    it("handles many small SSE events efficiently", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const chunks: string[] = [];
      const text = "Email: [EMAIL_1]";
      for (let i = 0; i < text.length; i++) {
        chunks.push(sseTextDelta(text[i]));
      }
      
      const sse = streamAll(map, chunks);
      const result = extractContent(sse);
      assert.ok(result.includes("john@test.com"), `got: ${result}`);
    });

    it("handles alternating content and non-content lines", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");
      map.getOrCreate("jane@test.com", "email");

      const sse = streamAll(map, [
        sseTextDelta("[EMAIL_1]"),
        'data: {"type":"ping"}\n',
        sseTextDelta("[EMAIL_2]"),
        'data: {"type":"ping"}\n',
        sseTextDelta("done"),
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("john@test.com"), `got: ${text}`);
      assert.ok(text.includes("jane@test.com"), `got: ${text}`);
      assert.ok(sse.includes('"type":"ping"'), "ping events preserved");
    });

    it("handles rapid onEnd without any chunks", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const stream = createStreamRehydrator(map);
      const result = stream.onEnd();
      
      // Should return null or empty buffer for empty stream
      assert.ok(result === null || toString(result) === "", `got: ${result}`);
    });

    it("handles onEnd called multiple times", () => {
      const map = new ReplacementMap();
      map.getOrCreate("john@test.com", "email");

      const stream = createStreamRehydrator(map);
      stream.onChunk(toBuffer(sseTextDelta("[EMAIL_1]")));
      
      const first = stream.onEnd();
      const second = stream.onEnd();
      
      // onChunk already emitted the data, so both onEnd calls should return null
      assert.equal(first, null, "first onEnd: data already flushed by onChunk");
      assert.equal(second, null, "second onEnd: idempotent");
    });
  });

  describe("special characters in placeholders", () => {
    it("handles placeholder with special regex characters in original", () => {
      const map = new ReplacementMap();
      // Value with characters that might confuse regex
      map.getOrCreate("test.user+tag@example.com", "email");

      const sse = streamAll(map, [
        sseTextDelta("Email: [EMAIL_1]"),
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("test.user+tag@example.com"), `got: ${text}`);
    });

    it("handles Unicode in original value", () => {
      const map = new ReplacementMap();
      map.getOrCreate("用户@例子.测试", "email");

      const sse = streamAll(map, [
        sseTextDelta("Email: [EMAIL_1]"),
      ]);
      
      const text = extractContent(sse);
      assert.ok(text.includes("用户@例子.测试"), `got: ${text}`);
    });

    it("handles newlines in SSE content field", () => {
      const map = new ReplacementMap();
      map.getOrCreate("line1\nline2", "secret");

      const text = "Before [SECRET_1] after";
      // The extractContent regex handles escaped newlines properly
      const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const line = `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${escaped}"}}\n`;
      
      const sse = streamAll(map, [line]);
      
      // The placeholder should be rehydrated to the multi-line value
      const result = extractContent(sse);
      assert.ok(result.includes("line1"), `got: ${result}`);
    });
  });
});
