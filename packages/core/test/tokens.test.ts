import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { IMAGE_TOKEN_ESTIMATE, estimateTokens, countImageBlocks } from "../dist/tokens.js";

describe("tokens.ts", () => {
  describe("estimateTokens", () => {
    it("returns 0 for null/undefined/empty", () => {
      assert.equal(estimateTokens(null), 0);
      assert.equal(estimateTokens(undefined), 0);
      assert.equal(estimateTokens(""), 0);
    });

    it("calculates tokens for plain strings", () => {
      // ceil(5 / 4) = 2
      assert.equal(estimateTokens("Hello"), 2);
      // "Hello world" is 11 chars, ceil(11/4) = 3
      assert.equal(estimateTokens("Hello world"), 3);
      // 100 chars / 4 = 25
      assert.equal(estimateTokens("a".repeat(100)), 25);
    });

    it("calculates tokens for objects", () => {
      const obj = { name: "test", value: 123 };
      const tokens = estimateTokens(obj);
      assert.ok(tokens > 0);
    });

    it("calculates tokens for arrays", () => {
      const arr = [1, 2, 3, 4, 5];
      const tokens = estimateTokens(arr);
      assert.ok(tokens > 0);
    });

    it("handles image blocks with fixed estimate", () => {
      // Anthropic image block
      const img = { type: "image", source: { type: "base64", data: "xxx" } };
      assert.equal(estimateTokens(img), IMAGE_TOKEN_ESTIMATE);

      // OpenAI image_url
      const img2 = { type: "image_url", image_url: { url: "data:image/png;base64,xxx" } };
      assert.equal(estimateTokens(img2), IMAGE_TOKEN_ESTIMATE);

      // Gemini inlineData
      const img3 = { inlineData: { data: "xxx", mimeType: "image/png" } };
      assert.equal(estimateTokens(img3), IMAGE_TOKEN_ESTIMATE);

      // Gemini fileData
      const img4 = { fileData: { fileUri: "gs://bucket/img.png" } };
      assert.equal(estimateTokens(img4), IMAGE_TOKEN_ESTIMATE);
    });

    it("strips base64 before counting", () => {
      // Large base64 should not be counted in the string length
      const bigBase64 = "a".repeat(10000);
      const withImage = {
        type: "image",
        source: { type: "base64", data: bigBase64 },
        text: "short",
      };
      const tokens = estimateTokens(withImage);
      // Should be exactly 1 image token (1600) - base64 is stripped
      assert.equal(tokens, 1600);
    });

    it("handles nested structures with images", () => {
      // Tool result with image content
      const toolResult = {
        type: "tool_result",
        content: [
          { type: "image", source: { type: "base64", data: "xxx" } },
          "Some text",
        ],
      };
      const tokens = estimateTokens(toolResult);
      assert.ok(tokens > IMAGE_TOKEN_ESTIMATE);
    });

    it("handles gemini parts with images", () => {
      const geminiTurn = {
        role: "user",
        parts: [
          { text: "Hello" },
          { inlineData: { data: "xxx", mimeType: "image/png" } },
        ],
      };
      const tokens = estimateTokens(geminiTurn);
      assert.ok(tokens > IMAGE_TOKEN_ESTIMATE);
    });
  });

  describe("countImageBlocks", () => {
    it("returns 0 for non-image values", () => {
      assert.equal(countImageBlocks("text"), 0);
      assert.equal(countImageBlocks({ foo: "bar" }), 0);
      assert.equal(countImageBlocks([1, 2, 3]), 0);
    });

    it("counts single image blocks", () => {
      assert.equal(countImageBlocks({ type: "image" }), 1);
      assert.equal(countImageBlocks({ type: "image_url" }), 1);
      assert.equal(countImageBlocks({ inlineData: {} }), 1);
    });

    it("counts multiple image blocks in array", () => {
      const arr = [
        { type: "image" },
        { type: "image_url" },
        { text: "hello" },
      ];
      assert.equal(countImageBlocks(arr), 2);
    });

    it("counts images in nested structures", () => {
      const nested = {
        type: "tool_result",
        content: [
          { type: "image" },
          { type: "image", source: { type: "base64" } },
        ],
      };
      assert.equal(countImageBlocks(nested), 2);
    });

    it("counts images in gemini parts", () => {
      const parts = [
        { text: "hello" },
        { inlineData: { data: "x" } },
        { fileData: {} },
      ];
      assert.equal(countImageBlocks(parts), 2);
    });
  });

  describe("IMAGE_TOKEN_ESTIMATE", () => {
    it("is 1600", () => {
      assert.equal(IMAGE_TOKEN_ESTIMATE, 1600);
    });
  });
});
