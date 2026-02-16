# @contextio/cli

[![npm](https://img.shields.io/npm/v/@contextio/cli)](https://www.npmjs.com/package/@contextio/cli)

CLI for contextio. Wraps your AI coding tools with a local proxy that logs and optionally redacts LLM API calls. One command, no code changes.

## Install

```bash
npm install -g @contextio/cli
```

## Quick start

```bash
ctxio proxy -- claude                          # log all API calls
ctxio proxy --redact -- claude                 # log + redact PII
ctxio proxy --redact-reversible -- claude      # log + redact + restore in responses
```

## Commands

```bash
ctxio proxy [flags] -- <tool>       # wrap a tool with the proxy
ctxio proxy [flags]                 # start proxy standalone (no child process)
ctxio proxy -d [flags]              # start proxy detached (background)
ctxio proxy stop                    # stop background proxy
ctxio proxy status                  # check if background proxy is running
ctxio attach <tool>                 # connect a tool to a running proxy
ctxio monitor [session]             # live view of proxy traffic
ctxio inspect [session]             # inspect prompts and tool definitions
ctxio replay <capture-file>         # re-send a captured request to the API
ctxio export [session]              # bundle session captures for sharing
ctxio doctor                        # check ports, certs, capture dir
```

## Tool support

| Tool | Method | Notes |
|:---|:---|:---|
| Claude CLI | proxy | Sets `ANTHROPIC_BASE_URL` |
| Pi | proxy | Sets `ANTHROPIC_BASE_URL` + `OPENAI_BASE_URL` |
| Gemini CLI | proxy | Sets `GOOGLE_GEMINI_BASE_URL` + `CODE_ASSIST_ENDPOINT` |
| Aider | proxy | Sets `ANTHROPIC_BASE_URL` + `OPENAI_BASE_URL` |
| Codex | mitmproxy + proxy | Requires `pipx install mitmproxy` |
| OpenCode | mitmproxy + proxy | Requires `pipx install mitmproxy` |
| Copilot CLI | mitmproxy + proxy | Requires `pipx install mitmproxy` |

**Proxy mode** sets the tool's base URL environment variable to route traffic through contextio.

**Mitmproxy mode** is for tools that ignore base URL overrides but respect `HTTPS_PROXY`. contextio starts mitmproxy to terminate TLS, then chains all traffic through the contextio proxy for redaction and logging. mitmproxy startup and shutdown is handled automatically.

Unknown tools fall through to a default that sets both `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`.

## Redaction

```bash
ctxio proxy --redact                          # "pii" preset (default)
ctxio proxy --redact-preset secrets           # API keys and tokens only
ctxio proxy --redact-preset strict            # PII + IPs, dates of birth
ctxio proxy --redact-policy ./my-rules.json   # custom rules
ctxio proxy --redact-reversible               # strip on request, restore on response
```

See [@contextio/redact](https://www.npmjs.com/package/@contextio/redact) for details on presets, reversible mode, and custom policies.

## Logging

On by default. Captures go to `~/.contextio/captures/`.

```bash
ctxio proxy --log-dir ./my-captures -- claude      # custom directory
ctxio proxy --log-max-sessions 10 -- claude        # prune old sessions
ctxio proxy --no-log -- claude                     # disable logging
```

## Inspecting captures

```bash
ctxio inspect --last                      # inspect most recent session
ctxio inspect <session-id>                # inspect specific session
ctxio inspect --source claude             # filter by tool
ctxio monitor                             # watch traffic in real time
ctxio monitor --last 1h                   # show recent captures, then watch
ctxio replay ./captures/some-capture.json # re-send a request
ctxio replay ./capture.json --diff        # re-send and diff against original response
ctxio export --last                       # export most recent session
ctxio export <session-id> -o ./out.json   # export to specific file
```

## Background mode

```bash
ctxio proxy -d --redact       # start detached proxy
ctxio attach claude            # connect tool in another terminal
ctxio attach gemini            # connect another tool
ctxio proxy status             # check if it's running
ctxio proxy stop               # stop the proxy
```

## Aliases

`contextio` is a longer alias for `ctxio`.

## License

MIT
