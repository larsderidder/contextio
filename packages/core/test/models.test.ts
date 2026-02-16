import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CONTEXT_LIMITS,
  MODEL_PRICING,
  estimateCost,
  getContextLimit,
  getKnownModels,
} from "../dist/models.js";

describe("models.ts", () => {
  describe("getContextLimit", () => {
    it("returns exact match for claude models", () => {
      assert.equal(getContextLimit("claude-opus-4-20250514"), 200000);
      assert.equal(getContextLimit("claude-sonnet-4-20250514"), 200000);
      assert.equal(getContextLimit("claude-haiku-4-20250320"), 200000);
    });

    it("returns match for claude-3 models", () => {
      assert.equal(getContextLimit("claude-3-5-sonnet-20241022"), 200000);
      assert.equal(getContextLimit("claude-3-opus-20240229"), 200000);
      assert.equal(getContextLimit("claude-3-haiku-20240307"), 200000);
    });

    it("returns exact match for openai models", () => {
      assert.equal(getContextLimit("gpt-4o-mini-20240718"), 128000);
      assert.equal(getContextLimit("gpt-4o-20240513"), 128000);
      assert.equal(getContextLimit("gpt-4-turbo-2024-04-09"), 128000);
      assert.equal(getContextLimit("gpt-4"), 8192);
      assert.equal(getContextLimit("gpt-3.5-turbo-0125"), 16385);
    });

    it("returns exact match for o-series models", () => {
      assert.equal(getContextLimit("o4-mini"), 200000);
      assert.equal(getContextLimit("o3-mini"), 200000);
      assert.equal(getContextLimit("o3"), 200000);
      assert.equal(getContextLimit("o1-mini"), 128000);
      assert.equal(getContextLimit("o1"), 200000);
    });

    it("returns exact match for gemini models", () => {
      assert.equal(getContextLimit("gemini-2.5-pro-preview-06-05"), 1048576);
      assert.equal(getContextLimit("gemini-2.5-flash-preview-05-20"), 1048576);
      assert.equal(getContextLimit("gemini-2.0-flash-exp"), 1048576);
      assert.equal(getContextLimit("gemini-1.5-pro-002"), 2097152);
      assert.equal(getContextLimit("gemini-1.5-flash-8b"), 1048576);
    });

    it("returns default for unknown models", () => {
      assert.equal(getContextLimit("unknown-model"), 128000);
      assert.equal(getContextLimit(""), 128000);
    });
  });

  describe("MODEL_PRICING", () => {
    it("contains anthropic models", () => {
      assert.ok(MODEL_PRICING["claude-opus-4"]);
      assert.ok(MODEL_PRICING["claude-sonnet-4"]);
      assert.ok(MODEL_PRICING["claude-haiku-4"]);
      assert.ok(MODEL_PRICING["claude-3-5-sonnet"]);
    });

    it("contains openai models", () => {
      assert.ok(MODEL_PRICING["gpt-4o"]);
      assert.ok(MODEL_PRICING["gpt-4o-mini"]);
      assert.ok(MODEL_PRICING["o1"]);
    });

    it("contains gemini models", () => {
      assert.ok(MODEL_PRICING["gemini-2.5-pro"]);
      assert.ok(MODEL_PRICING["gemini-2.0-flash"]);
    });

    it("contains minimax models", () => {
      assert.ok(MODEL_PRICING["minimax-m2.5"]);
      assert.ok(MODEL_PRICING["minimax-m2.5-fast"]);
    });
  });

  describe("estimateCost", () => {
    it("calculates cost for anthropic models", () => {
      // claude-sonnet-4: $3/M input, $15/M output
      const cost = estimateCost("claude-sonnet-4-20250514", 1000, 500);
      assert.equal(cost, 0.0105); // (1000*3 + 500*15) / 1M = 0.0105
    });

    it("calculates cost for openai models", () => {
      // gpt-4o: $2.5/M input, $10/M output
      const cost = estimateCost("gpt-4o-20240513", 1000, 500);
      assert.equal(cost, 0.0075); // (1000*2.5 + 500*10) / 1M = 0.0075
    });

    it("calculates cost for o1 models", () => {
      // o1: $15/M input, $60/M output
      const cost = estimateCost("o1", 1000, 500);
      assert.equal(cost, 0.045); // (1000*15 + 500*60) / 1M = 0.045
    });

    it("calculates cache costs for anthropic", () => {
      // Cache read: 10% of input price
      // Cache write: 25% of input price
      const cost = estimateCost(
        "claude-3-5-sonnet-20241022",
        1000,
        500,
        100, // cache read tokens
        50, // cache write tokens
      );
      // input: 1000*3/1M = 0.003
      // output: 500*15/1M = 0.0075
      // cache read: 100*3*0.1/1M = 0.00003
      // cache write: 50*3*0.25/1M = 0.0000375
      // total: 0.0105675 -> rounded to 0.010568
      assert.equal(cost, 0.010568);
    });

    it("returns null for unknown models", () => {
      const cost = estimateCost("unknown-model", 1000, 500);
      assert.equal(cost, null);
    });

    it("handles zero tokens", () => {
      const cost = estimateCost("claude-sonnet-4", 0, 0);
      assert.equal(cost, 0);
    });

    it("uses substring matching for model names", () => {
      const cost = estimateCost("claude-opus-4-20250514", 1000, 500);
      assert.ok(cost !== null);
    });
  });

  describe("getKnownModels", () => {
    it("returns sorted array of model names", () => {
      const models = getKnownModels();
      assert.ok(Array.isArray(models));
      assert.ok(models.length > 0);
      // Should be sorted
      for (let i = 1; i < models.length; i++) {
        assert.ok(models[i] >= models[i - 1]);
      }
    });

    it("includes minimax models", () => {
      const models = getKnownModels();
      assert.ok(models.includes("minimax-m2.5"));
      assert.ok(models.includes("minimax-m2.5-fast"));
    });
  });

  describe("CONTEXT_LIMITS", () => {
    it("has expected entries", () => {
      assert.equal(CONTEXT_LIMITS["claude-opus-4"], 200000);
      assert.equal(CONTEXT_LIMITS["gpt-4o"], 128000);
      assert.equal(CONTEXT_LIMITS["o1"], 200000);
      assert.equal(CONTEXT_LIMITS["gemini-1.5-pro"], 2097152);
    });
  });
});
