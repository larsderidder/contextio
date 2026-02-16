export type AlertSeverity = "high" | "medium" | "info";

interface PatternRule {
  id: string;
  severity: AlertSeverity;
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

  // Base64-encoded instruction blocks (heuristic: long base64 string > 100 chars)
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
// Helper functions
// ----------------------------------------------------------------------------

export function truncateMatch(text: string, start: number, length: number): string {
  const snippet = text.slice(start, start + length);
  return snippet.length > 120 ? `${snippet.slice(0, 117)}...` : snippet;
}
