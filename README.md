# ContextIO - Control your context

[![CI](https://github.com/larsderidder/contextio/actions/workflows/ci.yml/badge.svg)](https://github.com/larsderidder/contextio/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@contextio/cli)](https://www.npmjs.com/package/@contextio/cli)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

A local proxy that sits between your AI coding tools and the LLM APIs they call. Logs every request and response, optionally strips PII and secrets before anything leaves your machine.

I built this because I get nervous sending data I don't see to LLMs. Now at least I know if they are gossiping about me.

All your stuff passes through this thing, so the proxy has zero external dependencies. Read the code, it's small.

**Looking for full observability?** Check out [Context Lens](https://github.com/larsderidder/contextlens), a web-based tracing and analytics platform built on top of contextio (well I'm working on porting things over).

## Install

```bash
npm install -g @contextio/cli
```

## Quick start

Log everything:

```bash
ctxio proxy -- claude
```

Log and redact PII:

```bash
ctxio proxy --redact -- claude
```

Log, redact, and restore originals in responses:

```bash
ctxio proxy --redact-reversible -- claude
```

Works with multiple tools at once:

```bash
ctxio proxy --redact          # start the proxy
ctxio attach claude           # in another terminal
ctxio attach gemini           # in another terminal
```

Or run it in the background:

```bash
ctxio proxy -d --redact
ctxio attach claude
ctxio proxy stop
```

`contextio` is a longer alias for `ctxio` for those who just _love_ typing.

## Commands

### Proxy

Start the proxy standalone (runs until you Ctrl+C):

```bash
ctxio proxy [--redact] [--log-dir ./captures]
```

Wrap a tool (starts proxy, runs tool, cleans up when tool exits):

```bash
ctxio proxy [flags] -- claude
ctxio proxy --redact -- aider
```

Background mode (detached):

```bash
ctxio proxy -d --redact       # start in background
ctxio proxy status            # check if running
ctxio proxy stop              # stop background proxy
```

### Attach

Connect a tool to an already-running proxy:

```bash
ctxio attach <tool>
```

Works with both standalone and background proxies. Multiple tools can attach to the same proxy.

### Monitor

Live view of traffic passing through the proxy:

```bash
ctxio monitor              # watch all traffic
ctxio monitor a1b2c3d4     # filter to one session ID
```

Shows request/response pairs as they arrive, with timing, token counts, and streaming status. Press Ctrl+C to exit.

### Inspect

Analyze captured sessions:

```bash
ctxio inspect                    # list all sessions
ctxio inspect a1b2c3d4           # show session details
ctxio inspect a1b2c3d4 --stats   # token stats per request
```

Displays:
- Session summary (tool, provider, request count, token usage)
- System prompts and tool definitions (if present)
- First user message
- Token consumption breakdown

### Replay

Re-send a captured request to the API (experimental):

```bash
ctxio replay capture-file.json
```

Requires the correct API key for the provider. Shows the new response and highlights any differences from the original.

### Export

Bundle session captures into a shareable tarball (experimental):

```bash
ctxio export                  # export all sessions
ctxio export a1b2c3d4         # export one session
ctxio export --redact         # strip PII before bundling
```

Creates `contextio-export-YYYY-MM-DD-HHMMSS.tar.gz` with all matching capture files.

### Doctor

Check environment and configuration:

```bash
ctxio doctor
```

Verifies:
- mitmproxy installation and CA cert
- Capture directory permissions
- Port availability (4040, 8080)
- Lockfile state
- Background proxy status

## Architecture

```
Tool  ─HTTP─▶  Proxy (:4040)  ─HTTPS─▶  api.anthropic.com / api.openai.com
                  │
            plugin pipeline
            (redact → log)
                  │
            capture files on disk
```

The proxy has zero npm dependencies (Node.js built-ins + `@contextio/core` only). Plugins like redact and logger are separate packages that hook into the proxy's request/response lifecycle.

### Packages

| Package | Description |
|:---|:---|
| [`@contextio/cli`](packages/cli) | CLI that wraps your tools with proxy + redaction + logging |
| [`@contextio/proxy`](packages/proxy) | HTTP reverse proxy for LLM APIs with plugin system. Zero deps |
| [`@contextio/redact`](packages/redact) | Privacy and redaction plugin: presets, custom policies, reversible mode |
| [`@contextio/logger`](packages/logger) | Capture-to-disk plugin with atomic writes and session retention |
| [`@contextio/core`](packages/core) | Shared types, routing, headers, token estimation, security scanning |

## Tool support

| Tool | Method | Redaction | Logging |
|:---|:---|:---|:---|
| Claude CLI | proxy | ✓ | ✓ |
| Pi | proxy | ✓ | ✓ |
| Gemini CLI | proxy | ✓ | ✓ |
| Aider | proxy | ✓ | ✓ |
| Codex | mitmproxy + proxy | ✓ | ✓ |
| OpenCode | mitmproxy + proxy | ✓ | ✓ |
| Copilot CLI | mitmproxy + proxy | ✓ | ✓ |

Tools that accept a base URL override (Claude, Pi, Gemini, Aider) get routed through the proxy directly. Tools that don't (Codex, Copilot, OpenCode) go through mitmproxy first to terminate TLS, then chain into the contextio proxy. contextio handles starting and stopping mitmproxy automatically.

Codex, OpenCode, and Copilot require mitmproxy to be installed:

```bash
pipx install mitmproxy
mitmdump --version         # run once to generate the CA cert
```

Any tool not in this list falls through to a default that sets both `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`, which covers most tools that respect those env vars.

## Redaction

Three built-in presets, or bring your own policy file.

```bash
ctxio proxy --redact                          # "pii" preset (default)
ctxio proxy --redact-preset secrets           # API keys and tokens only
ctxio proxy --redact-preset strict            # PII + IPs, dates of birth
ctxio proxy --redact-policy ./my-rules.json   # custom rules
```

| Preset | What it catches |
|:---|:---|
| `secrets` | API keys, tokens, private keys, AWS credentials |
| `pii` | Everything in secrets, plus email, SSN, credit cards, US phone numbers |
| `strict` | Everything in pii, plus IPv4 addresses, dates of birth |

Rules are context-gated where it makes sense. `123-45-6789` on its own is left alone; `My SSN is 123-45-6789` gets redacted.

### Reversible mode

```bash
ctxio proxy --redact-reversible -- claude
```

Replaces values with numbered placeholders, then restores them in the response stream:

```
You:       "My email is john@test.com"
LLM sees:  "My email is [EMAIL_1]"
LLM says:  "I've noted [EMAIL_1] as your contact"
You see:   "I've noted john@test.com as your contact"
```

Same value always maps to the same placeholder within a session. Works across Anthropic, OpenAI, and Gemini streaming formats.

This is opt-in. It keeps originals in memory and reconstructs SSE events on the fly. Stable enough for daily use, but it hasn't had months of production mileage yet.

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

Full reference in [docs/redaction-policy.md](docs/redaction-policy.md). Examples in [examples/](examples/).

See [docs/FAQ.md](docs/FAQ.md) for common questions about redaction, troubleshooting, and usage patterns.

## Logging

On by default. Disable with `--no-log`.

```bash
ctxio proxy --log-dir ./my-captures -- claude      # custom directory
ctxio proxy --log-max-sessions 10 -- claude        # prune old sessions on startup
```

Each capture file is a complete request/response pair:

```
claude_a1b2c3d4_1739000000000-000001.json
```

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

Actual files include headers, byte counts, and detailed timings.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for dependency policy and guidelines.

## License

MIT
