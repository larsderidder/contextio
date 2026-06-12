/**
 * Response parsing: extract token usage, model info, and finish reasons
 * from LLM API responses.
 *
 * Handles both streaming SSE and non-streaming JSON responses from:
 * - Anthropic Messages API
 * - OpenAI Chat Completions and Responses API
 * - Google Gemini, including Code Assist wrapper responses
 */

/** Parsed token usage from an API response. */
export interface ParsedResponseUsage {
  /** Input or prompt tokens, excluding cache reads where providers report them separately. */
  inputTokens: number;
  /** Output or completion tokens, excluding thinking tokens where providers report them separately. */
  outputTokens: number;
  /** Cache read tokens. */
  cacheReadTokens: number;
  /** Cache write tokens. */
  cacheWriteTokens: number;
  /** Reasoning or thinking tokens. */
  thinkingTokens: number;
  /** Model identifier. */
  model: string | null;
  /** Finish reasons, such as stop, length, or end_turn. */
  finishReasons: string[];
  /** Whether this was parsed as a streaming response. */
  stream: boolean;
}

function emptyUsage(stream = false): ParsedResponseUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    model: null,
    finishReasons: [],
    stream,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isRecord);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function readSseData(line: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5);
  return (data.startsWith(" ") ? data.slice(1) : data).trim();
}

function hasSseData(body: string): boolean {
  return body.split("\n").some((line) => readSseData(line) !== null);
}

function setOpenAiUsage(
  result: ParsedResponseUsage,
  usage: Record<string, unknown>,
): void {
  result.inputTokens =
    numberValue(usage.input_tokens) ||
    numberValue(usage.prompt_tokens) ||
    result.inputTokens;
  result.outputTokens =
    numberValue(usage.output_tokens) ||
    numberValue(usage.completion_tokens) ||
    result.outputTokens;
  result.cacheReadTokens =
    numberValue(usage.cache_read_input_tokens) ||
    numberValue(asRecord(usage.input_tokens_details)?.cached_tokens) ||
    numberValue(asRecord(usage.prompt_tokens_details)?.cached_tokens) ||
    result.cacheReadTokens;
  result.cacheWriteTokens =
    numberValue(usage.cache_creation_input_tokens) || result.cacheWriteTokens;
  result.thinkingTokens =
    numberValue(usage.thinking_tokens) ||
    numberValue(usage.reasoning_tokens) ||
    numberValue(asRecord(usage.output_tokens_details)?.reasoning_tokens) ||
    numberValue(asRecord(usage.completion_tokens_details)?.reasoning_tokens) ||
    result.thinkingTokens;
}

function setGeminiUsage(
  result: ParsedResponseUsage,
  usage: Record<string, unknown>,
): void {
  const prompt = numberValue(usage.promptTokenCount);
  const cached = numberValue(usage.cachedContentTokenCount);
  result.inputTokens = Math.max(0, prompt - cached);
  result.outputTokens =
    numberValue(usage.candidatesTokenCount) ||
    Math.max(0, numberValue(usage.totalTokenCount) - prompt);
  result.cacheReadTokens = cached;
  result.thinkingTokens = numberValue(usage.thoughtsTokenCount);
}

function collectFinishReasons(candidates: unknown, field: string): string[] {
  const items = asRecordArray(candidates);
  if (!items) return [];
  return items
    .map((candidate) => stringValue(candidate[field]))
    .filter((value): value is string => value !== null);
}

/**
 * Extract the response ID from a response object.
 *
 * Works for both non-streaming JSON and Context Lens streaming wrapper
 * responses. For streaming, scans for response.created or response.completed
 * SSE events that carry the response object with its ID.
 */
