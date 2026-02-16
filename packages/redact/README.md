# @contextio/redact

[![npm](https://img.shields.io/npm/v/@contextio/redact)](https://www.npmjs.com/package/@contextio/redact)

Privacy and redaction plugin for `@contextio/proxy`. Strips PII, secrets, and sensitive data from LLM API requests before they leave your machine.

Two modes: one-way (strip and forget) or reversible (strip on request, restore on response). In reversible mode the LLM sees placeholders, you see the originals.

## Install

```bash
npm install @contextio/redact
```

## Usage

```typescript
import { createProxy } from '@contextio/proxy';
import { createRedactPlugin } from '@contextio/redact';

// One-way: strip and forget
const proxy = createProxy({
  port: 4040,
  plugins: [createRedactPlugin({ preset: 'pii' })],
});

// Reversible: strip on request, restore on response
const proxy = createProxy({
  port: 4040,
  plugins: [createRedactPlugin({ preset: 'pii', reversible: true })],
});

await proxy.start();
```

## Presets

Each preset builds on the previous one:

| Preset | What it catches |
|:---|:---|
| `secrets` | API keys, tokens, private keys, AWS credentials |
| `pii` | Everything in secrets, plus email, SSN, credit cards, US phone numbers |
| `strict` | Everything in pii, plus IPv4/IPv6 addresses, dates of birth |

Rules are context-gated where it makes sense. `123-45-6789` on its own is left alone; `My SSN is 123-45-6789` gets redacted.

## Reversible mode

```typescript
const redact = createRedactPlugin({ preset: 'pii', reversible: true });
```

Replaces values with numbered placeholders, then restores them in the response stream:

```
You:       "My email is john@test.com"
LLM sees:  "My email is [EMAIL_1]"
LLM says:  "I've noted [EMAIL_1] as your contact"
You see:   "I've noted john@test.com as your contact"
```

Same value always maps to the same placeholder within a session. Works across Anthropic, OpenAI, and Gemini streaming formats. Session maps are evicted after 30 minutes of inactivity.

## Custom policies

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

```typescript
const redact = createRedactPlugin({ policyFile: './my-rules.json' });
```

Full policy reference: [redaction-policy.md](https://github.com/larsderidder/contextio/blob/main/docs/redaction-policy.md)

## Standalone usage

The redaction engine works without the proxy:

```typescript
import { redactWithPolicy, fromPreset, createStats } from '@contextio/redact';

const policy = fromPreset('pii');
const stats = createStats();
const redacted = redactWithPolicy(inputObject, policy, stats);

console.log(`Redacted ${stats.totalReplacements} matches`);
```

## License

MIT
