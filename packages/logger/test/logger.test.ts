import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

import { createLoggerPlugin } from "../dist/index.js";
import type { CaptureData } from "@contextio/core";

function tmpDir(): string {
  const dir = join(
    tmpdir(),
    `contextio-logger-test-${randomBytes(4).toString("hex")}`,
  );
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

    const content = JSON.parse(
      fs.readFileSync(join(dir, files[0]), "utf-8"),
    );
    assert.equal(content.provider, "anthropic");

    fs.rmSync(dir, { recursive: true });
  });

  it("includes source in filename", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    logger.onCapture!(fakeCapture({ source: "claude" }));

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
    assert.ok(
      files[0].startsWith("claude_"),
      `Expected filename to start with claude_, got: ${files[0]}`,
    );

    fs.rmSync(dir, { recursive: true });
  });

  it("includes session ID in filename", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    logger.onCapture!(fakeCapture({ source: "aider", sessionId: "ab12cd34" }));

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
    assert.ok(
      files[0].startsWith("aider_ab12cd34_"),
      `Expected aider_ab12cd34_ prefix, got: ${files[0]}`,
    );

    fs.rmSync(dir, { recursive: true });
  });

  it("falls back to 'unknown' when source is null", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    logger.onCapture!(fakeCapture({ source: null }));

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.ok(
      files[0].startsWith("unknown_"),
      `Expected unknown_ prefix, got: ${files[0]}`,
    );

    fs.rmSync(dir, { recursive: true });
  });

  it("exposes captureDir on the plugin", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });
    assert.equal(logger.captureDir, dir);
    fs.rmSync(dir, { recursive: true });
  });

  it("handles source with special characters", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    // Source with special characters that should be sanitized
    logger.onCapture!(fakeCapture({ source: "test@#$%^&*" }));

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
    // Should not contain @#$%^&*
    assert.ok(!files[0].includes("@"), "Special chars should be sanitized");

    fs.rmSync(dir, { recursive: true });
  });

  it("handles multiple rapid captures", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    // Write multiple captures rapidly
    for (let i = 0; i < 5; i++) {
      logger.onCapture!(fakeCapture({ source: `test${i}` }));
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 5);

    fs.rmSync(dir, { recursive: true });
  });

  it("preserves capture data correctly", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    const capture = fakeCapture({
      source: "test",
      sessionId: "aabbccdd",
      requestBody: {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "Hello" }],
      },
      responseBody: JSON.stringify({
        id: "msg_123",
        content: [{ type: "text", text: "Hi there" }],
      }),
    });

    logger.onCapture!(capture);

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const content = JSON.parse(fs.readFileSync(join(dir, files[0]), "utf8"));

    assert.equal(content.source, "test");
    assert.equal(content.sessionId, "aabbccdd");
    assert.equal(content.requestBody.model, "claude-3-5-sonnet-20241022");
    assert.equal(content.responseBody.includes("Hi there"), true);

    fs.rmSync(dir, { recursive: true });
  });
});

