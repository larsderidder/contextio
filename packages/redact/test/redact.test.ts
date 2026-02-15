import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createStats, redactValue, redactWithPolicy } from "../src/redact.js";
import { PRESETS } from "../src/presets.js";
import { compilePolicy, fromPreset } from "../src/policy.js";
import { ReplacementMap } from "../src/mapping.js";
import { createStreamRehydrator } from "../src/stream.js";
import type { RedactionRule } from "../src/rules.js";

// --- Legacy API tests (redactValue) ---

describe("redactValue (legacy API)", () => {
  const rules = PRESETS.pii;
  const allowlist = new Set<string>();

  it("redacts email addresses", () => {
    const stats = createStats();
    const result = redactValue(
      "Contact me at john.doe@example.com please",
      rules,
      allowlist,
      stats,
    );
    assert.equal(result, "Contact me at [EMAIL_REDACTED] please");
    assert.equal(stats.totalReplacements, 1);
    assert.equal(stats.byRule["email"], 1);
  });

  it("redacts AWS access keys", () => {
    const stats = createStats();
    const result = redactValue(
      "key: AKIAIOSFODNN7EXAMPLE",
      rules,
      allowlist,
      stats,
    );
    assert.equal(result, "key: [AWS_KEY_REDACTED]");
  });

  it("redacts GitHub tokens", () => {
    const stats = createStats();
    const result = redactValue(
      "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn",
      rules,
      allowlist,
      stats,
    );
    assert.equal(result, "token: [GITHUB_TOKEN_REDACTED]");
  });

  it("redacts PEM private keys", () => {
    const stats = createStats();
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALRi...\n-----END RSA PRIVATE KEY-----";
    const result = redactValue(
      `Here is a key: ${pem}`,
      rules,
      allowlist,
      stats,
    );
    assert.equal(result, "Here is a key: [PRIVATE_KEY_REDACTED]");
  });

  it("respects allowlist", () => {
    const stats = createStats();
    const allowed = new Set(["keep@example.com"]);
    const result = redactValue(
      "Contact keep@example.com or other@example.com",
      rules,
      allowed,
      stats,
    );
    assert.equal(result, "Contact keep@example.com or [EMAIL_REDACTED]");
    assert.equal(stats.totalReplacements, 1);
  });

  it("walks nested objects", () => {
    const stats = createStats();
    const input = {
      model: "claude-3",
      messages: [{ role: "user", content: "Email me at user@test.com" }],
    };
    const result = redactValue(input, rules, allowlist, stats) as any;
    assert.equal(result.messages[0].content, "Email me at [EMAIL_REDACTED]");
  });

  it("passes through non-string primitives", () => {
    const stats = createStats();
    assert.equal(redactValue(42, rules, allowlist, stats), 42);
    assert.equal(redactValue(true, rules, allowlist, stats), true);
    assert.equal(redactValue(null, rules, allowlist, stats), null);
  });

  it("does not mutate the original object", () => {
    const stats = createStats();
    const input = { msg: "user@test.com" };
    const result = redactValue(input, rules, allowlist, stats) as any;
    assert.equal(input.msg, "user@test.com");
    assert.equal(result.msg, "[EMAIL_REDACTED]");
  });
});

// --- Policy API tests ---

describe("presets", () => {
  it("secrets preset catches API keys but not emails", () => {
    const policy = fromPreset("secrets");
    const stats = createStats();
    const result = redactWithPolicy(
      "key: AKIAIOSFODNN7EXAMPLE and john@test.com",
      policy,
      stats,
    );
    assert.equal(result, "key: [AWS_KEY_REDACTED] and john@test.com");
    assert.equal(stats.totalReplacements, 1);
  });

  it("pii preset catches secrets and emails", () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = redactWithPolicy(
      "key: AKIAIOSFODNN7EXAMPLE and john@test.com",
      policy,
      stats,
    );
    assert.equal(result, "key: [AWS_KEY_REDACTED] and [EMAIL_REDACTED]");
    assert.equal(stats.totalReplacements, 2);
  });

  it("strict preset catches IPs", () => {
    const policy = fromPreset("strict");
    const stats = createStats();
    const result = redactWithPolicy("server at 192.168.1.100", policy, stats);
    assert.equal(result, "server at [IP_REDACTED]");
  });
});

