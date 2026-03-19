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

/** A credential detection rule. `pattern` must NOT use the global flag. */
export interface CredentialPattern {
  /** Stable identifier used in alert reports. */
  id: string;
  /** Human-readable label shown in UI alerts. */
  label: string;
  /** Detection regex. Stateless — no global flag. */
  pattern: RegExp;
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
  {
    id: "credential_generic",
    label: "Likely API key or secret",
    // Context-gated: fires only when a credential-hinting label is nearby.
    // Covers: api_key=, token:, secret=, password=, bearer <value>
    pattern:
      /(?<=(?:api[_-]?key|apikey|access[_-]?key|token|secret|password|passwd|bearer)\s*[=:]\s*["']?)[A-Za-z0-9/+_.=-]{20,}(?=["']?(?:\s|$))/im,
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
