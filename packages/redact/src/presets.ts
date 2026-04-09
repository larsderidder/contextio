/**
 * Built-in presets for @contextio/redact.
 *
 * Each preset is an ordered array of RedactionRules.
 * Presets build on each other: pii includes secrets, strict includes pii.
 *
 * Credential patterns (private key, AWS, GitHub, Anthropic, OpenAI, generic
 * secret assignment) are derived from the canonical CREDENTIAL_PATTERNS in
 * @contextio/core/security-patterns so detection and redaction stay in sync.
 */

import { CREDENTIAL_PATTERNS, shannonEntropy } from "@contextio/core";

import type { RedactionRule } from "./rules.js";

/**
 * Build a RedactionRule from a CredentialPattern by adding a global flag and
 * a replacement string. The source pattern must not already have the global flag.
 *
 * Carries over the CredentialPattern's allowlist so detection and redaction
 * stay in sync — FP suppression rules are not silently dropped.
 */
function toRule(id: string, replacement: string): RedactionRule {
  const cp = CREDENTIAL_PATTERNS.find((p) => p.id === id);
  if (!cp) throw new Error(`Unknown credential pattern id: ${id}`);
  // Re-compile with global flag for use in string.replace()
  const src = cp.pattern.source;
  const flags = cp.pattern.flags.includes("g") ? cp.pattern.flags : `g${cp.pattern.flags}`;
  const rule: RedactionRule = { name: id, pattern: new RegExp(src, flags), replacement };
  if (cp.allowlist) rule.allowlist = cp.allowlist;
  if (cp.minEntropy !== undefined) rule.minEntropy = cp.minEntropy;
  return rule;
}

// ---- Secrets preset ----
// High-confidence patterns for API keys, tokens, and credentials.
// Very low false-positive rate; safe to run on all traffic.

