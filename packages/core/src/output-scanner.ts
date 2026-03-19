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
import { escapeRegex, truncateMatch } from "./security-patterns.js";

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
 * Patterns for dangerous code that a model might be tricked into generating.
 *
 * These target the most common prompt-injection-to-code-execution patterns:
 * - eval/exec with base64 payloads (classic obfuscated shell drops)
 * - child_process / subprocess shell calls (direct system access)
 * - writes to /etc/passwd or /etc/shadow (privilege escalation / persistence)
 * - fetch/requests/axios posting to a path named "exfiltrate" (data theft)
 *
 * These are heuristics, not a complete sandbox. They catch the obvious cases;
 * a determined attacker can evade them. The value is catching accidental or
 * unsophisticated injection, not hardening against a motivated adversary.
 */
const DANGEROUS_CODE_PATTERNS = [
  // Shell execution via base64-decoded payloads (Node.js and browser)
  { id: "shell_exec", pattern: /eval\s*\(\s*atob\s*\(/gi, severity: "high" as const },
  { id: "shell_exec", pattern: /eval\s*\(\s*Buffer\.from.*base64/gi, severity: "high" as const },
  { id: "shell_exec", pattern: /exec\s*\(\s*atob\s*\(/gi, severity: "high" as const },
  // Direct subprocess spawning (Node.js and Python)
  { id: "shell_exec", pattern: /child_process.*exec\s*\(/gi, severity: "high" as const },
  { id: "shell_exec", pattern: /subprocess.*shell\s*=\s*True/gi, severity: "medium" as const },
  { id: "shell_exec", pattern: /os\.system\s*\(/gi, severity: "medium" as const },

  // Writes to sensitive system files
  { id: "fs_access", pattern: /fs\.writeFile\s*\(\s*['"]\/etc\/passwd/gi, severity: "high" as const },
  { id: "fs_access", pattern: /open\s*\([^)]*\/etc\/shadow/gi, severity: "high" as const },

  // Data exfiltration to suspiciously named endpoints
  { id: "exfil", pattern: /fetch\s*\(\s*['"]https?:\/\/[^/]*\/exfiltrate/gi, severity: "high" as const },
  { id: "exfil", pattern: /requests\.post\s*\([^)]*\/exfiltrate/gi, severity: "high" as const },
  { id: "exfil", pattern: /axios\.post\s*\([^)]*\/exfiltrate/gi, severity: "high" as const },
];


// ----------------------------------------------------------------------------
// Main scanning functions
// ----------------------------------------------------------------------------

/**
 * Scan text for banned substrings.
 *
 * Each substring is compiled into a regex (with special chars escaped) so
 * multi-line and Unicode text is handled correctly. All matches for all
 * substrings are collected; a single piece of text can trigger multiple alerts.
 *
 * @param text - The text to scan.
 * @param substrings - Substrings to ban. Defaults to {@link OUTPUT_BAN_SUBSTRINGS}.
 * @param caseSensitive - When false (default), matching is case-insensitive.
 * @returns Scan result; `isSafe` is true only if zero substrings matched.
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
 * Supports two modes:
 * - **Blocked mode** (`isBlocked = true`, the default): each match triggers an alert.
 *   Use this to flag output that contains forbidden content.
 * - **Required mode** (`isBlocked = false`): each *absent* pattern triggers an alert.
 *   Use this to enforce that output contains required content (e.g. a disclaimer).
 *   `isSafe` is true when every required pattern was found (zero alerts).
 *
 * @param text - The text to scan.
 * @param patterns - Regex pattern strings, compiled with "gi" flags.
 * @param isBlocked - `true` = alert on matches; `false` = alert on missing matches.
 * @param redact - When `true` and in blocked mode, replace matched text with "[REDACTED]".
 * @returns Scan result with alerts and optionally `redactedOutput`.
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

      if (isBlocked) {
        // Blocked mode: alert on every match, optionally redact.
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          alerts.push({
            index: i,
            severity: "medium",
            pattern: `regex_${i}`,
            match: truncateMatch(text, match.index, match[0].length),
            offset: match.index,
            length: match[0].length,
          });
          if (redact) {
            redacted = redacted.replace(match[0], "[REDACTED]");
          }
        }
      } else {
        // Required mode: alert when the pattern is absent.
        if (!pattern.test(text)) {
          alerts.push({
            index: i,
            severity: "medium",
            pattern: `regex_${i}`,
            match: `(required pattern not found: ${patterns[i]})`,
            offset: 0,
            length: 0,
          });
        }
      }
    } catch {
      // Skip invalid regex
    }
  }

  return {
    // Safe when no alerts were raised, regardless of mode.
    isSafe: alerts.length === 0,
    alerts,
    redactedOutput: redact ? redacted : undefined,
  };
}

/**
 * Scan text for dangerous code patterns from {@link DANGEROUS_CODE_PATTERNS}.
 *
 * Resets `lastIndex` before each pattern because all patterns use the global
 * flag, and re-using a global regex without resetting it will skip matches
 * after the first call.
 *
 * @param text - The text or code snippet to scan.
 * @returns Scan result; `isSafe` is true only if no patterns matched.
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
 * By default all four scanners are active: banned substrings, URL checking,
 * dangerous code patterns, and custom regex. Disable individual scanners by
 * passing `false` for their option; enable redaction by passing `redact: true`.
 *
 * @param text - The LLM response text to scan.
 * @param options.banSubstrings - Override the default ban list. Pass an empty
 *   array to disable banned-substring scanning entirely.
 * @param options.regexPatterns - Additional regex pattern strings to check
 *   (compiled with "gi" flags). Only runs when this array is non-empty.
 * @param options.scanUrls - Set to `false` to skip URL domain checking.
 * @param options.scanCode - Set to `false` to skip dangerous code detection.
 * @param options.redact - When `true`, replace matched regex patterns with
 *   "[REDACTED]" in `redactedOutput`. Does not affect other scanners.
 * @returns Combined alerts from all enabled scanners, plus `isSafe` and
 *   optionally `redactedOutput`.
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

