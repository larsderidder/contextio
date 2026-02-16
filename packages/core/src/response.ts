/**
 * Response parsing utilities for extracting token usage from API responses.
 *
 * Handles streaming SSE and non-streaming JSON responses from:
 * - Anthropic
 * - OpenAI (Chat Completions and Responses API)
 * - Google Gemini (including Code Assist wrapper)
 */

import { estimateTokens } from "./tokens.js";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Parsed token usage from an API response.
 */
export interface ParsedResponseUsage {
  /** Input/prompt tokens. */
  inputTokens: number;
  /** Output/completion tokens. */
  outputTokens: number;
  /** Cache read tokens (Anthropic). */
  cacheReadTokens: number;
  /** Cache write tokens (Anthropic). */
  cacheWriteTokens: number;
  /** Model identifier. */
  model: string | null;
  /** Finish reasons (stop, length, etc). */
  finishReasons: string[];
  /** Whether this was a streaming response. */
  stream: boolean;
}

// ----------------------------------------------------------------------------
// Main API
// ----------------------------------------------------------------------------

/**
 * Extract the response ID from a response object.
 *
 * Works for both non-streaming (direct JSON) and streaming (SSE chunks)
 * responses. For streaming, scans for `response.completed` or
 * `response.created` SSE events that carry the response object with its ID.
 *
 * @param responseData - Response data (may include streaming chunks).
 * @returns Response ID or null if not found.
 */
export function extractResponseId(responseData: unknown): string | null {
  if (!responseData) return null;
  const data = responseData as Record<string, unknown>;

  // Non-streaming: direct JSON response with id field
  if (data.id) return String(data.id);
  if (data.response_id) return String(data.response_id);

  // Streaming: scan SSE chunks for response events
  if (data.streaming && typeof data.chunks === "string") {
    const lines = String(data.chunks).split("\n");
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const lineData = line.slice(6).trim();
      if (lineData === "[DONE]") continue;
      try {
        const parsed = JSON.parse(lineData);
        // OpenAI Responses API: response.completed / response.created events
        // carry the full response object including its id
        if (parsed.response?.id) return parsed.response.id;
        // Direct id on the event object (some streaming formats)
        if (
          parsed.type === "response.completed" ||
          parsed.type === "response.created"
        ) {
          if (parsed.id) return parsed.id;
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  return null;
}

/**
 * Parse token usage from an API response.
 *
 * Handles both streaming SSE and non-streaming JSON for Anthropic, OpenAI, and Gemini.
 *
 * @param responseData - Response body (string for streaming, object for non-streaming).
 * @returns Parsed usage information.
 */
export function parseResponseUsage(
  responseData: unknown,
): ParsedResponseUsage {
  const result: ParsedResponseUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model: null,
    finishReasons: [],
    stream: false,
  };

  if (!responseData) return result;

  // Handle string input (streaming SSE chunks)
  if (typeof responseData === "string") {
    result.stream = true;
    return parseStreamingUsage(responseData, result);
  }

  // Non-streaming: direct JSON object
  const data = responseData as Record<string, unknown>;

  // OpenAI / ChatGPT usage (non-streaming)
  if (data.usage) {
    const u = data.usage as Record<string, unknown>;
    result.inputTokens = Number(u.input_tokens || u.prompt_tokens || 0);
    result.outputTokens = Number(u.output_tokens || u.completion_tokens || 0);
    result.cacheReadTokens = Number(u.cache_read_input_tokens || 0);
    result.cacheWriteTokens = Number(u.cache_creation_input_tokens || 0);
  }

  // Anthropic non-streaming
  if (data.usage && data.id) {
    const u = data.usage as Record<string, unknown>;
    result.inputTokens = Number(u.input_tokens || 0);
    result.outputTokens = Number(u.output_tokens || 0);
    result.cacheReadTokens = Number(u.cache_read_input_tokens || 0);
    result.cacheWriteTokens = Number(u.cache_creation_input_tokens || 0);
  }

  // Gemini usageMetadata (direct or inside Code Assist wrapper .response)
  const geminiResp = data.usageMetadata
    ? data
    : (data.response as Record<string, unknown>) || {};
  if (geminiResp.usageMetadata) {
    const u = geminiResp.usageMetadata as Record<string, unknown>;
    result.inputTokens = Number(u.promptTokenCount || 0);
    result.outputTokens =
      Number(
        u.candidatesTokenCount ||
          Number(u.totalTokenCount || 0) - Number(u.promptTokenCount || 0) ||
          0,
      ) + Number(u.thoughtsTokenCount || 0);
    result.cacheReadTokens = Number(u.cachedContentTokenCount || 0);
  }

  result.model =
    (data.model as string) ||
    (data.modelVersion as string) ||
    (geminiResp.modelVersion as string) ||
    null;

  // Finish reasons
  if (data.stop_reason) {
    result.finishReasons = [String(data.stop_reason)];
  } else if (data.choices && Array.isArray(data.choices)) {
    result.finishReasons = data.choices
      .map((c: unknown) => (c as Record<string, unknown>).finish_reason)
      .filter(Boolean)
      .map(String);
  } else if (data.candidates && Array.isArray(data.candidates)) {
    result.finishReasons = data.candidates
      .map((c: unknown) => (c as Record<string, unknown>).finishReason)
      .filter(Boolean)
      .map(String);
  } else if (
    geminiResp.candidates &&
    Array.isArray(geminiResp.candidates)
  ) {
    result.finishReasons = geminiResp.candidates
      .map((c: unknown) => (c as Record<string, unknown>).finishReason)
      .filter(Boolean)
      .map(String);
  }

  return result;
}

/**
 * Parse streaming SSE chunks to extract usage.
 *
 * @param chunks - SSE chunk string.
 * @param result - Result object to accumulate into.
 * @returns Updated result with parsed usage.
 */
function parseStreamingUsage(
  chunks: string,
  result: ParsedResponseUsage,
): ParsedResponseUsage {
  const lines = chunks.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;

      // Anthropic message_start: contains model
      if (parsed.type === "message_start" && parsed.message) {
        const msg = parsed.message as Record<string, unknown>;
        result.model = (msg.model as string) || result.model;
        if (msg.usage) {
          const u = msg.usage as Record<string, unknown>;
          result.inputTokens = Number(u.input_tokens || 0);
          result.cacheReadTokens = Number(u.cache_read_input_tokens || 0);
          result.cacheWriteTokens = Number(u.cache_creation_input_tokens || 0);
        }
      }

      // Anthropic message_delta: contains stop_reason and output token count
      if (parsed.type === "message_delta") {
        const delta = parsed.delta as Record<string, unknown>;
        if (delta?.stop_reason) {
          result.finishReasons = [String(delta.stop_reason)];
        }
        if (parsed.usage) {
          const u = parsed.usage as Record<string, unknown>;
          result.outputTokens = Number(u.output_tokens || result.outputTokens);
        }
      }

        // OpenAI streaming: final chunk with usage
        if (parsed.usage && parsed.choices) {
          const u = parsed.usage as Record<string, unknown>;
          result.inputTokens = Number(u.prompt_tokens || result.inputTokens);
          result.outputTokens = Number(u.completion_tokens || result.outputTokens);
        }
        const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
        if (choices && choices[0]?.finish_reason) {
          result.finishReasons = [String(choices[0].finish_reason)];
        }

        // Gemini streaming: usageMetadata in chunks
        if (parsed.usageMetadata) {
          const u = parsed.usageMetadata as Record<string, unknown>;
          result.inputTokens = Number(u.promptTokenCount || result.inputTokens);
          result.outputTokens =
            Number(u.candidatesTokenCount || result.outputTokens) +
            Number(u.thoughtsTokenCount || 0);
          result.cacheReadTokens = Number(
            u.cachedContentTokenCount || result.cacheReadTokens,
          );
        }
        const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
        if (candidates && candidates[0]?.finishReason) {
          result.finishReasons = [String(candidates[0].finishReason)];
        }
      if (parsed.modelVersion) {
        result.model = String(parsed.modelVersion);
      }
      if (parsed.model) {
        result.model = String(parsed.model);
      }
    } catch {
      // Skip unparseable lines
    }
  }
  return result;
}

