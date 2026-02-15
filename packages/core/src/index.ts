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
