/**
 * Output security scanning - scan model responses for suspicious content.
 *
 * This module provides regex-based scanning for:
 * - Banned substrings (jailbreak outputs, test patterns)
 * - Custom regex patterns
 * - URL extraction and basic domain checking
 *
 * Zero external dependencies.
 */

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface OutputAlert {
  index: number;
  severity: "high" | "medium" | "low";
  pattern: string;
  match: string;
  offset: number;
  length: number;
}

export interface OutputScanResult {
  isSafe: boolean;
  alerts: OutputAlert[];
  /** Redacted output if redaction was enabled */
  redactedOutput?: string;
}

// ----------------------------------------------------------------------------
// Banned substrings (from llm-guard)
// ----------------------------------------------------------------------------

/**
 * Predefined list of banned substrings for output scanning.
 * Includes jailbreak outputs and test patterns for malware/phishing detection.
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
 * Patterns that indicate potentially dangerous code execution.
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
// URL patterns
// ----------------------------------------------------------------------------

/**
 * Regex to extract URLs from text.
 */
const URL_PATTERN = /https?:\/\/(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\\(\\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+/g;

/**
 * Known malicious domains (simplified blocklist - would need to be maintained).
 */
const SUSPICIOUS_DOMAINS = [
  "evil.com",
  "malware.test",
  "phishing.test",
  "exfiltrate.me",
  "datatheft.io",
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
 * Scan text with custom regex patterns.
 *
 * @param text - The text to scan
 * @param patterns - List of regex patterns to match
 * @param patterns - List of regex patterns to match
 * @param isBlocked - If true, matches are blocked; if false, non-matches are blocked
 * @param redact - If true, replace matches with [REDACTED]
 * @returns Scan result
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
 * Extract URLs from text.
 *
 * @param text - The text to extract URLs from
 * @returns Array of URLs found
 */
export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  URL_PATTERN.lastIndex = 0;

  while ((match = URL_PATTERN.exec(text)) !== null) {
    urls.push(match[0]);
  }

  return urls;
}

/**
 * Scan text for suspicious URLs.
 *
 * @param text - The text to scan
 * @param blockedDomains - List of blocked domains (uses SUSPICIOUS_DOMAINS by default)
 * @returns Scan result
 */
export function scanUrls(
  text: string,
  blockedDomains: string[] = SUSPICIOUS_DOMAINS,
): OutputScanResult {
  const alerts: OutputAlert[] = [];
  const urls = extractUrls(text);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname.toLowerCase();

      for (const blocked of blockedDomains) {
        if (domain === blocked || domain.endsWith(`.${blocked}`)) {
          alerts.push({
            index: i,
            severity: "high",
            pattern: "suspicious_url",
            match: url,
            offset: text.indexOf(url),
            length: url.length,
          });
        }
      }
    } catch {
      // Invalid URL, skip
    }
  }

  return {
    isSafe: alerts.length === 0,
    alerts,
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
 * Combined output scanner - runs all scanners.
 *
 * @param text - The text to scan
 * @param options - Configuration options
 * @returns Combined scan result
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

// ----------------------------------------------------------------------------
// Utility
// ----------------------------------------------------------------------------

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
