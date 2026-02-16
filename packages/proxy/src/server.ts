#!/usr/bin/env node

/**
 * Standalone entry point for `@contextio/proxy`.
 *
 * Starts the proxy server and dynamically loads plugins from the
 * `CONTEXT_PROXY_PLUGINS` environment variable (comma-separated module
 * specifiers). Each module must export a ProxyPlugin or a factory
 * function that returns one.
 *
 * This file is the `context-proxy` binary defined in package.json.
 *
 * ZERO DEPENDENCY CONSTRAINT: this file and everything it imports must
 * use only Node.js built-ins and @contextio/core. API keys flow through
 * this code; keeping it small means the entire proxy is auditable by
 * reading two packages.
 */

import type { ProxyPlugin } from "@contextio/core";

import { createProxy } from "./proxy.js";

/**
 * Dynamically load plugins from the CONTEXT_PROXY_PLUGINS env var.
 *
 * Accepts comma-separated module specifiers (npm packages or file paths).
 * Each module can export either:
 * - A factory function (called with no args, must return a ProxyPlugin)
 * - A ProxyPlugin object directly
 */
async function loadPluginsFromEnv(): Promise<ProxyPlugin[]> {
  const pluginsEnv = process.env.CONTEXT_PROXY_PLUGINS;
  if (!pluginsEnv) return [];

  const specifiers = pluginsEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const plugins: ProxyPlugin[] = [];
  for (const specifier of specifiers) {
    try {
      const mod = await import(specifier);
      const factory = mod.default ?? mod;
      if (typeof factory === "function") {
        const plugin = factory();
        if (plugin && typeof plugin === "object" && plugin.name) {
          plugins.push(plugin);
          console.log(`Loaded plugin: ${plugin.name} (from ${specifier})`);
        } else {
          console.error(
            `Plugin "${specifier}": factory did not return a valid plugin object`,
          );
        }
      } else if (factory && typeof factory === "object" && factory.name) {
        // Module exports a plugin directly
        plugins.push(factory);
        console.log(`Loaded plugin: ${factory.name} (from ${specifier})`);
      } else {
        console.error(
          `Plugin "${specifier}": module does not export a plugin or factory`,
        );
      }
    } catch (err: unknown) {
      console.error(
        `Failed to load plugin "${specifier}":`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return plugins;
}

async function main(): Promise<void> {
  const plugins = await loadPluginsFromEnv();
  const proxy = createProxy({ plugins });
  await proxy.start();

  // Keep the process alive
  process.stdin.resume();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    proxy.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
