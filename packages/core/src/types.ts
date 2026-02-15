/**
 * Core types for the @context proxy.
 *
 * These are the public types that plugins and consumers depend on.
 * Zero external dependencies.
 */

// --- Provider / API format ---

export type Provider =
  | "anthropic"
  | "openai"
  | "chatgpt"
  | "gemini"
  | "unknown";

export type ApiFormat =
  | "anthropic-messages"
  | "chatgpt-backend"
  | "responses"
  | "chat-completions"
  | "gemini"
  | "raw"
  | "unknown";

// --- Upstream targets ---

export interface Upstreams {
  openai: string;
  anthropic: string;
  chatgpt: string;
  gemini: string;
  geminiCodeAssist: string;
}

// --- Capture data (the full request/response record) ---

export interface CaptureData {
  timestamp: string;
  sessionId: string | null;
  method: string;
  path: string;
  source: string | null;
  provider: string;
  apiFormat: string;
  targetUrl: string;
  requestHeaders: Record<string, string>;
  requestBody: Record<string, any> | null;
  requestBytes: number;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  responseIsStreaming: boolean;
  responseBytes: number;
  timings: {
    send_ms: number;
    wait_ms: number;
    receive_ms: number;
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
  headers: Record<string, any>;
  body: Record<string, any> | null;
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
  headers: Record<string, string>;
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
