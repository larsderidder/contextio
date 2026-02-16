/**
 * Tool-specific proxy configuration.
 *
 * Each AI tool has its own way of accepting a base URL override.
 * This module knows how to set the right env vars for each tool.
 */

export interface ToolEnv {
  /** Environment variables to set for the child process. */
  env: Record<string, string>;
  /**
   * Whether the tool needs mitmproxy as a TLS-terminating forward proxy
   * chained into the contextio proxy via upstream mode. This is for tools
   * that respect HTTPS_PROXY but ignore base URL overrides.
   */
  needsMitm?: boolean;
}

/**
 * Build environment variables to route a tool through the proxy.
 *
 * The proxy URL includes a source tag so captures can be attributed
 * to the originating tool (shows up as the "source" field in captures).
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
