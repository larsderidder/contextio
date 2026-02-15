import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isError, parseArgs } from "../src/args.js";

// Simulate process.argv: ["node", "ctxio", ...rest]
function parse(...rest: string[]) {
  return parseArgs(["node", "ctxio", ...rest]);
}

describe("parseArgs", () => {
  it("no args shows help", () => {
    const r = parse();
    assert.ok(!isError(r));
    assert.equal(r.command, "help");
  });

  it("version flag", () => {
    assert.deepEqual(parse("--version"), { command: "version" });
    assert.deepEqual(parse("-v"), { command: "version" });
    assert.deepEqual(parse("version"), { command: "version" });
  });

  it("doctor command", () => {
    assert.deepEqual(parse("doctor"), { command: "doctor" });
  });

  it("background command defaults to status", () => {
    assert.deepEqual(parse("background"), {
      command: "background",
      action: "status",
    });
  });

  it("background start/stop", () => {
    assert.deepEqual(parse("background", "start"), {
      command: "background",
      action: "start",
    });
    assert.deepEqual(parse("background", "stop"), {
      command: "background",
      action: "stop",
    });
  });

  it("help with topic", () => {
    const r = parse("help", "proxy");
    assert.ok(!isError(r));
    assert.equal(r.command, "help");
    if (r.command === "help") assert.equal(r.topic, "proxy");
  });

  it("proxy with no flags has logging on by default", () => {
    const r = parse("proxy");
    assert.ok(!isError(r));
    assert.equal(r.command, "proxy");
    if (r.command === "proxy") {
      assert.equal(r.redact, false);
      assert.equal(r.log, true);
      assert.equal(r.port, 0);
      assert.equal(r.verbose, false);
      assert.equal(r.wrap, null);
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

  it("proxy --redact enables redact with default logging", () => {
    const r = parse("proxy", "--redact");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.redact, true);
      assert.equal(r.log, true);
    }
  });

  it("proxy --port 8080", () => {
    const r = parse("proxy", "--port", "8080");
    assert.ok(!isError(r));
    if (r.command === "proxy") assert.equal(r.port, 8080);
  });

  it("proxy -p 9090", () => {
    const r = parse("proxy", "-p", "9090");
    assert.ok(!isError(r));
    if (r.command === "proxy") assert.equal(r.port, 9090);
  });

  it("--log-dir implies --log", () => {
    const r = parse("proxy", "--log-dir", "/tmp/caps");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.log, true);
      assert.equal(r.logDir, "/tmp/caps");
    }
  });

  it("--redact-preset implies --redact", () => {
    const r = parse("proxy", "--redact-preset", "strict");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.redact, true);
      assert.equal(r.redactPreset, "strict");
    }
  });

  it("--redact-policy implies --redact", () => {
    const r = parse("proxy", "--redact-policy", "./my-policy.json");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.redact, true);
      assert.equal(r.redactPolicy, "./my-policy.json");
    }
  });

  it("invalid preset is an error", () => {
    const r = parse("proxy", "--redact-preset", "bogus");
    assert.ok(isError(r));
    assert.ok(r.error.includes("Invalid preset"));
  });

  it("proxy --help returns help", () => {
    const r = parse("proxy", "--help");
    assert.ok(!isError(r));
    assert.equal(r.command, "help");
    if (r.command === "help") assert.equal(r.topic, "proxy");
  });

  it("unknown command is an error", () => {
    const r = parse("bogus");
    assert.ok(isError(r));
    assert.ok(r.error.includes("Unknown command"));
  });

  it("unknown proxy flag is an error", () => {
    const r = parse("proxy", "--bogus");
    assert.ok(isError(r));
    assert.ok(r.error.includes("Unknown option"));
  });

  it("--port without value is an error", () => {
    const r = parse("proxy", "--port");
    assert.ok(isError(r));
    assert.ok(r.error.includes("requires a value"));
  });

  it("invalid port is an error", () => {
    const r = parse("proxy", "--port", "abc");
    assert.ok(isError(r));
    assert.ok(r.error.includes("Invalid port"));
  });
});

describe("wrap mode (-- separator)", () => {
  it("proxy -- claude parses wrap command", () => {
    const r = parse("proxy", "--", "claude");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.deepEqual(r.wrap, ["claude"]);
      assert.equal(r.log, true);
    }
  });

  it("proxy --redact -- claude passes options and wrap", () => {
    const r = parse("proxy", "--redact", "--", "claude");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.redact, true);
      assert.deepEqual(r.wrap, ["claude"]);
    }
  });

  it("proxy -- aider --model opus passes args to wrapped command", () => {
    const r = parse("proxy", "--", "aider", "--model", "opus");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.deepEqual(r.wrap, ["aider", "--model", "opus"]);
    }
  });

  it("proxy --port 8080 --redact -- pi combines all", () => {
    const r = parse("proxy", "--port", "8080", "--redact", "--", "pi");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.port, 8080);
      assert.equal(r.redact, true);
      assert.equal(r.log, true);
      assert.deepEqual(r.wrap, ["pi"]);
    }
  });

  it("proxy -- with no command is an error", () => {
    const r = parse("proxy", "--");
    assert.ok(isError(r));
    assert.ok(r.error.includes("No command specified after --"));
  });
});
