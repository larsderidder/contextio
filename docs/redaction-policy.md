# Redaction Policy Reference

Redaction policies are JSON files that control what contextio redacts from LLM requests. Policies support `//` comments and trailing commas (JSONC).

## Structure

```jsonc
{
  "extends": "pii",             // optional: inherit rules from a preset
  "rules": [],                  // optional: custom redaction rules
  "allowlist": {},              // optional: values to never redact
  "paths": {}                   // optional: scope redaction to specific JSON paths
}
```

All fields are optional. An empty `{}` policy redacts nothing.

## `extends`

Inherit rules from a built-in preset. Custom rules are appended after preset rules (order matters for overlapping patterns).

| Value | Rules included |
|:---|:---|
| `"secrets"` | API keys, tokens, private keys, AWS credentials, generic secrets |
| `"pii"` | Everything in `secrets`, plus email, SSN, credit cards, US phone numbers |
| `"strict"` | Everything in `pii`, plus IPv4 addresses, dates of birth |

## `rules`

Array of custom redaction rules.

```jsonc
{
  "rules": [
    {
      "id": "employee-id",           // required: unique identifier
      "pattern": "EMP-\\d{5,}",      // required: regex (double-escaped in JSON)
      "replacement": "[EMPLOYEE_ID]", // required: replacement text
      "context": ["employee", "staff"], // optional: context-gating words
      "contextWindow": 150            // optional: character radius for context search (default: 100)
    }
  ]
}
```

### Rule fields

| Field | Type | Required | Description |
|:---|:---|:---|:---|
| `id` | string | yes | Unique name for the rule. Used in logging and numbered placeholders (`[EMPLOYEE_ID_1]` in reversible mode). |
| `pattern` | string | yes | Regular expression. Compiled with the global flag. Double-escape backslashes in JSON (`\\d`, not `\d`). |
| `replacement` | string | yes | Static replacement text. Supports `$1`, `$2` for capture groups. In reversible mode, a numbered suffix is appended automatically. |
| `context` | string[] | no | If set, the rule only fires when at least one of these words (case-insensitive) appears within `contextWindow` characters of the match. Reduces false positives for ambiguous patterns. |
| `contextWindow` | number | no | Character radius to search for context words. Default: 100. |

### Case-insensitive patterns

Prefix the pattern with `(?i)` to make it case-insensitive:

```jsonc
{ "id": "project-name", "pattern": "(?i)project[- ]atlas", "replacement": "[PROJECT]" }
```

This is converted to the JavaScript `i` flag internally.

## `allowlist`

Values that should never be redacted, even if they match a rule.

```jsonc
{
  "allowlist": {
    "strings": ["support@mycompany.com"],
    "patterns": ["test-\\d+@example\\.com"]
  }
}
```

| Field | Type | Description |
|:---|:---|:---|
| `strings` | string[] | Exact strings to skip. Checked after a match is found. |
| `patterns` | string[] | Regex patterns. If a match is fully covered by an allowlist pattern, it is not redacted. |

## `paths`

Scope redaction to specific parts of the JSON request body. Without path scoping, all string values in the body are redacted.

```jsonc
{
  "paths": {
    "only": ["messages[*].content", "system"],
    "skip": ["model", "max_tokens", "temperature"]
  }
}
```

| Field | Type | Description |
|:---|:---|:---|
| `only` | string[] | If set, only redact values at these paths. Everything else is left untouched. |
| `skip` | string[] | Skip redaction at these paths. Checked before `only`. |

### Path syntax

Paths use dot notation with `[*]` for array wildcards:

- `"model"` matches the top-level `model` field
- `"messages[*].content"` matches the `content` field of every element in the `messages` array
- `"system"` matches the top-level `system` field
- `"metadata.user.name"` matches a nested field

## Examples

### Secrets only, no customization

```json
{ "extends": "secrets" }
```

### PII preset with org-specific rules

```jsonc
{
  "extends": "pii",
  "rules": [
    { "id": "employee-id", "pattern": "EMP-\\d{5,}", "replacement": "[EMPLOYEE_ID]" }
  ],
  "allowlist": {
    "strings": ["noreply@company.com"]
  }
}
```

### Custom rules only, no preset

```jsonc
{
  "rules": [
    { "id": "internal-ip", "pattern": "10\\.\\d+\\.\\d+\\.\\d+", "replacement": "[INTERNAL_IP]" },
    {
      "id": "dutch-bsn",
      "pattern": "\\b\\d{9}\\b",
      "replacement": "[BSN]",
      "context": ["bsn", "burgerservicenummer", "sofinummer"]
    }
  ]
}
```

### Scoped to message content only

```jsonc
{
  "extends": "strict",
  "paths": {
    "only": ["messages[*].content", "system"],
    "skip": ["model"]
  }
}
```

## JSON Schema

A JSON Schema is available for validation and IDE autocomplete. Save this URL in your editor or policy file:

```json
{
  "$schema": "https://contextio.dev/schemas/redaction-policy.json"
}
```

Or download from: `https://github.com/your-org/contextio/raw/main/schemas/redaction-policy.schema.json`

### VS Code integration

Add this to your `.vscode/settings.json`:

```json
{
  "json.schemas": [
    {
      "fileMatch": ["*.contextio.json", "*-policy.json"],
      "url": "./schemas/redaction-policy.schema.json"
    }
  ]
}
```

## Verifying Your Policy

### 1. Test with the proxy

Start the proxy with your custom policy and send test traffic:

```bash
# Start proxy with your policy
ctxio proxy --redact-policy ./my-policy.jsonc --verbose

# In another terminal, send test data
curl -X POST http://127.0.0.1:4040/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"messages":[{"role":"user","content":"Test: john@test.com, 123-45-6789"}]}'

# Check the capture file
ls -t ~/.contextio/captures/ | head -1 | xargs cat
```

### 2. Validate JSON syntax

```bash
# Check if your policy is valid JSON/JSONC
node -e "
const fs = require('fs');
const policy = JSON.parse(fs.readFileSync('./my-policy.jsonc', 'utf8').replace(/\\/\\/.*$/gm, '').replace(/,\s*([\\]\\}])/g, '\$1'));
console.log('Valid JSON:', JSON.stringify(policy, null, 2));
"
```

### 3. Test rules in isolation

You can test your regex patterns directly:

```bash
node -e "
const pattern = /your-pattern-here/g;
const testString = 'Test string with sensitive data';
console.log('Matches:', testString.match(pattern));
"
```

### 4. Quick dry-run

To verify redaction without running the full proxy, use the redact package directly:

```bash
node -e "
import { createRedactPlugin, createStats } from '@contextio/redact';
import { compilePolicy, loadPolicyFile } from '@contextio/redact/dist/policy.js';

const policy = loadPolicyFile('./my-policy.jsonc');
const stats = createStats();

const testInput = 'Contact john@company.com or EMP-12345';
const result = redactWithPolicy(testInput, policy, stats);

console.log('Input:', testInput);
console.log('Output:', result);
console.log('Stats:', stats);
"
```

## Troubleshooting

### Rule not matching?

1. **Check regex escaping**: In JSON, `\` must be double-escaped: `\\d` not `\d`
2. **Test the regex**: Use an online regex tester like regex101.com
3. **Check context requirements**: If your rule has `context`, ensure the context word appears within `contextWindow` characters

### False positives?

1. Add context words to reduce matches
2. Use the `allowlist` to exclude specific values
3. Use `paths` to limit where redaction applies

### Performance issues?

- Complex regexes can be slow; simplify patterns where possible
- Avoid overly broad patterns like `.*`