export function extractResponseId(responseData: unknown): string | null {
  if (!responseData) return null;

  if (typeof responseData === "string") {
    const parsed = parseJsonObject(responseData.trim());
    if (!parsed) return null;
    return extractResponseId(parsed);
  }

  if (!isRecord(responseData)) return null;

  if (responseData.id) return String(responseData.id);
  if (responseData.response_id) return String(responseData.response_id);

  if (
    responseData.streaming === true &&
    typeof responseData.chunks === "string"
  ) {
    const lines = responseData.chunks.split("\n");
    for (const line of lines) {
      const data = readSseData(line);
      if (data === null || data === "[DONE]") continue;
      const parsed = parseJsonObject(data);
      if (!parsed) continue;
      const response = asRecord(parsed.response);
      if (response?.id) return String(response.id);
      if (
        (parsed.type === "response.completed" ||
          parsed.type === "response.created") &&
        parsed.id
      ) {
        return String(parsed.id);
      }
    }
  }

  return null;
}

/**
 * Parse token usage from an API response.
 *
 * Accepts direct JSON objects, raw JSON response body strings, raw SSE strings,
 * and Context Lens streaming wrapper objects of the form { streaming: true, chunks }.
 */
export function parseResponseUsage(responseData: unknown): ParsedResponseUsage {
  const result = emptyUsage(false);
  if (!responseData) return result;

  if (typeof responseData === "string") {
    const trimmed = responseData.trim();
    if (hasSseData(trimmed)) {
      return parseStreamingUsage(responseData, emptyUsage(true));
    }
    const parsed = parseJsonObject(trimmed);
    return parsed ? parseResponseUsage(parsed) : result;
  }

  if (!isRecord(responseData)) return result;

  if (
    responseData.streaming === true &&
    typeof responseData.chunks === "string"
  ) {
    return parseStreamingUsage(responseData.chunks, emptyUsage(true));
  }

  const usage = asRecord(responseData.usage);
  if (usage) {
    setOpenAiUsage(result, usage);
  }

  const response = asRecord(responseData.response);
  const responseUsage = asRecord(response?.usage);
  if (responseUsage) {
    setOpenAiUsage(result, responseUsage);
  }

  const geminiResp = responseData.usageMetadata ? responseData : response;
  const geminiUsage = asRecord(geminiResp?.usageMetadata);
  if (geminiUsage) {
    setGeminiUsage(result, geminiUsage);
  }

  result.model =
    stringValue(responseData.model) ||
    stringValue(responseData.modelVersion) ||
    stringValue(response?.model) ||
    stringValue(response?.modelVersion) ||
    null;

  const stopReason = stringValue(responseData.stop_reason);
  if (stopReason) {
    result.finishReasons = [stopReason];
  } else if (responseData.choices) {
    result.finishReasons = collectFinishReasons(responseData.choices, "finish_reason");
  } else if (responseData.candidates) {
    result.finishReasons = collectFinishReasons(responseData.candidates, "finishReason");
  } else if (geminiResp?.candidates) {
    result.finishReasons = collectFinishReasons(geminiResp.candidates, "finishReason");
  }

  return result;
}

