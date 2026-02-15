# @contextio

Transparent proxy between AI tools and LLM APIs. Logs and redacts traffic without touching the tools themselves.

```
AI Tool  -->  contextio proxy  -->  LLM API
                    |
              +-----------+
              |  plugins   |
              +-----------+
              redact  logger
```

Zero external dependencies. You route API keys through it, so the code must be fully auditable.

## Quick start

```bash
# Wrap a tool: proxy starts, runs the tool, shuts down when it exits
ctxio proxy -- claude

# With redaction
ctxio proxy --redact -- claude

# Or start the proxy separately and attach tools to it
ctxio proxy --redact
ctxio attach claude        # in another terminal
ctxio attach gemini        # in another terminal
```

`contextio` works as a longer alias for `ctxio`.

## Examples

Log everything Claude sends and receives:

```bash
ctxio proxy -- claude
ls ~/.contextio/captures/
# claude_a1b2c3d4_1771190200000-000000.json
# claude_a1b2c3d4_1771190200500-000001.json
```

Redact PII before it reaches the API:

```bash
ctxio proxy --redact -- claude
# "My SSN is 123-45-6789" -> LLM sees "My SSN is [SSN_REDACTED]"
```

Redact and restore in responses (reversible mode):

```bash
ctxio proxy --redact-reversible -- claude
# You:    "Email john@test.com about the project"
# LLM:    "I'll draft an email to [EMAIL_1]"
# You see: "I'll draft an email to john@test.com"
```

Run the proxy in the background, attach multiple tools:

```bash
ctxio background start --redact
ctxio attach claude
ctxio attach gemini
ctxio background stop
```

Use a custom redaction policy:

```bash
ctxio proxy --redact-policy ./my-rules.json -- claude
```

## Tool support

| Tool | Mode | Redaction | Logging | Notes |
|:---|:---|:---|:---|:---|
| Claude CLI | proxy | yes | yes | |
| Pi | proxy | yes | yes | Anthropic + OpenAI models |
| Gemini CLI | proxy | yes | yes | |
| Aider | proxy | yes | yes | untested |
| OpenCode | mitmproxy | no | yes | Routes through opencode.ai gateway regardless of model |
| Copilot CLI | mitmproxy | no | yes | |
| Codex | none | no | no | Own sandboxed network proxy, ignores all env vars |

Tools in **proxy** mode get full redaction and logging. The proxy rewrites base URLs so traffic flows through contextio.

Tools in **mitmproxy** mode can't be base-URL-rewritten but do respect `HTTPS_PROXY`. contextio starts mitmproxy automatically and captures traffic. No redaction because the traffic goes directly to the API (contextio can only observe, not modify).

## Logging

Logging is on by default. Every request/response pair is written as a JSON file to `~/.contextio/captures/`.

```bash
ctxio proxy -- claude                              # logging on (default)
ctxio proxy --no-log -- claude                     # disable logging
ctxio proxy --log-dir ./my-captures -- claude      # custom directory
ctxio proxy --log-max-sessions 10 -- claude        # keep only last 10 sessions
```

### Capture files

Files are named `{tool}_{session}_{timestamp}-{sequence}.json`:

```
claude_a1b2c3d4_1771190200000-000000.json
claude_a1b2c3d4_1771190200500-000001.json
gemini_67bb9e8f_1771188600815-000000.json
```

Each file contains one request/response pair:

```json
{
  "timestamp": "2026-02-15T20:50:00.815Z",
  "sessionId": "67bb9e8f",
  "method": "POST",
  "path": "/v1/messages",
  "source": "claude",
  "provider": "anthropic",
  "apiFormat": "anthropic-messages",
  "targetUrl": "https://api.anthropic.com/v1/messages",
  "requestHeaders": { "content-type": "application/json" },
  "requestBody": { "model": "claude-sonnet-4-20250514", "messages": [...] },
  "requestBytes": 1234,
  "responseStatus": 200,
  "responseHeaders": { "content-type": "text/event-stream" },
  "responseBody": "data: {\"type\":\"content_block_delta\",...}",
  "responseIsStreaming": true,
  "responseBytes": 5678,
  "timings": { "send_ms": 2, "wait_ms": 800, "receive_ms": 1200, "total_ms": 2002 }
}
```

### Session retention

Each `attach` or wrap invocation creates a session (8-char hex ID). The `--log-max-sessions` flag prunes the oldest sessions on startup, keeping only the most recent N. Files without a session ID are never pruned.

## Redaction

Strips sensitive data from requests before they reach the LLM.

```bash
ctxio proxy --redact                          # default "pii" preset
ctxio proxy --redact-preset secrets           # API keys and tokens only
ctxio proxy --redact-policy ./my-rules.json   # custom policy file
```

### Presets

| Preset | What it catches |
|:---|:---|
| `secrets` | API keys, tokens, private keys, credentials |
| `pii` (default) | Secrets + email, SSN, credit cards, phone numbers |
| `strict` | PII + IP addresses, dates of birth |

Context-gated rules only fire when relevant words appear nearby. `123-45-6789` by itself is not redacted, but `My SSN is 123-45-6789` is.

### Reversible mode (opt-in)

```bash
ctxio proxy --redact-reversible
```

Uses numbered placeholders and restores original values in the response:

```
You say:      "My email is john@test.com"
LLM sees:     "My email is [EMAIL_1]"
LLM replies:  "I've noted [EMAIL_1] as your contact"
You see:       "I've noted john@test.com as your contact"
```

Same value always gets the same placeholder within a session. Works with streaming responses across Anthropic, OpenAI, and Gemini formats.

Opt-in because it keeps originals in memory and reconstructs SSE events. Stable for daily use, but needs more mileage before becoming default.

### Custom policies

```jsonc
{
  "extends": "pii",
  "rules": [
    { "id": "employee-id", "pattern": "EMP-\\d{5,}", "replacement": "[EMPLOYEE_ID]" }
  ],
  "allowlist": {
    "strings": ["support@mycompany.com"],
    "patterns": ["test-\\d+@example\\.com"]
  },
  "paths": {
    "only": ["messages[*].content", "system"],
    "skip": ["model", "max_tokens"]
  }
}
```

See [examples/](examples/) for sample policy files and [docs/redaction-policy.md](docs/redaction-policy.md) for the full reference.

## All commands

```bash
ctxio proxy [flags]              # start proxy
ctxio proxy [flags] -- <tool>    # wrap a tool
ctxio attach <tool>              # attach to running proxy
ctxio background start|stop|status
ctxio doctor                     # diagnostics
ctxio --help                     # full flag reference
```

## Prerequisites for mitmproxy tools

Tools like Copilot CLI and OpenCode require mitmproxy for logging:

```bash
pipx install mitmproxy    # or: pip install mitmproxy
mitmdump --version         # run once to generate CA cert
```

contextio starts and stops mitmproxy automatically when you attach these tools.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
