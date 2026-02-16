/**
 * Tool-specific proxy configuration.
 *
 * Each AI coding tool has its own way of accepting a base URL override.
 * This module maps tool names to the right environment variables and
 * determines whether mitmproxy is needed.
 */

/** Environment configuration for routing a tool through the proxy. */
export interface ToolEnv {
  /** Environment variables to set on the child process. */
  env: Record<string, string>;
  /**
   * Whether the tool needs mitmproxy as a TLS-terminating forward proxy.
   *
   * Some tools (Codex, Copilot, OpenCode) ignore base URL overrides but
   * respect HTTPS_PROXY. For those, mitmproxy terminates TLS and chains
   * traffic through the contextio proxy for redaction and logging.
   */
  needsMitm?: boolean;
}

/**
 * Build environment variables to route a tool through the proxy.
 *
 * Constructs a source-tagged URL (`http://127.0.0.1:4040/claude/ab12cd34`)
 * that the proxy uses to attribute captures to specific tools and sessions.
 *
 * @param command - Tool binary name (e.g. "claude", "codex", "gemini").
 * @param proxyUrl - The proxy base URL (e.g. "http://127.0.0.1:4040").
 * @param sessionId - Optional 8-char hex session ID for capture grouping.
 * @returns Env vars to set and whether mitmproxy is needed.
 */
export function getToolEnv(
  command: string,
  proxyUrl: string,
  sessionId?: string,
): ToolEnv {
  const sourceTag = sessionId ? `${command}/${sessionId}` : command;
  const sourceUrl = `${proxyUrl}/${sourceTag}`;

  // Tool-specific overrides
  switch (command) {
    case "claude":
      return {
        env: { ANTHROPIC_BASE_URL: sourceUrl },
      };

    case "aider":
      // Untested. Aider should respect both base URL vars but we
      // haven't verified which models/providers work end-to-end.
      return {
        env: {
          ANTHROPIC_BASE_URL: sourceUrl,
          OPENAI_BASE_URL: sourceUrl,
        },
      };

    case "gemini":
      return {
        env: {
          GOOGLE_GEMINI_BASE_URL: `${sourceUrl}/`,
          CODE_ASSIST_ENDPOINT: sourceUrl,
        },
      };

    case "codex":
      // Codex ignores OPENAI_BASE_URL but respects HTTPS_PROXY.
      // Route through mitmproxy in upstream mode, chained into the
      // contextio proxy for full redaction and logging support.
      return {
        env: {},
        needsMitm: true,
      };

    case "copilot":
      // Copilot CLI ignores OPENAI_BASE_URL but respects HTTPS_PROXY.
      // Route through mitmproxy in upstream mode, chained into the
      // contextio proxy for full redaction and logging support.
      return {
        env: {},
        needsMitm: true,
      };

    case "opencode":
      // OpenCode embeds multiple AI SDKs (OpenAI, Anthropic, OpenRouter).
      // Direct providers (Anthropic, OpenAI) respect *_BASE_URL, but
      // OpenRouter and others don't. Route through mitmproxy in upstream
      // mode so all traffic flows through the contextio proxy regardless
      // of provider.
      return {
        env: {},
        needsMitm: true,
      };

    // Default: set both Anthropic and OpenAI base URLs.
    // Most tools respect at least one of these.
    default:
      return {
        env: {
          ANTHROPIC_BASE_URL: sourceUrl,
          OPENAI_BASE_URL: sourceUrl,
        },
      };
  }
}
