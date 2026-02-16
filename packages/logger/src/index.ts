/**
 * @contextio/logger
 *
 * Capture-to-disk plugin for the contextio proxy. Writes every
 * request/response pair as a JSON file using atomic writes (write to
 * .tmp, then rename) so readers never see half-written files.
 *
 * Filename format: `{source}_{sessionId}_{timestamp}-{counter}.json`
 * Example: `claude_a1b2c3d4_1739000000000-000001.json`
 *
 * @packageDocumentation
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CaptureData, ProxyPlugin } from "@contextio/core";

/** Configuration for {@link createLoggerPlugin}. */
export interface LoggerConfig {
  /**
   * Directory to write capture files to.
   * Default: `~/.contextio/captures`
   */
  captureDir?: string;

  /**
   * Maximum number of sessions to retain. On startup, the plugin
   * groups existing captures by session ID and deletes the oldest
   * sessions beyond this limit.
   *
   * Set to 0 to keep everything (no pruning). Default: 0.
   */
  maxSessions?: number;
}

/**
 * Extended plugin interface that exposes the resolved capture directory.
 * Useful for CLI output (telling the user where captures are written).
 */
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

  /** Create the capture directory if needed, and prune old sessions on first call. */
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
   *
   * Filename format: `{source}_{sessionId}_{timestamp}-{counter}.json`
   * The session ID is the second underscore-delimited segment and is
   * always 8 lowercase hex chars. Returns null if not present.
   */
  function extractSessionFromFilename(filename: string): string | null {
    const parts = filename.replace(/\.json$/, "").split("_");
    if (parts.length >= 3) {
      const candidate = parts[1];
      if (/^[a-f0-9]{8}$/.test(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Delete capture files from the oldest sessions, keeping the most
   * recent `maxSessions`. Groups files by session ID, sorts by newest
   * timestamp, and removes everything beyond the limit.
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
   * Write a capture to disk atomically (write to .tmp, then rename).
   * Returns the filename on success, null on failure.
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
