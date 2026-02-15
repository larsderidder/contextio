/**
 * @contextio/proxy - Pluggable HTTP proxy for LLM APIs.
 *
 * Depends on @contextio/core for types, routing, and headers.
 * Zero other npm dependencies.
 */

// Main API
export { createProxy } from "./proxy.js";
export type { ProxyInstance } from "./proxy.js";

// Handler (for advanced use / custom servers)
export { createProxyHandler } from "./forward.js";
export type { ForwardOptions } from "./forward.js";

// Config
export { resolveConfig } from "./config.js";
export type { ResolvedProxyConfig } from "./config.js";
