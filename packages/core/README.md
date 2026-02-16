# @contextio/core

[![npm](https://img.shields.io/npm/v/@contextio/core)](https://www.npmjs.com/package/@contextio/core)

Shared types, routing, and utility functions for the contextio packages. Zero npm dependencies.

This is the contract layer. It defines the plugin interface, request/response types, provider routing, header filtering, model pricing, token estimation, and security scanning. Every other `@contextio/*` package depends on this.

## Install

```bash
npm install @contextio/core
```

## What's in here

### Plugin interface

```typescript
import type { ProxyPlugin } from '@contextio/core';

const myPlugin: ProxyPlugin = {
  name: 'my-plugin',
  onRequest(ctx) { return ctx; },
  onResponse(ctx) { return ctx; },
  onCapture(capture) { /* ... */ },
  onStreamChunk(chunk, sessionId) { return chunk; },
};
```

This is what `@contextio/redact`, `@contextio/logger`, and any custom plugin implements.

### Routing

```typescript
import { classifyRequest, resolveTargetUrl, extractSource } from '@contextio/core';

const classification = classifyRequest(url, headers);
const target = resolveTargetUrl(url, upstreams);
const source = extractSource(url); // /claude/v1/messages -> "claude"
```

### Model utilities

```typescript
import { estimateCost, getContextLimit, MODEL_PRICING } from '@contextio/core';

const cost = estimateCost('claude-sonnet-4-20250514', { inputTokens: 1000, outputTokens: 500 });
const limit = getContextLimit('gpt-4o');
```

### Token estimation

```typescript
import { estimateTokens, countImageBlocks } from '@contextio/core';

const tokens = estimateTokens(requestBody);
```

### Response parsing

```typescript
import { parseResponseUsage, parseStreamingTokens } from '@contextio/core';

const usage = parseResponseUsage(responseBody, 'anthropic');
```

### Security scanning

```typescript
import { scanSecurity, scanOutput } from '@contextio/core';

const result = scanSecurity(messages);        // prompt injection patterns
const outputResult = scanOutput(text);        // URLs, code patterns, banned substrings
```

### Header filtering

```typescript
import { selectHeaders, SENSITIVE_HEADERS } from '@contextio/core';

const safe = selectHeaders(headers, { omit: SENSITIVE_HEADERS });
```

### Types

`ProxyConfig`, `RequestContext`, `ResponseContext`, `CaptureData`, `Provider`, `ApiFormat`, `Upstreams`, and more. See the TypeScript definitions for the full list.

## License

MIT