function parseStreamingUsage(
  chunks: string,
  result: ParsedResponseUsage,
): ParsedResponseUsage {
  const lines = chunks.split("\n");
  for (const line of lines) {
    const data = readSseData(line);
    if (data === null || data === "[DONE]") continue;

    const parsed = parseJsonObject(data);
    if (!parsed) continue;

    if (parsed.type === "message_start") {
      const message = asRecord(parsed.message);
      result.model = stringValue(message?.model) || result.model;
      const usage = asRecord(message?.usage);
      if (usage) {
        result.inputTokens = numberValue(usage.input_tokens);
        result.cacheReadTokens = numberValue(usage.cache_read_input_tokens);
        result.cacheWriteTokens = numberValue(usage.cache_creation_input_tokens);
        result.thinkingTokens =
          numberValue(usage.thinking_tokens) || numberValue(usage.reasoning_tokens);
      }
    }

    if (parsed.type === "message_delta") {
      const delta = asRecord(parsed.delta);
      const stopReason = stringValue(delta?.stop_reason);
      if (stopReason) result.finishReasons = [stopReason];
      const usage = asRecord(parsed.usage);
      if (usage) {
        result.outputTokens = numberValue(usage.output_tokens) || result.outputTokens;
        result.thinkingTokens =
          numberValue(usage.thinking_tokens) ||
          numberValue(usage.reasoning_tokens) ||
          result.thinkingTokens;
      }
    }

    const response = asRecord(parsed.response);
    const openAiUsage = asRecord(parsed.usage) ?? asRecord(response?.usage);
    if (openAiUsage) {
      setOpenAiUsage(result, openAiUsage);
    }
    const choices = asRecordArray(parsed.choices) ?? asRecordArray(response?.choices);
    const choiceFinish = choices?.[0]?.finish_reason;
    if (typeof choiceFinish === "string") {
      result.finishReasons = [choiceFinish];
    }

    const geminiCarrier = parsed.usageMetadata ? parsed : response;
    const geminiUsage = asRecord(geminiCarrier?.usageMetadata);
    if (geminiUsage) {
      setGeminiUsage(result, geminiUsage);
    }
    const candidates =
      asRecordArray(parsed.candidates) ?? asRecordArray(response?.candidates);
    const candidateFinish = candidates?.[0]?.finishReason;
    if (typeof candidateFinish === "string") {
      result.finishReasons = [candidateFinish];
    }

    result.model =
      stringValue(parsed.modelVersion) ||
      stringValue(parsed.model) ||
      stringValue(response?.modelVersion) ||
      stringValue(response?.model) ||
      result.model;
  }

  return result;
}

/**
 * Provider-specific streaming token parser.
 *
 * Unlike parseResponseUsage, this function takes an explicit provider hint
 * and only checks for that provider's SSE format.
 */
export function parseStreamingTokens(
  body: string,
  provider: string,
): ParsedResponseUsage | null {
  const result = emptyUsage(true);

  const lines = body.split("\n");
  for (const line of lines) {
    const data = readSseData(line);
    if (data === null || data === "[DONE]") continue;

    const parsed = parseJsonObject(data);
    if (!parsed) continue;

    if (provider === "anthropic") {
      if (parsed.type === "message_start") {
        const message = asRecord(parsed.message);
        result.model = stringValue(message?.model) || result.model;
        const usage = asRecord(message?.usage);
        if (usage) {
          result.inputTokens = numberValue(usage.input_tokens);
          result.cacheReadTokens = numberValue(usage.cache_read_input_tokens);
          result.cacheWriteTokens = numberValue(usage.cache_creation_input_tokens);
          result.thinkingTokens =
            numberValue(usage.thinking_tokens) || numberValue(usage.reasoning_tokens);
        }
      }
      if (parsed.type === "message_delta") {
        const delta = asRecord(parsed.delta);
        const stopReason = stringValue(delta?.stop_reason);
        if (stopReason) result.finishReasons = [stopReason];
        const usage = asRecord(parsed.usage);
        if (usage) {
          result.outputTokens = numberValue(usage.output_tokens);
          result.thinkingTokens =
            numberValue(usage.thinking_tokens) ||
            numberValue(usage.reasoning_tokens) ||
            result.thinkingTokens;
        }
      }
    } else if (provider === "openai" || provider === "chatgpt") {
      const usage = asRecord(parsed.usage);
      if (usage && parsed.choices) {
        setOpenAiUsage(result, usage);
      }
      const choices = asRecordArray(parsed.choices);
      const finishReason = choices?.[0]?.finish_reason;
      if (typeof finishReason === "string") {
        result.finishReasons = [finishReason];
      }
    } else if (provider === "gemini") {
      const usage = asRecord(parsed.usageMetadata);
      if (usage) setGeminiUsage(result, usage);
      const candidates = asRecordArray(parsed.candidates);
      const finishReason = candidates?.[0]?.finishReason;
      if (typeof finishReason === "string") {
        result.finishReasons = [finishReason];
      }
      result.model = stringValue(parsed.modelVersion) || result.model;
    }
  }

  if (
    result.inputTokens === 0 &&
    result.outputTokens === 0 &&
    result.cacheReadTokens === 0 &&
    result.cacheWriteTokens === 0 &&
    result.thinkingTokens === 0
  ) {
    return null;
  }

  return result;
}
