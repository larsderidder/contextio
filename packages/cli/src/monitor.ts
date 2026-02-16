import fs from "node:fs";
import { join } from "node:path";

import { estimateCost, parseResponseUsage, type CaptureData } from "@contextio/core";

import type { MonitorArgs } from "./args.js";
import { captureDir, listCaptureFiles, readCapture } from "./captures.js";

interface CaptureDisplay {
  time: string;
  source: string;
  model: string;
  status: number;
  latency: string;
  tokensIn: number;
  tokensOut: number;
  cost: string;
  sessionId: string | null;
}

function parseModelName(capture: CaptureData): string {
  const body = capture.requestBody;
  if (!body || typeof body !== "object") return "?";

  const model = body.model;
  if (typeof model === "string") return model;

  return "?";
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(inTokens: number, outTokens: number): string {
  if (inTokens === 0 && outTokens === 0) return "?/?";
  return `${formatNumber(inTokens)}/${formatNumber(outTokens)}`;
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`.replace(".0k", "k");
  return String(n);
}

function formatCost(cost: number | null): string {
  if (cost === null) return "$?";
  if (cost < 0.01) return `$${cost.toFixed(3)}`;
  if (cost < 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toTimeString().slice(0, 8);
}

function loadCaptureDisplay(filepath: string): CaptureDisplay | null {
  const capture = readCapture(filepath);
  if (!capture) return null;

  // Parse usage from response body
  const usage = parseResponseUsage(capture.responseBody);

  const model = parseModelName(capture);
  const latencyMs = capture.timings?.total_ms ?? 0;

  // Estimate cost - use cache tokens if available
  const cost = estimateCost(
    model,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  );

  return {
    time: formatTime(capture.timestamp),
    source: capture.source || "?",
    model,
    status: capture.responseStatus,
    latency: formatLatency(latencyMs),
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    cost: formatCost(cost),
    sessionId: capture.sessionId,
  };
}

function formatDisplayRow(c: CaptureDisplay): string {
  const statusColor = c.status >= 200 && c.status < 300 ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";

  return (
    `${c.time}  ` +
    `${c.source.slice(0, 10).padEnd(10)}  ` +
    `${c.model.slice(0, 16).padEnd(16)}  ` +
    `${statusColor}${String(c.status).padEnd(5)}${reset}  ` +
    `${c.latency.padEnd(5)}  ` +
    `${formatTokens(c.tokensIn, c.tokensOut).padEnd(14)}  ` +
    c.cost
  );
}

function getTotalsLine(displays: CaptureDisplay[]): string {
  const sessions = new Set(displays.map((d) => d.sessionId).filter(Boolean)).size;
  const totalIn = displays.reduce((sum, d) => sum + d.tokensIn, 0);
  const totalOut = displays.reduce((sum, d) => sum + d.tokensOut, 0);
  const totalCost = displays.reduce((sum, d) => {
    const c = d.cost;
    if (c === "$?") return sum;
    return sum + parseFloat(c.slice(1));
  }, 0);

  return (
    `\x1b[7m Sessions: ${sessions} active | ` +
    `Requests: ${displays.length} | ` +
    `Tokens: ${formatNumber(totalIn)} in / ${formatNumber(totalOut)} out | ` +
    `Cost: $${totalCost.toFixed(2)} \x1b[0m`
  );
}

function matchesFilter(c: CaptureDisplay, args: MonitorArgs): boolean {
  if (args.session && c.sessionId !== args.session) return false;
  if (args.source && c.source !== args.source) return false;
  return true;
}

function parseLastArg(arg: string): number | null {
  const match = arg.match(/^(\d+)([smh])$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    default: return null;
  }
}

function listExistingCaptures(args: MonitorArgs): string[] {
  const dir = captureDir();
  const files = listCaptureFiles(dir);

  const now = Date.now();
  const lastMs = args.last ? parseLastArg(args.last) : null;

  return files
    .map((f) => join(dir, f))
    .filter((filepath) => {
      if (!lastMs) return true;
      const stat = fs.statSync(filepath);
      return now - stat.mtimeMs <= lastMs;
    });
}

export async function runMonitor(args: MonitorArgs): Promise<void> {
  const dir = captureDir();

  if (!fs.existsSync(dir)) {
    console.log(`Capture directory not found: ${dir}`);
    console.log("Run some LLM traffic first (e.g., ctxio proxy -- claude)");
    process.exit(1);
  }

  const header = " TIME      SOURCE      MODEL             STATUS  LATENCY  TOKENS (in/out)  COST";
  console.log(header);

  // Only show existing captures for --last or --session mode.
  // Without those flags, just watch for new ones.
  const displays: CaptureDisplay[] = [];

  if (args.last || args.session) {
    const existingFiles = listExistingCaptures(args);

    for (const filepath of existingFiles) {
      const display = loadCaptureDisplay(filepath);
      if (display && matchesFilter(display, args)) {
        displays.push(display);
      }
    }

    for (const display of displays) {
      console.log(formatDisplayRow(display));
    }

    if (displays.length > 0) {
      console.log(getTotalsLine(displays));
    }
  }

  if (args.session) {
    console.log(`\nSession ${args.session}: ${displays.length} captures\n`);
  } else if (args.last) {
    console.log("\nShowing recent captures, watching for new ones...\n");
  } else {
    console.log("\nWatching for new captures... (Ctrl-C to exit)\n");
  }

  const watched = new Set<string>();
  let watcher: fs.FSWatcher | null = null;

  const processFile = (filepath: string): void => {
    if (watched.has(filepath)) return;
    watched.add(filepath);

    const display = loadCaptureDisplay(filepath);
    if (display && matchesFilter(display, args)) {
      displays.push(display);
      console.log(formatDisplayRow(display));
      console.log("\r" + getTotalsLine(displays) + "\n");
    }
  };

  try {
    watcher = fs.watch(dir, (eventType, filename) => {
      if (eventType !== "rename") return;
      if (!filename || !filename.endsWith(".json")) return;
      if (filename.endsWith(".tmp")) return;

      const filepath = join(dir, filename);
      setTimeout(() => processFile(filepath), 100);
    });

    process.stdin.resume();
  } catch (err) {
    console.error("Failed to watch directory:", err);
    process.exit(1);
  }
}
