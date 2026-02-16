/**
 * Proxy configuration resolution.
 *
 * Merges programmatic overrides with environment variables and applies
 * safe defaults. All upstream URLs, bind address, port, and feature
 * flags are resolved here before the proxy starts.
 */

import type { ProxyConfig, Upstreams } from "@contextio/core";

/**
 * Fully resolved config with all defaults applied.
 */
export interface ResolvedProxyConfig {
  upstreams: Upstreams;
  bindHost: string;
  port: number;
  allowTargetOverride: boolean;
}

/**
 * Resolve final proxy config from environment variables and overrides.
 *
 * Priority: programmatic overrides > environment variables > defaults.
 *
 * Environment variables:
 * - `UPSTREAM_OPENAI_URL`, `UPSTREAM_ANTHROPIC_URL`, etc. for upstream URLs
 * - `CONTEXT_PROXY_BIND_HOST` for bind address (default: "127.0.0.1")
 * - `CONTEXT_PROXY_PORT` for port (default: 4040)
 * - `CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE=1` to allow x-target-url header
 */
export function resolveConfig(
  overrides?: ProxyConfig,
): ResolvedProxyConfig {
  const defaultUpstreams: Upstreams = {
    openai: process.env.UPSTREAM_OPENAI_URL || "https://api.openai.com/v1",
    anthropic:
      process.env.UPSTREAM_ANTHROPIC_URL || "https://api.anthropic.com",
    chatgpt: process.env.UPSTREAM_CHATGPT_URL || "https://chatgpt.com",
    gemini:
      process.env.UPSTREAM_GEMINI_URL ||
      "https://generativelanguage.googleapis.com",
    geminiCodeAssist:
      process.env.UPSTREAM_GEMINI_CODE_ASSIST_URL ||
      "https://cloudcode-pa.googleapis.com",
  };

  const bindHost =
    overrides?.bindHost ||
    process.env.CONTEXT_PROXY_BIND_HOST ||
    "127.0.0.1";

  const port =
    overrides?.port ??
    parseInt(process.env.CONTEXT_PROXY_PORT || "4040", 10);

  const allowTargetOverride =
    overrides?.allowTargetOverride ??
    process.env.CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE === "1";

  const upstreams: Upstreams = {
    ...defaultUpstreams,
    ...overrides?.upstreams,
  };

  return {
    upstreams,
    bindHost,
    port,
    allowTargetOverride,
  };
}
