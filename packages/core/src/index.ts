/**
 * @contextio/core - Shared types, routing, and header utilities.
 *
 * The contract layer for the @context ecosystem. Zero npm dependencies.
 * No HTTP server, no proxy handler. Just types and pure functions.
 */

// Routing utilities
export {
  classifyRequest,
  extractSource,
  resolveTargetUrl,
} from "./routing.js";

// Header utilities
export { SENSITIVE_HEADERS, selectHeaders } from "./headers.js";

// Model utilities
export {
  CONTEXT_LIMITS,
  MODEL_PRICING,
  estimateCost,
  getContextLimit,
  getKnownModels,
} from "./models.js";

// Token utilities
export { IMAGE_TOKEN_ESTIMATE, estimateTokens, countImageBlocks } from "./tokens.js";

// Response parsing
export {
  extractResponseId,
  parseResponseUsage,
  parseStreamingTokens,
  type ParsedResponseUsage,
} from "./response.js";

// Security scanning
export {
  scanSecurity,
  scanRequestMessages,
  type AlertSeverity,
  type SecurityAlert,
  type SecurityResult,
  type SecuritySummary,
} from "./security.js";

// Output security scanning
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

// Types
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
