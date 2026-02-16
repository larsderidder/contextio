export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-3-5-sonnet-20241022": { inputPer1M: 3, outputPer1M: 15 },
  "claude-3-5-sonnet-20240620": { inputPer1M: 3, outputPer1M: 15 },
  "claude-3-5-sonnet": { inputPer1M: 3, outputPer1M: 15 },
  "claude-3-opus-20240229": { inputPer1M: 15, outputPer1M: 75 },
  "claude-3-opus": { inputPer1M: 15, outputPer1M: 75 },
  "claude-3-sonnet-20240229": { inputPer1M: 3, outputPer1M: 15 },
  "claude-3-sonnet": { inputPer1M: 3, outputPer1M: 15 },
  "claude-3-haiku-20240307": { inputPer1M: 0.25, outputPer1M: 1.25 },
  "claude-3-haiku": { inputPer1M: 0.25, outputPer1M: 1.25 },
  "claude-sonnet-4-20250514": { inputPer1M: 3, outputPer1M: 15 },
  "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "gpt-4o-20240513": { inputPer1M: 2.5, outputPer1M: 10 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o-mini-20240718": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4-turbo-2024-04-09": { inputPer1M: 10, outputPer1M: 30 },
  "gpt-4": { inputPer1M: 30, outputPer1M: 60 },
  "gpt-3.5-turbo": { inputPer1M: 0.5, outputPer1M: 1.5 },
  "o1": { inputPer1M: 15, outputPer1M: 60 },
  "o1-mini": { inputPer1M: 3, outputPer1M: 12 },
  "o1-preview": { inputPer1M: 15, outputPer1M: 60 },
  "gemini-2.0-flash-exp": { inputPer1M: 0, outputPer1M: 0 },
  "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gemini-1.5-flash-8b": { inputPer1M: 0.075, outputPer1M: 0.3 },
  "gemini-1.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
  "gemini-1.5-pro": { inputPer1M: 1.25, outputPer1M: 5 },
  "gemini-2.5-pro-preview-06-05": { inputPer1M: 1.25, outputPer1M: 10 },
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10 },
  "gemini-2.5-flash-preview-05-20": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gemini-2.5-flash": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "minimax-m2.5": { inputPer1M: 0.8, outputPer1M: 8 },
  "minimax-m2.5-fast": { inputPer1M: 0.4, outputPer1M: 4 },
};

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = PRICING[model];
  if (!pricing) return null;

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
  return inputCost + outputCost;
}

export function getKnownModels(): string[] {
  return Object.keys(PRICING).sort();
}
