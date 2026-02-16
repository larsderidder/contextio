/**
 * Export command: bundle session captures into a single shareable JSON file.
 *
 * Optionally redacts request/response bodies (keeping only metadata)
 * for sharing without leaking prompts or generated content.
 */

import fs from "node:fs";

import type { CaptureData } from "@contextio/core";

import type { ExportArgs } from "./args.js";
import { findLastSessionId, loadSessionCaptures } from "./captures.js";

/** The shape of an exported session file. */
interface ExportSession {
  sessionId: string;
  source: string;
  exportedAt: string;
  captures: CaptureData[];
  summary: {
    requests: number;
    totalMs: number;
    models: string[];
  };
}

/** Strip request/response bodies from a capture, keeping only metadata. */
function redactCapture(capture: CaptureData): CaptureData {
  return {
    ...capture,
    requestBody: null,
    responseBody: "[redacted]",
  };
}

/**
 * Export a session's captures to a single JSON file.
 *
 * @returns Exit code (0 on success, 1 on error).
 */
export async function runExport(args: ExportArgs): Promise<number> {
  let sessionId = args.session;

  if (!sessionId && args.last) {
    sessionId = findLastSessionId();
    if (!sessionId) {
      console.error("No sessions found");
      return 1;
    }
  }

  if (!sessionId) {
    console.error("Must specify session ID or --last");
    return 1;
  }

  const captures = loadSessionCaptures(sessionId);
  if (captures.length === 0) {
    console.error(`No captures found for session ${sessionId}`);
    return 1;
  }

  const source = captures[0]?.source || "unknown";
  const models = [...new Set(captures.map((c) => {
    const model = c.requestBody?.model;
    return typeof model === "string" ? model : "unknown";
  }))];
  const totalMs = captures.reduce((sum, c) => sum + (c.timings?.total_ms || 0), 0);

  const processedCaptures = args.redact
    ? captures.map(redactCapture)
    : captures;

  const exportData: ExportSession = {
    sessionId,
    source,
    exportedAt: new Date().toISOString(),
    captures: processedCaptures,
    summary: {
      requests: captures.length,
      totalMs,
      models,
    },
  };

  const outputPath = args.outputPath || `session-${sessionId}.json`;

  fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2));
  console.log(`Exported ${captures.length} requests to ${outputPath}`);

  return 0;
}
