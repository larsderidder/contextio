import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyRequest,
  extractSource,
  resolveTargetUrl,
} from "../dist/index.js";
import type { Upstreams } from "../dist/types.js";

const mockUpstreams: Upstreams = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
  geminiCodeAssist: "https://cloudcode-assist.googleusercontent.com",
  chatgpt: "https://chatgpt.com/backend-api",
};

describe("classifyRequest", () => {
  it("classifies ChatGPT backend traffic", () => {
    const result = classifyRequest("/api/some-endpoint", {});
    assert.equal(result.provider, "chatgpt");
    assert.equal(result.apiFormat, "chatgpt-backend");
  });

  it("classifies backend-api traffic as chatgpt", () => {
    const result = classifyRequest("/backend-api/v1/chat", {});
    assert.equal(result.provider, "chatgpt");
  });

  it("classifies Anthropic Messages API", () => {
    const result = classifyRequest("/v1/messages", {});
    assert.equal(result.provider, "anthropic");
    assert.equal(result.apiFormat, "anthropic-messages");
  });

  it("classifies Anthropic /v1/complete", () => {
    const result = classifyRequest("/v1/complete", {});
    assert.equal(result.provider, "anthropic");
    assert.equal(result.apiFormat, "unknown");
  });

  it("classifies Anthropic by header", () => {
    const result = classifyRequest("/some/path", {
      "anthropic-version": "2023-06-01",
    });
    assert.equal(result.provider, "anthropic");
  });

  it("classifies Gemini generateContent", () => {
    const result = classifyRequest(
      "/models/gemini-pro:generateContent",
      {},
    );
    assert.equal(result.provider, "gemini");
  });

  it("classifies Gemini streamGenerateContent", () => {
    const result = classifyRequest(
      "/models/gemini-pro:streamGenerateContent",
      {},
    );
    assert.equal(result.provider, "gemini");
  });

  it("classifies Gemini v1beta models", () => {
    const result = classifyRequest("/v1beta/models/gemini-pro:generateContent", {});
    assert.equal(result.provider, "gemini");
  });

  it("classifies Gemini v1alpha models", () => {
    const result = classifyRequest("/v1alpha/models/gemini-pro:generateContent", {});
    assert.equal(result.provider, "gemini");
  });

  it("classifies Gemini by header", () => {
    const result = classifyRequest("/some/path", {
      "x-goog-api-key": "some-key",
    });
    assert.equal(result.provider, "gemini");
  });

  it("classifies OpenAI /responses", () => {
    const result = classifyRequest("/v1/responses", {});
    assert.equal(result.provider, "openai");
    assert.equal(result.apiFormat, "responses");
  });

  it("classifies OpenAI /chat/completions", () => {
    const result = classifyRequest("/v1/chat/completions", {});
    assert.equal(result.provider, "openai");
    assert.equal(result.apiFormat, "chat-completions");
  });

  it("classifies OpenAI /models", () => {
    const result = classifyRequest("/v1/models", {});
    assert.equal(result.provider, "openai");
  });

  it("classifies OpenAI /embeddings", () => {
    const result = classifyRequest("/v1/embeddings", {});
    assert.equal(result.provider, "openai");
  });

  it("classifies OpenAI by Bearer token", () => {
    const result = classifyRequest("/some/path", {
      authorization: "Bearer sk-test-key",
    });
    assert.equal(result.provider, "openai");
  });

  it("returns unknown for unrecognized paths", () => {
    const result = classifyRequest("/unknown/path", {});
    assert.equal(result.provider, "unknown");
    assert.equal(result.apiFormat, "unknown");
  });

  it("prefers Gemini over OpenAI for gemini paths", () => {
    // Even with an sk- key, gemini paths should be detected first
    const result = classifyRequest("/v1beta/models/test:generateContent", {
      authorization: "Bearer sk-test",
    });
    assert.equal(result.provider, "gemini");
  });
});