describe("context words", () => {
  it("SSN with context word is redacted in pii preset", () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = redactWithPolicy(
      "My social security number is 123-45-6789",
      policy,
      stats,
    );
    assert.equal(
      result,
      "My social security number is [SSN_REDACTED]",
    );
  });

  it("SSN-like pattern without context word is not redacted", () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = redactWithPolicy(
      "Order number 123-45-6789 shipped",
      policy,
      stats,
    );
    assert.equal(result, "Order number 123-45-6789 shipped");
    assert.equal(stats.totalReplacements, 0);
  });

  it("credit card with context word is redacted", () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = redactWithPolicy(
      "Please charge my credit card 4111-1111-1111-1111",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[CC_REDACTED]"));
  });

  it("credit card without context word is not redacted", () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const result = redactWithPolicy(
      "Reference 4111-1111-1111-1111 for tracking",
      policy,
      stats,
    );
    assert.ok(!(result as string).includes("[CC_REDACTED]"));
  });
});

describe("custom policy", () => {
  it("compiles custom rules from JSON", () => {
    const policy = compilePolicy({
      rules: [
        {
          id: "employee-id",
          pattern: "EMP-\\d{5}",
          replacement: "[EMPLOYEE_REDACTED]",
        },
      ],
    });
    const stats = createStats();
    const result = redactWithPolicy("Employee EMP-12345 assigned", policy, stats);
    assert.equal(result, "Employee [EMPLOYEE_REDACTED] assigned");
  });

  it("extends a preset with custom rules", () => {
    const policy = compilePolicy({
      extends: "secrets",
      rules: [
        {
          id: "project-name",
          pattern: "(?i)project[- ](?:atlas|phoenix)",
          replacement: "[PROJECT_REDACTED]",
        },
      ],
    });
    const stats = createStats();
    const result = redactWithPolicy(
      "Working on Project Atlas with key AKIAIOSFODNN7EXAMPLE",
      policy,
      stats,
    );
    assert.ok((result as string).includes("[PROJECT_REDACTED]"));
    assert.ok((result as string).includes("[AWS_KEY_REDACTED]"));
  });

  it("allowlist strings prevent redaction", () => {
    const policy = compilePolicy({
      extends: "pii",
      allowlist: { strings: ["admin@company.com"] },
    });
    const stats = createStats();
    const result = redactWithPolicy(
      "Contact admin@company.com or user@test.com",
      policy,
      stats,
    );
    assert.equal(
      result,
      "Contact admin@company.com or [EMAIL_REDACTED]",
    );
  });

  it("allowlist patterns prevent redaction", () => {
    const policy = compilePolicy({
      extends: "pii",
      allowlist: { patterns: ["test-\\d+@example\\.com"] },
    });
    const stats = createStats();
    const result = redactWithPolicy(
      "Contact test-42@example.com or user@test.com",
      policy,
      stats,
    );
    assert.equal(
      result,
      "Contact test-42@example.com or [EMAIL_REDACTED]",
    );
  });
});

