/**
 * Unit tests for monitor.ts.
 *
 * Covers the pure functions (duration parser, display row rendering)
 * and the runMonitor listing behaviour against fixture captures.
 * Does not test fs.watch (that requires a live filesystem event loop).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CaptureData } from "@contextio/core";

// --- parseDuration ---

import { parseLastArg } from "../dist/monitor.js";

describe("parseLastArg", () => {
  it("parses seconds", () => {
    assert.equal(parseLastArg("30s"), 30_000);
    assert.equal(parseLastArg("1s"), 1_000);
  });

  it("parses minutes", () => {
    assert.equal(parseLastArg("5m"), 5 * 60 * 1_000);
    assert.equal(parseLastArg("60m"), 60 * 60 * 1_000);
  });

  it("parses hours", () => {
    assert.equal(parseLastArg("1h"), 60 * 60 * 1_000);
    assert.equal(parseLastArg("2h"), 2 * 60 * 60 * 1_000);
  });

  it("returns null for missing unit", () => {
    assert.equal(parseLastArg("30"), null);
  });

  it("returns null for unknown unit", () => {
    assert.equal(parseLastArg("30d"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseLastArg(""), null);
  });

  it("returns null for non-numeric value", () => {
    assert.equal(parseLastArg("xm"), null);
  });
});

// --- runMonitor listing ---

function makeCapture(overrides: Partial<CaptureData> & { sessionId: string }): CaptureData {
  return {
    timestamp: new Date().toISOString(),
    method: "POST",
    path: "/v1/messages",
    source: "claude",
    provider: "anthropic",
    apiFormat: "anthropic",
    targetUrl: "https://api.anthropic.com/v1/messages",
    requestHeaders: {},
    requestBody: { model: "claude-opus-4", messages: [{ role: "user", content: "Hi" }] },
    requestBytes: 100,
    responseStatus: 200,
    responseHeaders: {},
    responseBody: JSON.stringify({
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-opus-4",
    }),
    responseIsStreaming: false,
    responseBytes: 50,
    timings: { send_ms: 1, wait_ms: 200, receive_ms: 10, total_ms: 211 },
    ...overrides,
  };
}

describe("runMonitor listing", () => {
  let tmpHome: string;
  let captureSubdir: string;

  before(() => {
    tmpHome = fs.mkdtempSync(join(tmpdir(), "ctxio-monitor-"));
    captureSubdir = join(tmpHome, ".contextio", "captures");
    fs.mkdirSync(captureSubdir, { recursive: true });
    process.env.HOME = tmpHome;
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.HOME;
  });

  function writeFixtures(fixtures: CaptureData[]): void {
    for (const f of fs.readdirSync(captureSubdir)) {
      fs.unlinkSync(join(captureSubdir, f));
    }
    fixtures.forEach((c, i) => {
      fs.writeFileSync(
        join(captureSubdir, `${String(i).padStart(4, "0")}-${c.sessionId}.json`),
        JSON.stringify(c),
      );
    });
  }

  function captureConsole(fn: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    return fn().finally(() => { console.log = orig; }).then(() => lines.join("\n"));
  }

  it("prints the table header", async () => {
    writeFixtures([]);
    const { runMonitor } = await import("../dist/monitor.js");

    const out = await captureConsole(() =>
      // session filter with no matches exits cleanly after printing header
      runMonitor({ command: "monitor", session: "nosuchsession", last: null, source: null }),
    );

    assert.ok(out.includes("TIME"), `header missing in: ${out}`);
    assert.ok(out.includes("MODEL"), `header missing in: ${out}`);
    assert.ok(out.includes("COST"), `header missing in: ${out}`);
  });

  it("shows existing captures for --session filter", async () => {
    writeFixtures([
      makeCapture({ sessionId: "aabb0011", source: "claude" }),
      makeCapture({ sessionId: "ccdd0022", source: "aider" }),
    ]);
    const { runMonitor } = await import("../dist/monitor.js");

    const out = await captureConsole(() =>
      runMonitor({ command: "monitor", session: "aabb0011", last: null, source: null }),
    );

    assert.ok(out.includes("claude"), `source missing in: ${out}`);
    assert.ok(!out.includes("aider"), `unrelated session should be filtered out`);
    assert.ok(out.includes("aabb0011"), `session info missing in: ${out}`);
  });

  it("shows existing captures for --source filter with --session", async () => {
    writeFixtures([
      makeCapture({ sessionId: "aabb0011", source: "claude" }),
      makeCapture({ sessionId: "aabb0011", source: "aider" }),
    ]);
    const { runMonitor } = await import("../dist/monitor.js");

    const out = await captureConsole(() =>
      runMonitor({ command: "monitor", session: "aabb0011", last: null, source: "claude" }),
    );

    assert.ok(out.includes("claude"), `claude missing in: ${out}`);
    // aider has sessionId aabb0011 but source is filtered
    assert.ok(!out.includes("aider"), `aider should be filtered by source`);
  });

  it("shows totals line when captures are found", async () => {
    writeFixtures([
      makeCapture({ sessionId: "aabb0011", source: "claude" }),
    ]);
    const { runMonitor } = await import("../dist/monitor.js");

    const out = await captureConsole(() =>
      runMonitor({ command: "monitor", session: "aabb0011", last: null, source: null }),
    );

    assert.ok(out.includes("Requests:"), `totals line missing in: ${out}`);
    assert.ok(out.includes("Tokens:"), `token summary missing in: ${out}`);
  });

  it("shows token and latency info in row", async () => {
    writeFixtures([makeCapture({ sessionId: "aabb0011" })]);
    const { runMonitor } = await import("../dist/monitor.js");

    const out = await captureConsole(() =>
      runMonitor({ command: "monitor", session: "aabb0011", last: null, source: null }),
    );

    // timings.total_ms = 211 → "211ms"
    assert.ok(out.includes("211ms"), `latency missing in: ${out}`);
    // usage: 10 in / 5 out
    assert.ok(out.includes("10/5"), `token counts missing in: ${out}`);
  });
});
