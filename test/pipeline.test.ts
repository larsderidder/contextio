/**
 * Integration test: proxy + redact + logger pipeline.
 *
 * Spins up a mock upstream, starts the proxy with redact and logger plugins,
 * sends requests through, and verifies:
 * - Redact stripped PII from the request before it reached upstream
 * - Logger wrote a capture file with the redacted body
 * - The response flowed back to the client correctly
 * - Non-POST requests pass through without plugin interference
 * - Plugin errors in onCapture do not break the client response
 * - Reversible redaction with streaming SSE responses rehydrates placeholders
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

import { createProxy } from "@contextio/proxy";
import type { CaptureData, ProxyPlugin } from "@contextio/core";
import { createRedactPlugin } from "@contextio/redact";
import { createLoggerPlugin } from "@contextio/logger";

// --- Helpers ---

function makeRequest(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method || "POST",
        path: options.path,
        headers: options.headers || {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function waitForFile(dir: string, timeoutMs = 2000): Promise<string> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
        : [];
      if (files.length > 0) {
        resolve(join(dir, files[0]));
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("Timed out waiting for capture file"));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

// --- Test suite ---

describe("proxy + redact + logger pipeline", () => {
  let mockUpstream: http.Server;
  let mockUpstreamPort: number;
  let proxyInstance: Awaited<ReturnType<typeof createProxy>>;
  let captureDir: string;

  // Track what the mock upstream received
  let lastUpstreamBody: string;
  let lastUpstreamMethod: string;
  let lastUpstreamPath: string;

  before(async () => {
    // Create a temp directory for captures
    captureDir = fs.mkdtempSync(join(tmpdir(), "context-test-"));

    // Start mock upstream that echoes request info back
    mockUpstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      lastUpstreamMethod = req.method!;
      lastUpstreamPath = req.url!;
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        lastUpstreamBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            content: [{ type: "text", text: "Hello from mock" }],
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      mockUpstream.listen(0, "127.0.0.1", () => {
        const addr = mockUpstream.address();
        mockUpstreamPort =
          typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });

    // Start proxy with redact + logger
    const redact = createRedactPlugin({
      preset: "pii",
      verbose: true,
    });
    const logger = createLoggerPlugin({ captureDir });

    proxyInstance = createProxy({
      port: 0, // auto-assign
      plugins: [redact, logger], // redact before logger
      upstreams: {
        anthropic: `http://127.0.0.1:${mockUpstreamPort}`,
        openai: `http://127.0.0.1:${mockUpstreamPort}`,
        gemini: `http://127.0.0.1:${mockUpstreamPort}`,
        chatgpt: `http://127.0.0.1:${mockUpstreamPort}`,
        geminiCodeAssist: `http://127.0.0.1:${mockUpstreamPort}`,
      },
    });
    await proxyInstance.start();
  });

  after(async () => {
    await proxyInstance.stop();
    mockUpstream.close();
    // Clean up temp dir
    fs.rmSync(captureDir, { recursive: true, force: true });
  });

  it("redacts PII in request body before forwarding to upstream", async () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      messages: [
        {
          role: "user",
          content:
            "My email is john.doe@example.com and my SSN is 123-45-6789",
        },
      ],
    });

    const res = await makeRequest(proxyInstance.port, {
      path: "/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body,
    });

    // Response should come back successfully
    assert.equal(res.status, 200);
    const resBody = JSON.parse(res.body);
    assert.equal(resBody.content[0].text, "Hello from mock");

    // The upstream should have received the redacted body
    const upstreamBody = JSON.parse(lastUpstreamBody);
    assert.equal(upstreamBody.model, "claude-sonnet-4-20250514");
    assert.ok(
      upstreamBody.messages[0].content.includes("[EMAIL_REDACTED]"),
      `Expected email redaction in: ${upstreamBody.messages[0].content}`,
    );
    assert.ok(
      upstreamBody.messages[0].content.includes("[SSN_REDACTED]"),
      `Expected SSN redaction in: ${upstreamBody.messages[0].content}`,
    );
    assert.ok(
      !upstreamBody.messages[0].content.includes("john.doe@example.com"),
      "Original email should not appear",
    );
  });

  it("writes redacted capture to disk via logger", async () => {
    // Wait for the capture file from the previous test
    const capturePath = await waitForFile(captureDir);
    const capture: CaptureData = JSON.parse(
      fs.readFileSync(capturePath, "utf8"),
    );

    // The capture should have the redacted body (redact ran before logger)
    assert.equal(capture.provider, "anthropic");
    assert.ok(capture.requestBody);
    assert.ok(
      capture.requestBody!.messages[0].content.includes("[EMAIL_REDACTED]"),
      "Capture should contain redacted email",
    );
    assert.ok(
      capture.requestBody!.messages[0].content.includes("[SSN_REDACTED]"),
      "Capture should contain redacted SSN",
    );

    // Clean up for next test
    fs.unlinkSync(capturePath);
  });

  it("passes non-POST requests through without plugins", async () => {
    const res = await makeRequest(proxyInstance.port, {
      method: "GET",
      path: "/v1/models",
      headers: {
        Authorization: "Bearer sk-test",
      },
    });

    // Should get a response (mock echoes back)
    assert.equal(res.status, 200);
    assert.equal(lastUpstreamMethod, "GET");
  });

  it("handles requests with no PII (passthrough)", async () => {
    // Clean capture dir
    for (const f of fs.readdirSync(captureDir)) {
      fs.unlinkSync(join(captureDir, f));
    }

    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "What is 2 + 2?" },
      ],
    });

    const res = await makeRequest(proxyInstance.port, {
      path: "/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body,
    });

    assert.equal(res.status, 200);

    // Upstream received the body unchanged
    const upstreamBody = JSON.parse(lastUpstreamBody);
    assert.equal(upstreamBody.messages[0].content, "What is 2 + 2?");

    // Capture still written
    const capturePath = await waitForFile(captureDir);
    const capture: CaptureData = JSON.parse(
      fs.readFileSync(capturePath, "utf8"),
    );
    assert.equal(
      capture.requestBody!.messages[0].content,
      "What is 2 + 2?",
    );
  });

  it("survives a failing onCapture plugin without breaking the response", async () => {
    // Create a proxy with a broken capture plugin
    const brokenPlugin: ProxyPlugin = {
      name: "broken",
      onCapture() {
        throw new Error("Intentional test failure");
      },
    };

    const tempProxy = createProxy({
      port: 0,
      plugins: [brokenPlugin],
      upstreams: {
        anthropic: `http://127.0.0.1:${mockUpstreamPort}`,
        openai: `http://127.0.0.1:${mockUpstreamPort}`,
        gemini: `http://127.0.0.1:${mockUpstreamPort}`,
        chatgpt: `http://127.0.0.1:${mockUpstreamPort}`,
        geminiCodeAssist: `http://127.0.0.1:${mockUpstreamPort}`,
      },
    });
    await tempProxy.start();

    try {
      const res = await makeRequest(tempProxy.port, {
        path: "/v1/messages",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "test" }],
        }),
      });

      // Response should still succeed despite the broken plugin
      assert.equal(res.status, 200);
    } finally {
      await tempProxy.stop();
    }
  });

  it("decompresses zstd-encoded request bodies for redaction", async () => {
    // Clean capture dir
    for (const f of fs.readdirSync(captureDir)) {
      fs.unlinkSync(join(captureDir, f));
    }

    const body = JSON.stringify({
      model: "gpt-5.3-codex",
      messages: [
        { role: "user", content: "My email is codex-user@example.com" },
      ],
    });
    const compressed = zlib.zstdCompressSync(Buffer.from(body, "utf8"));

    const res = await makeRequest(proxyInstance.port, {
      path: "/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "zstd",
      },
      body: compressed,
    });

    assert.equal(res.status, 200);

    // Upstream should have received decompressed, redacted body
    const upstreamBody = JSON.parse(lastUpstreamBody);
    assert.ok(
      upstreamBody.messages[0].content.includes("[EMAIL_REDACTED]"),
      `Expected email redaction, got: ${upstreamBody.messages[0].content}`,
    );
    assert.ok(
      !upstreamBody.messages[0].content.includes("codex-user@example.com"),
      "Original email should not appear",
    );
  });
});

// --- Streaming reversible redaction integration test ---

describe("streaming reversible redaction", () => {
  let mockUpstream: http.Server;
  let mockUpstreamPort: number;
  let proxyInstance: Awaited<ReturnType<typeof createProxy>>;
  let captureDir: string;

  // What the mock upstream received (redacted request body)
  let lastUpstreamBody: string;
  // SSE events the mock upstream will send back
  let sseEvents: string[];

  before(async () => {
    captureDir = fs.mkdtempSync(join(tmpdir(), "context-stream-test-"));

    // Mock upstream that captures the request and responds with SSE
    mockUpstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        lastUpstreamBody = Buffer.concat(chunks).toString("utf8");

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        // Send SSE events with small delays to simulate real streaming
        let i = 0;
        const sendNext = (): void => {
          if (i >= sseEvents.length) {
            res.end();
            return;
          }
          res.write(sseEvents[i]);
          i++;
          setTimeout(sendNext, 5);
        };
        sendNext();
      });
    });

    await new Promise<void>((resolve) => {
      mockUpstream.listen(0, "127.0.0.1", () => {
        const addr = mockUpstream.address();
        mockUpstreamPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });

    // Start proxy with reversible redaction
    const redact = createRedactPlugin({
      preset: "pii",
      reversible: true,
    });
    const logger = createLoggerPlugin({ captureDir });

    proxyInstance = createProxy({
      port: 0,
      plugins: [redact, logger],
      upstreams: {
        anthropic: `http://127.0.0.1:${mockUpstreamPort}`,
        openai: `http://127.0.0.1:${mockUpstreamPort}`,
        gemini: `http://127.0.0.1:${mockUpstreamPort}`,
        chatgpt: `http://127.0.0.1:${mockUpstreamPort}`,
        geminiCodeAssist: `http://127.0.0.1:${mockUpstreamPort}`,
      },
    });
    await proxyInstance.start();
  });

  after(async () => {
    await proxyInstance.stop();
    mockUpstream.close();
    fs.rmSync(captureDir, { recursive: true, force: true });
  });

  /** Collect a streaming response into a string. */
  function makeStreamingRequest(
    port: number,
    path: string,
    body: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          method: "POST",
          path,
          headers: {
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              status: res.statusCode!,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  /** Extract text content from SSE text_delta events. */
  /** Extract text content from SSE events (handles both original and reconstructed formats). */
  function extractTextFromSSE(sse: string): string {
    let text = "";
    for (const line of sse.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const obj = JSON.parse(line.slice(6));
        // Anthropic original: delta.text
        if (obj.delta?.text) text += obj.delta.text;
        // Reconstructed minimal: top-level "text"
        if (typeof obj.text === "string" && !obj.delta) text += obj.text;
      } catch {
        // not JSON
      }
    }
    return text;
  }

  it("redacts PII in request and rehydrates placeholders in SSE response", async () => {
    // The mock upstream will echo back the placeholders it received,
    // split across multiple SSE events (simulating real LLM streaming)
    sseEvents = [
      'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514"}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Email: [EMAIL_"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1] Phone: [PHONE_US_"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1] SSN: [SS"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"N_1]"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];

    const requestBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      messages: [
        {
          role: "user",
          content:
            "Contact info: john@example.com, call (555) 234-5678, SSN 123-45-6789",
        },
      ],
    });

    // Use a session ID in the path (required for per-session replacement maps)
    const res = await makeStreamingRequest(
      proxyInstance.port,
      "/testsrc/aabb0011/v1/messages",
      requestBody,
    );

    assert.equal(res.status, 200);

    // 1. Verify the upstream received redacted values (numbered placeholders)
    const upBody = JSON.parse(lastUpstreamBody);
    const upContent = upBody.messages[0].content;
    assert.ok(upContent.includes("[EMAIL_1]"), `request should have [EMAIL_1], got: ${upContent}`);
    assert.ok(upContent.includes("[PHONE_US_1]"), `request should have [PHONE_US_1], got: ${upContent}`);
    assert.ok(upContent.includes("[SSN_1]"), `request should have [SSN_1], got: ${upContent}`);
    assert.ok(!upContent.includes("john@example.com"), "real email should not reach upstream");
    assert.ok(!upContent.includes("(555) 234-5678"), "real phone should not reach upstream");
    assert.ok(!upContent.includes("123-45-6789"), "real SSN should not reach upstream");

    // 2. Verify the client received rehydrated values in the SSE stream
    const clientText = extractTextFromSSE(res.body);
    assert.ok(clientText.includes("john@example.com"), `client should see real email, got: ${clientText}`);
    assert.ok(clientText.includes("(555) 234-5678"), `client should see real phone, got: ${clientText}`);
    assert.ok(clientText.includes("123-45-6789"), `client should see real SSN, got: ${clientText}`);
    assert.ok(!clientText.includes("[EMAIL_1]"), `client should not see placeholder, got: ${clientText}`);
    assert.ok(!clientText.includes("[PHONE_US_1]"), `client should not see placeholder, got: ${clientText}`);
    assert.ok(!clientText.includes("[SSN_1]"), `client should not see placeholder, got: ${clientText}`);

    // 3. Verify structural SSE events passed through
    assert.ok(res.body.includes("message_start"), "message_start event preserved");
    assert.ok(res.body.includes("content_block_stop"), "content_block_stop event preserved");
    assert.ok(res.body.includes("message_stop"), "message_stop event preserved");
  });

  it("handles response with no placeholders (passthrough)", async () => {
    sseEvents = [
      'data: {"type":"message_start","message":{"id":"msg_02","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514"}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The answer is 42."}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];

    const res = await makeStreamingRequest(
      proxyInstance.port,
      "/testsrc/aabb0022/v1/messages",
      JSON.stringify({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "What is 6 * 7?" }],
      }),
    );

    assert.equal(res.status, 200);
    const text = extractTextFromSSE(res.body);
    assert.ok(text.includes("The answer is 42."), `got: ${text}`);
  });

  it("handles multiple PII values with same type getting distinct numbers", async () => {
    // Two emails in the request should get EMAIL_1 and EMAIL_2
    sseEvents = [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"First: [EMAIL_1], Second: [EMAIL_2]"}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];

    const res = await makeStreamingRequest(
      proxyInstance.port,
      "/testsrc/aabb0033/v1/messages",
      JSON.stringify({
        model: "claude-sonnet-4-20250514",
        messages: [
          {
            role: "user",
            content: "Emails: alice@example.com and bob@example.com",
          },
        ],
      }),
    );

    assert.equal(res.status, 200);
    const text = extractTextFromSSE(res.body);
    assert.ok(text.includes("alice@example.com"), `got: ${text}`);
    assert.ok(text.includes("bob@example.com"), `got: ${text}`);
    assert.ok(!text.includes("[EMAIL_"), `got: ${text}`);
  });
});

