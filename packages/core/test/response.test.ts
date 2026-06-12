import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractResponseId,
  parseResponseUsage,
  parseStreamingTokens,
  type ParsedResponseUsage,
} from "../dist/response.js";

type UsageWithThinking = ParsedResponseUsage & { thinkingTokens: number };

describe("response.ts", () => {
  describe("parseResponseUsage", () => {
    it("returns zeros for null/undefined", () => {
      const result = parseResponseUsage(null);
      assert.equal(result.inputTokens, 0);
      assert.equal(result.outputTokens, 0);
      assert.equal(result.cacheReadTokens, 0);
      assert.equal(result.cacheWriteTokens, 0);
      assert.equal(result.model, null);
      assert.deepEqual(result.finishReasons, []);
      assert.equal(result.stream, false);
    });

    it("parses OpenAI non-streaming usage", () => {
      const data = {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
        model: "gpt-4o",
      };
      const result = parseResponseUsage(data);
      assert.equal(result.inputTokens, 100);
      assert.equal(result.outputTokens, 50);
      assert.equal(result.model, "gpt-4o");
    });

    it("parses OpenAI cached prompt and reasoning token details", () => {
      const data = {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 30 },
          completion_tokens_details: { reasoning_tokens: 12 },
        },
        model: "gpt-4o",
      };
      const result = parseResponseUsage(data) as UsageWithThinking;
      assert.equal(result.inputTokens, 100);
      assert.equal(result.outputTokens, 50);
      assert.equal(result.cacheReadTokens, 30);
      assert.equal(result.thinkingTokens, 12);
    });

    it("parses Anthropic non-streaming usage", () => {
      const data = {
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 25,
        },
        id: "msg_123",
        model: "claude-3-5-sonnet-20241022",
      };
      const result = parseResponseUsage(data);
      assert.equal(result.inputTokens, 200);
      assert.equal(result.outputTokens, 100);
      assert.equal(result.cacheReadTokens, 50);
      assert.equal(result.cacheWriteTokens, 25);
      assert.equal(result.model, "claude-3-5-sonnet-20241022");
    });

    it("parses Gemini usageMetadata with cached prompt split out", () => {
      const data = {
        usageMetadata: {
          promptTokenCount: 300,
          candidatesTokenCount: 150,
          totalTokenCount: 450,
          cachedContentTokenCount: 100,
          thoughtsTokenCount: 25,
        },
        modelVersion: "gemini-1.5-pro",
      };
      const result = parseResponseUsage(data) as UsageWithThinking;
      assert.equal(result.inputTokens, 200);
      assert.equal(result.outputTokens, 150);
      assert.equal(result.cacheReadTokens, 100);
      assert.equal(result.thinkingTokens, 25);
      assert.equal(result.model, "gemini-1.5-pro");
    });

    it("extracts model from various fields", () => {
      assert.equal(
        parseResponseUsage({ model: "gpt-4o" }).model,
        "gpt-4o",
      );
      assert.equal(
        parseResponseUsage({ modelVersion: "gemini-2.0" }).model,
        "gemini-2.0",
      );
    });

    it("parses Gemini Code Assist nested .response wrapper", () => {
      // Code Assist wraps the Gemini response inside a .response field
      const data = {
        response: {
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: {
            promptTokenCount: 120,
            candidatesTokenCount: 60,
            cachedContentTokenCount: 20,
          },
          modelVersion: "gemini-2.0-flash",
        },
      };
      const result = parseResponseUsage(data);
      assert.equal(result.inputTokens, 100);
      assert.equal(result.outputTokens, 60);
      assert.equal(result.cacheReadTokens, 20);
      assert.equal(result.model, "gemini-2.0-flash");
      assert.deepEqual(result.finishReasons, ["STOP"]);
    });

    it("extracts finish reasons from OpenAI choices", () => {
      const data = {
        choices: [{ finish_reason: "stop" }, { finish_reason: "length" }],
      };
      const result = parseResponseUsage(data);
      assert.deepEqual(result.finishReasons, ["stop", "length"]);
    });

    it("extracts finish reasons from Anthropic", () => {
      const data = { stop_reason: "end_turn" };
      const result = parseResponseUsage(data);
      assert.deepEqual(result.finishReasons, ["end_turn"]);
    });

    it("extracts finish reasons from Gemini candidates", () => {
      const data = {
        candidates: [{ finishReason: "STOP" }],
      };
      const result = parseResponseUsage(data);
      assert.deepEqual(result.finishReasons, ["STOP"]);
    });

    it("parses raw JSON response bodies from capture files", () => {
      const body = JSON.stringify({
        usage: {
          input_tokens: 42,
          output_tokens: 7,
        },
        model: "gpt-4.1",
      });
      const result = parseResponseUsage(body);
      assert.equal(result.stream, false);
      assert.equal(result.inputTokens, 42);
      assert.equal(result.outputTokens, 7);
      assert.equal(result.model, "gpt-4.1");
    });

    it("parses Context Lens streaming response wrapper objects", () => {
      const chunks = `data: {"type":"message_start","message":{"model":"claude-3-5-sonnet-20241022","usage":{"input_tokens":100,"cache_read_input_tokens":50}}}
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":75}}
data: [DONE]`;
      const result = parseResponseUsage({ streaming: true, chunks });
      assert.equal(result.stream, true);
      assert.equal(result.inputTokens, 100);
      assert.equal(result.outputTokens, 75);
      assert.equal(result.cacheReadTokens, 50);
      assert.equal(result.model, "claude-3-5-sonnet-20241022");
      assert.deepEqual(result.finishReasons, ["end_turn"]);
    });

    it("parses OpenAI Responses streaming nested usage", () => {
      const chunks = `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5-mini-2025-08-07","status":"in_progress"}}
data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5-mini-2025-08-07","status":"completed","usage":{"input_tokens":6968,"input_tokens_details":{"cached_tokens":0},"output_tokens":406,"output_tokens_details":{"reasoning_tokens":384},"total_tokens":7374}}}
data: [DONE]`;
      const result = parseResponseUsage({ streaming: true, chunks });
      assert.equal(result.stream, true);
      assert.equal(result.inputTokens, 6968);
      assert.equal(result.outputTokens, 406);
      assert.equal(result.cacheReadTokens, 0);
      assert.equal(result.thinkingTokens, 384);
      assert.equal(result.model, "gpt-5-mini-2025-08-07");
    });

    it("parses Code Assist streaming nested Gemini usage", () => {
      const chunks = `data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"number"}]}}],"usageMetadata":{"promptTokenCount":28393,"candidatesTokenCount":3,"totalTokenCount":28396,"cachedContentTokenCount":18000},"modelVersion":"claude-sonnet-4-6"}}
data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":" is:"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":28393,"candidatesTokenCount":4,"totalTokenCount":28397,"cachedContentTokenCount":18000},"modelVersion":"claude-sonnet-4-6"}}
data: [DONE]`;
      const result = parseResponseUsage({ streaming: true, chunks });
      assert.equal(result.stream, true);
      assert.equal(result.inputTokens, 10393);
      assert.equal(result.outputTokens, 4);
      assert.equal(result.cacheReadTokens, 18000);
      assert.equal(result.model, "claude-sonnet-4-6");
      assert.deepEqual(result.finishReasons, ["STOP"]);
    });
  });

  describe("parseStreamingTokens", () => {
    it("parses Anthropic streaming SSE", () => {
      const chunks = `data: {"type":"message_start","message":{"model":"claude-3-5-sonnet-20241022","usage":{"input_tokens":100,"cache_read_input_tokens":50}}}
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":75}}
data: [DONE]`;

      const result = parseStreamingTokens(chunks, "anthropic");
      assert.ok(result);
      assert.equal(result!.inputTokens, 100);
      assert.equal(result!.outputTokens, 75);
      assert.equal(result!.cacheReadTokens, 50);
      assert.equal(result!.model, "claude-3-5-sonnet-20241022");
      assert.deepEqual(result!.finishReasons, ["end_turn"]);
      assert.equal(result!.stream, true);
    });

    it("parses OpenAI streaming SSE", () => {
      const chunks = `data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}
data: {"usage":{"prompt_tokens":10,"completion_tokens":5},"choices":[{"index":0,"finish_reason":"stop"}]}
data: [DONE]`;

      const result = parseStreamingTokens(chunks, "openai");
      assert.ok(result);
      assert.equal(result!.inputTokens, 10);
      assert.equal(result!.outputTokens, 5);
      assert.deepEqual(result!.finishReasons, ["stop"]);
    });

    it("parses Gemini streaming SSE", () => {
      const chunks = `data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":25,"cachedContentTokenCount":10}}
data: [DONE]`;

      const result = parseStreamingTokens(chunks, "gemini");
      assert.ok(result);
      assert.equal(result!.inputTokens, 40);
      assert.equal(result!.outputTokens, 25);
      assert.equal(result!.cacheReadTokens, 10);
      assert.deepEqual(result!.finishReasons, ["STOP"]);
    });

    it("returns null when no usage found", () => {
      const chunks = `data: {"foo":"bar"}
data: [DONE]`;

      const result = parseStreamingTokens(chunks, "anthropic");
      assert.equal(result, null);
    });

    it("handles provider mismatch gracefully", () => {
      const chunks = `data: {"type":"message_start","message":{"usage":{"input_tokens":100}}}
data: [DONE]`;

      // Using wrong provider should still return null (no usage parsed for that provider)
      const result = parseStreamingTokens(chunks, "openai");
      assert.equal(result, null);
    });
  });

  describe("extractResponseId", () => {
    it("returns null for null/undefined", () => {
      assert.equal(extractResponseId(null), null);
      assert.equal(extractResponseId(undefined), null);
    });

    it("extracts id from non-streaming response", () => {
      const data = { id: "resp_123", model: "gpt-4o" };
      assert.equal(extractResponseId(data), "resp_123");
    });

    it("extracts response_id from non-streaming response", () => {
      const data = { response_id: "resp_456", model: "gpt-4o" };
      assert.equal(extractResponseId(data), "resp_456");
    });

    it("extracts id from streaming SSE", () => {
      const data = {
        streaming: true,
        chunks: `data: {"type":"response.completed","id":"resp_789","response":{"id":"resp_789"}}
data: [DONE]`,
      };
      assert.equal(extractResponseId(data), "resp_789");
    });
  });

  describe("round-trip with parseResponseUsage", () => {
    it("handles string input as streaming", () => {
      const chunks = `data: {"type":"message_start","message":{"usage":{"input_tokens":100}}}
data: [DONE]`;

      const result = parseResponseUsage(chunks);
      assert.equal(result.stream, true);
      assert.equal(result.inputTokens, 100);
    });

    it("scans string input for SSE data lines", () => {
      const chunks = `event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":100}}}

event: message_delta
data:{"type":"message_delta","usage":{"output_tokens":12}}

data: [DONE]`;

      const result = parseResponseUsage(chunks);
      assert.equal(result.stream, true);
      assert.equal(result.inputTokens, 100);
      assert.equal(result.outputTokens, 12);
    });
  });
});
