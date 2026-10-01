/**
 * Model pricing and context limits for Anthropic, OpenAI, Google, and MiniMax.
 *
 * Context limits describe the provider-advertised total window, not a reserved
 * input budget or the maximum output. They do not validate whether a request fits.
 * Provider documentation is authoritative; catalogs are comparison aids only.
 *
 * Sources for updated entries, checked 2026-10-01:
 * - Anthropic windows: https://platform.claude.com/docs/en/build-with-claude/context-windows
 * - Anthropic prices: https://platform.claude.com/docs/en/about-claude/pricing
 * - OpenAI windows and prices: https://developers.openai.com/api/docs/models/{model-id}
 *   Chat aliases use the corresponding {model-id}-latest page.
 * - Google limits: https://ai.google.dev/gemini-api/docs/models
 * - Google prices: https://ai.google.dev/gemini-api/docs/pricing
 * - MiniMax windows: https://platform.minimax.io/docs/api-reference/text-anthropic-api
 * - MiniMax prices: https://platform.minimax.io/docs/pricing/overview
 *
 * Historical entries from OpenRouter and LiteLLM are retained for retired models:
 * https://openrouter.ai/models
 * https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
 * Provider prefixes and snapshots are accepted, but unknown variants do not inherit data.
 */

// ----------------------------------------------------------------------------
// Context limits (tokens)
// ----------------------------------------------------------------------------

/**
 * Provider-advertised context windows in tokens, including input and output.
 *
 * Input and output caps are separate constraints; neither is subtracted here.
 */
export const CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic
  "claude-opus-4.6": 1000000,
  "claude-opus-4.5": 200000,
  "claude-opus-4.1": 200000,
  "claude-opus-4": 200000,
  "claude-sonnet-4.6": 1000000,
  "claude-sonnet-4.5": 200000,
  "claude-sonnet-4": 200000,
  "claude-haiku-4.5": 200000,
  "claude-haiku-4": 200000,
  "claude-3-7-sonnet": 200000,
  "claude-3-5-sonnet": 200000,
  "claude-3-5-haiku": 200000,
  "claude-3-haiku": 200000,
  "claude-3-opus": 200000,
  // OpenAI: reasoning/Codex windows are 400k; Chat variants remain 128k.
  "gpt-5.2-pro": 400000,
  "gpt-5.2-codex": 400000,
  "gpt-5.2-chat": 128000,
  "gpt-5.2": 400000,
  "gpt-5.1-codex-max": 400000,
  "gpt-5.1-codex-mini": 400000,
  "gpt-5.1-codex": 400000,
  "gpt-5.1-chat": 128000,
  "gpt-5.1": 400000,
  "gpt-5.3-codex": 400000,
  "gpt-5-pro": 400000,
  "gpt-5-codex": 400000,
  "gpt-5-chat": 128000,
  "gpt-5-mini": 400000,
  "gpt-5-nano": 400000,
  "gpt-5": 400000,
  "gpt-4.1-mini": 1047576,
  "gpt-4.1-nano": 1047576,
  "gpt-4.1": 1047576,
  "gpt-4o-mini": 128000,
  "gpt-4o": 128000,
  "gpt-4-turbo": 128000,
  "gpt-4": 8192,
  "gpt-3.5-turbo": 16385,
  "o4-mini-deep-research": 200000,
  "o4-mini-high": 200000,
  "o4-mini": 200000,
  "o3-deep-research": 200000,
  "o3-pro": 200000,
  "o3-mini-high": 200000,
  "o3-mini": 200000,
  o3: 200000,
  "o1-pro": 200000,
  "o1-mini": 128000,
  o1: 200000,
  // Google publishes input/output caps separately; retain its advertised window.
  "gemini-3.1-pro-preview": 1048576,
  "gemini-3-pro-preview": 1048576,
  "gemini-3-flash-preview": 1048576,
  "gemini-2.5-pro-preview": 1048576,
  "gemini-2.5-pro": 1048576,
  "gemini-2.5-flash-lite": 1048576,
  "gemini-2.5-flash": 1048576,
  "gemini-2.0-flash-lite": 1048576,
  "gemini-2.0-flash": 1048576,
  "gemini-1.5-pro": 2097152,
  "gemini-1.5-flash-8b": 1048576,
  "gemini-1.5-flash": 1048576,
  // MiniMax: "fast" is retained as a compatibility alias for "highspeed".
  "minimax-m2.5-highspeed": 204800,
  "minimax-m2.5-fast": 204800,
  "minimax-m2.5": 204800,
};

