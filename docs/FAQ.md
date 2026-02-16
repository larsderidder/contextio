# Frequently Asked Questions

## General

### What does contextio do?

It's a local HTTP proxy that sits between your AI coding tools (Claude CLI, Aider, etc.) and the LLM APIs they call. It logs every request and response, and optionally strips PII and secrets before they leave your machine. Nothing leaves your machine, it's all local-first.

### Why would I use this?

I don't know, maybe you want to:

- **Audit what your tools send**: See exactly what context, prompts, and code go to the API
- **Have some privacy**: Redact sensitive data (emails, SSNs, API keys) before it reaches the LLM
- **Debug**: Inspect token usage, system prompts, and tool definitions
- **Do something complicated with compliance**: Keep local copies of all LLM interactions for review

### Does it work with any AI tool?

Most tools that accept base URL overrides work directly (Claude CLI, Aider, Pi, Gemini CLI). Tools that don't (Codex, Copilot, OpenCode) require mitmproxy for TLS termination, which contextio handles automatically.

### Does it slow down requests?

Minimally. The proxy adds ~1-5ms of latency for routing and plugin processing. Redaction adds another ~2-10ms depending on content size and rule complexity. Streaming responses pass through with negligible delay.

## Installation and Setup

### Do I need to install mitmproxy?

Only if you're using tools that don't support base URL overrides (Codex, Copilot CLI, OpenCode); these are a bit nasty and it was a headache to get them working at all. For Claude CLI, Aider, Gemini CLI, and most other tools, mitmproxy is not required.

```bash
pipx install mitmproxy
mitmdump --version  # run once to generate the CA cert
```

### Where are capture files stored?

By default: `~/.contextio/captures/`

Override with `--log-dir`:

```bash
ctxio proxy --log-dir ./my-captures -- claude
```

### How do I check if everything is working?

```bash
ctxio doctor
```

This verifies:
- mitmproxy installation (if needed)
- CA certificate presence
- Capture directory permissions
- Port availability (4040 for proxy, 8080 for mitmproxy)
- Lockfile state

### Can I use a different port?

Yes, set the `CONTEXTIO_PORT` environment variable:

```bash
export CONTEXTIO_PORT=5000
ctxio proxy -- claude
```

The proxy will listen on port 5000 instead of the default 4040.

## Usage

### What's the difference between standalone, wrap, and attach?

**Standalone**: Start the proxy manually, leave it running
```bash
ctxio proxy
# proxy runs until you Ctrl+C
```

**Wrap**: Start proxy, run tool, stop proxy when tool exits
```bash
ctxio proxy -- claude
# proxy starts, claude runs, proxy stops when claude exits
```

**Attach**: Connect a tool to an already-running proxy
```bash
# Terminal 1
ctxio proxy

# Terminal 2
ctxio attach claude
```

Wrap mode uses a shared proxy with reference counting. Multiple `ctxio proxy -- <tool>` invocations share one proxy process; the proxy shuts down when the last tool exits.

### Can I run multiple tools through the same proxy?

Yes. Use standalone or background mode, then attach multiple tools:

```bash
ctxio proxy -d           # start in background

ctxio attach claude      # in any terminal
ctxio attach aider       # in another terminal
ctxio attach gemini      # in another terminal

ctxio proxy stop         # when done
```

Or use wrap mode multiple times. They'll share a single proxy process automatically.

### How do I stop a background proxy?

```bash
ctxio proxy stop
```

Or check status:

```bash
ctxio proxy status
```

## Redaction

### What's the difference between the presets?

| Preset | What it catches |
|:---|:---|
| `secrets` | API keys, tokens, AWS credentials, private keys |
| `pii` | Everything in `secrets` + email, SSN, credit cards, US phone numbers |
| `strict` | Everything in `pii` + IPv4 addresses, dates of birth |

Default is `pii`.

### What is reversible mode?

Reversible mode replaces sensitive values with numbered placeholders in the request, then restores them in the streaming response:

```bash
ctxio proxy --redact-reversible -- claude
```

```
You send:  "My email is john@test.com"
LLM sees:  "My email is [EMAIL_1]"
LLM says:  "I've noted [EMAIL_1]"
You see:   "I've noted john@test.com"
```

It's incredibly cool but experimental; you basically keep some context from your LLM. It's like a secret decoder ring for your LLM.  This should keep the LLM's response coherent while still redacting the outbound request. Same value always maps to the same placeholder within a session.

### Does reversible mode work with all providers?

Yes, it supports Anthropic, OpenAI, and Gemini streaming formats. It reconstructs SSE events on the fly.

### Can I add custom redaction rules?

Yes, create a policy file:

```jsonc
{
  "extends": "pii",
  "rules": [
    {
      "id": "employee-id",
      "pattern": "EMP-\\d{5,}",
      "replacement": "[EMPLOYEE_ID]"
    }
  ]
}
```

Then:

```bash
ctxio proxy --redact-policy ./my-policy.json -- claude
```

See [docs/redaction-policy.md](redaction-policy.md) for full reference.

### Why isn't my rule matching?

Common issues:

1. **Escaping**: In JSON, backslashes must be doubled: `\\d` not `\d`
2. **Context requirements**: If your rule has `context`, the context word must appear near the match
3. **Allowlist**: Check if the value is in your allowlist

