/**
 * Shared utilities for reading capture files from the capture directory.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CaptureData } from "@contextio/core";

/** Default capture directory: ~/.contextio/captures */
export function captureDir(): string {
  return join(homedir(), ".contextio", "captures");
}

/** List all .json capture files in the directory, sorted by name. */
export function listCaptureFiles(dir?: string): string[] {
  const d = dir ?? captureDir();
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
    .sort();
}

/** Read and parse a capture file. Returns null on any error. */
export function readCapture(filepath: string): CaptureData | null {
  try {
    const raw = fs.readFileSync(filepath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Find the session ID of the most recent capture. */
export function findLastSessionId(dir?: string): string | null {
  const d = dir ?? captureDir();
  const files = listCaptureFiles(d);

  for (let i = files.length - 1; i >= 0; i--) {
    const capture = readCapture(join(d, files[i]));
    if (capture?.sessionId) return capture.sessionId;
  }

  return null;
}

/** Load all captures for a given session ID. */
export function loadSessionCaptures(sessionId: string, dir?: string): CaptureData[] {
  const d = dir ?? captureDir();
  const files = listCaptureFiles(d);
  const captures: CaptureData[] = [];

  for (const file of files) {
    const capture = readCapture(join(d, file));
    if (capture && capture.sessionId === sessionId) {
      captures.push(capture);
    }
  }

  return captures;
}
