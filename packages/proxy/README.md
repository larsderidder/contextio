# @contextio/proxy

[![npm](https://img.shields.io/npm/v/@contextio/proxy)](https://www.npmjs.com/package/@contextio/proxy)

HTTP reverse proxy for LLM API calls with a plugin system. Routes requests to Anthropic, OpenAI, and Google APIs. Zero npm dependencies beyond `@contextio/core`.

Your API keys pass through this thing, so it's intentionally small and dependency-free. Read the source.

## Install

```bash
npm install @contextio/proxy
```

## Usage

```typescript
import { createProxy } from '@contextio/proxy';

const proxy = createProxy({
  port: 4040,
  plugins: [],  // add @contextio/redact, @contextio/logger, or your own
});

await proxy.start();
// Proxy listening on http://localhost:4040

// Point your tool at the proxy:
// ANTHROPIC_BASE_URL=http://localhost:4040 claude
```

## Plugin system

Plugins hook into the request/response lifecycle:

```typescript
import type { ProxyPlugin } from '@contextio/core';

const myPlugin: ProxyPlugin = {
  name: 'my-plugin',

  // Transform the request before forwarding
  onRequest(ctx) {
    console.log(`${ctx.provider} request to ${ctx.targetUrl}`);
    return ctx;
  },

  // Transform the response before sending back
  onResponse(ctx) {
    return ctx;
  },

  // Receive the complete capture after the cycle finishes
  onCapture(capture) {
    console.log(`Captured ${capture.source} call`);
  },

  // Transform individual streaming chunks
  onStreamChunk(chunk, sessionId) {
    return chunk;
  },
};

const proxy = createProxy({ port: 4040, plugins: [myPlugin] });
```

## With redaction and logging

```typescript
import { createProxy } from '@contextio/proxy';
import { createRedactPlugin } from '@contextio/redact';
import { createLoggerPlugin } from '@contextio/logger';

const proxy = createProxy({
  port: 4040,
  plugins: [
    createRedactPlugin({ preset: 'pii', reversible: true }),
    createLoggerPlugin({ maxSessions: 50 }),
  ],
});

await proxy.start();
```

## How it works

```
Tool  ─HTTP─▶  Proxy (:4040)  ─HTTPS─▶  api.anthropic.com / api.openai.com / generativelanguage.googleapis.com
                  │
            onRequest → onResponse/onStreamChunk → onCapture
                  │
              [plugins]
```

The proxy classifies each incoming request by provider and API format, runs it through plugin `onRequest` hooks, forwards to the real API, runs the response through `onResponse`/`onStreamChunk`, then calls `onCapture` with the complete pair.

Streaming (SSE) responses are passed through chunk by chunk. No added latency.

## Embedding in your own server

```typescript
import { createProxyHandler } from '@contextio/proxy';

const handler = createProxyHandler({ plugins: [] });
// handler is a (req, res) function compatible with http.createServer
```

## License

MIT
