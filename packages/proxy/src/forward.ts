/**
 * HTTP forwarding logic: the core of the proxy.
 *
 * Request lifecycle:
 * 1. Buffer incoming request body, decompress if needed
 * 2. Parse JSON, build RequestContext
 * 3. Run onRequest plugin pipeline (redaction happens here)
 * 4. Forward to upstream LLM API
 * 5. For streaming: pipe SSE chunks through onStreamChunk plugins to client
 *    For non-streaming: buffer response, run onResponse plugins, send to client
 * 6. Build CaptureData, fire onCapture plugins (logging happens here)
 *
 * Non-POST requests (GET /v1/models, OPTIONS) are passed through without
 * plugin processing or capture.
 *
 * Zero external dependencies beyond @contextio/core.
 */

import http from "node:http";
import https from "node:https";
import url from "node:url";
import zlib from "node:zlib";

import {
  classifyRequest,
  extractSource,
  resolveTargetUrl,
  selectHeaders,
} from "@contextio/core";
import type {
  CaptureData,
  ProxyPlugin,
  RequestContext,
  ResponseContext,
  Upstreams,
} from "@contextio/core";

export interface ForwardOptions {
  upstreams: Upstreams;
  allowTargetOverride: boolean;
  plugins: ProxyPlugin[];
  logTraffic: boolean;
}

// --- Plugin pipeline helpers ---

/**
 * Run onRequest hooks as a pipeline: each plugin receives the output of
 * the previous one. If a plugin throws, the error is logged and the
 * pipeline continues with the last successful context (fail-open).
 */
