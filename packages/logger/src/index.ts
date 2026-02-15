/**
 * @contextio/logger - Capture-to-disk plugin for @contextio/core.
 *
 * Writes raw request/response captures as JSON files to a directory.
 * Uses atomic writes (write to .tmp, then rename) so readers never see
 * partial files.
 *
 * Filenames include the source tool and session ID for easy identification:
 *   claude_a1b2c3d4_1739000000000-000001.json
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CaptureData, ProxyPlugin } from "@contextio/core";

export interface LoggerConfig {
  /**
   * Directory to write capture files to.
   * Default: ~/.contextio/captures
   */
  captureDir?: string;

  /**
   * Maximum number of sessions to keep. Older sessions are pruned on startup.
   * Sessions are identified by their session ID prefix in filenames.
   * Set to 0 to disable retention (keep everything).
   * Default: 0 (no limit)
   */
  maxSessions?: number;
}

export interface LoggerPlugin extends ProxyPlugin {
  /** The resolved directory where captures are written. */
  captureDir: string;
}

/**
 * Create a logger plugin that writes captures to disk.
 *
 * ```typescript
 * import { createLoggerPlugin } from '@contextio/logger';
 *
 * const logger = createLoggerPlugin({ maxSessions: 20 });
 * console.log(logger.captureDir); // ~/.contextio/captures
 * ```
 */
export function createLoggerPlugin(config?: LoggerConfig): LoggerPlugin {
  const captureDir =
    config?.captureDir || join(homedir(), ".contextio", "captures");
  const maxSessions = config?.maxSessions ?? 0;

  let dirReady = false;
  let counter = 0;

  function ensureDir(): void {
    if (dirReady) return;
    fs.mkdirSync(captureDir, { recursive: true });
    dirReady = true;
    if (maxSessions > 0) {
      pruneOldSessions();
    }
  }

  /**
   * Build a filename from capture metadata.
   * Format: {source}_{sessionId}_{timestamp}-{counter}.json
   * Falls back to "unknown" for missing source, omits session if null.
   */
  function buildFilename(capture: CaptureData): string {
    const source = capture.source || "unknown";
    const safe = source.replace(/[^a-zA-Z0-9_-]/g, "_");
    const session = capture.sessionId
      ? `_${capture.sessionId}`
      : "";
    const ts = Date.now();
    const seq = String(counter++).padStart(6, "0");
    return `${safe}${session}_${ts}-${seq}.json`;
  }

  /**
   * Extract the session ID from a capture filename.
   * Returns null if no session ID is present.
   */
  function extractSessionFromFilename(filename: string): string | null {
    // Format: {source}_{sessionId}_{timestamp}-{counter}.json
    // or:     {source}_{timestamp}-{counter}.json (no session)
    const parts = filename.replace(/\.json$/, "").split("_");
    // If there are 4+ parts: source, sessionId, timestamp-counter parts
    // The timestamp part contains a dash: "1739000000000-000001"
    // Session IDs are 8 hex chars
    if (parts.length >= 3) {
      const candidate = parts[1];
      // Session IDs are 8 hex chars
      if (/^[a-f0-9]{8}$/.test(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Prune old sessions, keeping the most recent `maxSessions`.
   */
  function pruneOldSessions(): void {
    try {
      const files = fs.readdirSync(captureDir)
        .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
        .sort(); // lexicographic, but we group by session below

      // Group files by session ID
      const sessionFiles = new Map<string, string[]>();
      const noSessionFiles: string[] = [];

      for (const file of files) {
        const session = extractSessionFromFilename(file);
        if (session) {
          const existing = sessionFiles.get(session) ?? [];
          existing.push(file);
          sessionFiles.set(session, existing);
        } else {
          noSessionFiles.push(file);
        }
      }

      // Find the most recent timestamp per session to sort them
      const sessions = [...sessionFiles.entries()].map(([id, sessionFilesList]) => {
        // Extract the max timestamp from the session's files.
        // Filename format: {source}_{sessionId}_{timestamp}-{counter}.json
        let maxTs = 0;
        for (const f of sessionFilesList) {
          const match = f.match(/_(\d{13})-\d{6}\.json$/);
          if (match) {
            const ts = parseInt(match[1], 10);
            if (ts > maxTs) maxTs = ts;
          }
        }
        return { id, files: sessionFilesList, maxTs };
      });

      // Sort newest first by timestamp
      sessions.sort((a, b) => b.maxTs - a.maxTs);

      // Keep the newest maxSessions, prune the rest
      const toPrune = sessions.slice(maxSessions);
      let pruned = 0;
      for (const session of toPrune) {
        for (const file of session.files) {
          try {
            fs.unlinkSync(join(captureDir, file));
            pruned++;
          } catch {
            // ignore: file may have been removed already
          }
        }
      }

      if (pruned > 0) {
        console.log(
          `[logger] Pruned ${pruned} capture file(s) from ${toPrune.length} old session(s)`,
        );
      }
    } catch {
      // ignore: directory may not exist or be unreadable
    }
  }

  /**
   * Write a capture to disk atomically.
   */
  function write(capture: CaptureData): string | null {
    ensureDir();
    const filename = buildFilename(capture);
    const filePath = join(captureDir, filename);
    const tmpPath = `${filePath}.tmp`;

    try {
      fs.writeFileSync(tmpPath, JSON.stringify(capture));
      fs.renameSync(tmpPath, filePath);
      return filename;
    } catch (err: unknown) {
      console.error(
        "Capture write error:",
        err instanceof Error ? err.message : String(err),
      );
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* may not exist */
      }
      return null;
    }
  }

  // Eagerly create directory and prune on construction, not first write.
  ensureDir();

  return {
    name: "logger",
    captureDir,
    onCapture(capture: CaptureData): void {
      write(capture);
    },
  };
}
