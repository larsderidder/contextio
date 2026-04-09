/**
 * Raw pattern data for prompt injection and jailbreak detection.
 *
 * Shared between `security.ts` (input scanning) and kept separate so the
 * pattern lists can be updated without touching scanner logic. Also exports
 * small utilities (`truncateMatch`, `escapeRegex`) that multiple scanners need.
 */

/** Severity level for a security alert. "info" is observational; "high" warrants action. */
export type AlertSeverity = "high" | "medium" | "info";

/** A single pattern rule used by the tier-1 injection scanner. */
interface PatternRule {
  /** Stable identifier used in alert reports and filtering. */
  id: string;
  severity: AlertSeverity;
  /** Must be stateless (no global flag) since `exec` is called once per string. */
  pattern: RegExp;
}

// ----------------------------------------------------------------------------
// Tier 1: Pattern matching for known injection phrases
// ----------------------------------------------------------------------------

export const TIER1_PATTERNS: PatternRule[] = [
  // Role hijacking
  {
    id: "role_hijack_ignore",
    severity: "high",
    pattern:
      /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier|preceding)\s+instructions/i,
  },
  {
    id: "role_hijack_disregard",
    severity: "high",
    pattern:
      /disregard\s+(?:all\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions|directives|rules|guidelines)/i,
  },
  {
    id: "role_hijack_forget",
    severity: "high",
    pattern:
      /forget\s+(?:all\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions|directives|rules|context)/i,
  },
  {
    id: "role_hijack_new_instructions",
    severity: "high",
    pattern:
      /(?:your\s+new\s+instructions\s+are|from\s+now\s+on\s+you\s+(?:are|will|must|should))/i,
  },
  {
    id: "role_hijack_override",
    severity: "high",
    pattern: /system\s*prompt\s*override/i,
  },
  {
    id: "role_hijack_act_as",
    severity: "high",
    pattern:
      /(?:you\s+are\s+now|act\s+as|pretend\s+(?:to\s+be|you\s+are))\s+(?:DAN|an?\s+unrestricted|an?\s+unfiltered|jailbroken|evil)/i,
  },

  // Known jailbreak templates
  {
    id: "jailbreak_dan",
    severity: "high",
    pattern: /\bDAN\s*(?:mode|prompt|jailbreak|\d+\.\d+)\b/i,
  },
  {
    id: "jailbreak_developer_mode",
    severity: "high",
    pattern: /(?:developer|god)\s*mode\s*(?:enabled|activated|on)\b/i,
  },
  {
    id: "jailbreak_do_anything_now",
    severity: "high",
    pattern: /do\s+anything\s+now/i,
  },

  // Chat template tokens in content (should never appear in user/tool messages)
  {
    id: "chat_template_inst",
    severity: "high",
    pattern: /\[INST\]|\[\/INST\]/,
  },
  {
    id: "chat_template_im",
    severity: "high",
    pattern: /<\|im_start\|>|<\|im_end\|>/,
  },
  {
    id: "chat_template_special",
    severity: "high",
    pattern: /<\|(?:system|user|assistant|endof(?:text|turn)|sep|pad)\|>/,
  },

  // Base64-encoded instruction blocks.
  // 100+ character base64 strings are suspicious in user/tool messages; legitimate
  // content rarely contains them, but attackers use them to hide instructions from
  // human reviewers while the model still decodes and follows them.
  {
    id: "base64_block",
    severity: "medium",
    pattern: /(?:^|[\s:=])([A-Za-z0-9+/]{100,}={0,2})(?:$|[\s])/m,
  },

  // HTML/Markdown injection hiding content
  {
    id: "html_hidden_text",
    severity: "medium",
    pattern:
      /<!--[\s\S]*?(?:ignore|instruction|system|prompt|override)[\s\S]*?-->/i,
  },
  {
    id: "html_invisible_style",
    severity: "medium",
    pattern:
      /style\s*=\s*["'][^"']*(?:font-size\s*:\s*0|display\s*:\s*none|visibility\s*:\s*hidden|color\s*:\s*(?:white|#fff(?:fff)?|rgba?\([^)]*,\s*0\)))[^"']*["']/i,
  },

  // Prompt leaking attempts
  {
    id: "prompt_leak_request",
    severity: "medium",
    pattern:
      /(?:reveal|show|display|output|print|repeat|echo)\s+(?:your\s+)?(?:system\s+prompt|instructions|initial\s+prompt|hidden\s+prompt|original\s+prompt)/i,
  },
];

