/**
 * Compare bundled OpenAI model data and token estimates with a pinned gpt-tokenizer package.
 * This is an offline development check, not a runtime dependency or a data generator.
 *
 * pnpm build
 * npm install --prefix /tmp/contextio-tokenizer-check --no-save --ignore-scripts --package-lock=false gpt-tokenizer@4.0.0
 * node packages/core/scripts/check-model-data.mjs /tmp/contextio-tokenizer-check/node_modules/gpt-tokenizer
 *
 * Catalog provenance: https://github.com/niieani/gpt-tokenizer#model-information
 * Text encoding reference: https://github.com/openai/tiktoken
 * Samples exercise text only, not chat framing, tools, images, or provider usage.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CONTEXT_LIMITS, MODEL_PRICING } from "../dist/models.js";
import { estimateTokens } from "../dist/tokens.js";

const packageDirectory = process.argv[2];
if (!packageDirectory) {
  throw new Error("Pass the local gpt-tokenizer package directory. See usage in this script.");
}

const packagePath = resolve(packageDirectory);
const packageInfo = JSON.parse(await readFile(resolve(packagePath, "package.json"), "utf8"));
if (packageInfo.name !== "gpt-tokenizer" || packageInfo.version !== "4.0.0") {
  throw new Error("This check expects gpt-tokenizer@4.0.0 for reproducible comparisons.");
}

const catalog = await import(pathToFileURL(resolve(packagePath, "esm/models.js")).href);
const o200k = await import(pathToFileURL(resolve(packagePath, "esm/encoding/o200k_base.js")).href);
const cl100k = await import(pathToFileURL(resolve(packagePath, "esm/encoding/cl100k_base.js")).href);

const modelComparisons = [];
for (const [model, contextWindow] of Object.entries(CONTEXT_LIMITS)) {
  const metadata = catalog[model];
  if (!metadata) {
    continue;
  }

  const comparison = {
    model,
    bundled: { contextWindow, pricing: MODEL_PRICING[model] },
    catalog: {
      contextWindow: metadata.context_window,
      maxInputTokens: metadata.max_input_tokens,
      maxOutputTokens: metadata.max_output_tokens,
      pricing: metadata.price_data?.main,
    },
  };
  modelComparisons.push(comparison);
}

const samples = [
  { name: "English", text: "The proxy captures requests and responses without exposing API keys." },
  { name: "Dutch", text: "De proxy legt verzoeken en antwoorden vast zonder API-sleutels bloot te stellen." },
  { name: "Chinese", text: "代理记录请求和响应，不会暴露任何密钥。" },
  { name: "Japanese", text: "プロキシは秘密鍵を公開せずにリクエストとレスポンスを記録します。" },
  { name: "Emoji", text: "👨‍👩‍👧‍👦 🔐 🚀 ✅" },
  { name: "TypeScript", text: "export function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }" },
  { name: "JSON", text: JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "Hello!" }] }) },
  { name: "Repeated text", text: "a".repeat(100) },
];
const tokenComparisons = samples.map(({ name, text }) => ({
  name,
  text,
  utf16Units: text.length,
  utf8Bytes: Buffer.byteLength(text, "utf8"),
  bundledEstimate: estimateTokens(text),
  o200kTokens: o200k.encode(text).length,
  cl100kTokens: cl100k.encode(text).length,
}));

console.log(JSON.stringify({
  source: {
    package: packageInfo.name,
    version: packageInfo.version,
    catalog: "https://github.com/niieani/gpt-tokenizer/blob/fb04ebca53f662200e737caefe9a5ef372a5e41a/src/models.gen.ts",
    contextWindowMeaning: "Total context capacity, not the separate maximum input or output budget.",
    pricingCaveat: "Catalog pricing may disagree with provider documentation; do not import it without review.",
  },
  modelComparisons,
  tokenComparisons,
}, null, 2));
