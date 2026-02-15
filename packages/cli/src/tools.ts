/**
 * Tool-specific proxy configuration.
 *
 * Each AI tool has its own way of accepting a base URL override.
 * This module knows how to set the right env vars for each tool.
 */

export interface ToolEnv {
  /** Environment variables to set for the child process. */
  env: Record<string, string>;
  /** Whether the tool needs a forward HTTPS proxy (mitmproxy). */
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
      // Codex has its own built-in network proxy and sandboxed networking.
      // It ignores OPENAI_BASE_URL. Cannot be routed through contextio.
      console.error(
        "Warning: Codex has its own network proxy and cannot be routed through contextio.",
      );
      console.error(
        "Redaction and logging will not apply to Codex traffic.",
      );
      return { env: {} };

    case "copilot":
      // Copilot CLI respects HTTPS_PROXY (uses undici ProxyAgent) but
      // ignores OPENAI_BASE_URL. Route through mitmproxy for logging.
      // Redaction is not applied (traffic goes direct to API).
      return {
        env: {
          https_proxy: "http://127.0.0.1:8080",
          SSL_CERT_FILE: "",
        },
        needsMitm: true,
      };

    case "opencode":
      // OpenCode embeds multiple AI SDKs (OpenAI, Anthropic, OpenRouter).
      // Direct providers (Anthropic, OpenAI) respect *_BASE_URL, but
      // OpenRouter and others don't. Route through mitmproxy for
      // universal logging regardless of provider.
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
