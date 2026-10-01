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

const cost = estimateCost('claude-sonnet-4-20250514', 1000, 500);
const limit = getContextLimit('gpt-4o');
```

`getContextLimit()` returns the provider-advertised total context window, not the maximum input or output budget. It is not a request-fit validator. Unknown models return a heuristic fallback. Model IDs accept provider prefixes and date snapshots; an unknown model variant does not inherit a base model's pricing.

`estimateCost()` uses standard direct-provider text rates. It does not account for batch discounts, long-context price tiers, regional or service-tier premiums, tool fees, or cache storage. Provider documentation is authoritative; source links live beside the tables in [`src/models.ts`](src/models.ts). Historical values remain available for retired models.

Cache estimates currently cover Anthropic's five-minute writes, a legacy Gemini approximation, and MiniMax M2.5 rates. Other cache rates are omitted; these costs are estimates, not invoice calculations.

### Token estimation

```typescript
import { estimateTokens, countImageBlocks } from '@contextio/core';

const tokens = estimateTokens(requestBody);
```

This is a rough, model-independent estimate, not exact tokenization. Text uses JavaScript string length divided by four. Images use a fixed fallback because the estimator does not inspect dimensions or model-specific vision rules. Language, structured data, and chat/tool overhead can materially change the actual count. Use provider-reported response usage for actual request totals, not this estimate.

### Response parsing

```typescript
import { parseResponseUsage, parseStreamingTokens } from '@contextio/core';

const usage = parseResponseUsage(responseBody);
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
