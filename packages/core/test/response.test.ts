import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractResponseId,
  parseResponseUsage,
  parseStreamingTokens,
  type ParsedResponseUsage,
} from "../dist/response.js";

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

    it("parses Gemini usageMetadata", () => {
      const data = {
        usageMetadata: {
          promptTokenCount: 300,
          candidatesTokenCount: 150,
          totalTokenCount: 450,
          cachedContentTokenCount: 100,
        },
        modelVersion: "gemini-1.5-pro",
      };
      const result = parseResponseUsage(data);
      assert.equal(result.inputTokens, 300);
      assert.equal(result.outputTokens, 150);
      assert.equal(result.cacheReadTokens, 100);
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
      assert.equal(result!.inputTokens, 50);
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
  });
});
