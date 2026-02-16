/**
 * Security scanning for prompt injection and suspicious patterns.
 *
 * This module provides regex-based scanning for:
 * - Tier 1: Known prompt injection patterns (role hijacking, jailbreak templates)
 * - Tier 2: Heuristic analysis (role confusion in tool results, suspicious Unicode)
 *
 * Zero external dependencies.
 */

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type AlertSeverity = "high" | "medium" | "info";

export interface SecurityAlert {
  /** Index for multi-part content (message index, block index) */
  index: number;
  /** Role if applicable (user, assistant, tool) */
  role: string | null;
  /** Tool name if the content is from a tool */
  toolName: string | null;
  severity: AlertSeverity;
  /** Machine-readable pattern identifier */
  pattern: string;
  /** The matched text snippet (truncated to ~120 chars) */
  match: string;
  /** Character offset where the match starts */
  offset: number;
  /** Length of the matched region */
  length: number;
}

export interface SecuritySummary {
  high: number;
  medium: number;
  info: number;
}

export interface SecurityResult {
  alerts: SecurityAlert[];
  summary: SecuritySummary;
}

// ----------------------------------------------------------------------------
// Tier 1: Pattern matching for known injection phrases
// ----------------------------------------------------------------------------

interface PatternRule {
  id: string;
  severity: AlertSeverity;
  pattern: RegExp;
}

const TIER1_PATTERNS: PatternRule[] = [
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
 * Detect role confusion: imperative AI instructions appearing in tool results.
 */
const ROLE_CONFUSION_PATTERNS: RegExp[] = [
  /\bas\s+an?\s+AI\b.*?\byou\s+(?:must|should|will|are)\b/i,
  /\byou\s+are\s+an?\s+(?:helpful|AI|language\s+model|assistant)\b/i,
  /\brespond\s+(?:only\s+)?(?:in|with)\b.*?\bformat\b/i,
  /\balways\s+(?:respond|reply|answer|say)\b/i,
  /\bnever\s+(?:mention|reveal|disclose|say|tell)\b/i,
];

/**
 * Detect unusual Unicode: zero-width characters, RTL overrides, homoglyphs.
 */
const SUSPICIOUS_UNICODE: RegExp =
  /[\u200B-\u200F\u2028-\u202F\uFEFF\u061C\u115F\u1160\u17B4\u17B5\u180E\u2000-\u200A\u2060-\u2064\u2066-\u2069\u206A-\u206F]|\u00AD|\u034F/;

// ----------------------------------------------------------------------------
// Helper functions
// ----------------------------------------------------------------------------

function truncateMatch(text: string, start: number, length: number): string {
  const snippet = text.slice(start, start + length);
  return snippet.length > 120 ? `${snippet.slice(0, 117)}...` : snippet;
}

// ----------------------------------------------------------------------------
// Main scanning functions
// ----------------------------------------------------------------------------

/**
 * Scan a string for prompt injection patterns.
 *
 * @param text - The text to scan
 * @param options - Scanning options
 * @returns Security result with alerts
 */
export function scanSecurity(
  text: string,
  options?: {
    /** Skip system/developer message scanning (they're trusted) */
    skipSystemMessages?: boolean;
    /** Role of the content being scanned */
    role?: string;
    /** Tool name if this is tool output */
    toolName?: string | null;
  },
): SecurityResult {
  const alerts: SecurityAlert[] = [];

  if (!text || typeof text !== "string") {
    return { alerts, summary: { high: 0, medium: 0, info: 0 } };
  }

  // Skip system messages if configured
  if (options?.skipSystemMessages && (options.role === "system" || options.role === "developer")) {
    return { alerts, summary: { high: 0, medium: 0, info: 0 } };
  }

  const role = options?.role ?? "unknown";
  const toolName = options?.toolName ?? null;
  const isToolResult = role === "tool";

  // --- Tier 1: Pattern matching ---
  for (const rule of TIER1_PATTERNS) {
    const match = rule.pattern.exec(text);
    if (match) {
      alerts.push({
        index: 0,
        role,
        toolName,
        severity: rule.severity,
        pattern: rule.id,
        match: truncateMatch(text, match.index, match[0].length),
        offset: match.index,
        length: match[0].length,
      });
    }
  }

  // --- Tier 2: Role confusion (only in tool results) ---
  if (isToolResult) {
    for (const pat of ROLE_CONFUSION_PATTERNS) {
      const match = pat.exec(text);
      if (match) {
        alerts.push({
          index: 0,
          role,
          toolName,
          severity: "medium",
          pattern: "role_confusion",
          match: truncateMatch(text, match.index, match[0].length),
          offset: match.index,
          length: match[0].length,
        });
        break; // One role confusion alert per message is enough
      }
    }
  }

  // --- Tier 2: Suspicious Unicode ---
  const unicodeMatch = SUSPICIOUS_UNICODE.exec(text);
  if (unicodeMatch) {
    // Count total suspicious chars
    const count = (text.match(new RegExp(SUSPICIOUS_UNICODE.source, "g")) || []).length;
    alerts.push({
      index: 0,
      role,
      toolName,
      severity: "info",
      pattern: "suspicious_unicode",
      match: `${count} suspicious Unicode character${count > 1 ? "s" : ""} (zero-width, RTL override, etc.)`,
      offset: unicodeMatch.index,
      length: 1,
    });
  }

  // Build summary
  const summary: SecuritySummary = { high: 0, medium: 0, info: 0 };
  for (const alert of alerts) {
    summary[alert.severity]++;
  }

  return { alerts, summary };
}

/**
 * Scan request messages for prompt injection.
 *
 * Extracts and scans user messages and tool results from the request body.
 *
 * @param messages - Array of messages from the request
 * @returns Security result
 */
export function scanRequestMessages(
  messages: Array<{
    role: string;
    content?: string | null;
    parts?: Array<{ text?: string }> | null;
    content_blocks?: Array<{ type: string; text?: string; content?: string }> | null;
  }>,
): SecurityResult {
  const alerts: SecurityAlert[] = [];
  let index = 0;

  for (const msg of messages ?? []) {
    const role = msg.role;

    // Skip system and developer messages (they're trusted)
    if (role === "system" || role === "developer") {
      index++;
      continue;
    }

    // Extract text content from various formats
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.parts)) {
      text = msg.parts.map((p) => p.text ?? "").join("\n");
    } else if (Array.isArray(msg.content_blocks)) {
      // Anthropic content_blocks
      text = msg.content_blocks
        .map((b) => b.text ?? b.content ?? "")
        .join("\n");
    }

    if (text) {
      const result = scanSecurity(text, { role, skipSystemMessages: true });
      // Adjust indices for each message
      for (const alert of result.alerts) {
        alert.index = index;
        alerts.push(alert);
      }
    }

    index++;
  }

  const summary: SecuritySummary = { high: 0, medium: 0, info: 0 };
  for (const alert of alerts) {
    summary[alert.severity]++;
  }

  return { alerts, summary };
}
