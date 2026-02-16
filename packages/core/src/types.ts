/**
 * Core types for the contextio proxy ecosystem.
 *
 * These are the public types that plugins and consumers depend on.
 * Zero external dependencies.
 */

// --- Provider / API format ---

/**
 * LLM API provider identifier.
 *
 * "chatgpt" is separate from "openai" because ChatGPT's backend API
 * (used by Codex subscriptions) has a different format from the
 * OpenAI platform API.
 */
export type Provider =
  | "anthropic"
  | "openai"
  | "chatgpt"
  | "gemini"
  | "unknown";

/**
 * Wire format of the API request.
 *
 * Used to determine how to parse request/response bodies for token
 * usage, streaming events, and content extraction.
 */
export type ApiFormat =
  | "anthropic-messages"
  | "chatgpt-backend"
  | "responses"
  | "chat-completions"
  | "gemini"
  | "raw"
  | "unknown";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type HeaderMap = Record<string, string | string[] | undefined>;

// --- Upstream targets ---

/**
 * Base URLs for each provider's API.
 *
 * The proxy prepends these to the request path when forwarding.
 * Configurable via environment variables or the ProxyConfig.
 */
export interface Upstreams {
  openai: string;
  anthropic: string;
  chatgpt: string;
  gemini: string;
  geminiCodeAssist: string;
}

// --- Capture data (the full request/response record) ---

/**
 * A complete request/response pair captured by the proxy.
 *
 * Written to disk as JSON by the logger plugin. Contains everything
 * needed to inspect, replay, or analyze an API call.
 */
export interface CaptureData {
  /** ISO-8601 timestamp when the request was received. */
  timestamp: string;
  /** Session ID from the URL path, or null if not tagged. */
  sessionId: string | null;
  /** HTTP method (always "POST" for LLM API calls). */
  method: string;
  /** Cleaned URL path (source tag stripped). */
  path: string;
  /** Source tool name extracted from the URL path (e.g. "claude", "gemini"). */
  source: string | null;
  /** Detected LLM provider. */
  provider: string;
  /** Detected API wire format. */
  apiFormat: string;
  /** The upstream URL the request was forwarded to. */
  targetUrl: string;
  /** Request headers with sensitive values (auth, API keys) stripped. */
  requestHeaders: Record<string, string>;
  /** Parsed JSON request body, or null if non-JSON. */
  requestBody: JsonValue | null;
  /** Size of the raw request body in bytes. */
  requestBytes: number;
  /** HTTP status code from the upstream. */
  responseStatus: number;
  /** Response headers with sensitive values stripped. */
  responseHeaders: Record<string, string>;
  /** Raw response body (SSE text for streaming, JSON string for non-streaming). */
  responseBody: string;
  /** Whether the upstream returned a streaming (SSE) response. */
  responseIsStreaming: boolean;
  /** Size of the raw response body in bytes. */
  responseBytes: number;
  /** Timing breakdown for the request lifecycle. */
  timings: {
    /** Time from receiving the request to finishing the upstream send. */
    send_ms: number;
    /** Time from send complete to first response byte (TTFB). */
    wait_ms: number;
    /** Time from first byte to last byte of the response. */
    receive_ms: number;
    /** Total wall-clock time. */
    total_ms: number;
  };
}

// --- Plugin system ---

/**
 * Context passed to onRequest hooks.
 *
 * Plugins can modify `headers` and `body` to transform the request
 * before it is forwarded to the upstream provider.
 */
export interface RequestContext {
  provider: Provider | string;
  apiFormat: ApiFormat | string;
  path: string;
  source: string | null;
  sessionId: string | null;
  headers: HeaderMap;
  body: JsonValue | null;
  rawBody: Buffer;
}

/**
 * Context passed to onResponse hooks.
 *
 * Plugins can modify `body` to transform the response before it is
 * sent back to the client. Only available for non-streaming responses.
 */
export interface ResponseContext {
  status: number;
  headers: HeaderMap;
  body: string;
  isStreaming: boolean;
  sessionId: string | null;
}

/**
 * A proxy plugin.
 *
 * Plugins run in array order. Request hooks form a pipeline: each
 * receives the output of the previous one. Capture hooks are
 * fire-and-forget; errors are logged but do not affect the client.
 */
export interface ProxyPlugin {
  name: string;

  /**
   * Transform the request before forwarding to the upstream provider.
   * Return the (possibly modified) context. Runs in pipeline order.
   */
  onRequest?: (ctx: RequestContext) => RequestContext | Promise<RequestContext>;

  /**
   * Transform the response before sending back to the client.
   * Only called for non-streaming responses.
   */
  onResponse?: (
    ctx: ResponseContext,
  ) => ResponseContext | Promise<ResponseContext>;

  /**
   * Transform a streaming (SSE) response chunk before sending to the client.
   * Called for each data chunk. Return the (possibly modified) chunk.
   * Plugins that need to handle split tokens should buffer internally.
   */
  onStreamChunk?: (chunk: Buffer, sessionId: string | null) => Buffer;

  /**
   * Called when a streaming response ends. Plugins can flush any
   * buffered data. Return null if nothing to flush.
   */
  onStreamEnd?: (sessionId: string | null) => Buffer | null;

  /**
   * Observe the completed request/response capture.
   * Fire-and-forget. Errors are logged but do not block the response.
   */
  onCapture?: (capture: CaptureData) => void | Promise<void>;
}

// --- Proxy config ---

export interface ProxyConfig {
  port?: number;
  bindHost?: string;
  upstreams?: Partial<Upstreams>;
  allowTargetOverride?: boolean;
  plugins?: ProxyPlugin[];
}

// --- Routing helpers (re-exported from routing.ts) ---

export interface ExtractSourceResult {
  source: string | null;
  sessionId: string | null;
  cleanPath: string;
}

export interface ResolveTargetResult {
  targetUrl: string;
  provider: Provider;
}