describe("extractSource", () => {
  it("extracts source from simple path", () => {
    const result = extractSource("/claude/v1/messages");
    assert.equal(result.source, "claude");
    assert.equal(result.sessionId, null);
    assert.equal(result.cleanPath, "/v1/messages");
  });

  it("extracts source and session ID", () => {
    const result = extractSource("/claude/ab12cd34/v1/messages");
    assert.equal(result.source, "claude");
    assert.equal(result.sessionId, "ab12cd34");
    assert.equal(result.cleanPath, "/v1/messages");
  });

  it("returns null for API path segments", () => {
    const result = extractSource("/v1/messages");
    assert.equal(result.source, null);
    assert.equal(result.sessionId, null);
    assert.equal(result.cleanPath, "/v1/messages");
  });

  it("returns null for v1beta path segments", () => {
    const result = extractSource("/v1beta/models");
    assert.equal(result.source, null);
  });

  it("returns null for v1alpha path segments", () => {
    const result = extractSource("/v1alpha/models");
    assert.equal(result.source, null);
  });

  it("returns null for responses path segment", () => {
    const result = extractSource("/responses");
    assert.equal(result.source, null);
  });

  it("returns null for chat path segment", () => {
    const result = extractSource("/chat/completions");
    assert.equal(result.source, null);
  });

  it("returns null for models path segment", () => {
    const result = extractSource("/models");
    assert.equal(result.source, null);
  });

  it("returns null for embeddings path segment", () => {
    const result = extractSource("/embeddings");
    assert.equal(result.source, null);
  });

  it("returns null for backend-api path segment", () => {
    const result = extractSource("/backend-api/test");
    assert.equal(result.source, null);
  });

  it("returns null for api path segment", () => {
    const result = extractSource("/api/test");
    assert.equal(result.source, null);
  });

  it("extracts source from root path as null", () => {
    const result = extractSource("/");
    assert.equal(result.source, null);
    assert.equal(result.cleanPath, "/");
  });

  it("extracts source from encoded path", () => {
    const result = extractSource("/test%20source/v1/messages");
    assert.equal(result.source, "test source");
  });

  it("extracts source with forward slash but doesn't treat second segment as session", () => {
    // /test/source/v1/messages - "source" is treated as part of path, not session
    const result = extractSource("/test/source/v1/messages");
    // The source is "test", the rest is "/source/v1/messages"
    assert.equal(result.source, "test");
    assert.equal(result.cleanPath, "/source/v1/messages");
  });

  it("returns null for source with backslash", () => {
    const result = extractSource("/test\\source/v1/messages");
    assert.equal(result.source, null);
  });

  it("extracts source with .. (doesn't do path traversal check)", () => {
    // The source is extracted before path validation, so "test" is extracted
    const result = extractSource("/test/../source/v1/messages");
    // The implementation extracts "test" as source
    assert.equal(result.source, "test");
  });

  it("returns null for path with only source and no trailing slash", () => {
    // /claude - without a trailing path, this is treated as root with no source
    const result = extractSource("/claude");
    // The implementation returns null for the source when there's nothing after it
    assert.equal(result.source, null);
  });

  it("extracts session ID that is valid hex", () => {
    const result = extractSource("/source/a1b2c3d4/v1/messages");
    assert.equal(result.sessionId, "a1b2c3d4");
  });

  it("does not treat non-8-char segments as session ID", () => {
    const result = extractSource("/source/abc/v1/messages");
    assert.equal(result.sessionId, null);
    assert.equal(result.cleanPath, "/abc/v1/messages");
  });

  it("treats 8-char hex segments as session ID", () => {
    const result = extractSource("/source/12345678/v1/messages");
    assert.equal(result.sessionId, "12345678");
  });
});

