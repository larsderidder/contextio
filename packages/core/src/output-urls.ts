import type { OutputAlert, OutputScanResult } from "./output-scanner.js";

/** Regex to extract HTTP(S) URLs from plain text. */
const URL_PATTERN = /https?:\/\/(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\\(\\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+/g;

/**
 * Placeholder domain blocklist used by `scanUrls`.
 *
 * These are illustrative examples. In a real deployment you would replace
 * or extend this list with a maintained threat-intel feed. Pass a custom
 * `blockedDomains` array to `scanUrls` to override at call time.
 */
const SUSPICIOUS_DOMAINS = [
  "evil.com",
  "malware.test",
  "phishing.test",
  "exfiltrate.me",
  "datatheft.io",
];

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
 * Scan text for URLs whose domain appears in the blocklist.
 *
 * Subdomains are also matched: blocking "evil.com" also blocks "api.evil.com".
 * Invalid or unparseable URLs are silently skipped.
 *
 * Note: `offset` is computed with `indexOf`, so if the same URL appears
 * multiple times the reported offset will always point to the first occurrence.
 * This is a known limitation; for most alerting purposes it is good enough.
 *
 * @param text - The text to scan.
 * @param blockedDomains - Domains to block (defaults to the built-in placeholder list).
 * @returns Scan result with one alert per blocked URL found.
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
      // Unparseable URL; skip rather than crash
    }
  }

  return {
    isSafe: alerts.length === 0,
    alerts,
  };
}
