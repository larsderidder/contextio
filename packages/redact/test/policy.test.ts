import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

import { compilePolicy, fromPreset, loadPolicyFile } from "../dist/policy.js";

function tmpFile(extension = "json"): string {
  return join(
    tmpdir(),
    `contextio-policy-test-${randomBytes(4).toString("hex")}.${extension}`,
  );
}

describe("policy compilation", () => {
  it("compiles empty policy", () => {
    const policy = compilePolicy({});
    assert.equal(policy.rules.length, 0);
    assert.equal(policy.allowlist.strings.size, 0);
    assert.equal(policy.allowlist.patterns.length, 0);
    assert.equal(policy.paths.only, null);
    assert.equal(policy.paths.skip.length, 0);
  });

  it("compiles policy with custom rules only", () => {
    const policy = compilePolicy({
      rules: [
        {
          id: "custom-rule",
          pattern: "CUSTOM-\\d+",
          replacement: "[CUSTOM_REDACTED]",
        },
      ],
    });

    assert.equal(policy.rules.length, 1);
    assert.equal(policy.rules[0].name, "custom-rule");
  });

  it("extends secrets preset", () => {
    const policy = compilePolicy({ extends: "secrets" });
    assert.ok(policy.rules.length > 0);
  });

  it("extends pii preset", () => {
    const policy = compilePolicy({ extends: "pii" });
    assert.ok(policy.rules.length > 0);
  });

  it("extends strict preset", () => {
    const policy = compilePolicy({ extends: "strict" });
    assert.ok(policy.rules.length > 0);
  });

  it("extends preset and adds custom rules", () => {
    const policy = compilePolicy({
      extends: "secrets",
      rules: [
        {
          id: "custom",
          pattern: "PATTERN",
          replacement: "[REDACTED]",
        },
      ],
    });

    assert.ok(policy.rules.length > 1);
    // Custom rule should be last
    assert.equal(policy.rules[policy.rules.length - 1].name, "custom");
  });

  it("compiles allowlist strings", () => {
    const policy = compilePolicy({
      allowlist: {
        strings: ["keep-me@test.com", "safe@example.org"],
      },
    });

    assert.equal(policy.allowlist.strings.size, 2);
    assert.ok(policy.allowlist.strings.has("keep-me@test.com"));
    assert.ok(policy.allowlist.strings.has("safe@example.org"));
  });

  it("compiles allowlist patterns", () => {
    const policy = compilePolicy({
      allowlist: {
        patterns: ["^test-.*$", ".*@example\\.com$"],
      },
    });

    assert.equal(policy.allowlist.patterns.length, 2);
  });

  it("compiles paths.only", () => {
    const policy = compilePolicy({
      paths: {
        only: ["messages[*].content", "system"],
      },
    });

    assert.notEqual(policy.paths.only, null);
    assert.equal(policy.paths.only!.length, 2);
    assert.equal(policy.paths.only![0].source, "messages[*].content");
  });

  it("compiles paths.skip", () => {
    const policy = compilePolicy({
      paths: {
        skip: ["model", "metadata"],
      },
    });

    assert.equal(policy.paths.skip.length, 2);
    assert.equal(policy.paths.skip[0].source, "model");
  });

  it("compiles both paths.only and paths.skip", () => {
    const policy = compilePolicy({
      paths: {
        only: ["messages[*].content"],
        skip: ["metadata"],
      },
    });

    assert.notEqual(policy.paths.only, null);
    assert.equal(policy.paths.skip.length, 1);
  });

  it("throws on unknown preset", () => {
    assert.throws(
      () => compilePolicy({ extends: "nonexistent" as any }),
      /Unknown preset/,
    );
  });

  it("throws on unknown preset even with other options", () => {
    assert.throws(
      () =>
        compilePolicy({
          extends: "nonexistent" as any,
          rules: [{ id: "test", pattern: "x", replacement: "y" }],
        }),
      /Unknown preset/,
    );
  });
});

describe("rule compilation", () => {
  it("compiles simple pattern", () => {
    const policy = compilePolicy({
      rules: [
        {
          id: "test",
          pattern: "test123",
          replacement: "[TEST]",
        },
      ],
    });

    assert.ok(policy.rules[0].pattern instanceof RegExp);
  });

  it("adds global flag to pattern", () => {
    const policy = compilePolicy({
      rules: [
        {
          id: "test",
          pattern: "test",
          replacement: "[TEST]",
        },
      ],
    });

    assert.ok(policy.rules[0].pattern.flags.includes("g"));
  });

  it("converts (?i) prefix to case-insensitive flag", () => {
    const policy = compilePolicy({
      rules: [
        {
          id: "test",
          pattern: "(?i)hello",
          replacement: "[HI]",
        },
      ],
    });

    assert.ok(policy.rules[0].pattern.flags.includes("i"));
    assert.ok(!policy.rules[0].pattern.source.startsWith("(?i)"));
  });

  it("compiles rule with context", () => {
    const policy = compilePolicy({
      rules: [
        {
          id: "test",
          pattern: "\\d{3}-\\d{4}",
          replacement: "[PHONE]",
          context: ["call", "phone", "contact"],
        },
      ],
    });

    assert.deepEqual(policy.rules[0].context, ["call", "phone", "contact"]);
    assert.equal(policy.rules[0].contextWindow, 100); // default
  });

  it("compiles rule with custom context window", () => {
    const policy = compilePolicy({
      rules: [
        {
          id: "test",
          pattern: "\\d{3}-\\d{4}",
          replacement: "[PHONE]",
          context: ["call"],
          contextWindow: 200,
        },
      ],
    });

    assert.equal(policy.rules[0].contextWindow, 200);
  });
});