/** Resolve an exact model, a provider-prefixed ID, or a recognized snapshot alias. */
function findModelKey(model: string, keys: string[]): string | null {
  const normalized = model.toLowerCase().replace(/\./g, "-");
  const modelId = normalized.slice(normalized.lastIndexOf("/") + 1);
  for (const key of keys) {
    const normalizedKey = key.replace(/\./g, "-");
    if (modelId === normalizedKey) {
      return key;
    }
    if (!modelId.startsWith(`${normalizedKey}-`)) {
      continue;
    }

    // Only recognized aliases may extend a known ID, not new model generations.
    const suffix = modelId.slice(normalizedKey.length);
    if (/^-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/.test(suffix)) {
      return key;
    }
    if ((key === "gpt-3.5-turbo" || key === "gpt-4") && /^-\d{4}$/.test(suffix)) {
      return key;
    }
    if (key.startsWith("gemini-")) {
      if (/^-(?:\d{3}|exp|preview(?:-\d{2}-\d{2})?)$/.test(suffix)) {
        return key;
      }
      if (key.endsWith("-preview") && /^-\d{2}-\d{2}$/.test(suffix)) {
        return key;
      }
    }
  }
  return null;
}

/**
 * Resolve the provider-advertised total context window in tokens.
 * Unknown models return a heuristic 128k fallback, not a verified model limit.
 * Provider prefixes, dotted/hyphenated IDs, and date snapshots are supported.
 */
export function getContextLimit(model: string): number {
  const key = findModelKey(model, Object.keys(CONTEXT_LIMITS));
  if (key !== null) {
    return CONTEXT_LIMITS[key];
  }
  return 128000;
}

// ----------------------------------------------------------------------------
// Pricing
// ----------------------------------------------------------------------------

/**
 * Model pricing: `[inputPerMTok, outputPerMTok]` in USD.
 *
 * Standard direct-provider text rates. Long-context tiers, batch discounts,
 * regional/service-tier premiums, tool fees, and cache storage are not included.
 */
export const MODEL_PRICING: Record<string, [number, number]> = {
  // Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
  "claude-opus-4.6": [5, 25],
  "claude-opus-4.5": [5, 25],
  "claude-opus-4.1": [15, 75],
  "claude-opus-4": [15, 75],
  "claude-sonnet-4.6": [3, 15],
  "claude-sonnet-4.5": [3, 15],
  "claude-sonnet-4": [3, 15],
  "claude-haiku-4.5": [1, 5],
  "claude-haiku-4": [0.8, 4],
  "claude-3-7-sonnet": [3, 15],
  "claude-3-5-sonnet": [3, 15],
  "claude-3-5-haiku": [0.8, 4],
  "claude-3-haiku": [0.25, 1.25],
  "claude-3-opus": [15, 75],
  // OpenAI: https://developers.openai.com/api/docs/models/{model-id}
  "gpt-5.2-pro": [21, 168],
  "gpt-5.2-codex": [1.75, 14],
  "gpt-5.2-chat": [1.75, 14],
  "gpt-5.2": [1.75, 14],
  "gpt-5.1-codex-max": [1.25, 10],
  "gpt-5.1-codex-mini": [0.25, 2],
  "gpt-5.1-codex": [1.25, 10],
  "gpt-5.1-chat": [1.25, 10],
  "gpt-5.1": [1.25, 10],
  "gpt-5.3-codex": [1.75, 14],
  "gpt-5-pro": [15, 120],
  "gpt-5-codex": [1.25, 10],
  "gpt-5-chat": [1.25, 10],
  "gpt-5-mini": [0.25, 2],
  "gpt-5-nano": [0.05, 0.4],
  "gpt-5": [1.25, 10],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1-nano": [0.1, 0.4],
  "gpt-4.1": [2.0, 8.0],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o": [2.5, 10],
  "gpt-4-turbo": [10, 30],
  "gpt-4": [30, 60],
  "gpt-3.5-turbo": [0.5, 1.5],
  "o4-mini-deep-research": [2, 8],
  "o4-mini-high": [1.1, 4.4],
  "o4-mini": [1.1, 4.4],
  "o3-deep-research": [10, 40],
  "o3-pro": [20, 80],
  "o3-mini-high": [1.1, 4.4],
  "o3-mini": [1.1, 4.4],
  o3: [2, 8],
  "o1-pro": [150, 600],
  "o1-mini": [1.1, 4.4],
  o1: [15, 60],
  // Google: standard text rates for the shorter-prompt tier, without cache storage.
  "gemini-3.1-pro-preview": [2, 12],
  "gemini-3-pro-preview": [2, 12],
  "gemini-3-flash-preview": [0.5, 3],
  "gemini-2.5-pro-preview": [1.25, 10],
  "gemini-2.5-pro": [1.25, 10],
  "gemini-2.5-flash-lite": [0.1, 0.4],
  "gemini-2.5-flash": [0.3, 2.5],
  "gemini-2.0-flash-lite": [0.075, 0.3],
  "gemini-2.0-flash": [0.1, 0.4],
  "gemini-1.5-pro": [1.25, 5],
  "gemini-1.5-flash": [0.075, 0.3],
  // MiniMax: https://platform.minimax.io/docs/pricing/overview
  "minimax-m2.5-highspeed": [0.6, 2.4],
  "minimax-m2.5-fast": [0.6, 2.4],
  "minimax-m2.5": [0.3, 1.2],
};