describe("path filtering", () => {
  it("skip paths are not redacted", () => {
    const policy = compilePolicy({
      extends: "pii",
      paths: { skip: ["model", "messages[*].role"] },
    });
    const stats = createStats();
    const input = {
      model: "sk-secret-key-that-looks-like-api-key-12345678",
      messages: [
        { role: "user@test.com", content: "My email is real@test.com" },
      ],
    };
    const result = redactWithPolicy(input, policy, stats) as any;
    // model and role should be untouched
    assert.equal(result.model, input.model);
    assert.equal(result.messages[0].role, "user@test.com");
    // content should be redacted
    assert.ok(result.messages[0].content.includes("[EMAIL_REDACTED]"));
  });

  it("only paths restricts redaction to those paths", () => {
    const policy = compilePolicy({
      extends: "pii",
      paths: { only: ["messages[*].content"] },
    });
    const stats = createStats();
    const input = {
      metadata: { author: "user@test.com" },
      messages: [
        { role: "user", content: "Email me at real@test.com" },
      ],
    };
    const result = redactWithPolicy(input, policy, stats) as any;
    // metadata.author should be untouched (not in "only" paths)
    assert.equal(result.metadata.author, "user@test.com");
    // content should be redacted
    assert.ok(result.messages[0].content.includes("[EMAIL_REDACTED]"));
  });
});

describe("error handling", () => {
  it("unknown preset throws", () => {
    assert.throws(
      () => compilePolicy({ extends: "nonexistent" as any }),
      /Unknown preset/,
    );
  });
});

// --- ReplacementMap tests ---

describe("ReplacementMap", () => {
  it("generates numbered placeholders per rule", () => {
    const map = new ReplacementMap();
    assert.equal(map.getOrCreate("john@test.com", "email"), "[EMAIL_1]");
    assert.equal(map.getOrCreate("jane@test.com", "email"), "[EMAIL_2]");
    assert.equal(map.getOrCreate("123-45-6789", "ssn"), "[SSN_1]");
  });

  it("returns the same placeholder for the same original", () => {
    const map = new ReplacementMap();
    const first = map.getOrCreate("john@test.com", "email");
    const second = map.getOrCreate("john@test.com", "email");
    assert.equal(first, second);
    assert.equal(map.size, 1);
  });

  it("rehydrates all placeholders in a string", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");
    map.getOrCreate("123-45-6789", "ssn");

    const redacted = "Your email is [EMAIL_1] and your SSN is [SSN_1].";
    const restored = map.rehydrate(redacted);
    assert.equal(restored, "Your email is john@test.com and your SSN is 123-45-6789.");
  });

  it("rehydrates repeated placeholders", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const redacted = "Sent to [EMAIL_1]. Confirmed: [EMAIL_1].";
    assert.equal(
      map.rehydrate(redacted),
      "Sent to john@test.com. Confirmed: john@test.com.",
    );
  });

  it("handles no matches gracefully", () => {
    const map = new ReplacementMap();
    assert.equal(map.rehydrate("no placeholders here"), "no placeholders here");
  });
});

// --- Reversible redaction (end-to-end with policy) ---

describe("reversible redaction", () => {
  it("redacts with numbered placeholders when map is provided", () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const map = new ReplacementMap();

    const result = redactWithPolicy(
      "Email john@test.com and jane@test.com",
      policy,
      stats,
      [],
      map,
    );

    assert.equal(result, "Email [EMAIL_1] and [EMAIL_2]");
    assert.equal(map.size, 2);
  });

  it("same email in same request gets same placeholder", () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const map = new ReplacementMap();

    const result = redactWithPolicy(
      "From john@test.com to john@test.com",
      policy,
      stats,
      [],
      map,
    );

    assert.equal(result, "From [EMAIL_1] to [EMAIL_1]");
    assert.equal(map.size, 1);
  });

  it("map persists across multiple redaction calls", () => {
    const policy = fromPreset("pii");
    const map = new ReplacementMap();

    // First request
    const stats1 = createStats();
    redactWithPolicy("From john@test.com", policy, stats1, [], map);

    // Second request (same email should get same placeholder)
    const stats2 = createStats();
    const result = redactWithPolicy(
      "Also cc john@test.com and new@test.com",
      policy,
      stats2,
      [],
      map,
    );

    assert.equal(result, "Also cc [EMAIL_1] and [EMAIL_2]");
    assert.equal(map.size, 2);
  });

  it("round-trips through redact then rehydrate", () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const map = new ReplacementMap();

    const original = "Contact john@test.com. My SSN is 123-45-6789.";
    const redacted = redactWithPolicy(original, policy, stats, [], map) as string;

    // Simulate LLM echoing the redacted content
    const llmResponse = `Got it, I'll email ${redacted.includes("[EMAIL_1]") ? "[EMAIL_1]" : "??"} about SSN ${redacted.includes("[SSN_1]") ? "[SSN_1]" : "??"}`;

    const restored = map.rehydrate(llmResponse);
    assert.equal(
      restored,
      "Got it, I'll email john@test.com about SSN 123-45-6789",
    );
  });

  it("works with nested objects", () => {
    const policy = fromPreset("pii");
    const stats = createStats();
    const map = new ReplacementMap();

    const input = {
      messages: [
        { role: "user", content: "My email is john@test.com" },
      ],
    };

    const result = redactWithPolicy(input, policy, stats, [], map) as any;
    assert.equal(result.messages[0].content, "My email is [EMAIL_1]");

    // Rehydrate simulated response
    const responseBody = '{"content": "Noted, [EMAIL_1] is your email."}';
    const restored = map.rehydrate(responseBody);
    assert.equal(restored, '{"content": "Noted, john@test.com is your email."}');
  });
});

