# contextio

Sits between your AI coding tools and the LLM APIs they call. Logs everything, optionally redacts PII and secrets before they leave your machine.

You route your API keys through this thing, so there are zero external dependencies. Read the code.

## What it can do

Log everything an AI tool sends and receives:

```bash
ctxio proxy -- claude
ls ~/.contextio/captures/
# claude_a1b2c3d4_1771190200000-000000.json
# claude_a1b2c3d4_1771190200500-000001.json
```

Strip PII and secrets from requests before they reach the API:

```bash
ctxio proxy --redact -- claude
# "My SSN is 123-45-6789" -> LLM sees "My SSN is [SSN_REDACTED]"
```

Redact with reversible placeholders, so responses still make sense:

```bash
ctxio proxy --redact-reversible -- claude
# You:     "Email john@test.com about the project"
# LLM:     "I'll draft an email to [EMAIL_1]"
# You see: "I'll draft an email to john@test.com"
```

Run a shared proxy, attach multiple tools:

```bash
ctxio proxy --redact
ctxio attach claude       # another terminal
ctxio attach gemini       # another terminal
```

Or run it in the background:

```bash
ctxio background start --redact
ctxio attach claude
ctxio background stop
```

`contextio` is a longer alias if you prefer typing.

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

Rules are context-gated where it makes sense. `123-45-6789` on its own is left alone, but `My SSN is 123-45-6789` gets redacted.

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

## Logging

On by default. Disable with `--no-log`.

```bash
ctxio proxy --log-dir ./my-captures -- claude      # custom directory
ctxio proxy --log-max-sessions 10 -- claude        # prune old sessions on startup
```

Each capture file is a complete request/response pair:

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

(Truncated for readability. Actual files include headers, byte counts, and detailed timings.)

## Tool support

| Tool | How | Redaction | Logging |
|:---|:---|:---|:---|
| Claude CLI | proxy | yes | yes |
| Pi | proxy | yes | yes |
| Gemini CLI | proxy | yes | yes |
| Aider | proxy | yes | yes (untested) |
| OpenCode | mitmproxy | no | yes |
| Copilot CLI | mitmproxy | no | yes |
| Codex | not supported | | |

**Proxy mode** rewrites the tool's base URL so all traffic flows through contextio. Full redaction and logging.

**Mitmproxy mode** is for tools that ignore base URL env vars but do respect `HTTPS_PROXY`. contextio starts mitmproxy in the background and captures traffic. You get logging but no redaction, since we can only observe the traffic, not rewrite it.

**Codex** has its own sandboxed network proxy baked into a statically linked Rust binary. It ignores every env var we could set. Nothing to be done.

OpenCode and Copilot require mitmproxy to be installed:

```bash
pipx install mitmproxy
mitmdump --version         # run once to generate the CA cert
```

contextio handles starting and stopping mitmproxy automatically.

## Commands

```bash
ctxio proxy [flags]              # start proxy
ctxio proxy [flags] -- <tool>    # wrap a tool
ctxio attach <tool>              # connect to running proxy
ctxio background start|stop|status
ctxio doctor                     # check what's working
ctxio --help
```

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