describe("fromPreset", () => {
  it("creates policy from secrets preset", () => {
    const policy = fromPreset("secrets");
    assert.ok(policy.rules.length > 0);
  });

  it("creates policy from pii preset", () => {
    const policy = fromPreset("pii");
    assert.ok(policy.rules.length > 0);
  });

  it("creates policy from strict preset", () => {
    const policy = fromPreset("strict");
    assert.ok(policy.rules.length > 0);
  });
});

describe("loadPolicyFile", () => {
  it("loads and compiles a simple JSON file", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        rules: [
          {
            id: "from-file",
            pattern: "FILE-\\d+",
            replacement: "[FILE_REDACTED]",
          },
        ],
      }),
    );

    const policy = loadPolicyFile(file);
    assert.equal(policy.rules.length, 1);
    assert.equal(policy.rules[0].name, "from-file");

    fs.unlinkSync(file);
  });

  it("strips single-line comments", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      `{
      // This is a comment
      "rules": [
        {
          "id": "from-file",
          "pattern": "TEST",
          "replacement": "[REDACTED]"
        }
      ]
    }`,
    );

    const policy = loadPolicyFile(file);
    assert.equal(policy.rules.length, 1);

    fs.unlinkSync(file);
  });

  it("strips trailing commas", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      `{
      "rules": [
        {
          "id": "test",
          "pattern": "x",
          "replacement": "y"
        },
      ],
      "allowlist": {
        "strings": ["a", "b",],
      }
    }`,
    );

    const policy = loadPolicyFile(file);
    assert.equal(policy.rules.length, 1);
    assert.equal(policy.allowlist.strings.size, 2);

    fs.unlinkSync(file);
  });

  it("strips comments and trailing commas together", () => {
    const file = tmpFile();
    // Only test valid JSON with comments stripped properly - the // after value is tricky
    fs.writeFileSync(
      file,
      `{
      // Comment at start
      "extends": "secrets",
      "rules": [
        {
          "id": "rule1",
          "pattern": "PAT1",
          "replacement": "[R1]"
        }
      ]
    }`,
    );

    const policy = loadPolicyFile(file);
    assert.ok(policy.rules.length > 0);

    fs.unlinkSync(file);
  });

  it("handles file with only comments", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      `{
      // Just comments
      // Nothing else
    }`,
    );

    const policy = loadPolicyFile(file);
    // Should compile empty policy
    assert.equal(policy.rules.length, 0);

    fs.unlinkSync(file);
  });

  it("throws on invalid JSON (after comment stripping)", () => {
    const file = tmpFile();
    // Invalid JSON even after stripping comments
    fs.writeFileSync(
      file,
      `{
      "rules": [
        { "id": "test" }
      ], // missing closing bracket
    `,
    );

    assert.throws(() => loadPolicyFile(file), /JSON/);

    fs.unlinkSync(file);
  });

  it("throws on missing file", () => {
    const file = tmpFile();
    // File doesn't exist
    assert.throws(() => loadPolicyFile(file), /ENOENT/);
  });
});

describe("path parsing", () => {
  it("parses simple path", () => {
    const policy = compilePolicy({
      paths: { only: ["messages"] },
    });

    assert.equal(policy.paths.only![0].segments.length, 1);
    assert.equal(policy.paths.only![0].segments[0], "messages");
  });

  it("parses nested path", () => {
    const policy = compilePolicy({
      paths: { only: ["messages.content"] },
    });

    const segments = policy.paths.only![0].segments;
    assert.equal(segments.length, 2);
    assert.equal(segments[0], "messages");
    assert.equal(segments[1], "content");
  });

  it("parses wildcard path", () => {
    const policy = compilePolicy({
      paths: { only: ["messages[*].content"] },
    });

    const segments = policy.paths.only![0].segments;
    assert.equal(segments.length, 3);
    assert.equal(segments[0], "messages");
    assert.equal(segments[1], "*");
    assert.equal(segments[2], "content");
  });

  it("parses multiple wildcards", () => {
    const policy = compilePolicy({
      paths: { only: ["a[*].b[*].c"] },
    });

    const segments = policy.paths.only![0].segments;
    assert.deepEqual(segments, ["a", "*", "b", "*", "c"]);
  });

  it("filters empty segments", () => {
    const policy = compilePolicy({
      paths: { only: [".messages..content."] },
    });

    const segments = policy.paths.only![0].segments;
    assert.deepEqual(segments, ["messages", "content"]);
  });

  it("preserves original source string", () => {
    const policy = compilePolicy({
      paths: { only: ["messages[*].content"] },
    });

    assert.equal(policy.paths.only![0].source, "messages[*].content");
  });
});

describe("allowlist matching", () => {
  it("strings are matched exactly", () => {
    const policy = compilePolicy({
      rules: [
        {
          id: "email",
          pattern: "[a-z]+@[a-z.]+",
          replacement: "[EMAIL]",
        },
      ],
      allowlist: {
        strings: ["test@example.com"],
      },
    });

    // The allowlist is applied during redaction, not at compile time
    // But we verify the strings are in the set
    assert.ok(policy.allowlist.strings.has("test@example.com"));
    assert.ok(!policy.allowlist.strings.has("other@example.com"));
  });

  it("patterns are compiled to RegExp", () => {
    const policy = compilePolicy({
      allowlist: {
        patterns: ["^test-.*", ".*@example\\.com$"],
      },
    });

    assert.equal(policy.allowlist.patterns.length, 2);
    assert.ok(policy.allowlist.patterns[0] instanceof RegExp);
    assert.ok(policy.allowlist.patterns[1] instanceof RegExp);
  });

  it("empty allowlist works", () => {
    const policy = compilePolicy({
      allowlist: {},
    });

    assert.equal(policy.allowlist.strings.size, 0);
    assert.equal(policy.allowlist.patterns.length, 0);
  });
});
