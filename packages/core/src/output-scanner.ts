/**
 * Output security scanning for model responses.
 *
 * Scans LLM output for:
 * - Jailbreak indicators (DAN mode markers, EICAR test strings)
 * - Dangerous code patterns (eval+atob, child_process, fs writes to /etc/)
 * - Suspicious URLs (known malicious domains)
 * - Custom regex patterns (user-configurable)
 *
 * Each scanner can run independently or combined via `scanOutput()`.
 *
 * Zero external dependencies.
 */

import { extractUrls, scanUrls } from "./output-urls.js";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/** A single finding from output scanning. */
export interface OutputAlert {
  /** Index of the matched rule or pattern within its scanner. */
  index: number;
  severity: "high" | "medium" | "low";
  /** Scanner-specific pattern identifier (e.g. "ban_substring", "shell_exec"). */
  pattern: string;
  /** The matched text, truncated to ~120 chars. */
  match: string;
  /** Character offset in the scanned text. */
  offset: number;
  /** Length of the matched region. */
  length: number;
}

/** Result from any output scanner. */
export interface OutputScanResult {
  /** True if no alerts were found. */
  isSafe: boolean;
  alerts: OutputAlert[];
  /** The input text with matches replaced by "[REDACTED]", if redaction was enabled. */
  redactedOutput?: string;
}

// ----------------------------------------------------------------------------
// Banned substrings (from llm-guard)
// ----------------------------------------------------------------------------

/**
 * Substrings that indicate a compromised or jailbroken model response.
 *
 * Includes DAN/jailbreak output markers, the EICAR antivirus test string,
 * GTUBE anti-spam test, GTPHISH anti-phishing test, and markdown image
 * injection (`![http`) which can exfiltrate data via image URLs.
 */
export const OUTPUT_BAN_SUBSTRINGS = [
  // Jailbreak outputs
  "[DAN]",
  "DAN:",
  "DAN Mode enabled",
  "ANTI-DAN:",
  "[🔓JAILBREAK]",
  "successfully jailbroken",
  "STAN:",
  "DUDE:",
  "(🔓Developer Mode Output)",
  "![http",  // Potential markdown image injection

  // Test patterns
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*", // EICAR
  "XJS*C4JDBQADN1.NSBN3*2IDNEN*GTUBE-STANDARD-ANTI-UBE-TEST-EMAIL*C.34X", // GTUBE
  "XJS*C4JDBQADN1.NSBN3*2IDNEN*GTPHISH-STANDARD-ANTI-PHISH-TEST-EMAIL*C.34X", // GTPHISH
];

// ----------------------------------------------------------------------------
// Dangerous code patterns
// ----------------------------------------------------------------------------

/**
 * Patterns for dangerous code that a model might be tricked into generating:
 * shell execution via eval/atob, direct child_process spawning, writes to
 * sensitive system files, and network exfiltration to suspicious endpoints.
 */
