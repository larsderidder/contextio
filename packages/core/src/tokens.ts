/**
 * Token estimation utilities.
 *
 * This is a heuristic, not a model-specific tokenizer:
 * - Plain text: ceil(JavaScript string length / 4)
 * - Image content blocks: fixed fallback of 1600 tokens per image
 * - Structured objects: strips base64 before estimating JSON text
 *
 * The four-character rule is a rough text approximation, not an accuracy bound:
 * https://ai.google.dev/gemini-api/docs/tokens
 * OpenAI describes an average of four bytes, which is not JavaScript string length:
 * https://github.com/openai/tiktoken
 * Prefer provider-reported usage for actual request totals.
 */

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/**
 * Fallback token estimate for an image with unknown dimensions and model.
 *
 * This constant is not a provider billing rule or a conservative upper bound.
 * We do not decode dimensions, inspect resolution settings, or run a vision tokenizer.
 * Providers use different model-specific patch/tile rules:
 * https://platform.claude.com/docs/en/build-with-claude/vision
 * https://developers.openai.com/api/docs/guides/images-vision
 * https://ai.google.dev/gemini-api/docs/tokens
 */
export const IMAGE_TOKEN_ESTIMATE = 1_600;

// ----------------------------------------------------------------------------
// Helper functions
// ----------------------------------------------------------------------------

/**
 * Return true if the value looks like an image content block.
 *
 * Matches Anthropic `{type:"image", source:{type:"base64", data:"..."}}`,
 * OpenAI `{type:"image_url", image_url:{url:"data:..."}}`,
 * and Gemini `{inlineData:{...}}` / `{fileData:{...}}`.
 */
function isImageBlock(val: unknown): val is Record<string, unknown> {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  const obj = val as Record<string, unknown>;
  if (obj.type === "image" || obj.type === "image_url") return true;
  if (obj.inlineData || obj.fileData) return true;
  return false;
}

/**
 * Strip base64 image data from a value before stringifying for token estimation.
 *
 * Walks arrays and recognizes image blocks at any nesting level (top-level content
 * arrays, tool_result content arrays, Gemini parts). Image blocks are replaced with
 * a sentinel so the rest of the structure is still counted.
 */
function stripImageData(val: unknown): unknown {
  if (!val || typeof val !== "object") return val;

  if (Array.isArray(val)) {
    return val.map(stripImageData);
  }

  // Image block: return a lightweight placeholder
  if (isImageBlock(val)) {
    return {
      type: (val as Record<string, unknown>).type || "image",
      _image: true,
    };
  }

  const obj = val as Record<string, unknown>;

  // tool_result blocks can nest image blocks inside their content array
  if (obj.type === "tool_result" && Array.isArray(obj.content)) {
    return { ...obj, content: obj.content.map(stripImageData) };
  }

  // Gemini turn: parts array may contain inlineData
  if (Array.isArray(obj.parts)) {
    return { ...obj, parts: obj.parts.map(stripImageData) };
  }

  return obj;
}

/**
 * Count the number of image blocks in a value (recursive).
 */
function countImages(val: unknown): number {
  if (!val || typeof val !== "object") return 0;

  if (isImageBlock(val)) return 1;

  if (Array.isArray(val)) {
    let count = 0;
    for (const item of val) {
      count += countImages(item);
    }
    return count;
  }

  const obj = val as Record<string, unknown>;

  // Check nested content in tool_result blocks
  if (obj.type === "tool_result" && Array.isArray(obj.content)) {
    return countImages(obj.content);
  }

  // Check Gemini parts
  if (Array.isArray(obj.parts)) {
    return countImages(obj.parts);
  }

  return 0;
}

// ----------------------------------------------------------------------------
// Main API
// ----------------------------------------------------------------------------

/**
 * Lightweight token estimator.
 *
 * Approximates text as `ceil(string.length / 4)` using UTF-16 code units.
 * Accuracy varies by language, encoding, and content; chat/tool overhead is not modeled.
 * Images use a fixed fallback instead of counting base64 characters.
 * Do not use this estimate to enforce a model's input or context limits.
 *
 * @param text - Value to estimate tokens for. Objects are stringified as JSON.
 * @returns Estimated token count (>= 0).
 */
export function estimateTokens(text: unknown): number {
  if (!text) return 0;

  // Fast path: plain strings never contain image data
  if (typeof text === "string") {
    return Math.ceil(text.length / 4);
  }

  // Single image block
  if (isImageBlock(text)) {
    return IMAGE_TOKEN_ESTIMATE;
  }

  // Object/array: strip image data, then stringify the rest
  const cleaned = stripImageData(text);
  const s = JSON.stringify(cleaned);
  const baseTokens = Math.ceil(s.length / 4);

  // Count image blocks and add fixed estimate for each
  const imageCount = countImages(text);
  return baseTokens + imageCount * IMAGE_TOKEN_ESTIMATE;
}

/**
 * Count the number of image blocks in a value.
 *
 * @param val - Value to count images in.
 * @returns Number of image blocks found.
 */
export function countImageBlocks(val: unknown): number {
  return countImages(val);
}
