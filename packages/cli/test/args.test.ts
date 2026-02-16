import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isError, parseArgs } from "../dist/args.js";

function parse(...rest: string[]) {
  return parseArgs(["node", "ctxio", ...rest]);
}

describe("parseArgs", () => {
  // --- proxy ---

  it("proxy defaults", () => {
    const r = parse("proxy");
    assert.ok(!isError(r));
    assert.equal(r.command, "proxy");
    if (r.command === "proxy") {
      assert.equal(r.port, 0);
      assert.equal(r.redact, false);
      assert.equal(r.log, true);
      assert.equal(r.verbose, false);
      assert.equal(r.wrap, null);
    }
  });

  it("proxy --redact implies redact", () => {
    const r = parse("proxy", "--redact");
    assert.ok(!isError(r));
    if (r.command === "proxy") assert.equal(r.redact, true);
  });

  it("proxy --redact-preset implies redact", () => {
    const r = parse("proxy", "--redact-preset", "strict");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.redact, true);
      assert.equal(r.redactPreset, "strict");
    }
  });

  it("proxy --redact-policy implies redact", () => {
    const r = parse("proxy", "--redact-policy", "./policy.json");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.redact, true);
      assert.equal(r.redactPolicy, "./policy.json");
    }
  });

  it("proxy --no-log disables logging", () => {
    const r = parse("proxy", "--no-log");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.log, false);
      assert.equal(r.noLog, true);
    }
  });

  it("proxy --log-dir implies log", () => {
    const r = parse("proxy", "--log-dir", "/tmp/caps");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.log, true);
      assert.equal(r.logDir, "/tmp/caps");
    }
  });

  it("proxy -p sets port", () => {
    const r = parse("proxy", "-p", "9090");
    assert.ok(!isError(r));
    if (r.command === "proxy") assert.equal(r.port, 9090);
  });

  it("proxy -- wraps a command", () => {
    const r = parse("proxy", "--", "claude");
    assert.ok(!isError(r));
    if (r.command === "proxy") assert.deepEqual(r.wrap, ["claude"]);
  });

  it("proxy -- passes args to wrapped command", () => {
    const r = parse("proxy", "--redact", "--", "aider", "--model", "opus");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.redact, true);
      assert.deepEqual(r.wrap, ["aider", "--model", "opus"]);
    }
  });

  it("proxy --verbose", () => {
    const r = parse("proxy", "--verbose");
    assert.ok(!isError(r));
    if (r.command === "proxy") assert.equal(r.verbose, true);
  });

  it("proxy --bind", () => {
    const r = parse("proxy", "--bind", "0.0.0.0");
    assert.ok(!isError(r));
    if (r.command === "proxy") assert.equal(r.bind, "0.0.0.0");
  });

  it("proxy --log-max-sessions", () => {
    const r = parse("proxy", "--log-max-sessions", "50");
    assert.ok(!isError(r));
    if (r.command === "proxy") assert.equal(r.logMaxSessions, 50);
  });

  // --- attach ---

  it("attach parses command and args", () => {
    const r = parse("attach", "claude", "--model", "opus");
    assert.ok(!isError(r));
    if (r.command === "attach") {
      assert.deepEqual(r.wrap, ["claude", "--model", "opus"]);
      assert.equal(r.port, 4040);
    }
  });

  it("attach --port", () => {
    const r = parse("attach", "--port", "5050", "aider");
    assert.ok(!isError(r));
    if (r.command === "attach") {
      assert.equal(r.port, 5050);
      assert.deepEqual(r.wrap, ["aider"]);
    }
  });

  it("attach requires a command", () => {
    const r = parse("attach");
    assert.ok(isError(r));
  });

  // --- background ---

  it("background defaults to status", () => {
    const r = parse("background");
    assert.ok(!isError(r));
    if (r.command === "background") assert.equal(r.action, "status");
  });

  it("background start/stop", () => {
    const r1 = parse("background", "start");
    assert.ok(!isError(r1));
    if (r1.command === "background") assert.equal(r1.action, "start");

    const r2 = parse("background", "stop");
    assert.ok(!isError(r2));
    if (r2.command === "background") assert.equal(r2.action, "stop");
  });

  it("background invalid action is error", () => {
    const r = parse("background", "restart");
    assert.ok(isError(r));
  });

  // --- monitor ---

  it("monitor defaults", () => {
    const r = parse("monitor");
    assert.ok(!isError(r));
    if (r.command === "monitor") {
      assert.equal(r.session, null);
      assert.equal(r.last, null);
      assert.equal(r.source, null);
    }
  });

  it("monitor with positional session", () => {
    const r = parse("monitor", "abc12345");
    assert.ok(!isError(r));
    if (r.command === "monitor") assert.equal(r.session, "abc12345");
  });

  it("monitor --last --source", () => {
    const r = parse("monitor", "--last", "1h", "--source", "claude");
    assert.ok(!isError(r));
    if (r.command === "monitor") {
      assert.equal(r.last, "1h");
      assert.equal(r.source, "claude");
    }
  });

  // --- inspect ---

  it("inspect defaults", () => {
    const r = parse("inspect");
    assert.ok(!isError(r));
    if (r.command === "inspect") {
      assert.equal(r.session, null);
      assert.equal(r.last, false);
      assert.equal(r.source, null);
      assert.equal(r.full, false);
    }
  });

  it("inspect with positional session", () => {
    const r = parse("inspect", "def67890");
    assert.ok(!isError(r));
    if (r.command === "inspect") assert.equal(r.session, "def67890");
  });

  it("inspect --last --source --full", () => {
    const r = parse("inspect", "--last", "--source", "codex", "--full");
    assert.ok(!isError(r));
    if (r.command === "inspect") {
      assert.equal(r.last, true);
      assert.equal(r.source, "codex");
      assert.equal(r.full, true);
    }
  });

  // --- replay ---

  it("replay with file", () => {
    const r = parse("replay", "test.json");
    assert.ok(!isError(r));
    if (r.command === "replay") {
      assert.equal(r.captureFile, "test.json");
      assert.equal(r.diff, false);
      assert.equal(r.model, null);
    }
  });

  it("replay --diff --model", () => {
    const r = parse("replay", "test.json", "--diff", "--model", "gpt-4o");
    assert.ok(!isError(r));
    if (r.command === "replay") {
      assert.equal(r.diff, true);
      assert.equal(r.model, "gpt-4o");
    }
  });

  it("replay requires a file", () => {
    const r = parse("replay");
    assert.ok(isError(r));
  });

  // --- export ---

  it("export with session", () => {
    const r = parse("export", "abc12345");
    assert.ok(!isError(r));
    if (r.command === "export") {
      assert.equal(r.session, "abc12345");
      assert.equal(r.last, false);
    }
  });

  it("export --last -o --redact", () => {
    const r = parse("export", "--last", "-o", "/tmp/out.json", "--redact");
    assert.ok(!isError(r));
    if (r.command === "export") {
      assert.equal(r.last, true);
      assert.equal(r.outputPath, "/tmp/out.json");
      assert.equal(r.redact, true);
    }
  });

  it("export requires session or --last", () => {
    const r = parse("export");
    assert.ok(isError(r));
  });

  // --- doctor ---

  it("doctor", () => {
    const r = parse("doctor");
    assert.ok(!isError(r));
    assert.equal(r.command, "doctor");
  });
});
