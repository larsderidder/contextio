/**
 * Request routing for the proxy.
 *
 * Three responsibilities:
 * 1. Classify requests by provider and API format (path/header heuristics)
 * 2. Extract source tool tags and session IDs from URL path prefixes
 * 3. Resolve the upstream URL to forward the request to
 *
 * Zero external dependencies.
 */

import type {
  ApiFormat,
  ExtractSourceResult,
  Provider,
  ResolveTargetResult,
  Upstreams,
} from "./types.js";

/**
 * URL path segments that belong to known API routes, not source tool prefixes.
 *
 * When the proxy sees `/v1/messages`, "v1" should be treated as an API
 * version prefix, not as a source tool tag. This set prevents
 * `extractSource()` from misidentifying API path segments as tools.
 */
const API_PATH_SEGMENTS = new Set([
  "v1",
  "v1beta",
  "v1alpha",
  "v1internal",
  "responses",
  "chat",
  "models",
  "embeddings",
  "backend-api",
  "api",
]);

/**
 * Classify an incoming request by provider and API format.
 *
 * Uses URL path patterns and header checks. All detection heuristics
 * live here so routing and format detection stay in sync.
 *
 * Order matters: ChatGPT backend is checked first (it uses /api/ paths
 * that could collide), then Anthropic, Gemini (before OpenAI because
 * both use /models/), and finally OpenAI as the catch-all.
 */
export function classifyRequest(
  pathname: string,
  headers: Record<string, string | undefined>,
): { provider: Provider; apiFormat: ApiFormat } {
  // ChatGPT backend (Codex subscription uses /api/ and /backend-api/ paths)
  if (pathname.match(/^\/(api|backend-api)\//))
    return { provider: "chatgpt", apiFormat: "chatgpt-backend" };

  // Anthropic Messages API
  if (pathname.includes("/v1/messages"))
    return { provider: "anthropic", apiFormat: "anthropic-messages" };
  if (pathname.includes("/v1/complete"))
    return { provider: "anthropic", apiFormat: "unknown" };
  if (headers["anthropic-version"])
    return { provider: "anthropic", apiFormat: "unknown" };

  // Gemini (checked before OpenAI because both use /models/ paths)
  const isGeminiPath =
    pathname.includes(":generateContent") ||
    pathname.includes(":streamGenerateContent") ||
    pathname.match(/\/v1(beta|alpha)\/models\//) ||
    pathname.includes("/v1internal:");
  if (isGeminiPath || headers["x-goog-api-key"])
    return { provider: "gemini", apiFormat: "gemini" };

  // OpenAI platform API (catch-all for Bearer sk- tokens)
  if (pathname.includes("/responses"))
    return { provider: "openai", apiFormat: "responses" };
  if (pathname.includes("/chat/completions"))
    return { provider: "openai", apiFormat: "chat-completions" };
  if (pathname.match(/\/(models|embeddings)/))
    return { provider: "openai", apiFormat: "unknown" };
  if (headers.authorization?.startsWith("Bearer sk-"))
    return { provider: "openai", apiFormat: "unknown" };

  return { provider: "unknown", apiFormat: "unknown" };
}

/** Check if a string looks like a session ID (8 lowercase hex chars). */
function isSessionId(segment: string): boolean {
  return /^[a-f0-9]{8}$/.test(segment);
}

/**
 * Extract a source tool tag and optional session ID from a request path.
 *
 * The CLI prepends a source tag (and optionally a session ID) to the URL
 * path so the proxy can attribute traffic to specific tools:
 *
 *   `/claude/v1/messages`          -> source="claude", sessionId=null, cleanPath="/v1/messages"
 *   `/claude/ab12cd34/v1/messages` -> source="claude", sessionId="ab12cd34", cleanPath="/v1/messages"
 *   `/v1/messages`                 -> source=null (no tag; path starts with a known API segment)
 *
 * Path traversal attempts (encoded slashes, ".." segments) are rejected.
 */
export function extractSource(pathname: string): ExtractSourceResult {
  const match = pathname.match(/^\/([^/]+)(\/.*)?$/);
  if (match?.[2] && !API_PATH_SEGMENTS.has(match[1])) {
    let decoded = match[1];
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      decoded = match[1];
    }
    if (
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("..")
    ) {
      return { source: null, sessionId: null, cleanPath: pathname };
    }

    // Check for session ID as the next segment: /source/sessionId/rest...
    const rest = match[2] || "/";
    const sessionMatch = rest.match(/^\/([^/]+)(\/.*)?$/);
    if (sessionMatch?.[2] && isSessionId(sessionMatch[1])) {
      return {
        source: decoded,
        sessionId: sessionMatch[1],
        cleanPath: sessionMatch[2] || "/",
      };
    }

    return { source: decoded, sessionId: null, cleanPath: rest };
  }
  return { source: null, sessionId: null, cleanPath: pathname };
}

/**
 * Determine the upstream URL to forward a request to.
 *
 * Checks for an explicit `x-target-url` header first (used by
 * mitmproxy addon to specify the original destination). Falls back
 * to the configured upstream base URL for the detected provider.
 *
 * @param pathname - Cleaned request path (source tag already stripped).
 * @param search - Query string including "?", or null.
 * @param headers - Request headers (may contain x-target-url).
 * @param upstreams - Configured upstream base URLs per provider.
 */
export function resolveTargetUrl(
  pathname: string,
  search: string | null,
  headers: Record<string, string | undefined>,
  upstreams: Upstreams,
): ResolveTargetResult {
  const provider = classifyRequest(pathname, headers).provider;
  const qs = search || "";
  let targetUrl = headers["x-target-url"];
  if (!targetUrl) {
    if (provider === "chatgpt") {
      targetUrl = upstreams.chatgpt + pathname + qs;
    } else if (provider === "anthropic") {
      targetUrl = upstreams.anthropic + pathname + qs;
    } else if (provider === "gemini") {
      const isCodeAssist = pathname.includes("/v1internal");
      targetUrl =
        (isCodeAssist ? upstreams.geminiCodeAssist : upstreams.gemini) +
        pathname +
        qs;
    } else {
      targetUrl = upstreams.openai + pathname + qs;
    }
  } else if (!targetUrl.startsWith("http")) {
    targetUrl = targetUrl + pathname + qs;
  }
  return { targetUrl, provider };
}
