# ContextIO Docker Image

Minimal Docker image for `@contextio/proxy` with logging and redaction plugins pre-installed.

## What's Included

- **@contextio/proxy**: HTTP proxy server (port 4040)
- **@contextio/logger**: Capture-to-disk plugin (**enabled by default**)
- **@contextio/redact**: PII/secrets redaction plugin (**disabled by default, opt-in**)

## Quick Start

### Using Pre-built Image (GitHub Container Registry)

```bash
# Pull from ghcr.io
docker pull ghcr.io/larsderidder/contextio:latest

# Run with default settings (logging only, no redaction)
docker run --rm -p 4040:4040 ghcr.io/larsderidder/contextio:latest

# Enable redaction (PII preset)
docker run --rm -p 4040:4040 \
  -e CONTEXT_PROXY_PLUGINS=/app/logger-plugin.js,/app/redact-plugin.js \
  ghcr.io/larsderidder/contextio:latest

# Mount a volume to persist captures
docker run --rm -p 4040:4040 \
  -v $(pwd)/captures:/home/node/.contextio/captures \
  ghcr.io/larsderidder/contextio:latest
```

### Building Locally

```bash
# Build the image
docker build -t contextio-proxy .

# Run with default settings (logging only, no redaction)
docker run --rm -p 4040:4040 contextio-proxy

# Enable redaction
docker run --rm -p 4040:4040 \
  -e CONTEXT_PROXY_PLUGINS=/app/logger-plugin.js,/app/redact-plugin.js \
  contextio-proxy

# Mount a volume to persist captures
docker run --rm -p 4040:4040 \
  -v $(pwd)/captures:/home/node/.contextio/captures \
  contextio-proxy
```

### Available Tags

- `:latest` - Latest build from `main` branch
- `:v0.1.1` - Specific version (semver)
- `:0.1` - Minor version (auto-updates patch versions)
- `:0` - Major version (auto-updates minor/patch versions)
- `:main` - Latest commit on `main` branch
- `:main-sha-abc123` - Specific commit SHA

## Configuration

All configuration is via environment variables.

### Quick Reference

| Env Var | Default | Description |
|:--------|:--------|:------------|
| `CONTEXT_PROXY_PLUGINS` | `/app/logger-plugin.js` | Comma-separated plugin paths |
| `CONTEXT_PROXY_BIND_HOST` | `0.0.0.0` | Bind address |
| `CONTEXT_PROXY_PORT` | `4040` | Port to listen on |
| `LOGGER_CAPTURE_DIR` | `~/.contextio/captures` | Capture output directory |
| `LOGGER_MAX_SESSIONS` | `0` (unlimited) | Max sessions to retain |
| `REDACT_PRESET` | `pii` | Preset: `secrets`, `pii`, `strict` |
| `REDACT_REVERSIBLE` | `false` | Restore originals in responses |
| `REDACT_POLICY_FILE` | _(none)_ | Path to custom policy JSON |

### Detailed Configuration

### Proxy Settings

- `CONTEXT_PROXY_BIND_HOST`: Bind address (default: `0.0.0.0`)
- `CONTEXT_PROXY_PORT`: Port to listen on (default: `4040`)
- `CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE`: Allow `x-target-url` header (default: `0`)

### Upstream URLs

- `UPSTREAM_OPENAI_URL`: OpenAI API endpoint (default: `https://api.openai.com/v1`)
- `UPSTREAM_ANTHROPIC_URL`: Anthropic API endpoint (default: `https://api.anthropic.com`)
- `UPSTREAM_GEMINI_URL`: Gemini API endpoint (default: `https://generativelanguage.googleapis.com`)

### Plugin Configuration

By default, only **logging is enabled**. Redaction is opt-in.

Plugins are loaded from `CONTEXT_PROXY_PLUGINS` (comma-separated module paths). The image includes:
- `/app/logger-plugin.js` - Logging plugin (enabled by default)
- `/app/redact-plugin.js` - Redaction plugin (disabled by default)

#### Enable Redaction

```bash
# Logging + PII redaction
docker run --rm -p 4040:4040 \
  -e CONTEXT_PROXY_PLUGINS=/app/logger-plugin.js,/app/redact-plugin.js \
  ghcr.io/larsderidder/contextio:latest

# Logging + reversible redaction (restores originals in responses)
docker run --rm -p 4040:4040 \
  -e CONTEXT_PROXY_PLUGINS=/app/logger-plugin.js,/app/redact-plugin.js \
  -e REDACT_REVERSIBLE=true \
  ghcr.io/larsderidder/contextio:latest
```

#### Redaction Presets

