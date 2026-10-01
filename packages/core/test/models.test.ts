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

    it("returns total GPT-5 windows rather than reserved input budgets", () => {
      // Each model's OpenAI documentation specifies a 400k context window.
      const models = [
        "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5-codex",
        "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-codex-max",
        "gpt-5.2", "gpt-5.2-pro", "gpt-5.2-codex", "gpt-5.3-codex",
      ];
      for (const model of models) {
        assert.equal(getContextLimit(model), 400000, model);
      }
    });

    it("keeps Chat variant windows separate from reasoning models", () => {
      assert.equal(getContextLimit("openai/gpt-5-chat-latest"), 128000);
      assert.equal(getContextLimit("gpt-5.1-chat-latest"), 128000);
      assert.equal(getContextLimit("gpt-5.2-chat-latest"), 128000);
    });

    it("distinguishes Claude point releases and provider prefixes", () => {
      assert.equal(getContextLimit("anthropic/claude-sonnet-4.5"), 200000);
      assert.equal(getContextLimit("claude-sonnet-4-6"), 1000000);
      assert.equal(getContextLimit("claude-opus-4-6-20251101"), 1000000);
      assert.equal(getContextLimit("claude-sonnet-4-latest"), 200000);
    });

    it("uses documented MiniMax windows and recognizes native IDs", () => {
      assert.equal(getContextLimit("MiniMax-M2.5"), 204800);
      assert.equal(getContextLimit("minimax/MiniMax-M2.5-highspeed"), 204800);
      assert.equal(getContextLimit("minimax-m2.5-fast"), 204800);
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

    it("does not borrow a window from a different model variant", () => {
      for (const model of ["gpt-5.4", "claude-opus-4.99", "gpt-4o-fake", "my-gpt-4o-model"]) {
        assert.equal(getContextLimit(model), 128000, model);
      }
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

    it("uses direct-provider MiniMax pricing and preserves the fast alias", () => {
      assert.deepEqual(MODEL_PRICING["minimax-m2.5"], [0.3, 1.2]);
      assert.deepEqual(MODEL_PRICING["minimax-m2.5-highspeed"], [0.6, 2.4]);
      assert.deepEqual(MODEL_PRICING["minimax-m2.5-fast"], [0.6, 2.4]);
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
      // Cache write: 125% of input price (1.25x)
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
      // cache write: 50*3*1.25/1M = 0.0001875
      // total: 0.0107175 -> rounded to 0.010718
      assert.equal(cost, 0.010718);
    });

    it("returns null for unknown models", () => {
      const cost = estimateCost("unknown-model", 1000, 500);
      assert.equal(cost, null);
    });

    it("does not assign base-model pricing to unknown variants", () => {
      for (const model of ["gpt-5.4", "claude-opus-4.99", "gpt-4o-fake", "my-gpt-4o-model", "gpt-5-preview"]) {
        assert.equal(estimateCost(model, 1000, 500), null, model);
      }
    });

    it("charges native MiniMax IDs at the correct base and highspeed rates", () => {
      assert.equal(estimateCost("minimax/MiniMax-M2.5", 1_000_000, 0), 0.3);
      assert.equal(estimateCost("MiniMax-M2.5", 0, 1_000_000), 1.2);
      assert.equal(estimateCost("MiniMax-M2.5-highspeed", 1_000_000, 0), 0.6);
      assert.equal(estimateCost("minimax-m2.5-fast", 0, 1_000_000), 2.4);
    });

    it("uses the same absolute MiniMax cache rates for both speed variants", () => {
      for (const model of ["MiniMax-M2.5", "MiniMax-M2.5-highspeed", "minimax-m2.5-fast"]) {
        assert.equal(estimateCost(model, 0, 0, 1_000_000, 0), 0.03);
        assert.equal(estimateCost(model, 0, 0, 0, 1_000_000), 0.375);
      }
    });

    it("handles zero tokens", () => {
      const cost = estimateCost("claude-sonnet-4", 0, 0);
      assert.equal(cost, 0);
    });

    it("recognizes model date snapshots", () => {
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
      assert.equal(CONTEXT_LIMITS["claude-sonnet-4"], 200000);
      assert.equal(CONTEXT_LIMITS["gpt-4o"], 128000);
      assert.equal(CONTEXT_LIMITS["o1"], 200000);
      assert.equal(CONTEXT_LIMITS["gemini-1.5-pro"], 2097152);
      assert.equal(CONTEXT_LIMITS["gemini-2.5-flash"], 1048576);
    });
  });
});