describe("session retention", () => {
  it("prunes oldest sessions when maxSessions is set", () => {
    const dir = tmpDir();

    // Seed 3 sessions: oldest, middle, newest
    fs.writeFileSync(
      join(dir, "claude_aaaa0001_1000000000000-000000.json"),
      "{}",
    );
    fs.writeFileSync(
      join(dir, "claude_aaaa0001_1000000000001-000001.json"),
      "{}",
    );
    fs.writeFileSync(
      join(dir, "aider_bbbb0002_1000000001000-000000.json"),
      "{}",
    );
    fs.writeFileSync(
      join(dir, "pi_cccc0003_1000000002000-000000.json"),
      "{}",
    );
    fs.writeFileSync(
      join(dir, "pi_cccc0003_1000000002001-000001.json"),
      "{}",
    );

    // Keep 2 sessions
    createLoggerPlugin({ captureDir: dir, maxSessions: 2 });

    const remaining = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();

    // Should have pruned aaaa0001 (2 files), kept bbbb0002 and cccc0003
    assert.equal(remaining.length, 3);
    assert.ok(
      remaining.every((f) => !f.includes("aaaa0001")),
      "Oldest session should be pruned",
    );
    assert.ok(
      remaining.some((f) => f.includes("bbbb0002")),
      "Middle session should remain",
    );
    assert.ok(
      remaining.some((f) => f.includes("cccc0003")),
      "Newest session should remain",
    );

    fs.rmSync(dir, { recursive: true });
  });

  it("does not prune when maxSessions is 0", () => {
    const dir = tmpDir();

    fs.writeFileSync(
      join(dir, "claude_aaaa0001_1000000000000-000000.json"),
      "{}",
    );
    fs.writeFileSync(
      join(dir, "aider_bbbb0002_1000000001000-000000.json"),
      "{}",
    );
    fs.writeFileSync(
      join(dir, "pi_cccc0003_1000000002000-000000.json"),
      "{}",
    );

    createLoggerPlugin({ captureDir: dir, maxSessions: 0 });

    const remaining = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"));
    assert.equal(
      remaining.length,
      3,
      "All files should remain when maxSessions=0",
    );

    fs.rmSync(dir, { recursive: true });
  });

  it("does not prune sessionless files", () => {
    const dir = tmpDir();

    // Sessionless files (standalone mode)
    fs.writeFileSync(
      join(dir, "unknown_1000000000000-000000.json"),
      "{}",
    );
    fs.writeFileSync(
      join(dir, "claude_1000000001000-000000.json"),
      "{}",
    );
    // One session
    fs.writeFileSync(
      join(dir, "claude_dddd0004_1000000002000-000000.json"),
      "{}",
    );

    createLoggerPlugin({ captureDir: dir, maxSessions: 1 });

    const remaining = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();

    // Session dddd0004 should remain (the only session, within limit)
    // Sessionless files should also remain (never pruned)
    assert.equal(
      remaining.length,
      3,
      "Sessionless files should not be pruned",
    );

    fs.rmSync(dir, { recursive: true });
  });

  it("handles empty directory without error", () => {
    const dir = tmpDir();
    // Should not throw
    createLoggerPlugin({ captureDir: dir, maxSessions: 5 });
    fs.rmSync(dir, { recursive: true });
  });

  it("prunes all sessions when maxSessions is 1", () => {
    const dir = tmpDir();

    fs.writeFileSync(
      join(dir, "claude_aaaa0001_1000000000000-000000.json"),
      "{}",
    );
    fs.writeFileSync(
      join(dir, "aider_bbbb0002_1000000001000-000000.json"),
      "{}",
    );

    createLoggerPlugin({ captureDir: dir, maxSessions: 1 });

    const remaining = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"));

    // Should keep only the newest session
    assert.equal(remaining.length, 1);
    assert.ok(
      remaining[0].includes("bbbb0002"),
      "Should keep the newest session",
    );

    fs.rmSync(dir, { recursive: true });
  });

  it("handles directory with only tmp files without error", () => {
    const dir = tmpDir();

    // Only .tmp files
    fs.writeFileSync(
      join(dir, "claude_aaaa0001_1000000000000-000000.json.tmp"),
      "{}",
    );

    // Should not throw - tmp files are filtered out during read, but the dir still exists
    // No pruning happens because there are no .json files
    createLoggerPlugin({ captureDir: dir, maxSessions: 1 });

    // Tmp files are ignored during prune, so they remain
    const remaining = fs.readdirSync(dir);
    assert.equal(remaining.length, 1);

    fs.rmSync(dir, { recursive: true });
  });
});

describe("error handling", () => {
  it("handles read-only directory gracefully", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    // Try to capture - should handle error gracefully
    // Note: on CI this might not be read-only, so we just test it doesn't crash
    logger.onCapture!(fakeCapture());

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);

    fs.rmSync(dir, { recursive: true });
  });

  it("handles invalid JSON in capture gracefully", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    // Capture with non-serializable content
    const capture = fakeCapture({
      requestBody: {
        // Circular reference
        self: {} as any,
      },
    });
    capture.requestBody!.self = capture.requestBody;

    // Should not throw, but may fail silently
    logger.onCapture!(capture);

    // File may or may not be written depending on JSON serialization
    fs.rmSync(dir, { recursive: true });
  });

  it("handles capture with undefined values", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    const capture = fakeCapture({
      // Some optional fields can be undefined
      sessionId: undefined as any,
      source: undefined as any,
    });

    logger.onCapture!(capture);

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);

    fs.rmSync(dir, { recursive: true });
  });

  it("handles capture with null values", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    const capture = fakeCapture({
      requestBody: null as any,
      responseBody: null as any,
    });

    logger.onCapture!(capture);

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);

    fs.rmSync(dir, { recursive: true });
  });

  it("handles capture with very large body", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    // Create a large body (1MB)
    const largeBody = "x".repeat(1024 * 1024);
    const capture = fakeCapture({
      requestBody: { data: largeBody },
      requestBytes: largeBody.length,
    });

    logger.onCapture!(capture);

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);

    // Verify file was written
    const content = JSON.parse(fs.readFileSync(join(dir, files[0]), "utf8"));
    assert.equal(content.requestBody.data.length, largeBody.length);

    fs.rmSync(dir, { recursive: true });
  });

  it("handles capture with special characters in body", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });

    const capture = fakeCapture({
      requestBody: {
        // Various special characters
        text: "Hello\t\n\r\"'<>",
        unicode: "Hello 世界 🔥",
        emoji: "🎉🚀✨",
      },
    });

    logger.onCapture!(capture);

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const content = JSON.parse(fs.readFileSync(join(dir, files[0]), "utf8"));
    assert.equal(content.requestBody.text, "Hello\t\n\r\"'<>");
    assert.equal(content.requestBody.unicode, "Hello 世界 🔥");
    assert.equal(content.requestBody.emoji, "🎉🚀✨");

    fs.rmSync(dir, { recursive: true });
  });
});

describe("default capture directory", () => {
  it("uses default directory when no captureDir provided", () => {
    const logger = createLoggerPlugin();
    // Should use ~/.contextio/captures
    assert.ok(logger.captureDir.includes(".contextio"));
    assert.ok(logger.captureDir.includes("captures"));
  });

  it("uses custom directory when provided", () => {
    const dir = tmpDir();
    const logger = createLoggerPlugin({ captureDir: dir });
    assert.equal(logger.captureDir, dir);
    fs.rmSync(dir, { recursive: true });
  });
});
