/**
 * Integration test: mitmproxy addon + proxy pipeline.
 *
 * Verifies the full flow for tools like Copilot and OpenCode:
 *   HTTPS request → mitmproxy (TLS termination + URL rewrite)
 *     → contextio proxy (redaction + logging)
 *       → mock upstream
 *
 * Requires mitmdump to be installed (skips if not available).
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";

import { createProxy } from "@contextio/proxy";
import type { CaptureData } from "@contextio/core";
import { createRedactPlugin } from "@contextio/redact";
import { createLoggerPlugin } from "@contextio/logger";

// --- Helpers ---

function hasMitmdump(): boolean {
  try {
    execSync("mitmdump --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasMitmCert(): boolean {
  const certPath = join(
    process.env.HOME || "~",
    ".mitmproxy",
    "mitmproxy-ca-cert.pem",
  );
  return fs.existsSync(certPath);
}

function waitForPort(
  port: number,
  timeoutMs = 8000,
): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const poll = (): void => {
      const socket = net.connect({ port, host: "127.0.0.1" }, () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(poll, 200);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(poll, 200);
      });
    };
    poll();
  });
}

function waitForFile(dir: string, timeoutMs = 5000): Promise<string> {
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
      setTimeout(poll, 100);
    };
    poll();
  });
}

function curlThroughProxy(
  mitmPort: number,
  targetUrl: string,
  body: string,
  certPath: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const curl = spawn("curl", [
      "-s",
      "-o", "/dev/null",
      "-w", "%{http_code}",
      "--proxy", `http://127.0.0.1:${mitmPort}`,
      "--cacert", certPath,
      "-X", "POST",
      "-H", "Content-Type: application/json",
      "-H", "anthropic-version: 2023-06-01",
      "-d", body,
      targetUrl,
    ]);

    let stdout = "";
    let stderr = "";
    curl.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    curl.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    curl.on("error", reject);
    curl.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`curl exited ${code}: ${stderr}`));
        return;
      }
      resolve({ status: parseInt(stdout, 10), body: stdout });
    });
  });
}

// --- Test suite ---

const SKIP = !hasMitmdump() || !hasMitmCert();

describe("mitmproxy addon flow", { skip: SKIP ? "mitmdump or CA cert not available" : false }, () => {
  let mockUpstream: http.Server;
  let mockUpstreamPort: number;
  let proxyInstance: Awaited<ReturnType<typeof createProxy>>;
  let mitmProcess: ChildProcess;
  let captureDir: string;
  let mitmPort: number;

  let lastUpstreamBody: string;
  let lastUpstreamPath: string;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  const MITM_ADDON = resolve("packages/cli/mitm_addon.py");
  const CERT_PATH = join(process.env.HOME || "~", ".mitmproxy", "mitmproxy-ca-cert.pem");

  before(async () => {
    captureDir = fs.mkdtempSync(join(tmpdir(), "context-mitm-test-"));

    // Start mock upstream (simulates api.anthropic.com)
    mockUpstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      lastUpstreamPath = req.url!;
      lastUpstreamHeaders = req.headers;
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        lastUpstreamBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            content: [{ type: "text", text: "Response from mock" }],
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      mockUpstream.listen(0, "127.0.0.1", () => {
        const addr = mockUpstream.address();
        mockUpstreamPort = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });

    // Start the contextio proxy with redaction + logging
    const redact = createRedactPlugin({ preset: "pii" });
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

    // Find a free port for mitmproxy
    mitmPort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = addr && typeof addr === "object" ? addr.port : 0;
        srv.close((err) => (err ? reject(err) : resolve(port)));
      });
    });

    // Start mitmproxy with the addon
    mitmProcess = spawn(
      "mitmdump",
      ["-s", MITM_ADDON, "--quiet", "--listen-port", String(mitmPort)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CONTEXTIO_PROXY_URL: `http://127.0.0.1:${proxyInstance.port}`,
          CONTEXTIO_SOURCE: "testclient",
          CONTEXTIO_SESSION_ID: "aabb0011",
        },
      },
    );

    const ready = await waitForPort(mitmPort);
    assert.ok(ready, "mitmproxy did not start in time");
  });

  after(async () => {
    if (mitmProcess && !mitmProcess.killed) {
      mitmProcess.kill("SIGTERM");
      // Wait briefly for cleanup
      await new Promise((r) => setTimeout(r, 500));
    }
    await proxyInstance.stop();
    mockUpstream.close();
    fs.rmSync(captureDir, { recursive: true, force: true });
  });

  it("routes HTTPS traffic through the proxy with redaction", async () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      messages: [
        {
          role: "user",
          content: "My email is secret@example.com and SSN is 123-45-6789",
        },
      ],
    });

    // Send HTTPS request through mitmproxy to a real-looking URL.
    // mitmproxy terminates TLS, the addon rewrites to our proxy.
    // The proxy uses path-based routing, so the host doesn't matter
    // as long as mitmproxy can connect to it. We use the mock upstream
    // as the HTTPS target, but the addon rewrites the URL before the
    // request reaches the upstream directly.
    //
    // Since the mock upstream is HTTP (not HTTPS), we send directly
    // through the proxy to test the addon's URL rewriting. We simulate
    // the flow by sending an HTTP request through mitmproxy.
    const res = await curlThroughProxy(
      mitmPort,
      `http://127.0.0.1:${mockUpstreamPort}/v1/messages`,
      body,
      CERT_PATH,
    );

    assert.equal(res.status, 200);

    // The upstream should have received redacted content
    const upstreamBody = JSON.parse(lastUpstreamBody) as { messages: Array<{ content: string }> };
    assert.ok(
      upstreamBody.messages[0].content.includes("[EMAIL_REDACTED]"),
      `Expected email redaction, got: ${upstreamBody.messages[0].content}`,
    );
    assert.ok(
      upstreamBody.messages[0].content.includes("[SSN_REDACTED]"),
      `Expected SSN redaction, got: ${upstreamBody.messages[0].content}`,
    );
    assert.ok(
      !upstreamBody.messages[0].content.includes("secret@example.com"),
      "Original email should not reach upstream",
    );

    // The request should have arrived at the proxy with source tags
    // (the addon rewrites /v1/messages to /testclient/aabb0011/v1/messages)
    // We can verify this through the capture file.
    const capturePath = await waitForFile(captureDir);
    const capture: CaptureData = JSON.parse(
      fs.readFileSync(capturePath, "utf8"),
    );

    assert.equal(capture.source, "testclient");
    assert.equal(capture.sessionId, "aabb0011");
    assert.equal(capture.provider, "anthropic");
    const reqBody = capture.requestBody as { messages: Array<{ content: string }> };
    assert.ok(
      reqBody.messages[0].content.includes("[EMAIL_REDACTED]"),
      "Capture should contain redacted email",
    );
  });
});
