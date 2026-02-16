# Contributing

## Dependencies

The proxy routes API keys and sensitive data. A compromised dependency in that path is a supply chain attack on every user. So:

- **`core` and `proxy` must have zero external runtime dependencies.** No exceptions. These are the trust boundary.
- **`logger` and `redact`** should stay zero-dep where practical, but can take dependencies if there's a strong reason.
- **`cli`** is free to use external packages (arg parsing, terminal formatting, etc.). It's a consumer of the other packages, not part of the trust path.

Dev dependencies (TypeScript, test runners, build tools) are fine everywhere.

If you're unsure whether a new dependency is appropriate, open an issue first.

## Development

```bash
pnpm install
pnpm build
pnpm test
```
