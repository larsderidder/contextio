import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isError, parseArgs } from "../dist/args.js";

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

  // --- attach subcommand tests ---

  it("attach requires a command", () => {
    const r = parse("attach");
    assert.ok(isError(r));
    assert.ok(r.error.includes("No command specified"));
  });

  it("attach parses command and args", () => {
    const r = parse("attach", "claude", "--model", "opus");
    assert.ok(!isError(r));
    if (r.command === "attach") {
      assert.deepEqual(r.wrap, ["claude", "--model", "opus"]);
      assert.equal(r.port, 4040);
    }
  });

  it("attach with port option", () => {
    const r = parse("attach", "--port", "5050", "aider");
    assert.ok(!isError(r));
    if (r.command === "attach") {
      assert.equal(r.port, 5050);
      assert.deepEqual(r.wrap, ["aider"]);
    }
  });

  it("attach with -p short flag", () => {
    const r = parse("attach", "-p", "3030", "pi");
    assert.ok(!isError(r));
    if (r.command === "attach") {
      assert.equal(r.port, 3030);
    }
  });

  it("attach unknown option is error", () => {
    const r = parse("attach", "--unknown", "claude");
    assert.ok(isError(r));
  });

  // --- monitor subcommand tests ---

  it("monitor with no options", () => {
    const r = parse("monitor");
    assert.ok(!isError(r));
    assert.equal(r.command, "monitor");
  });

  it("monitor --session", () => {
    const r = parse("monitor", "--session", "abc12345");
    assert.ok(!isError(r));
    if (r.command === "monitor") {
      assert.equal(r.session, "abc12345");
      assert.equal(r.last, null);
      assert.equal(r.source, null);
    }
  });

  it("monitor --last", () => {
    const r = parse("monitor", "--last", "30m");
    assert.ok(!isError(r));
    if (r.command === "monitor") {
      assert.equal(r.last, "30m");
    }
  });

  it("monitor --source", () => {
    const r = parse("monitor", "--source", "claude");
    assert.ok(!isError(r));
    if (r.command === "monitor") {
      assert.equal(r.source, "claude");
    }
  });

  it("monitor combined options", () => {
    const r = parse("monitor", "--session", "abc12345", "--last", "1h", "--source", "aider");
    assert.ok(!isError(r));
    if (r.command === "monitor") {
      assert.equal(r.session, "abc12345");
      assert.equal(r.last, "1h");
      assert.equal(r.source, "aider");
    }
  });

  it("monitor unknown option is error", () => {
    const r = parse("monitor", "--unknown");
    assert.ok(isError(r));
  });

  it("monitor --session without value is error", () => {
    const r = parse("monitor", "--session");
    assert.ok(isError(r));
    assert.ok(r.error.includes("requires a value"));
  });

  // --- inspect subcommand tests ---

  it("inspect with no options", () => {
    const r = parse("inspect");
    assert.ok(!isError(r));
    assert.equal(r.command, "inspect");
  });

  it("inspect --session", () => {
    const r = parse("inspect", "--session", "def67890");
    assert.ok(!isError(r));
    if (r.command === "inspect") {
      assert.equal(r.session, "def67890");
      assert.equal(r.last, false);
    }
  });

  it("inspect --last", () => {
    const r = parse("inspect", "--last");
    assert.ok(!isError(r));
    if (r.command === "inspect") {
      assert.equal(r.last, true);
    }
  });

  it("inspect --source", () => {
    const r = parse("inspect", "--source", "gemini");
    assert.ok(!isError(r));
    if (r.command === "inspect") {
      assert.equal(r.source, "gemini");
    }
  });

  it("inspect --full", () => {
    const r = parse("inspect", "--full");
    assert.ok(!isError(r));
    if (r.command === "inspect") {
      assert.equal(r.full, true);
    }
  });

  // --- replay subcommand tests ---

  it("replay requires file", () => {
    const r = parse("replay");
    assert.ok(isError(r));
    assert.ok(r.error.includes("No capture file"));
  });

  it("replay with file", () => {
    const r = parse("replay", "captures/test.json");
    assert.ok(!isError(r));
    if (r.command === "replay") {
      assert.equal(r.captureFile, "captures/test.json");
      assert.equal(r.diff, false);
      assert.equal(r.model, null);
    }
  });

  it("replay --diff", () => {
    const r = parse("replay", "test.json", "--diff");
    assert.ok(!isError(r));
    if (r.command === "replay") {
      assert.equal(r.diff, true);
    }
  });

  it("replay --model", () => {
    const r = parse("replay", "test.json", "--model", "gpt-4o");
    assert.ok(!isError(r));
    if (r.command === "replay") {
      assert.equal(r.model, "gpt-4o");
    }
  });

  it("replay unknown option is error", () => {
    const r = parse("replay", "test.json", "--unknown");
    assert.ok(isError(r));
  });

  // --- export subcommand tests ---

  it("export requires session or --last", () => {
    const r = parse("export");
    assert.ok(isError(r));
    assert.ok(r.error.includes("Must specify session"));
  });

  it("export with session", () => {
    const r = parse("export", "abc12345");
    assert.ok(!isError(r));
    if (r.command === "export") {
      assert.equal(r.session, "abc12345");
      assert.equal(r.last, false);
    }
  });

  it("export --last", () => {
    const r = parse("export", "--last");
    assert.ok(!isError(r));
    if (r.command === "export") {
      assert.equal(r.last, true);
    }
  });

  it("export -o output", () => {
    const r = parse("export", "abc12345", "-o", "/tmp/out.json");
    assert.ok(!isError(r));
    if (r.command === "export") {
      assert.equal(r.outputPath, "/tmp/out.json");
    }
  });

  it("export --output", () => {
    const r = parse("export", "--last", "--output", "/tmp/out.json");
    assert.ok(!isError(r));
    if (r.command === "export") {
      assert.equal(r.outputPath, "/tmp/out.json");
    }
  });

  it("export --redact", () => {
    const r = parse("export", "abc12345", "--redact");
    assert.ok(!isError(r));
    if (r.command === "export") {
      assert.equal(r.redact, true);
    }
  });

  // --- background subcommand tests ---

  it("background defaults to status", () => {
    const r = parse("background");
    assert.ok(!isError(r));
    if (r.command === "background") {
      assert.equal(r.action, "status");
    }
  });

  it("background start", () => {
    const r = parse("background", "start");
    assert.ok(!isError(r));
    if (r.command === "background") {
      assert.equal(r.action, "start");
    }
  });

  it("background stop", () => {
    const r = parse("background", "stop");
    assert.ok(!isError(r));
    if (r.command === "background") {
      assert.equal(r.action, "stop");
    }
  });

  it("background invalid action is error", () => {
    const r = parse("background", "restart");
    assert.ok(isError(r));
    assert.ok(r.error.includes("one of"));
  });

  // --- proxy wrap mode tests ---

  it("proxy -- with command", () => {
    const r = parse("proxy", "--", "claude");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.deepEqual(r.wrap, ["claude"]);
    }
  });

  it("proxy -- with command and args", () => {
    const r = parse("proxy", "--", "claude", "--model", "opus");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.deepEqual(r.wrap, ["claude", "--model", "opus"]);
    }
  });

  it("proxy -- with no command is error", () => {
    const r = parse("proxy", "--");
    assert.ok(isError(r));
    assert.ok(r.error.includes("No command specified"));
  });

  // --- verbose and other options ---

  it("proxy --verbose", () => {
    const r = parse("proxy", "--verbose");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.verbose, true);
    }
  });

  it("proxy --log-max-sessions", () => {
    const r = parse("proxy", "--log-max-sessions", "50");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.logMaxSessions, 50);
    }
  });

  it("proxy --bind", () => {
    const r = parse("proxy", "--bind", "0.0.0.0");
    assert.ok(!isError(r));
    if (r.command === "proxy") {
      assert.equal(r.bind, "0.0.0.0");
    }
  });

  // --- help topics ---

  it("help with unknown topic", () => {
    const r = parse("help", "bogus");
    assert.ok(!isError(r));
    if (r.command === "help") {
      assert.equal(r.topic, "bogus");
    }
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
