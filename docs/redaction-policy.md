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