// ----------------------------------------------------------------------------
// Tier 2: Heuristic analysis for structural anomalies
// ----------------------------------------------------------------------------

/**
 * Patterns that look like AI system instructions. When these appear in
 * tool results, it suggests an injection attempt trying to override the
 * model's behavior through tool output.
 */
export const ROLE_CONFUSION_PATTERNS: RegExp[] = [
  /\bas\s+an?\s+AI\b.*?\byou\s+(?:must|should|will|are)\b/i,
  /\byou\s+are\s+an?\s+(?:helpful|AI|language\s+model|assistant)\b/i,
  /\brespond\s+(?:only\s+)?(?:in|with)\b.*?\bformat\b/i,
  /\balways\s+(?:respond|reply|answer|say)\b/i,
  /\bnever\s+(?:mention|reveal|disclose|say|tell)\b/i,
];

/**
 * Suspicious Unicode characters that can hide content from human review:
 * zero-width spaces/joiners, RTL overrides, invisible separators, soft hyphens.
 */
export const SUSPICIOUS_UNICODE: RegExp =
  /[\u200B-\u200F\u2028-\u202F\uFEFF\u061C\u115F\u1160\u17B4\u17B5\u180E\u2000-\u200A\u2060-\u2064\u2066-\u2069\u206A-\u206F]|\u00AD|\u034F/;

// ----------------------------------------------------------------------------
// Tier 3: Credential detection patterns
//
// Detection-only regexes (no global flag). Used by the security scanner to
// alert when credentials appear in message content. The redact package uses
// these as the canonical source and wraps them in RedactionRule objects with
// replacements and the global flag.
//
// Patterns are listed most-specific first so precise matches are preferred
// when scanners iterate in order.
// ----------------------------------------------------------------------------