/**
 * Cache pricing multipliers by provider prefix.
 *
 * Each entry maps a model key prefix to `[readMultiplier, writeMultiplier]`
 * relative to the base input price.
 * - Anthropic: reads at 10% of base input, writes at 125% (1.25x)
 * - Gemini: cached content at 25% of base input, no write billing
 */
const CACHE_PRICING: Record<string, [number, number]> = {
  "claude-": [0.1, 1.25],
  "gemini-": [0.25, 0],
};

function getCacheMultipliers(modelKey: string): [number, number] {
  if (modelKey.startsWith("minimax-m2.5")) {
    // Both variants use the same absolute cache rates (USD/MTok).
    // https://platform.minimax.io/docs/pricing/overview
    const [inputPrice] = MODEL_PRICING[modelKey];
    return [0.03 / inputPrice, 0.375 / inputPrice];
  }
  for (const [prefix, multipliers] of Object.entries(CACHE_PRICING)) {
    if (modelKey.startsWith(prefix)) {
      return multipliers;
    }
  }
  return [0, 0];
}

/**
 * Estimate cost in USD for a request/response token pair using `MODEL_PRICING`.
 *
 * Cache estimates cover Anthropic's five-minute writes, a legacy Gemini
 * approximation, and documented MiniMax M2.5 rates. Other cache rates are omitted.
 *
 * @param model - Exact model identifier, provider-prefixed ID, or recognized snapshot.
 * @param inputTokens - Input/prompt tokens (non-cached).
 * @param outputTokens - Output/completion tokens.
 * @param cacheReadTokens - Cache read tokens.
 * @param cacheWriteTokens - Cache write tokens.
 * @returns Cost in USD, rounded to 6 decimals; `null` if the model is unknown.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number | null {
  const key = findModelKey(model, Object.keys(MODEL_PRICING));
  if (key === null) {
    return null;
  }

  const [inp, out] = MODEL_PRICING[key];
  const [readMul, writeMul] = getCacheMultipliers(key);
  const cacheReadCost = cacheReadTokens * inp * readMul;
  const cacheWriteCost = cacheWriteTokens * inp * writeMul;

  return Math.round(
    inputTokens * inp + outputTokens * out + cacheReadCost + cacheWriteCost,
  ) / 1_000_000;
}

/**
 * Get list of known model names.
 *
 * @returns Sorted array of model identifiers.
 */
export function getKnownModels(): string[] {
  return Object.keys(MODEL_PRICING).sort();
}
