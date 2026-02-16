import type { OutputAlert, OutputScanResult } from "./output-scanner.js";

/** Regex to extract HTTP(S) URLs from plain text. */
const URL_PATTERN = /https?:\/\/(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\\(\\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+/g;

/**
 * Placeholder blocklist for suspicious domains. In production this would
 * be a maintained feed; these are test/example domains.
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