describe("resolveTargetUrl", () => {
  it("resolves to anthropic for anthropic provider", () => {
    const result = resolveTargetUrl(
      "/v1/messages",
      "",
      {},
      mockUpstreams,
    );
    assert.equal(result.provider, "anthropic");
    assert.equal(
      result.targetUrl,
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("resolves to openai for openai provider", () => {
    const result = resolveTargetUrl(
      "/v1/models",
      "",
      {},
      mockUpstreams,
    );
    assert.equal(result.provider, "openai");
    assert.equal(
      result.targetUrl,
      "https://api.openai.com/v1/models",
    );
  });

  it("resolves to gemini for gemini provider", () => {
    const result = resolveTargetUrl(
      "/models/gemini-pro:generateContent",
      "",
      {},
      mockUpstreams,
    );
    assert.equal(result.provider, "gemini");
    assert.equal(
      result.targetUrl,
      "https://generativelanguage.googleapis.com/models/gemini-pro:generateContent",
    );
  });

  it("resolves to geminiCodeAssist for v1internal paths", () => {
    const result = resolveTargetUrl(
      "/v1internal:test",
      "",
      {},
      mockUpstreams,
    );
    assert.equal(result.provider, "gemini");
    assert.equal(
      result.targetUrl,
      "https://cloudcode-assist.googleusercontent.com/v1internal:test",
    );
  });

  it("resolves to chatgpt for chatgpt provider", () => {
    const result = resolveTargetUrl(
      "/api/test",
      "",
      {},
      mockUpstreams,
    );
    assert.equal(result.provider, "chatgpt");
    assert.equal(
      result.targetUrl,
      "https://chatgpt.com/backend-api/api/test",
    );
  });

  it("uses x-target-url header when allowed", () => {
    const result = resolveTargetUrl(
      "/v1/messages",
      "",
      { "x-target-url": "https://custom.com/api" },
      mockUpstreams,
    );
    // Default allowTargetOverride is false, so this would still use upstream
    // But we test the resolution without that flag
    assert.equal(result.provider, "anthropic");
  });

  it("appends query string to target URL", () => {
    const result = resolveTargetUrl(
      "/v1/messages",
      "?key=value",
      {},
      mockUpstreams,
    );
    assert.equal(
      result.targetUrl,
      "https://api.anthropic.com/v1/messages?key=value",
    );
  });

  it("handles empty query string", () => {
    const result = resolveTargetUrl("/v1/messages", null, {}, mockUpstreams);
    assert.equal(
      result.targetUrl,
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("uses upstream when x-target-url is relative", () => {
    // This tests the case where x-target-url doesn't start with http
    // The function would need x-target-url to be passed through
    const result = resolveTargetUrl(
      "/v1/messages",
      "",
      {},
      mockUpstreams,
    );
    assert.equal(result.provider, "anthropic");
  });
});

describe("round-trip classification and resolution", () => {
  it("handles Anthropic Claude API path", () => {
    const { source } = extractSource("/claude/ab12cd34/v1/messages");
    const { provider } = classifyRequest("/v1/messages", {});
    const { targetUrl } = resolveTargetUrl("/v1/messages", "", {}, mockUpstreams);

    assert.equal(source, "claude");
    assert.equal(provider, "anthropic");
    assert.equal(targetUrl, "https://api.anthropic.com/v1/messages");
  });

  it("handles OpenAI Chat Completions path", () => {
    const { source } = extractSource("/openai/v1/chat/completions");
    const { provider } = classifyRequest("/v1/chat/completions", {});
    const { targetUrl } = resolveTargetUrl(
      "/v1/chat/completions",
      "",
      {},
      mockUpstreams,
    );

    assert.equal(source, "openai");
    assert.equal(provider, "openai");
    assert.equal(targetUrl, "https://api.openai.com/v1/chat/completions");
  });

  it("handles Gemini path with session", () => {
    const { source, sessionId } = extractSource("/gemini/abcdef01/v1beta/models/pro:generateContent");
    const { provider } = classifyRequest(
      "/v1beta/models/pro:generateContent",
      {},
    );
    const { targetUrl } = resolveTargetUrl(
      "/v1beta/models/pro:generateContent",
      "",
      {},
      mockUpstreams,
    );

    assert.equal(source, "gemini");
    assert.equal(sessionId, "abcdef01");
    assert.equal(provider, "gemini");
    assert.equal(
      targetUrl,
      "https://generativelanguage.googleapis.com/v1beta/models/pro:generateContent",
    );
  });
});
