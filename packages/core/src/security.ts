/**
 * Input security scanning for prompt injection and suspicious patterns.
 *
 * Two tiers of detection:
 *
 * **Tier 1 (pattern matching):** Known injection phrases like "ignore previous
 * instructions", jailbreak templates (DAN, developer mode), and chat template
 * tokens that should never appear in user content.
 *
 * **Tier 2 (heuristic):** Role confusion in tool results (AI instructions
 * embedded in tool output), suspicious Unicode characters (zero-width,
 * RTL overrides) that could hide content from human review.
 *
 * Zero external dependencies.
 */

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type AlertSeverity = "high" | "medium" | "info";

/** A single security finding from scanning input content. */
export interface SecurityAlert {
  /** Message index in the conversation (0-based). */
  index: number;
  /** Message role ("user", "assistant", "tool"), or null if unknown. */
  role: string | null;
  /** Tool name if this alert came from tool output content. */
  toolName: string | null;
  severity: AlertSeverity;
  /** Machine-readable pattern ID (matches a TIER1_PATTERNS id or "role_confusion"/"suspicious_unicode"). */
  pattern: string;
  /** The matched text snippet, truncated to ~120 chars. */
  match: string;
  /** Character offset where the match starts in the scanned text. */
  offset: number;
  /** Length of the matched region in characters. */
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
 * Patterns that look like AI system instructions. When these appear in
 * tool results, it suggests an injection attempt trying to override the
 * model's behavior through tool output.
 */
const ROLE_CONFUSION_PATTERNS: RegExp[] = [
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
 * Scan a single text string for prompt injection patterns.
 *
 * Runs both tier 1 (known phrases) and tier 2 (heuristic) checks.
 * Tier 2 role confusion checks only run when the content role is "tool".
 *
 * @param text - The text to scan.
 * @param options - Optional: role, tool name, and whether to skip system messages.
 * @returns Alerts found, plus a severity summary.
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
 * Scan a conversation's messages for prompt injection.
 *
 * Iterates over the message array, skipping system/developer messages
 * (those are trusted). Extracts text from various content formats
 * (Anthropic content blocks, Gemini parts, plain strings) and scans each.
 *
 * @param messages - Message array from the request body.
 * @returns Combined alerts from all scanned messages, with per-message indices.
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
