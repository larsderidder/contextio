# @contextio/logger

[![npm](https://img.shields.io/npm/v/@contextio/logger)](https://www.npmjs.com/package/@contextio/logger)

Capture-to-disk plugin for `@contextio/proxy`. Writes every LLM API request/response pair as a JSON file with atomic writes (write to `.tmp`, then rename).

## Install

```bash
npm install @contextio/logger
```

## Usage

```typescript
import { createProxy } from '@contextio/proxy';
import { createLoggerPlugin } from '@contextio/logger';

const logger = createLoggerPlugin({
  captureDir: '~/.contextio/captures',  // default
  maxSessions: 20,                       // prune old sessions on startup; 0 = keep all
});

const proxy = createProxy({
  port: 4040,
  plugins: [logger],
});

await proxy.start();
console.log(`Captures written to ${logger.captureDir}`);
```

## Capture format

Each file is a complete request/response pair:

```
claude_a1b2c3d4_1739000000000-000001.json
```

Filename: `{source}_{sessionId}_{timestamp}-{counter}.json`

```json
{
  "timestamp": "2026-02-15T20:50:00.815Z",
  "sessionId": "67bb9e8f",
  "source": "claude",
  "provider": "anthropic",
  "apiFormat": "anthropic-messages",
  "targetUrl": "https://api.anthropic.com/v1/messages",
  "requestBody": { "model": "claude-sonnet-4-20250514", "messages": ["..."] },
  "responseStatus": 200,
  "responseIsStreaming": true,
  "responseBody": "data: {\"type\":\"content_block_delta\",...}",
  "timings": { "total_ms": 2002 }
}
```

## Session retention

When `maxSessions` is set, the plugin groups captures by session ID on startup and removes the oldest sessions, keeping only the most recent N.

## License

MIT