// --- Stream rehydration ---

describe("stream rehydration", () => {
  function toBuffer(s: string): Buffer {
    return Buffer.from(s, "utf8");
  }
  function toString(b: Buffer | null): string {
    return b ? b.toString("utf8") : "";
  }

  /** Build an SSE text_delta line (with trailing \n). */
  function sseTextDelta(text: string, index = 0): string {
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `data: {"type":"content_block_delta","index":${index},"delta":{"type":"text_delta","text":"${escaped}"}}\n`;
  }

  /** Build an SSE thinking_delta line (with trailing \n). */
  function sseThinkingDelta(thinking: string, index = 0): string {
    const escaped = thinking.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `data: {"type":"content_block_delta","index":${index},"delta":{"type":"thinking_delta","thinking":"${escaped}"}}\n`;
  }

  /** Extract all text/thinking content from SSE output (all provider formats). */
  function extractContent(sse: string): string {
    let result = "";
    for (const line of sse.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const obj = JSON.parse(line.slice(6));
        // Anthropic: delta.text / delta.thinking
        if (obj.delta?.text) result += obj.delta.text;
        if (obj.delta?.thinking) result += obj.delta.thinking;
        // OpenAI: choices[].delta.content
        if (obj.choices?.[0]?.delta?.content) result += obj.choices[0].delta.content;
        // Gemini: candidates[].content.parts[].text
        if (obj.candidates?.[0]?.content?.parts) {
          for (const part of obj.candidates[0].content.parts) {
            if (typeof part.text === "string") result += part.text;
          }
        }
        // Gemini with response wrapper
        if (obj.response?.candidates?.[0]?.content?.parts) {
          for (const part of obj.response.candidates[0].content.parts) {
            if (typeof part.text === "string") result += part.text;
          }
        }
      } catch {
        // not JSON; ignore
      }
    }
    return result;
  }

  /** Stream all chunks through a rehydrator and return combined output. */
  function streamAll(
    map: ReplacementMap,
    chunks: string[],
  ): string {
    const stream = createStreamRehydrator(map);
    let out = "";
    for (const c of chunks) {
      out += toString(stream.onChunk(toBuffer(c)));
    }
    out += toString(stream.onEnd());
    return out;
  }

  it("rehydrates a complete placeholder in a single event", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const sse = streamAll(map, [sseTextDelta("Hello [EMAIL_1]") + "\n"]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
    assert.ok(!text.includes("[EMAIL_1]"), `got: ${text}`);
  });

  it("rehydrates a placeholder split across two SSE events", () => {
    const map = new ReplacementMap();
    map.getOrCreate("(555) 234-5678", "phone-us");

    // "[PHONE_US_1" in one event, "]" in the next (the actual bug scenario)
    const sse = streamAll(map, [
      sseTextDelta("call [PHONE_US_1") + "\n",
      sseTextDelta("] please") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("(555) 234-5678"), `got: ${text}`);
    assert.ok(!text.includes("[PHONE_US_1]"), `got: ${text}`);
  });

  it("rehydrates a placeholder split across three SSE events", () => {
    const map = new ReplacementMap();
    map.getOrCreate("AKIAIOSFODNN7EXAMPLE", "aws-access-key");

    // "[AWS_ACCESS_" / "KEY_" / "1]"
    const sse = streamAll(map, [
      sseTextDelta("key: [AWS_ACCESS_") + "\n",
      sseTextDelta("KEY_") + "\n",
      sseTextDelta("1] done") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("AKIAIOSFODNN7EXAMPLE"), `got: ${text}`);
    assert.ok(!text.includes("[AWS_ACCESS_KEY_1]"), `got: ${text}`);
  });

  it("handles multiple split placeholders in sequence", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");
    map.getOrCreate("jane@test.com", "email");
    map.getOrCreate("123-45-6789", "ssn");

    const sse = streamAll(map, [
      sseTextDelta("[EMAIL_") + "\n",
      sseTextDelta("1] and [EMAIL_") + "\n",
      sseTextDelta("2] and [SS") + "\n",
      sseTextDelta("N_1]") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
    assert.ok(text.includes("jane@test.com"), `got: ${text}`);
    assert.ok(text.includes("123-45-6789"), `got: ${text}`);
    assert.ok(!text.includes("[EMAIL_"), `got: ${text}`);
    assert.ok(!text.includes("[SSN_"), `got: ${text}`);
  });

  it("handles TCP-level splits within a single SSE line", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    // One SSE line split across two TCP chunks (mid-JSON)
    const fullLine = sseTextDelta("Hi [EMAIL_1] bye");
    const splitAt = fullLine.indexOf("[EMAIL");
    const sse = streamAll(map, [
      fullLine.slice(0, splitAt),
      fullLine.slice(splitAt) + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
  });

  it("passes through non-delta events unchanged", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const event = 'data: {"type":"message_start","message":{"content":[]}}\n\n';
    const sse = streamAll(map, [event]);
    assert.ok(sse.includes("message_start"), `got: ${sse}`);
    assert.ok(sse.includes('"content":[]'), `JSON brackets preserved, got: ${sse}`);
  });

  it("handles empty map without modification", () => {
    const map = new ReplacementMap();
    const input = sseTextDelta("[EMAIL_1]") + "\n";
    const stream = createStreamRehydrator(map);
    const out = toString(stream.onChunk(toBuffer(input)));
    assert.equal(out, input);
  });

  it("passes through text with no placeholders", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const sse = streamAll(map, [sseTextDelta("Hello world") + "\n"]);
    const text = extractContent(sse);
    assert.equal(text, "Hello world");
  });

  it("handles text containing [ that is not a placeholder", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const sse = streamAll(map, [
      sseTextDelta("[click here](http://example.com) and [EMAIL_1]") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("[click here](http://example.com)"), `got: ${text}`);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
  });

  it("flushes text buffer when non-delta event arrives", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const sse = streamAll(map, [
      sseTextDelta("Hello [EMAIL_1]") + "\n",
      'data: {"type":"content_block_stop","index":1}\n',
      "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
    assert.ok(sse.includes("content_block_stop"), `stop event preserved, got: ${sse}`);
  });

  it("rehydrates thinking_delta content", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const sse = streamAll(map, [
      sseThinkingDelta("processing [EMAIL_1]") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
  });

  it("rehydrates thinking_delta split across events", () => {
    const map = new ReplacementMap();
    map.getOrCreate("123-45-6789", "ssn");

    const sse = streamAll(map, [
      sseThinkingDelta("SSN is [SS") + "\n",
      sseThinkingDelta("N_1] noted") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("123-45-6789"), `got: ${text}`);
    assert.ok(!text.includes("[SSN_1]"), `got: ${text}`);
  });

  it("flushes pending buffer on end", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    const stream = createStreamRehydrator(map);
    // Incomplete line, never terminated
    toString(stream.onChunk(toBuffer("data: incomplete")));
    const flushed = toString(stream.onEnd());
    assert.ok(flushed.includes("data: incomplete"), `got: ${flushed}`);
  });

  it("handles realistic Claude response with mixed event types", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");
    map.getOrCreate("jane@test.com", "email");
    map.getOrCreate("(555) 234-5678", "phone-us");
    map.getOrCreate("123-45-6789", "ssn");
    map.getOrCreate("AKIAIOSFODNN7EXAMPLE", "aws-access-key");

    const sse = streamAll(map, [
      'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514"}}\n\n',
      'event: content_block_start\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      sseThinkingDelta("The user has [EMAIL_") + "\n",
      sseThinkingDelta("1] and [SS") + "\n",
      sseThinkingDelta("N_1]") + "\n",
      'data: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      sseTextDelta("| [EMAIL_1] | [PHONE_US_", 1) + "\n",
      sseTextDelta("1] |", 1) + "\n",
      sseTextDelta("\\n| [EMAIL_2] | AWS [AWS_ACCESS_", 1) + "\n",
      sseTextDelta("KEY_1] |", 1) + "\n",
      'data: {"type":"content_block_stop","index":1}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    const text = extractContent(sse);

    // All values rehydrated
    assert.ok(text.includes("john@test.com"), `email 1, got: ${text}`);
    assert.ok(text.includes("jane@test.com"), `email 2, got: ${text}`);
    assert.ok(text.includes("(555) 234-5678"), `phone, got: ${text}`);
    assert.ok(text.includes("123-45-6789"), `ssn, got: ${text}`);
    assert.ok(text.includes("AKIAIOSFODNN7EXAMPLE"), `aws key, got: ${text}`);

    // No placeholders remain
    assert.ok(!text.includes("[EMAIL_"), `no email placeholder, got: ${text}`);
    assert.ok(!text.includes("[PHONE_"), `no phone placeholder, got: ${text}`);
    assert.ok(!text.includes("[SSN_"), `no ssn placeholder, got: ${text}`);
    assert.ok(!text.includes("[AWS_"), `no aws placeholder, got: ${text}`);

    // Structure preserved: non-delta events pass through
    assert.ok(sse.includes("message_start"), "message_start preserved");
    assert.ok(sse.includes("content_block_stop"), "content_block_stop preserved");
    assert.ok(sse.includes("message_stop"), "message_stop preserved");
  });

  it("rehydrates OpenAI streaming format", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    function openaiDelta(content: string): string {
      const escaped = content.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `data: {"choices":[{"index":0,"delta":{"content":"${escaped}"}}]}\n`;
    }

    const sse = streamAll(map, [
      openaiDelta("Email: [EMAIL_") + "\n",
      openaiDelta("1] ok") + "\n",
      "data: [DONE]\n\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
    assert.ok(!text.includes("[EMAIL_1]"), `got: ${text}`);
    assert.ok(sse.includes("[DONE]"), "DONE event preserved");
  });

  it("rehydrates Gemini streaming format", () => {
    const map = new ReplacementMap();
    map.getOrCreate("john@test.com", "email");

    function geminiDelta(text: string): string {
      const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `data: {"candidates":[{"content":{"parts":[{"text":"${escaped}"}]}}]}\n`;
    }

    const sse = streamAll(map, [
      geminiDelta("Hello [EMAIL_") + "\n",
      geminiDelta("1] world") + "\n",
    ]);
    const text = extractContent(sse);
    assert.ok(text.includes("john@test.com"), `got: ${text}`);
    assert.ok(!text.includes("[EMAIL_1]"), `got: ${text}`);
  });
});
