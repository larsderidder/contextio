/**
 * High-level proxy API.
 *
 * Creates an HTTP server with the plugin pipeline wired up.
 * This is the main entry point for programmatic use.
 */

import http from "node:http";

import type { ProxyConfig, ProxyPlugin } from "@contextio/core";

import { resolveConfig } from "./config.js";
import { createProxyHandler } from "./forward.js";

export interface ProxyInstance {
  /** Start listening. Resolves when the server is ready. */
  start: () => Promise<void>;
  /** Stop the server. Resolves when all connections are closed. */
  stop: () => Promise<void>;
  /** The bound port (useful when port 0 is passed for auto-assignment). */
  port: number;
}

/**
 * Create a proxy instance.
 *
 * ```typescript
 * import { createProxy } from '@contextio/proxy';
 *
 * const proxy = createProxy({
 *   port: 4040,
 *   plugins: [myPlugin],
 * });
 * await proxy.start();
 * ```
 */
export function createProxy(
  config?: ProxyConfig & { logTraffic?: boolean },
): ProxyInstance {
  const resolved = resolveConfig(config);
  const plugins: ProxyPlugin[] = config?.plugins ?? [];

  const handler = createProxyHandler({
    upstreams: resolved.upstreams,
    allowTargetOverride: resolved.allowTargetOverride,
    plugins,
    logTraffic: !!config?.logTraffic,
  });

  const server = http.createServer(handler);
  let boundPort = resolved.port;
  let started = false;

  return {
    get port() {
      return boundPort;
    },

    start() {
      return new Promise<void>((resolve, reject) => {
        server.once("error", (err: NodeJS.ErrnoException) => {
          reject(err);
        });

        server.listen(resolved.port, resolved.bindHost, () => {
          started = true;
          const addr = server.address();
          if (addr && typeof addr === "object") {
            boundPort = addr.port;
          }
          console.log(
            `@contextio/proxy running on http://${resolved.bindHost}:${boundPort}`,
          );
          resolve();
        });
      });
    },

    stop() {
      if (!started) return Promise.resolve();
      return new Promise<void>((resolve) => {
        // Force resolve after a short grace period. server.close() waits
        // for active connections to drain, which may never happen with
        // long-lived streaming or SSE connections.
        const forceTimer = setTimeout(() => resolve(), 500);
        server.close(() => {
          clearTimeout(forceTimer);
          resolve();
        });
      });
    },
  };
}
