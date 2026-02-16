import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getToolEnv } from "../dist/tools.js";

describe("getToolEnv", () => {
  const proxy = "http://127.0.0.1:4040";

  it("claude sets ANTHROPIC_BASE_URL with source tag", () => {
    const { env } = getToolEnv("claude", proxy);
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4040/claude");
    assert.equal(env.OPENAI_BASE_URL, undefined);
  });

  it("aider sets both ANTHROPIC and OPENAI base URLs", () => {
    const { env } = getToolEnv("aider", proxy);
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4040/aider");
    assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:4040/aider");
  });

  it("gemini sets GOOGLE_GEMINI_BASE_URL and CODE_ASSIST_ENDPOINT", () => {
    const { env } = getToolEnv("gemini", proxy);
    assert.equal(env.GOOGLE_GEMINI_BASE_URL, "http://127.0.0.1:4040/gemini/");
    assert.equal(env.CODE_ASSIST_ENDPOINT, "http://127.0.0.1:4040/gemini");
  });

  it("codex returns empty env (unsupported)", () => {
    const { env, needsMitm } = getToolEnv("codex", proxy);
    assert.deepEqual(env, {});
    assert.ok(!needsMitm);
  });

  it("copilot uses mitmproxy upstream mode", () => {
    const { env, needsMitm } = getToolEnv("copilot", proxy);
    assert.deepEqual(env, {});
    assert.equal(needsMitm, true);
  });

  it("opencode uses mitmproxy upstream mode", () => {
    const { env, needsMitm } = getToolEnv("opencode", proxy);
    assert.deepEqual(env, {});
    assert.equal(needsMitm, true);
  });

  it("unknown tool gets both ANTHROPIC and OPENAI as fallback", () => {
    const { env } = getToolEnv("my-custom-tool", proxy);
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4040/my-custom-tool");
    assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:4040/my-custom-tool");
  });
});