Test your regex outside JSON first (regex101.com), then double-escape for JSON.

### Can I disable redaction for specific fields?

Yes, use path scoping:

```jsonc
{
  "extends": "pii",
  "paths": {
    "only": ["messages[*].content", "system"],
    "skip": ["model", "metadata"]
  }
}
```

This only redacts message content and system prompts, skipping model names and metadata.

## Logging

### How do I disable logging?

```bash
ctxio proxy --no-log -- claude
```

### What's in a capture file?

Every capture is a JSON file containing:

- Full request (method, headers, body, URL)
- Full response (status, headers, body, streaming flag)
- Metadata (timestamp, session ID, source tool, provider, API format)
- Timing breakdown (total, upstream, plugin processing)
- Token/byte counts

Sensitive headers (Authorization, API keys) are stripped before writing.

### How do I clean up old captures?

Set a session retention limit:

```bash
ctxio proxy --log-max-sessions 10 -- claude
```

On startup, the oldest sessions are pruned if the total exceeds 10. Sessions are identified by session ID (first 8 hex chars in the filename).

Or delete manually:

```bash
rm -rf ~/.contextio/captures/
```

### Can I share captures?

Use the `export` command to bundle a session into a tarball:

```bash
ctxio export a1b2c3d4              # export session a1b2c3d4
ctxio export a1b2c3d4 --redact     # strip PII before bundling
```

This creates `contextio-export-YYYY-MM-DD-HHMMSS.tar.gz` with all capture files for that session.

## Monitoring and Inspection

### How do I watch traffic in real time?

```bash
ctxio monitor
```

Press Ctrl+C to exit. Filter to a specific session:

```bash
ctxio monitor a1b2c3d4
```

### What does inspect show?

```bash
ctxio inspect a1b2c3d4
```

Shows:
- Session summary (tool, provider, request count, total tokens)
- System prompt (if present)
- Tool definitions (if the API call included tools)
- First user message
- Token breakdown with `--stats`

Useful for understanding what prompts your tools are sending.

### Can I replay a request?

Yes (experimental):

```bash
ctxio replay ~/.contextio/captures/claude_a1b2c3d4_1739000000000-000001.json
```

Re-sends the exact same request to the API and shows the new response. Requires the correct API key for that provider.

You can swap the model:

```bash
ctxio replay capture.json --model claude-opus-4-20250514
```

## Troubleshooting

### Port 4040 is already in use

Either something else is using 4040, or a previous proxy didn't shut down cleanly.

Check what's using it:

```bash
lsof -i :4040
```

Or use a different port:

```bash
export CONTEXTIO_PORT=5000
ctxio proxy -- claude
```

### mitmproxy certificate errors

Tools using mitmproxy need the CA cert installed. Run this once:

```bash
mitmdump --version
```

This generates `~/.mitmproxy/mitmproxy-ca-cert.pem`. Some tools auto-trust it; others need manual configuration.

### The proxy started but my tool can't connect

1. Check the proxy is listening: `ctxio proxy status` or `lsof -i :4040`
2. Check your tool is using the right base URL (proxy prints this on startup)
3. Run `ctxio doctor` to verify configuration

### Redaction isn't working

1. Check the preset: `--redact-preset secrets` is less aggressive than `pii` or `strict`
2. Verify the pattern: test your regex in isolation
3. Check context requirements: does the context word appear near the match?
4. Inspect a capture file to see what actually got logged

### Background proxy won't start

Check if another instance is already running:

```bash
ctxio proxy status
```

If it says "not running" but startup still fails, the lockfile might be stale:

```bash
rm /tmp/contextio.lock
ctxio proxy -d
```

## Architecture and Design

### Why zero dependencies for the proxy?

Your API keys pass through the proxy. Zero npm dependencies means the attack surface is minimal and the code is fully auditable. Only Node.js built-ins + `@contextio/core` (also zero deps).

Plugins (redact, logger) are separate packages with their own dependencies, loaded dynamically.

### How does the plugin system work?

Plugins implement the `ProxyPlugin` interface:

```typescript
interface ProxyPlugin {
  onRequest?: (ctx: RequestContext) => Promise<RequestContext>;
  onResponse?: (ctx: ResponseContext) => Promise<ResponseContext>;
  onCapture?: (capture: CaptureData) => Promise<void>;
}
```

The proxy calls hooks in order:

1. `onRequest` (before forwarding to upstream)
2. `onResponse` (after receiving upstream response)
3. `onCapture` (after writing capture file)

Redact modifies `onRequest` and `onResponse`. Logger implements `onCapture`.

### Can I write my own plugin?

Yes. See the [logger source](../packages/logger/src/index.ts) for a simple example, or [redact](../packages/redact/src/index.ts) for a more complex one.

Your plugin can be a local package or a published npm module. Load it by creating a custom proxy wrapper that imports your plugin and passes it to `createProxy()`.

### Why does wrap mode use a shared proxy?

To reduce overhead. If you run `ctxio proxy -- claude` in two terminals, both instances share a single proxy process. Reference counting ensures the proxy stays up as long as any tool is using it.

This is more efficient than spinning up a new proxy for every tool invocation.

### Does contextio send telemetry?

No. Zero network activity except forwarding your API requests to the upstream you specify. No analytics, no ET, no phone-home.
