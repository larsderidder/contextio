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
# Start the proxy (logging on by default to ~/.contextio/captures/)
ctxio proxy

# Wrap a tool: proxy starts, runs the tool, shuts down when it exits
ctxio proxy --redact -- claude

# Or start the proxy separately and attach tools to it
ctxio proxy --redact
ctxio attach claude        # in another terminal
ctxio attach gemini        # in another terminal
```

`contextio` works as a longer alias.

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

See [examples/](examples/) for sample policy files.

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