async function runRequestPlugins(
  plugins: ProxyPlugin[],
  ctx: RequestContext,
): Promise<RequestContext> {
  let current = ctx;
  for (const plugin of plugins) {
    if (!plugin.onRequest) continue;
    try {
      current = await plugin.onRequest(current);
    } catch (err: unknown) {
      console.error(
        `Plugin "${plugin.name}" onRequest error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return current;
}

/** Run onResponse hooks as a pipeline (same fail-open semantics as onRequest). */
async function runResponsePlugins(
  plugins: ProxyPlugin[],
  ctx: ResponseContext,
): Promise<ResponseContext> {
  let current = ctx;
  for (const plugin of plugins) {
    if (!plugin.onResponse) continue;
    try {
      current = await plugin.onResponse(current);
    } catch (err: unknown) {
      console.error(
        `Plugin "${plugin.name}" onResponse error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return current;
}

/** Fire all onCapture hooks. Errors are logged but never block the response. */
function runCapturePlugins(
  plugins: ProxyPlugin[],
  capture: CaptureData,
): void {
  for (const plugin of plugins) {
    if (!plugin.onCapture) continue;
    try {
      const result = plugin.onCapture(capture);
      // If the hook returns a promise, catch rejections
      if (result && typeof result.catch === "function") {
        result.catch((err: unknown) => {
          console.error(
            `Plugin "${plugin.name}" onCapture async error:`,
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    } catch (err: unknown) {
      console.error(
        `Plugin "${plugin.name}" onCapture error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// --- Header / lifecycle helpers ---

/**
 * Build headers for the upstream request.
 *
 * Strips proxy-internal headers (x-target-url, host) and removes
 * accept-encoding so upstreams return uncompressed responses. The proxy
 * needs to read and potentially modify response bodies as text;
 * compression between localhost and client is pointless anyway.
 */
function buildForwardHeaders(
  reqHeaders: Record<string, any>,
  targetHost: string | null,
  bodyLength?: number,
): Record<string, any> {
  const forwardHeaders = { ...reqHeaders };
  delete forwardHeaders["x-target-url"];
  delete forwardHeaders.host;
  delete forwardHeaders["accept-encoding"];
  if (targetHost) {
    forwardHeaders.host = targetHost;
  }
  if (bodyLength != null) {
    delete forwardHeaders["transfer-encoding"];
    forwardHeaders["content-length"] = bodyLength;
  }
  return forwardHeaders;
}

/**
 * Wire up error and close handlers between client and upstream.
 *
 * If the client disconnects, destroy the upstream request. If the
 * upstream errors, send a 502 to the client.
 */
function attachLifecycleHandlers(
  res: http.ServerResponse,
  proxyReq: http.ClientRequest,
): void {
  res.on("close", () => {
    if (!proxyReq.destroyed) proxyReq.destroy();
  });

  proxyReq.on("error", (err) => {
    if (res.destroyed) return;
    const detail = err.message || ("code" in err ? err.code : "unknown");
    console.error("Proxy error:", detail);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    if (!res.destroyed) {
      res.end(JSON.stringify({ error: "Proxy error", details: err.message }));
    }
  });
}

/**
 * Prepare headers for route resolution.
 *
 * The `x-target-url` header lets mitmproxy specify the original
 * destination, but is only trusted from local connections when
 * `allowTargetOverride` is enabled.
 */
function headersForResolution(
  headers: http.IncomingHttpHeaders,
  remoteAddr: string | undefined,
  allowTargetOverride: boolean,
): Record<string, string | undefined> {
  const h = headers as Record<string, string | undefined>;
  if (
    h["x-target-url"] &&
    !(allowTargetOverride && isLocalRemote(remoteAddr))
  ) {
    const { "x-target-url": _drop, ...rest } = h;
    return rest;
  }
  return h;
}

function isLocalRemote(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
  );
}

// --- Passthrough for non-POST ---

/**
 * Forward a non-POST request (GET /v1/models, OPTIONS, etc.) directly
 * to the upstream. No plugin processing, no capture.
 */
function forwardPassthrough(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
  body: Buffer | null,
): void {
  const targetParsed = url.parse(targetUrl);
  const forwardHeaders = buildForwardHeaders(
    req.headers as Record<string, any>,
    targetParsed.host,
    body ? body.length : undefined,
  );

  const protocol = targetParsed.protocol === "https:" ? https : http;
  const proxyReq = protocol.request(
    {
      hostname: targetParsed.hostname,
      port: targetParsed.port,
      path: targetParsed.path,
      method: req.method,
      headers: forwardHeaders,
    },
    (proxyRes) => {
      if (!res.headersSent)
        res.writeHead(proxyRes.statusCode!, proxyRes.headers);
      proxyRes.pipe(res);
      proxyRes.on("error", (err) => {
        console.error("Upstream response error (forward):", err.message);
        if (!res.destroyed) res.end();
      });
    },
  );

  attachLifecycleHandlers(res, proxyReq);
  if (body) proxyReq.write(body);
  proxyReq.end();
}

// --- Main handler ---

/**
 * Create the main `(req, res)` handler for the proxy HTTP server.
 *
 * Pre-computes which plugin hook types are present to skip unnecessary
 * work on the hot path. The returned function is compatible with
 * `http.createServer()`.
 */
export function createProxyHandler(
  opts: ForwardOptions,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const plugins = opts.plugins;
  const hasRequestPlugins = plugins.some((p) => p.onRequest);
  const hasResponsePlugins = plugins.some((p) => p.onResponse);
  const hasStreamPlugins = plugins.some((p) => p.onStreamChunk);
  const hasCapturePlugins = plugins.some((p) => p.onCapture);

  return function handleProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const parsedUrl = url.parse(req.url!);
    const { source, sessionId, cleanPath } = extractSource(parsedUrl.pathname!);
    const search = parsedUrl.search || null;

    const routingHeaders = headersForResolution(
      req.headers,
      req.socket.remoteAddress,
      opts.allowTargetOverride,
    );
    const { targetUrl, provider } = resolveTargetUrl(
      cleanPath,
      search,
      routingHeaders,
      opts.upstreams,
    );
    const { apiFormat } = classifyRequest(cleanPath, routingHeaders);

    if (opts.logTraffic) {
      const hasAuth = !!req.headers.authorization;
      const sourceTag = source ? `[${source}]` : "";
      console.log(
        `${req.method} ${req.url} → ${targetUrl} [${provider}] ${sourceTag} auth=${hasAuth}`,
      );
    }

    // Non-POST requests: pass through without plugins or capturing
    if (req.method !== "POST") {
      forwardPassthrough(req, res, targetUrl, null);
      return;
    }

    // Buffer the request body
    const chunks: Buffer[] = [];
    let clientAborted = false;
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("error", () => {
      clientAborted = true;
    });

    req.on("end", () => {
      if (clientAborted) return;

      const bodyBuffer = Buffer.concat(chunks);
      const contentEncoding = (
        req.headers["content-encoding"] || ""
      ).toLowerCase();

      // Decompress the body so plugins can inspect/modify it as text.
      // The original compressed buffer is kept; if no plugin modifies
      // the body, we forward the original bytes to avoid re-compression.
      let decompressed: Buffer;
      try {
        if (contentEncoding === "zstd") {
          decompressed = zlib.zstdDecompressSync(bodyBuffer);
        } else if (contentEncoding === "br") {
          decompressed = zlib.brotliDecompressSync(bodyBuffer);
        } else if (contentEncoding === "gzip" || contentEncoding === "deflate") {
          decompressed = zlib.unzipSync(bodyBuffer);
        } else {
          decompressed = bodyBuffer;
        }
      } catch {
        // Decompression failed; use raw bytes
        decompressed = bodyBuffer;
      }

      const bodyText = decompressed.toString("utf8");

      // Try to parse as JSON, but forward regardless
      let bodyJson: Record<string, any> | null = null;
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        // Not JSON; forward as raw bytes
      }

      // Build the request context for plugins
      const reqCtx: RequestContext = {
        provider,
        apiFormat,
        path: cleanPath,
        source,
        sessionId,
        headers: { ...req.headers } as Record<string, any>,
        body: bodyJson,
        rawBody: bodyBuffer,
      };

      // Run the async plugin pipeline, then forward
      const doForward = (ctx: RequestContext): void => {
        // If a plugin modified the body, re-serialize as plain JSON.
        // Otherwise forward original bytes (possibly still compressed).
        let forwardBuffer: Buffer;
        let bodyWasModified = false;
        if (ctx.body && ctx.body !== bodyJson) {
          forwardBuffer = Buffer.from(JSON.stringify(ctx.body), "utf8");
          bodyWasModified = true;
        } else {
          forwardBuffer = bodyBuffer;
        }

        // Strip content-encoding when we re-serialized; the new body
        // is plain JSON, not compressed.
        if (bodyWasModified && contentEncoding) {
          delete ctx.headers["content-encoding"];
        }

        const targetParsed = url.parse(targetUrl);
        const forwardHeaders = buildForwardHeaders(
          ctx.headers,
          targetParsed.host,
          forwardBuffer.length,
        );

        const protocol =
          targetParsed.protocol === "https:" ? https : http;
        const startTime = performance.now();
        let firstByteTime = 0;
        let requestSentTime = 0;
        const reqBytes = forwardBuffer.length;

        const proxyReq = protocol.request(
          {
            hostname: targetParsed.hostname,
            port: targetParsed.port,
            path: targetParsed.path,
            method: req.method,
            headers: forwardHeaders,
          },
          (proxyRes) => {
            if (opts.logTraffic) {
              console.log(
                `  ← ${proxyRes.statusCode} ${proxyRes.statusMessage}`,
              );
            }

            const isStreaming =
              proxyRes.headers["content-type"]?.includes(
                "text/event-stream",
              );
            let respBytes = 0;
            const respChunks: Buffer[] = [];

            // For non-streaming with response plugins, we need to buffer
            // the full response before sending to the client.
            const shouldBufferResponse =
              hasResponsePlugins && !isStreaming;

            if (!shouldBufferResponse) {
              // Stream directly to client
              res.writeHead(proxyRes.statusCode!, proxyRes.headers);
            }

            proxyRes.on("data", (chunk: Buffer) => {
              if (!firstByteTime) firstByteTime = performance.now();
              respBytes += chunk.length;
              respChunks.push(chunk);
              if (!shouldBufferResponse && !res.destroyed) {
                let out = chunk;
                if (hasStreamPlugins && isStreaming) {
                  for (const plugin of plugins) {
                    if (!plugin.onStreamChunk) continue;
                    try {
                      out = plugin.onStreamChunk(out, sessionId);
                    } catch (err: unknown) {
                      console.error(
                        `Plugin "${plugin.name}" onStreamChunk error:`,
                        err instanceof Error ? err.message : String(err),
                      );
                    }
                  }
                }
                res.write(out);
              }
            });

            proxyRes.on("end", () => {
              const endTime = performance.now();
              if (!firstByteTime) firstByteTime = endTime;

              // Flush any buffered data from stream plugins
              if (hasStreamPlugins && isStreaming && !res.destroyed) {
                for (const plugin of plugins) {
                  if (!plugin.onStreamEnd) continue;
                  try {
                    const flushed = plugin.onStreamEnd(sessionId);
                    if (flushed && flushed.length > 0) {
                      res.write(flushed);
                    }
                  } catch (err: unknown) {
                    console.error(
                      `Plugin "${plugin.name}" onStreamEnd error:`,
                      err instanceof Error ? err.message : String(err),
                    );
                  }
                }
              }

              const respBody =
                Buffer.concat(respChunks).toString("utf8");

              // Run response plugins for non-streaming responses
              const finishResponse = (
                finalBody: string,
                finalHeaders: Record<string, any>,
                finalStatus: number,
              ): void => {
                if (shouldBufferResponse && !res.headersSent) {
                  const outBuf = Buffer.from(finalBody, "utf8");
                  const outHeaders = { ...finalHeaders };
                  outHeaders["content-length"] = String(outBuf.length);
                  delete outHeaders["transfer-encoding"];
                  res.writeHead(finalStatus, outHeaders);
                  res.end(outBuf);
                } else if (!res.destroyed) {
                  res.end();
                }

                // Build capture and run capture plugins
                if (hasCapturePlugins) {
                  const capture: CaptureData = {
                    timestamp: new Date().toISOString(),
                    sessionId,
                    method: req.method!,
                    path: cleanPath,
                    source,
                    provider,
                    apiFormat,
                    targetUrl,
                    requestHeaders: selectHeaders(ctx.headers),
                    requestBody: ctx.body,
                    requestBytes: reqBytes,
                    responseStatus: proxyRes.statusCode || 0,
                    responseHeaders: selectHeaders(
                      proxyRes.headers as Record<string, any>,
                    ),
                    responseBody: finalBody,
                    responseIsStreaming: !!isStreaming,
                    responseBytes: respBytes,
                    timings: {
                      send_ms: Math.round(
                        Math.max(
                          0,
                          (requestSentTime || firstByteTime) -
                            startTime,
                        ),
                      ),
                      wait_ms: Math.round(
                        Math.max(
                          0,
                          firstByteTime -
                            (requestSentTime || startTime),
                        ),
                      ),
                      receive_ms: Math.round(
                        endTime - firstByteTime,
                      ),
                      total_ms: Math.round(endTime - startTime),
                    },
                  };

                  runCapturePlugins(plugins, capture);
                }
              };

              if (shouldBufferResponse) {
                const respCtx: ResponseContext = {
                  status: proxyRes.statusCode || 0,
                  headers: {
                    ...((proxyRes.headers as Record<string, any>) || {}),
                  },
                  body: respBody,
                  isStreaming: false,
                  sessionId,
                };
                runResponsePlugins(plugins, respCtx)
                  .then((finalCtx) => {
                    finishResponse(
                      finalCtx.body,
                      finalCtx.headers,
                      finalCtx.status,
                    );
                  })
                  .catch((err: unknown) => {
                    console.error(
                      "Response plugin pipeline error:",
                      err instanceof Error
                        ? err.message
                        : String(err),
                    );
                    finishResponse(
                      respBody,
                      proxyRes.headers as Record<string, any>,
                      proxyRes.statusCode || 0,
                    );
                  });
              } else {
                finishResponse(
                  respBody,
                  proxyRes.headers as Record<string, any>,
                  proxyRes.statusCode || 0,
                );
              }
            });

            proxyRes.on("error", (err) => {
              console.error(
                "Upstream response error:",
                err.message,
              );
              if (!res.destroyed) res.end();
            });
          },
        );

        attachLifecycleHandlers(res, proxyReq);
        proxyReq.on("finish", () => {
          requestSentTime = performance.now();
        });
        proxyReq.write(forwardBuffer);
        proxyReq.end();
      };

      // Run request plugins, then forward
      if (hasRequestPlugins) {
        runRequestPlugins(plugins, reqCtx)
          .then(doForward)
          .catch((err: unknown) => {
            console.error(
              "Request plugin pipeline error:",
              err instanceof Error ? err.message : String(err),
            );
            // Forward the original request on pipeline failure
            doForward(reqCtx);
          });
      } else {
        doForward(reqCtx);
      }
    });
  };
}