const DANGEROUS_CODE_PATTERNS = [
  // Shell execution
  { id: "shell_exec", pattern: /eval\s*\(\s*atob\s*\(/gi, severity: "high" as const },
  { id: "shell_exec", pattern: /eval\s*\(\s*Buffer\.from.*base64/gi, severity: "high" as const },
  { id: "shell_exec", pattern: /exec\s*\(\s*atob\s*\(/gi, severity: "high" as const },
  { id: "shell_exec", pattern: /child_process.*exec\s*\(/gi, severity: "high" as const },
  { id: "shell_exec", pattern: /subprocess.*shell\s*=\s*True/gi, severity: "medium" as const },
  { id: "shell_exec", pattern: /os\.system\s*\(/gi, severity: "medium" as const },

  // File system
  { id: "fs_access", pattern: /fs\.writeFile\s*\(\s*['"]\/etc\/passwd/gi, severity: "high" as const },
  { id: "fs_access", pattern: /open\s*\([^)]*\/etc\/shadow/gi, severity: "high" as const },

  // Network exfiltration
  { id: "exfil", pattern: /fetch\s*\(\s*['"]https?:\/\/[^\/]*\/exfiltrate/gi, severity: "high" as const },
  { id: "exfil", pattern: /requests\.post\s*\([^)]*\/exfiltrate/gi, severity: "high" as const },
  { id: "exfil", pattern: /axios\.post\s*\([^)]*\/exfiltrate/gi, severity: "high" as const },
];


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
 * Scan text for banned substrings.
 *
 * @param text - The text to scan
 * @param substrings - List of substrings to ban (uses OUTPUT_BAN_SUBSTRINGS by default)
 * @param caseSensitive - Whether to match case-sensitively
 * @returns Scan result
 */
export function scanBanSubstrings(
  text: string,
  substrings: string[] = OUTPUT_BAN_SUBSTRINGS,
  caseSensitive = false,
): OutputScanResult {
  const alerts: OutputAlert[] = [];
  const flags = caseSensitive ? "g" : "gi";

  for (let i = 0; i < substrings.length; i++) {
    const substring = substrings[i];
    try {
      const pattern = new RegExp(escapeRegex(substring), flags);
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(text)) !== null) {
        alerts.push({
          index: i,
          severity: "high",
          pattern: "ban_substring",
          match: truncateMatch(text, match.index, match[0].length),
          offset: match.index,
          length: match[0].length,
        });
      }
    } catch {
      // Skip invalid regex
    }
  }

  return {
    isSafe: alerts.length === 0,
    alerts,
  };
}

/**
 * Scan text against a list of custom regex patterns.
 *
 * @param text - The text to scan.
 * @param patterns - Regex pattern strings (compiled with "gi" flags).
 * @param isBlocked - If true, matches trigger alerts. If false, absence of matches triggers alerts.
 * @param redact - If true, replace matched text with "[REDACTED]" in the output.
 * @returns Scan result with alerts and optionally redacted text.
 */
export function scanRegex(
  text: string,
  patterns: string[],
  isBlocked = true,
  redact = false,
): OutputScanResult {
  const alerts: OutputAlert[] = [];
  let redacted = text;

  for (let i = 0; i < patterns.length; i++) {
    try {
      const pattern = new RegExp(patterns[i], "gi");
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(text)) !== null) {
        const alert: OutputAlert = {
          index: i,
          severity: "medium",
          pattern: `regex_${i}`,
          match: truncateMatch(text, match.index, match[0].length),
          offset: match.index,
          length: match[0].length,
        };

        if (isBlocked) {
          alerts.push(alert);
          if (redact) {
            redacted = redacted.replace(match[0], "[REDACTED]");
          }
        }
      }
    } catch {
      // Skip invalid regex
    }
  }

  return {
    isSafe: isBlocked ? alerts.length === 0 : alerts.length === patterns.length,
    alerts,
    redactedOutput: redact ? redacted : undefined,
  };
}

/**
 * Scan text for dangerous code patterns.
 *
 * @param text - The code/text to scan
 * @returns Scan result
 */
export function scanDangerousCode(text: string): OutputScanResult {
  const alerts: OutputAlert[] = [];

  for (const rule of DANGEROUS_CODE_PATTERNS) {
    // Reset lastIndex to ensure consistent matching
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = rule.pattern.exec(text)) !== null) {
      alerts.push({
        index: 0,
        severity: rule.severity,
        pattern: rule.id,
        match: truncateMatch(text, match.index, match[0].length),
        offset: match.index,
        length: match[0].length,
      });
    }
  }

  return {
    isSafe: alerts.length === 0,
    alerts,
  };
}

/**
 * Run all output scanners on a piece of text.
 *
 * By default, runs banned substring checks, URL scanning, and dangerous
 * code detection. Custom regex patterns and redaction are opt-in.
 *
 * @param text - The text to scan.
 * @param options - Override default behavior: custom ban lists, regex patterns, toggle scanners.
 * @returns Combined result from all enabled scanners.
 */
export function scanOutput(
  text: string,
  options?: {
    banSubstrings?: string[];
    regexPatterns?: string[];
    scanUrls?: boolean;
    scanCode?: boolean;
    redact?: boolean;
  },
): OutputScanResult {
  const allAlerts: OutputAlert[] = [];
  let redactedOutput = text;

  // Banned substrings - default on unless explicitly set to false
  const banSubstringsSetting = options?.banSubstrings;
  const shouldRunBanSubstrings = banSubstringsSetting === undefined || Array.isArray(banSubstringsSetting);
  if (shouldRunBanSubstrings) {
    const result = scanBanSubstrings(
      text,
      Array.isArray(banSubstringsSetting) ? banSubstringsSetting : OUTPUT_BAN_SUBSTRINGS,
    );
    allAlerts.push(...result.alerts);
  }

  // Custom regex
  const regexPatterns = options?.regexPatterns;
  if (regexPatterns && regexPatterns.length > 0) {
    const result = scanRegex(
      text,
      regexPatterns,
      true,
      options?.redact ?? false,
    );
    allAlerts.push(...result.alerts);
    if (options?.redact && result.redactedOutput) {
      redactedOutput = result.redactedOutput;
    }
  }

  // URLs - default on unless explicitly set to false
  const scanUrlsSetting = options?.scanUrls;
  const shouldScanUrls = scanUrlsSetting === undefined || scanUrlsSetting === true;
  if (shouldScanUrls) {
    const result = scanUrls(text);
    allAlerts.push(...result.alerts);
  }

  // Dangerous code - default on unless explicitly set to false
  const scanCodeSetting = options?.scanCode;
  const shouldScanCode = scanCodeSetting === undefined || scanCodeSetting === true;
  if (shouldScanCode) {
    const result = scanDangerousCode(text);
    allAlerts.push(...result.alerts);
  }

  return {
    isSafe: allAlerts.length === 0,
    alerts: allAlerts,
    redactedOutput: options?.redact ? redactedOutput : undefined,
  };
}

export { extractUrls, scanUrls };

// ----------------------------------------------------------------------------
// Utility
// ----------------------------------------------------------------------------

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
