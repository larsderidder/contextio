import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { createLoggerPlugin } from "../dist/index.js";
import type { CaptureData } from "@contextio/core";

function tmpDir(): string {
  const dir = join("/tmp", `contextio-logger-test-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeCapture(overrides: Partial<CaptureData> = {}): CaptureData {
  return {
    timestamp: new Date().toISOString(),
    sessionId: null,
    method: "POST",
    path: "/v1/messages",
    source: null,
    provider: "anthropic",
    apiFormat: "anthropic-messages",
    targetUrl: "https://api.anthropic.com/v1/messages",
    requestHeaders: {},
    requestBody: { model: "claude-3", messages: [] },
    requestBytes: 100,
    responseStatus: 200,
    responseHeaders: {},
    responseBody: "{}",
    responseIsStreaming: false,
    responseBytes: 2,
    timings: { send_ms: 1, wait_ms: 10, receive_ms: 5, total_ms: 16 },
    ...overrides,
  };
}

describe("logger plugin", () => {
  it("writes capture files to disk", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    logger.onCapture!(fakeCapture());

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);

    const content = JSON.parse(fs.readFileSync(join(dir, files[0]), "utf-8"));
    assert.equal(content.provider, "anthropic");

    fs.rmSync(dir, { recursive: true });
  });

  it("includes source in filename", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    logger.onCapture!(fakeCapture({ source: "claude" }));

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith("claude_"), `Expected filename to start with claude_, got: ${files[0]}`);

    fs.rmSync(dir, { recursive: true });
  });

  it("includes session ID in filename", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    logger.onCapture!(fakeCapture({ source: "aider", sessionId: "ab12cd34" }));

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith("aider_ab12cd34_"), `Expected aider_ab12cd34_ prefix, got: ${files[0]}`);

    fs.rmSync(dir, { recursive: true });
  });

  it("falls back to 'unknown' when source is null", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    logger.onCapture!(fakeCapture({ source: null }));

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.ok(files[0].startsWith("unknown_"), `Expected unknown_ prefix, got: ${files[0]}`);

    fs.rmSync(dir, { recursive: true });
  });

  it("exposes captureDir on the plugin", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });
    assert.equal(logger.captureDir, dir);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("session retention", () => {
  it("prunes oldest sessions when maxSessions is set", () => {
    const dir = tmpDir();

    // Seed 3 sessions: oldest, middle, newest
    fs.writeFileSync(join(dir, "claude_aaaa0001_1000000000000-000000.json"), "{}");
    fs.writeFileSync(join(dir, "claude_aaaa0001_1000000000001-000001.json"), "{}");
    fs.writeFileSync(join(dir, "aider_bbbb0002_1000000001000-000000.json"), "{}");
    fs.writeFileSync(join(dir, "pi_cccc0003_1000000002000-000000.json"), "{}");
    fs.writeFileSync(join(dir, "pi_cccc0003_1000000002001-000001.json"), "{}");

    // Keep 2 sessions
    createLoggerPlugin({ captureDir: dir, maxSessions: 2 });

    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

    // Should have pruned aaaa0001 (2 files), kept bbbb0002 and cccc0003
    assert.equal(remaining.length, 3);
    assert.ok(remaining.every((f) => !f.includes("aaaa0001")), "Oldest session should be pruned");
    assert.ok(remaining.some((f) => f.includes("bbbb0002")), "Middle session should remain");
    assert.ok(remaining.some((f) => f.includes("cccc0003")), "Newest session should remain");

    fs.rmSync(dir, { recursive: true });
  });

  it("does not prune when maxSessions is 0", () => {
    const dir = tmpDir();

    fs.writeFileSync(join(dir, "claude_aaaa0001_1000000000000-000000.json"), "{}");
    fs.writeFileSync(join(dir, "aider_bbbb0002_1000000001000-000000.json"), "{}");
    fs.writeFileSync(join(dir, "pi_cccc0003_1000000002000-000000.json"), "{}");

    createLoggerPlugin({ captureDir: dir, maxSessions: 0 });

    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(remaining.length, 3, "All files should remain when maxSessions=0");

    fs.rmSync(dir, { recursive: true });
  });

  it("does not prune sessionless files", () => {
    const dir = tmpDir();

    // Sessionless files (standalone mode)
    fs.writeFileSync(join(dir, "unknown_1000000000000-000000.json"), "{}");
    fs.writeFileSync(join(dir, "claude_1000000001000-000000.json"), "{}");
    // One session
    fs.writeFileSync(join(dir, "claude_dddd0004_1000000002000-000000.json"), "{}");

    createLoggerPlugin({ captureDir: dir, maxSessions: 1 });

    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

    // Session dddd0004 should remain (the only session, within limit)
    // Sessionless files should also remain (never pruned)
    assert.equal(remaining.length, 3, "Sessionless files should not be pruned");

    fs.rmSync(dir, { recursive: true });
  });

  it("handles empty directory without error", () => {
    const dir = tmpDir();
    // Should not throw
    createLoggerPlugin({ captureDir: dir, maxSessions: 5 });
    fs.rmSync(dir, { recursive: true });
  });
});
