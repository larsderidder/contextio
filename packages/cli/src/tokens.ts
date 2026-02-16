export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export function parseTokens(
  responseBody: string,
  provider: string,
  apiFormat: string,
): TokenUsage | null {
  if (!responseBody) return null;

  if (provider === "anthropic") {
    return parseAnthropicTokens(responseBody);
  }

  if (provider === "openai" || provider === "chatgpt" || apiFormat === "chat-completions" || apiFormat === "responses") {
    return parseOpenAITokens(responseBody);
  }

  if (provider === "gemini") {
    return parseGeminiTokens(responseBody);
  }

  return null;
}

function parseAnthropicTokens(body: string): TokenUsage | null {
  const lines = body.split("\n");
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") continue;

    try {
      const event = JSON.parse(data);
      if (event.type === "message_start" && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens || 0;
      }
      if (event.type === "message_delta" && event.usage) {
        outputTokens = event.usage.output_tokens || 0;
      }
    } catch {
      // skip invalid JSON
    }
  }

  if (inputTokens > 0 || outputTokens > 0) {
    return { inputTokens, outputTokens };
  }
  return null;
}

function parseOpenAITokens(body: string): TokenUsage | null {
  const lines = body.split("\n");
  let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data);
      if (parsed.usage) {
        lastUsage = parsed.usage;
      }
    } catch {
      // skip invalid JSON
    }
  }

  if (lastUsage) {
    const input = lastUsage.prompt_tokens ?? 0;
    const output = lastUsage.completion_tokens ?? 0;
    if (input > 0 || output > 0) {
      return { inputTokens: input, outputTokens: output };
    }
  }

  return null;
}

function parseGeminiTokens(body: string): TokenUsage | null {
  const lines = body.split("\n");
  let lastUsage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | null = null;

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data);
      // usageMetadata can be at the top level or nested under "response"
      const usage = parsed.usageMetadata ?? parsed.response?.usageMetadata;
      if (usage) lastUsage = usage;
    } catch {
      // skip invalid JSON
    }
  }

  if (lastUsage) {
    const input = lastUsage.promptTokenCount || 0;
    const output = (lastUsage.candidatesTokenCount || 0) + (lastUsage.thoughtsTokenCount || 0);
    if (input > 0 || output > 0) {
      return { inputTokens: input, outputTokens: output };
    }
  }

  return null;
}
