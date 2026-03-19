/**
 * Smoke tests for CLI command implementations.
 *
 * All tests run against in-memory fixture data (no disk, no network, no proxy).
 * The goal is to catch regressions in the inspect logic, especially
 * the three provider-specific body parsers rewritten in the JsonObject pass.
 *
 * Fixtures cover:
 *   - Anthropic: string system prompt + tools with input_schema
 *   - Anthropic: array system prompt (content blocks)
 *   - OpenAI: developer-role system message + tools with parameters
 *   - Gemini: systemInstruction.parts + functionDeclarations
 *   - No system prompt / no tools
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CaptureData } from "@contextio/core";

// We test the internals by calling runInspect / runExport with a patched
// capture directory, not by spawning a subprocess. The functions read from
// captureDir() which resolves ~/.contextio/captures — we monkey-patch the
// HOME env var so it points at a temp dir instead.

// --- Fixture builder ---

function makeCapture(overrides: Partial<CaptureData> & { sessionId: string }): CaptureData {
  return {
    timestamp: "2025-01-01T12:00:00.000Z",
    method: "POST",
    path: "/v1/messages",
    source: "claude",
    provider: "anthropic",
    apiFormat: "anthropic",
    targetUrl: "https://api.anthropic.com/v1/messages",
    requestHeaders: {},
    requestBody: null,
    requestBytes: 100,
    responseStatus: 200,
    responseHeaders: {},
    responseBody: '{"type":"message_stop"}',
    responseIsStreaming: false,
    responseBytes: 50,
    timings: { send_ms: 1, wait_ms: 100, receive_ms: 10, total_ms: 111 },
    ...overrides,
  };
}

// --- Fixtures ---

const ANTHROPIC_STRING_SYSTEM = makeCapture({
  sessionId: "sess-ant-str",
  source: "claude",
  provider: "anthropic",
  apiFormat: "anthropic",
  requestBody: {
    model: "claude-opus-4",
    system: "You are a helpful assistant.",
    messages: [{ role: "user", content: "Hello" }],
    tools: [
      {
        name: "read_file",
        description: "Reads a file from disk",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, encoding: { type: "string" } },
        },
      },
      {
        name: "write_file",
        description: "Writes content to a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
        },
      },
    ],
  },
});

const ANTHROPIC_ARRAY_SYSTEM = makeCapture({
  sessionId: "sess-ant-arr",
  source: "claude",
  provider: "anthropic",
  apiFormat: "anthropic",
  requestBody: {
    model: "claude-opus-4",
    system: [
      { type: "text", text: "Part one." },
      { type: "text", text: "Part two." },
    ],
    messages: [{ role: "user", content: "What can you do?" }],
    tools: [],
  },
});

const OPENAI_SESSION = makeCapture({
  sessionId: "sess-oai",
  source: "aider",
  provider: "openai",
  apiFormat: "openai",
  requestBody: {
    model: "gpt-4o",
    messages: [
      { role: "developer", content: "You are a coding assistant." },
      { role: "user", content: "Fix my code" },
    ],
    tools: [
      {
        type: "function",
        name: "run_tests",
        description: "Run the test suite",
        parameters: {
          type: "object",
          properties: { filter: { type: "string" } },
        },
      },
    ],
  },
});

const GEMINI_SESSION = makeCapture({
  sessionId: "sess-gem",
  source: "gemini",
  provider: "gemini",
  apiFormat: "gemini",
  requestBody: {
    model: "gemini-2.0-flash",
    systemInstruction: {
      parts: [
        { text: "You help with Google Cloud." },
        { text: "Be concise." },
      ],
    },
    contents: [{ role: "user", parts: [{ text: "List GCS buckets" }] }],
    tools: [
      {
        functionDeclarations: [
          {
            name: "list_buckets",
            description: "List all GCS buckets",
            parameters: {
              type: "object",
              properties: { project: { type: "string" } },
            },
          },
          {
            name: "get_bucket",
            description: "Get details of a single bucket",
            parameters: {
              type: "object",
              properties: { name: { type: "string" }, project: { type: "string" } },
            },
          },
        ],
      },
    ],
  },
});

const NO_SYSTEM_SESSION = makeCapture({
  sessionId: "sess-none",
  source: "claude",
  provider: "anthropic",
  apiFormat: "anthropic",
  requestBody: {
    model: "claude-haiku-4",
    messages: [{ role: "user", content: "Quick question" }],
  },
});

// --- Test harness: redirect captureDir() by overriding HOME ---

let tmpHome: string;
let captureSubdir: string;

function writeFixtures(fixtures: CaptureData[]): void {
  // Clean slate
  if (fs.existsSync(captureSubdir)) {
    fs.rmSync(captureSubdir, { recursive: true });
  }
  fs.mkdirSync(captureSubdir, { recursive: true });

  fixtures.forEach((capture, i) => {
    const filename = `${String(i).padStart(4, "0")}-${capture.sessionId}.json`;
    fs.writeFileSync(join(captureSubdir, filename), JSON.stringify(capture));
  });
}

// Capture console.log output for assertions
function captureConsole(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return fn().finally(() => {
    console.log = orig;
  }).then(() => lines.join("\n"));
}

// --- Tests ---

describe("CLI smoke tests", () => {
  before(() => {
    tmpHome = fs.mkdtempSync(join(tmpdir(), "ctxio-smoke-"));
    captureSubdir = join(tmpHome, ".contextio", "captures");
    process.env.HOME = tmpHome;
  });

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    // Restore HOME (best-effort; test runner doesn't care after this)
    delete process.env.HOME;
  });

  // --- inspect: system prompt extraction ---

  describe("inspect: extractSystemPrompt", () => {
    it("Anthropic string system prompt is extracted", async () => {
      writeFixtures([ANTHROPIC_STRING_SYSTEM]);
      const { runInspect } = await import("../dist/inspect.js");

      const out = await captureConsole(() =>
        runInspect({ command: "inspect", session: "sess-ant-str", last: false, source: null, full: true }),
      );

      assert.ok(out.includes("You are a helpful assistant."), `system prompt missing in: ${out}`);
    });

    it("Anthropic array system prompt is joined", async () => {
      writeFixtures([ANTHROPIC_ARRAY_SYSTEM]);
      const { runInspect } = await import("../dist/inspect.js");

      const out = await captureConsole(() =>
        runInspect({ command: "inspect", session: "sess-ant-arr", last: false, source: null, full: true }),
      );

      assert.ok(out.includes("Part one."), `first part missing in: ${out}`);
      assert.ok(out.includes("Part two."), `second part missing in: ${out}`);
    });

    it("OpenAI developer-role system message is extracted", async () => {
      writeFixtures([OPENAI_SESSION]);
      const { runInspect } = await import("../dist/inspect.js");

      const out = await captureConsole(() =>
        runInspect({ command: "inspect", session: "sess-oai", last: false, source: null, full: true }),
      );

      assert.ok(out.includes("You are a coding assistant."), `system prompt missing in: ${out}`);
    });

    it("Gemini systemInstruction.parts is joined", async () => {
      writeFixtures([GEMINI_SESSION]);
      const { runInspect } = await import("../dist/inspect.js");

      const out = await captureConsole(() =>
        runInspect({ command: "inspect", session: "sess-gem", last: false, source: null, full: true }),
      );

      assert.ok(out.includes("You help with Google Cloud."), `first part missing in: ${out}`);
      assert.ok(out.includes("Be concise."), `second part missing in: ${out}`);
    });

    it("no system prompt shows (none)", async () => {
      writeFixtures([NO_SYSTEM_SESSION]);
      const { runInspect } = await import("../dist/inspect.js");

      const out = await captureConsole(() =>
        runInspect({ command: "inspect", session: "sess-none", last: false, source: null, full: false }),
      );

      assert.ok(out.includes("(none)"), `expected (none) in: ${out}`);
    });
  });

  // --- inspect: tool extraction ---

  describe("inspect: tool extraction", () => {
    it("Anthropic input_schema.properties counted correctly", async () => {
      writeFixtures([ANTHROPIC_STRING_SYSTEM]);
      const { runInspect } = await import("../dist/inspect.js");

      const out = await captureConsole(() =>
        runInspect({ command: "inspect", session: "sess-ant-str", last: false, source: null, full: false }),
      );

      assert.ok(out.includes("read_file"), `read_file missing in: ${out}`);
      assert.ok(out.includes("write_file"), `write_file missing in: ${out}`);
      // Both tools have 2 properties
      const matches = out.match(/2 params/g);
      assert.ok(matches && matches.length >= 2, `expected 2x "2 params" in: ${out}`);
    });

    it("OpenAI parameters.properties counted correctly", async () => {
      writeFixtures([OPENAI_SESSION]);
      const { runInspect } = await import("../dist/inspect.js");

      const out = await captureConsole(() =>
        runInspect({ command: "inspect", session: "sess-oai", last: false, source: null, full: false }),
      );

      assert.ok(out.includes("run_tests"), `run_tests missing in: ${out}`);
      assert.ok(out.includes("1 params"), `expected "1 params" in: ${out}`);
    });

    it("Gemini functionDeclarations extracted with param counts", async () => {
      writeFixtures([GEMINI_SESSION]);
      const { runInspect } = await import("../dist/inspect.js");

      const out = await captureConsole(() =>
        runInspect({ command: "inspect", session: "sess-gem", last: false, source: null, full: false }),
      );

      assert.ok(out.includes("list_buckets"), `list_buckets missing in: ${out}`);
      assert.ok(out.includes("get_bucket"), `get_bucket missing in: ${out}`);
      // list_buckets has 1 param, get_bucket has 2
      assert.ok(out.includes("1 params"), `expected "1 params" in: ${out}`);
      assert.ok(out.includes("2 params"), `expected "2 params" in: ${out}`);
    });

    it("no tools shows (none)", async () => {
      writeFixtures([NO_SYSTEM_SESSION]);
      const { runInspect } = await import("../dist/inspect.js");

      const out = await captureConsole(() =>
        runInspect({ command: "inspect", session: "sess-none", last: false, source: null, full: false }),
      );

      assert.ok(out.includes("Tools: (none)"), `expected "Tools: (none)" in: ${out}`);
    });
  });

  // --- inspect: session listing ---

  describe("inspect: session listing", () => {
    it("lists all sessions when no session specified", async () => {
      writeFixtures([ANTHROPIC_STRING_SYSTEM, OPENAI_SESSION, GEMINI_SESSION]);
      const { runInspect } = await import("../dist/inspect.js");

      const out = await captureConsole(() =>
        runInspect({ command: "inspect", session: null, last: false, source: null, full: false }),
      );

      assert.ok(out.includes("sess-ant-str"), `sess-ant-str missing in: ${out}`);
      assert.ok(out.includes("sess-oai"), `sess-oai missing in: ${out}`);
      assert.ok(out.includes("sess-gem"), `sess-gem missing in: ${out}`);
    });

    it("--source filters to matching sessions", async () => {
      writeFixtures([ANTHROPIC_STRING_SYSTEM, OPENAI_SESSION, GEMINI_SESSION]);
      const { runInspect } = await import("../dist/inspect.js");

      const out = await captureConsole(() =>
        runInspect({ command: "inspect", session: null, last: false, source: "aider", full: false }),
      );

      assert.ok(out.includes("sess-oai"), `sess-oai missing in: ${out}`);
      assert.ok(!out.includes("sess-ant-str"), `sess-ant-str should be filtered out`);
      assert.ok(!out.includes("sess-gem"), `sess-gem should be filtered out`);
    });

    it("--last inspects the most recent session", async () => {
      // sess-oai is last in sort order
      writeFixtures([ANTHROPIC_STRING_SYSTEM, OPENAI_SESSION]);
      const { runInspect } = await import("../dist/inspect.js");

      const out = await captureConsole(() =>
        runInspect({ command: "inspect", session: null, last: true, source: null, full: false }),
      );

      assert.ok(out.includes("sess-oai"), `expected last session sess-oai in: ${out}`);
    });
  });

});
