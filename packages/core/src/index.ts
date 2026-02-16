/**
 * @contextio/core
 *
 * Shared types, routing, and utility functions for the contextio ecosystem.
 * This is the contract layer: every other `@contextio/*` package depends on it.
 *
 * Zero npm dependencies. No HTTP server, no proxy handler. Just types and
 * pure functions.
 *
 * @packageDocumentation
 */

// Routing: provider detection, source extraction, upstream URL resolution
export {
  classifyRequest,
  extractSource,
  resolveTargetUrl,
} from "./routing.js";

// Header filtering: strip auth/secret headers before persisting captures
export { SENSITIVE_HEADERS, selectHeaders } from "./headers.js";

// Model metadata: pricing, context limits, known model list
export {
  CONTEXT_LIMITS,
  MODEL_PRICING,
  estimateCost,
  getContextLimit,
  getKnownModels,
} from "./models.js";

// Token estimation: cheap char-based approximation with image awareness
export { IMAGE_TOKEN_ESTIMATE, estimateTokens, countImageBlocks } from "./tokens.js";

// Response parsing: extract usage/tokens from streaming and non-streaming responses
export {
  extractResponseId,
  parseResponseUsage,
  parseStreamingTokens,
  type ParsedResponseUsage,
} from "./response.js";

// Input security: prompt injection and suspicious pattern detection
export {
  scanSecurity,
  scanRequestMessages,
  type AlertSeverity,
  type SecurityAlert,
  type SecurityResult,
  type SecuritySummary,
} from "./security.js";

// Output security: jailbreak outputs, dangerous code, URL scanning
export {
  OUTPUT_BAN_SUBSTRINGS,
  scanBanSubstrings,
  scanRegex,
  extractUrls,
  scanUrls,
  scanDangerousCode,
  scanOutput,
  type OutputAlert,
  type OutputScanResult,
} from "./output-scanner.js";

// Core types used across all packages
export type {
  ApiFormat,
  CaptureData,
  ExtractSourceResult,
  Provider,
  ProxyConfig,
  ProxyPlugin,
  RequestContext,
  ResolveTargetResult,
  ResponseContext,
  Upstreams,
} from "./types.js";