/**
 * Shannon entropy of a string: average bits of information per character.
 * Used to gate credential_generic so low-variety values (all-same-char,
 * sequential digits) don't fire. Same algorithm as gitleaks detect/utils.go.
 */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq: Record<string, number> = {};
  for (const c of s) freq[c] = (freq[c] ?? 0) + 1;
  const len = s.length;
  let h = 0;
  for (const count of Object.values(freq)) {
    const p = count / len;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A credential detection rule. `pattern` must NOT use the global flag. */
export interface CredentialPattern {
  /** Stable identifier used in alert reports. */
  id: string;
  /** Human-readable label shown in UI alerts. */
  label: string;
  /** Detection regex. Stateless — no global flag. */
  pattern: RegExp;
  /**
   * Optional allowlist patterns. If any matches the full regex match string,
   * the finding is suppressed. Ported from gitleaks allowlist rules.
   * Each regex is tested against the entire match (not just the captured group).
   */
  allowlist?: RegExp[];
  /**
   * Minimum Shannon entropy (bits/char) required on the first capture group.
   * Findings where the captured value falls below this threshold are suppressed.
   * Mirrors the `entropy` field in gitleaks rules. Default: no check.
   */
  minEntropy?: number;
}

export const CREDENTIAL_PATTERNS: CredentialPattern[] = [
  {
    id: "credential_private_key",
    label: "Private key block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    id: "credential_aws_key",
    label: "AWS access key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: "credential_github",
    label: "GitHub token",
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/,
  },
  {
    id: "credential_anthropic",
    label: "Anthropic API key",
    pattern: /\bsk-ant-(?:api|admin)\d{2}-[a-zA-Z0-9_-]{80,}\b/,
  },
  {
    id: "credential_openai",
    label: "OpenAI API key",
    // Classic format: sk-<20chars>T3BlbkFJ<20chars>
    // Project key format: sk-proj-<chars>
    pattern: /\bsk-(?:[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}|proj-[a-zA-Z0-9_-]{20,})\b/,
  },
  // -------------------------------------------------------------------------
  // Vendor-specific patterns (Tier 1 — distinctive prefixes, near-zero FPs)
  //
  // Patterns ported from gitleaks rules (MIT):
  // https://github.com/gitleaks/gitleaks/tree/master/cmd/generate/config/rules
  // MIT License, Copyright (c) 2019 Zachary Rice
  // -------------------------------------------------------------------------

  {
    id: "credential_gcp_api_key",
    label: "GCP API key",
    // AIza + 35 word-chars or hyphens. Matches the GCP browser/server key format.
    // Allowlist: all-same-character keys (e.g. AIzaaaa...) are placeholder values.
    pattern: /\b(AIza[\w-]{35})\b/,
    allowlist: [
      /^AIza(.)\1{34}$/,  // all same char after prefix = placeholder
    ],
  },

  {
    id: "credential_gcp_service_account",
    label: "GCP service account credential",
    // The literal string that always appears in a GCP service account JSON file.
    pattern: /"type":\s*"service_account"/,
  },

  {
    id: "credential_gitlab",
    label: "GitLab personal access token",
    // glpat- + 20 word/hyphen chars. Covers classic PATs.
    pattern: /\bglpat-[\w-]{20}\b/,
  },

  {
    id: "credential_jwt",
    label: "JSON Web Token (JWT)",
    // Header.Payload.Signature — all three segments start with ey (base64 of '{').
    // Signature may be empty (unsigned JWTs end with a trailing dot).
    // From gitleaks jwt.go GenerateUniqueTokenRegex.
    pattern: /\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9\/\\_-]{17,}\.(?:[a-zA-Z0-9\/\\_-]{10,}={0,2})?/,
  },

  {
    id: "credential_stripe",
    label: "Stripe API key",
    // sk_/rk_ + environment prefix + alphanumeric body.
    // From gitleaks stripe.go GenerateUniqueTokenRegex.
    pattern: /\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}\b/,
  },

  {
    id: "credential_slack",
    label: "Slack token or webhook",
    // Covers bot (xoxb-), user (xoxp-/xoxe-), app (xapp-), config, legacy,
    // and incoming webhook URLs. Each sub-pattern is anchored to its prefix.
    // From gitleaks slack.go rules.
    pattern: /(?:xoxb-[0-9]{8,14}-[0-9]{10,13}[a-zA-Z0-9-]+|xox[pe]-(?:[0-9]{10,13}-){3}[a-zA-Z0-9-]{28,34}|xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+|xoxe\.xox[bp]-\d-[A-Z0-9]{163,166}|xoxe-\d-[A-Z0-9]{146}|xox[osar]-(?:\d-)?[0-9a-zA-Z]{8,48}|hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+\/]{43,56})/i,
    allowlist: [
      /^xoxb-x+(-x+)+$/i,         // all-x placeholder
      /^xoxb-[^-]+-[^-]+$/,       // legacy format with only 2 segments (too short)
      /^xoxp-\d{1,9}(?:-|$)/,     // xoxp- with too-short first segment
    ],
  },

  {
    id: "credential_huggingface",
    label: "HuggingFace token",
    // hf_ + 34 alpha chars (access token), or api_org_ + 34 alpha chars (org token).
    // The all-x placeholder pattern is excluded.
    // From gitleaks huggingface.go GenerateUniqueTokenRegex.
    pattern: /\b(?:hf_[a-zA-Z]{34}|api_org_[a-zA-Z]{34})\b/,
    allowlist: [
      /^hf_x+$/i,       // all-x placeholder
      /^api_org_x+$/i,  // all-x placeholder
    ],
  },

  {
    id: "credential_databricks",
    label: "Databricks API token",
    // dapi + 32 hex chars + optional -N suffix.
    // From gitleaks databricks.go GenerateUniqueTokenRegex.
    pattern: /\bdapi[a-f0-9]{32}(?:-\d)?\b/,
  },

  // -------------------------------------------------------------------------
  // Tier 1 continued: npm, PyPI, HashiCorp Vault, SendGrid
  // -------------------------------------------------------------------------

  {
    id: "credential_npm",
    label: "npm access token",
    // npm_ + 36 lowercase alphanumeric chars. Case-insensitive flag included
    // because the prefix may appear in any case in config files.
    // From gitleaks npm.go GenerateUniqueTokenRegex.
    pattern: /\bnpm_[a-z0-9]{36}\b/i,
  },

  {
    id: "credential_pypi",
    label: "PyPI upload token",
    // Fixed base64 prefix (encodes 'pypi.org') followed by 50-1000 word/hyphen chars.
    // From gitleaks pypi.go.
    pattern: /\bpypi-AgEIcHlwaS5vcmc[\w-]{50,1000}\b/,
  },

  {
    id: "credential_vault",
    label: "HashiCorp Vault token",
    // Covers three token formats:
    //   hvs. (new service tokens, 90-120 word/hyphen chars)
    //   hvb. (batch tokens, 138-300 word/hyphen chars)
    //   s.   (legacy service tokens, 24 alphanumeric chars, case-insensitive)
    // Allowlist suppresses low-entropy s. values (all-same-case strings)
    // and all-x placeholder values.
    // From gitleaks hashicorp_vault.go. Note: allowlists test the full match
    // (not anchored to capture group) because the pattern has no capture group.
    pattern: /\b(?:hvs\.[\w-]{90,120}|hvb\.[\w-]{138,300}|s\.[a-zA-Z0-9]{24})\b/,
    allowlist: [
      /\bs\.[a-z]{24}\b/,    // all-lowercase s. token: low entropy (gitleaks fps)
      /\bs\.[A-Z]{24}\b/,    // all-uppercase s. token: low entropy (gitleaks fps)
      /\bhvs\.x+\b/i,        // all-x hvs. placeholder
      /\bhvb\.x+\b/i,        // all-x hvb. placeholder
    ],
  },

  {
    id: "credential_sendgrid",
    label: "SendGrid API token",
    // SG. + 66 chars from [a-z0-9=_-.] (case-insensitive).
    // From gitleaks sendgrid.go GenerateUniqueTokenRegex.
    pattern: /\bSG\.[a-z0-9=_\-.]{66}\b/i,
  },

  {
    id: "credential_generic",
    label: "Likely API key or secret",
    //
    // Semi-generic pattern ported from gitleaks generic-api-key rule (MIT):
    // https://github.com/gitleaks/gitleaks/blob/master/cmd/generate/config/rules/generic.go
    //
    // Structure:
    //   [\w.-]{0,50}?                 optional prefix (e.g. GOOGLE_CLIENT_)
    //   (?:access|...|token)          keyword anchor anywhere in the variable name
    //   (?:[\w.-]{0,20})              optional suffix after keyword (e.g. _KEY, _STRING)
    //   [\s'"]{0,3}                   optional whitespace/quotes before operator
    //   (?:=|:{1,3}=|:|,|>)          assignment or colon operator
    //   [\x60'"\s=]{0,5}             optional opening quotes/spaces
    //   ([\w.=\-+/]{10,150})         the captured secret value (min 10 chars)
    //   (?:[\x60'"\s;]|\\[nr]|$)     trailing boundary
    //
    // Allowlist patterns suppress findings where the full match string indicates
    // a non-secret context. Ported from gitleaks allowlist rules (MIT).
    pattern:
      /[\w.-]{0,50}?(?:access|auth|api|API|credential|creds|key|passw(?:or)?d|secret|token)(?:[\w.-]{0,20})[\s'"]{0,3}(?:=|:{1,3}=|:|,|>)[\x60'"\s=]{0,5}([\w.=\-+\/]{10,150})(?:[\x60'"\s;]|\\[nr]|$)/im,
    minEntropy: 3.0,
    allowlist: [
      // Label-based: these variable name patterns are not secrets
      /access(?:ibility|or)/i,          // accessor, accessibility
      /access[_.-]?id/i,                // access_id is a reference, not a credential
      /credentials?[_.-]?id/i,          // Jenkins credentialsId
      /primary[_.-]?key/i,              // DB schema term
      /foreign[_.-]?key/i,              // DB schema term
      /public[_.-]?(?:token|key)/i,     // intentionally public values
      /csrf[_.-]?token/i,               // not an API secret
      /\bkeyword\b/i,                   // natural language, not a label
      // Value-based: these value shapes are not secrets
      /^[a-zA-Z_.-]+$/,                 // all-alpha, no digits: not a real secret (gitleaks allowlist #1)
      /^[A-Z0-9][A-Z0-9_-]*[A-Z][A-Z0-9_-]*=?$/,  // SCREAMING_SNAKE_CASE or MACRO-NAMES: env var names, not values
      /https?:\/\//i,                   // URL values are not secrets
      // Empty next-line pattern: KEY=\nNEXT_KEY= means both values are empty (gitleaks allowlist)
      /[A-Z_]+=$/m,                     // captured value is itself an empty env var assignment
    ],
  },
];

// ----------------------------------------------------------------------------
// Helper functions
// ----------------------------------------------------------------------------

/**
 * Extract a snippet from `text` at `[start, start+length)`, capped at 120 chars.
 * Used to keep alert `match` fields readable without embedding huge strings.
 */
export function truncateMatch(text: string, start: number, length: number): string {
  const snippet = text.slice(start, start + length);
  return snippet.length > 120 ? `${snippet.slice(0, 117)}...` : snippet;
}

/**
 * Escape special regex characters in a string so it can be embedded
 * in a RegExp pattern without treating any character as a metacharacter.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