```bash
# Secrets only (API keys, tokens)
docker run --rm -p 4040:4040 \
  -e CONTEXT_PROXY_PLUGINS=/app/logger-plugin.js,/app/redact-plugin.js \
  -e REDACT_PRESET=secrets \
  ghcr.io/larsderidder/contextio:latest

# PII (default: email, SSN, credit cards, phone numbers)
docker run --rm -p 4040:4040 \
  -e CONTEXT_PROXY_PLUGINS=/app/logger-plugin.js,/app/redact-plugin.js \
  -e REDACT_PRESET=pii \
  ghcr.io/larsderidder/contextio:latest

# Strict (PII + IP addresses, dates of birth)
docker run --rm -p 4040:4040 \
  -e CONTEXT_PROXY_PLUGINS=/app/logger-plugin.js,/app/redact-plugin.js \
  -e REDACT_PRESET=strict \
  ghcr.io/larsderidder/contextio:latest
```

#### Disable Logging

```bash
# Redaction only (no logging)
docker run --rm -p 4040:4040 \
  -e CONTEXT_PROXY_PLUGINS=/app/redact-plugin.js \
  ghcr.io/larsderidder/contextio:latest

# No plugins (raw proxy only)
docker run --rm -p 4040:4040 \
  -e CONTEXT_PROXY_PLUGINS= \
  ghcr.io/larsderidder/contextio:latest
```

#### Logger Configuration

- `LOGGER_CAPTURE_DIR`: Directory for captures (default: `~/.contextio/captures`)
- `LOGGER_MAX_SESSIONS`: Max sessions to retain, 0 = unlimited (default: `0`)

```bash
# Custom capture directory with session limit
docker run --rm -p 4040:4040 \
  -e LOGGER_CAPTURE_DIR=/app/captures \
  -e LOGGER_MAX_SESSIONS=50 \
  -v ./captures:/app/captures \
  ghcr.io/larsderidder/contextio:latest
```

#### Redaction Configuration

- `REDACT_PRESET`: Built-in preset (`secrets`, `pii`, `strict`) (default: `pii`)
- `REDACT_REVERSIBLE`: Restore originals in responses (`true`/`false`) (default: `false`)
- `REDACT_POLICY_FILE`: Path to custom policy JSON (overrides `REDACT_PRESET`)

```bash
# Custom redaction policy
docker run --rm -p 4040:4040 \
  -e CONTEXT_PROXY_PLUGINS=/app/logger-plugin.js,/app/redact-plugin.js \
  -e REDACT_POLICY_FILE=/app/policy.json \
  -v $(pwd)/my-policy.json:/app/policy.json:ro \
  ghcr.io/larsderidder/contextio:latest
```



## Capture Persistence

By default, captures are written to `/home/node/.contextio/captures` inside the container. Mount a volume to persist them:

```bash
docker run --rm -p 4040:4040 \
  -v ./captures:/home/node/.contextio/captures \
  contextio-proxy
```

Files on the host will be owned by UID `1000` (the `node` user inside the container).

## Docker Compose Example

```yaml
version: "3.8"
services:
  contextio-proxy:
    image: ghcr.io/larsderidder/contextio:latest
    ports:
      - "4040:4040"
    volumes:
      - ./captures:/home/node/.contextio/captures
    environment:
      # Logging only (default)
      CONTEXT_PROXY_PLUGINS: /app/logger-plugin.js
      # Or enable redaction:
      # CONTEXT_PROXY_PLUGINS: /app/logger-plugin.js,/app/redact-plugin.js
      # REDACT_PRESET: pii
      # REDACT_REVERSIBLE: "true"
    restart: unless-stopped
```

With custom policy:

```yaml
services:
  contextio-proxy:
    image: ghcr.io/larsderidder/contextio:latest
    ports:
      - "4040:4040"
    volumes:
      - ./captures:/home/node/.contextio/captures
      - ./my-policy.json:/app/custom-policy.json:ro
    environment:
      CONTEXT_PROXY_PLUGINS: /app/logger-plugin.js,/app/redact-plugin.js
      REDACT_POLICY_FILE: /app/custom-policy.json
      REDACT_REVERSIBLE: "false"
    restart: unless-stopped
```

## What's NOT Included

This image contains only the proxy server and plugins. The CLI tools (`ctxio`, `inspect`, `monitor`, etc.) are **not included**.

For the full CLI experience, install `@contextio/cli` via npm instead:

```bash
npm install -g @contextio/cli
```

## Image Size

- Build stage: ~500MB (includes build tools, source, dependencies)
- Runtime stage: ~200MB (Node 22 Alpine + compiled output only)

## Security Notes

- Runs as non-root user (`node`, UID 1000)
- Zero production npm dependencies beyond `@contextio/*` workspace packages
- All packages use only Node.js built-ins (no external network calls from the proxy itself)
- API keys pass through the proxy but are never logged by default (redaction plugin strips them if enabled)

## Troubleshooting

**Plugins not loading:**
```
Failed to load plugin "...": ...
```
Check that `CONTEXT_PROXY_PLUGINS` points to valid module paths. The image includes `/app/logger-plugin.js` and `/app/redact-plugin.js` by default.

**Port already in use:**
```
Error: listen EADDRINUSE: address already in use 0.0.0.0:4040
```
Change the port with `-p 4041:4040` or set `CONTEXT_PROXY_PORT=4041`.

**Captures not persisting:**

Mount a volume to `/home/node/.contextio/captures`. Without a volume, captures are lost when the container stops.