const SECRETS_RULES: RedactionRule[] = [
  // Private key blocks — match the full block including content
  {
    name: "private-key",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    replacement: "[PRIVATE_KEY_REDACTED]",
  },
  toRule("credential_aws_key", "[AWS_KEY_REDACTED]"),
  // AWS secret key — not in CREDENTIAL_PATTERNS (it's assignment-context-only)
  {
    name: "aws-secret-key",
    pattern:
      /(?<=(?:aws_secret_access_key|secret_?key|SECRET_?KEY)\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}(?=["']?\s)/g,
    replacement: "[AWS_SECRET_REDACTED]",
  },
  toRule("credential_github", "[GITHUB_TOKEN_REDACTED]"),
  toRule("credential_anthropic", "[ANTHROPIC_KEY_REDACTED]"),
  toRule("credential_openai", "[OPENAI_KEY_REDACTED]"),
  toRule("credential_gcp_api_key", "[GCP_API_KEY_REDACTED]"),
  toRule("credential_gcp_service_account", "[GCP_SERVICE_ACCOUNT_REDACTED]"),
  toRule("credential_gitlab", "[GITLAB_TOKEN_REDACTED]"),
  toRule("credential_jwt", "[JWT_REDACTED]"),
  toRule("credential_stripe", "[STRIPE_KEY_REDACTED]"),
  toRule("credential_slack", "[SLACK_TOKEN_REDACTED]"),
  toRule("credential_huggingface", "[HUGGINGFACE_TOKEN_REDACTED]"),
  toRule("credential_databricks", "[DATABRICKS_TOKEN_REDACTED]"),
  toRule("credential_npm", "[NPM_TOKEN_REDACTED]"),
  toRule("credential_pypi", "[PYPI_TOKEN_REDACTED]"),
  toRule("credential_vault", "[VAULT_TOKEN_REDACTED]"),
  toRule("credential_sendgrid", "[SENDGRID_TOKEN_REDACTED]"),
  // Broader prefix-based catch-all (sk-, pk-, api-, key-, token- prefixed values)
  {
    name: "api-key-prefixed",
    pattern: /\b(?:sk|pk|api|key|token)[-_][A-Za-z0-9_-]{20,}\b/g,
    replacement: "[API_KEY_REDACTED]",
  },
  toRule("credential_generic", "[SECRET_REDACTED]"),
];

// ---- PII preset ----
// Structured PII patterns: things with a defined format.
// Some rules use context words to reduce false positives.

const PII_RULES: RedactionRule[] = [
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[EMAIL_REDACTED]",
  },
  {
    name: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[SSN_REDACTED]",
    context: [
      "ssn",
      "social security",
      "social-security",
      "tax",
      "taxpayer",
    ],
    contextWindow: 200,
  },
  {
    name: "credit-card",
    pattern:
      /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{1,7}\b/g,
    replacement: "[CC_REDACTED]",
    context: [
      "credit",
      "card",
      "visa",
      "mastercard",
      "amex",
      "discover",
      "payment",
      "billing",
      "cc",
    ],
    contextWindow: 200,
  },
  {
    name: "phone-us",
    pattern:
      /(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}\b/g,
    replacement: "[PHONE_REDACTED]",
    context: [
      "phone",
      "call",
      "mobile",
      "cell",
      "tel",
      "fax",
      "contact",
      "reach",
    ],
    contextWindow: 200,
  },
  {
    name: "phone-eu",
    pattern:
      /\+(?:31|32|33|34|39|41|43|44|45|46|47|48|49)[\s\-\.]?(?:\d[\s\-\.]?){8,11}\b/g,
    replacement: "[PHONE_REDACTED]",
    context: [
      "phone",
      "call",
      "mobile",
      "cell",
      "tel",
      "contact",
      "reach",
      "number",
    ],
    contextWindow: 200,
  },
  {
    name: "iban",
    pattern:
      /\b[A-Z]{2}\d{2}(?:[\s]?[A-Z0-9]){11,26}\b/g,
    replacement: "[IBAN_REDACTED]",
    context: [
      "iban",
      "bank",
      "account",
      "rekening",
      "compte",
      "konto",
      "transfer",
      "payment",
    ],
    contextWindow: 200,
  },
];

// ---- Strict preset ----
// Everything above plus IP addresses, URLs, dates near PII context,
// and international PII patterns with higher false-positive risk.

const STRICT_RULES: RedactionRule[] = [
  {
    name: "ipv4",
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    replacement: "[IP_REDACTED]",
  },
  {
    name: "ipv6",
    pattern:
      /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
    replacement: "[IP_REDACTED]",
  },
  {
    name: "date-of-birth",
    pattern:
      /\b(?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])[-/](?:19|20)\d{2}\b/g,
    replacement: "[DOB_REDACTED]",
    context: [
      "birth",
      "birthday",
      "dob",
      "born",
      "date of birth",
      "age",
    ],
    contextWindow: 200,
  },
  {
    name: "bsn-dutch",
    pattern: /\b\d{9}\b/g,
    replacement: "[BSN_REDACTED]",
    context: [
      "bsn",
      "burgerservicenummer",
      "sofinummer",
      "sofi",
      "burgerservice",
      "citizen service number",
      "dutch",
      "netherlands",
      "nederland",
    ],
    contextWindow: 200,
  },
  {
    name: "ni-number-uk",
    pattern: /\b[A-CEGHJ-PR-TW-Z]{2}[\s]?\d{2}[\s]?\d{2}[\s]?\d{2}[\s]?[A-D\s]\b/g,
    replacement: "[NI_NUMBER_REDACTED]",
    context: [
      "ni number",
      "national insurance",
      "nino",
      "ni-nummer",
      "uk",
      "british",
      "united kingdom",
    ],
    contextWindow: 200,
  },
  {
    name: "passport-number",
    pattern: /\b[A-Z]{1,2}\d{6,9}\b/g,
    replacement: "[PASSPORT_REDACTED]",
    context: [
      "passport",
      "paspoort",
      "passeport",
      "reisepass",
      "travel document",
      "passport number",
      "passport nr",
      "passport#",
    ],
    contextWindow: 100,
  },
];

export type PresetName = "secrets" | "pii" | "strict";

/**
 * Built-in presets. Each higher tier includes all rules from lower tiers.
 */
export const PRESETS: Record<PresetName, RedactionRule[]> = {
  secrets: [...SECRETS_RULES],
  pii: [...SECRETS_RULES, ...PII_RULES],
  strict: [...SECRETS_RULES, ...PII_RULES, ...STRICT_RULES],
};
