/**
 * Header filtering for captures.
 *
 * The proxy logs headers for debugging but must never persist secrets
 * like API keys or auth tokens. This module is the single source of
 * truth for which headers get stripped before writing to disk.
 */

/**
 * Header names (lowercase) that must never be written to capture files.
 * Checked case-insensitively by `selectHeaders()`.
 */
export const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "x-target-url",
  "proxy-authorization",
  "x-auth-token",
  "x-forwarded-authorization",
  "www-authenticate",
  "proxy-authenticate",
  "x-goog-api-key",
]);

/**
 * Return a copy of `headers` with sensitive entries removed.
 *
 * Also filters out non-string values; Node's `IncomingHttpHeaders`
 * can represent multi-valued headers as `string[]`, but captures
 * store everything as `Record<string, string>`.
 */
export function selectHeaders(
  headers: Record<string, any>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) continue;
    if (typeof val === "string") result[key] = val;
  }
  return result;
}