/**
 * Simple token parser for streaming SSE responses.
 *
 * This is a simpler alternative to `parseResponseUsage` for cases where
 * you have raw SSE text from an HTTP response.
 *
 * @param body - Raw SSE response body.
 * @param provider - Provider name (anthropic, openai, gemini).
 * @returns Parsed usage or null if not found.
 */
export function parseStreamingTokens(
  body: string,
  provider: string,
): ParsedResponseUsage | null {
  const result: ParsedResponseUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    model: null,
    finishReasons: [],
    stream: true,
  };

  const lines = body.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;

      if (provider === "anthropic") {
        if (parsed.type === "message_start" && parsed.message) {
          const msg = parsed.message as Record<string, unknown>;
          result.model = (msg.model as string) || result.model;
          if (msg.usage) {
            const u = msg.usage as Record<string, unknown>;
            result.inputTokens = Number(u.input_tokens || 0);
            result.cacheReadTokens = Number(u.cache_read_input_tokens || 0);
            result.cacheWriteTokens = Number(u.cache_creation_input_tokens || 0);
          }
        }
        if (parsed.type === "message_delta") {
          const delta = parsed.delta as Record<string, unknown>;
          if (delta?.stop_reason) {
            result.finishReasons = [String(delta.stop_reason)];
          }
          if (parsed.usage) {
            const u = parsed.usage as Record<string, unknown>;
            result.outputTokens = Number(u.output_tokens || 0);
          }
        }
      } else if (provider === "openai" || provider === "chatgpt") {
        if (parsed.usage && parsed.choices) {
          const u = parsed.usage as Record<string, unknown>;
          result.inputTokens = Number(u.prompt_tokens || 0);
          result.outputTokens = Number(u.completion_tokens || 0);
        }
        const choices2 = parsed.choices as Array<Record<string, unknown>> | undefined;
        if (choices2 && choices2[0]?.finish_reason) {
          result.finishReasons = [String(choices2[0].finish_reason)];
        }
      } else if (provider === "gemini") {
        if (parsed.usageMetadata) {
          const u = parsed.usageMetadata as Record<string, unknown>;
          result.inputTokens = Number(u.promptTokenCount || 0);
          result.outputTokens =
            Number(u.candidatesTokenCount || 0) + Number(u.thoughtsTokenCount || 0);
          result.cacheReadTokens = Number(u.cachedContentTokenCount || 0);
        }
        const candidates2 = parsed.candidates as Array<Record<string, unknown>> | undefined;
        if (candidates2 && candidates2[0]?.finishReason) {
          result.finishReasons = [String(candidates2[0].finishReason)];
        }
        if (parsed.modelVersion) {
          result.model = String(parsed.modelVersion);
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  // Return null if no usage found
  if (
    result.inputTokens === 0 &&
    result.outputTokens === 0 &&
    result.cacheReadTokens === 0 &&
    result.cacheWriteTokens === 0
  ) {
    return null;
  }

  return result;
}
