/**
 * Replay command: re-send a captured request to the LLM API.
 *
 * Reads a capture JSON file, optionally swaps the model, and sends the
 * request directly to the upstream (not through the proxy). Useful for
 * debugging, testing model differences, or reproducing issues.
 */

import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

import type { CaptureData } from "@contextio/core";

import type { ReplayArgs } from "./args.js";

/** Look up an API key from environment variables for the given provider. */
function getApiKey(provider: string): string | null {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY ?? null;
    case "openai":
    case "chatgpt":
      return process.env.OPENAI_API_KEY ?? null;
    case "gemini":
      return process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? null;
    default:
      // Try all known keys
      return (
        process.env.ANTHROPIC_API_KEY ??
        process.env.OPENAI_API_KEY ??
        process.env.GOOGLE_API_KEY ??
        process.env.GEMINI_API_KEY ??
        null
      );
  }
}

/** Build the provider-specific auth header (x-api-key for Anthropic, Bearer for OpenAI, etc). */
function buildAuthHeader(provider: string, apiKey: string): { key: string; value: string } {
  switch (provider) {
    case "anthropic":
      return { key: "x-api-key", value: apiKey };
    case "gemini":
      return { key: "x-goog-api-key", value: apiKey };
    default:
      return { key: "authorization", value: `Bearer ${apiKey}` };
  }
}

/** Make an HTTP(S) request and collect the full response. 60s timeout. */
function makeRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const client = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers,
    };

    const req = client.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const responseHeaders: Record<string, string> = {};
        for (const [key, val] of Object.entries(res.headers)) {
          if (val) responseHeaders[key] = Array.isArray(val) ? val.join(", ") : val;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: responseHeaders,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });

    req.write(body);
    req.end();
  });
}

function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Produce a simple diff of content and usage between original and replayed responses. */
function findJsonDiff(original: string, replay: string): string {
  const orig = JSON.parse(original);
  const repl = JSON.parse(replay);

  const diffLines: string[] = [];

  // Compare content for streaming
  if (orig.choices && repl.choices) {
    for (let i = 0; i < orig.choices.length; i++) {
      const oc = orig.choices[i];
      const rc = repl.choices[i];
      if (!rc) {
        diffLines.push(`- choice[${i}]: missing in replay`);
        continue;
      }

      const od = oc.delta?.content ?? oc.message?.content ?? "";
      const rd = rc.delta?.content ?? rc.message?.content ?? "";
      if (od !== rd) {
        diffLines.push(`choice[${i}] content:`);
        diffLines.push(`- ${od.slice(0, 100)}`);
        diffLines.push(`+ ${rd.slice(0, 100)}`);
      }
    }
  }

  // Compare non-streaming
  if (orig.content && repl.content) {
    if (orig.content !== repl.content) {
      diffLines.push("content:");
      diffLines.push(`- ${orig.content.slice(0, 200)}`);
      diffLines.push(`+ ${repl.content.slice(0, 200)}`);
    }
  }

  if (orig.usage && repl.usage) {
    if (JSON.stringify(orig.usage) !== JSON.stringify(repl.usage)) {
      diffLines.push(`usage:`);
      diffLines.push(`- ${JSON.stringify(orig.usage)}`);
      diffLines.push(`+ ${JSON.stringify(repl.usage)}`);
    }
  }

  return diffLines.length > 0 ? diffLines.join("\n") : "(no significant differences)";
}

/**
 * Re-send a captured request to the API and display the response.
 *
 * With --diff, shows differences between the original and new response.
 * With --model, swaps the model before sending.
 */
export async function runReplay(args: ReplayArgs): Promise<void> {
  const { captureFile, diff, model } = args;

  if (!fs.existsSync(captureFile)) {
    console.error(`Capture file not found: ${captureFile}`);
    process.exit(1);
  }

  let capture: CaptureData;
  try {
    const raw = fs.readFileSync(captureFile, "utf8");
    capture = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse capture file: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const apiKey = getApiKey(capture.provider);
  if (!apiKey) {
    console.error(`No API key found for provider: ${capture.provider}`);
    console.error("Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY");
    process.exit(1);
  }

  const authHeader = buildAuthHeader(capture.provider, apiKey);

  // Build request body
  let requestBody = capture.requestBody;
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
    console.error("Capture has no valid request body");
    process.exit(1);
  }

  // Handle model swap
  if (model) {
    if (requestBody.model) {
      requestBody = { ...requestBody, model };
    } else if (requestBody.name) {
      // Gemini uses "name" for model
      requestBody = { ...requestBody, name: model };
    } else {
      console.warn("No model field found to swap");
    }
  }

  const bodyStr = JSON.stringify(requestBody);

  // Build headers (filter out auth, add user's key)
  const headers: Record<string, string> = {};
  const skipAuth = new Set(["authorization", "x-api-key", "x-goog-api-key", "api-key"]);

  for (const [key, val] of Object.entries(capture.requestHeaders)) {
    if (!skipAuth.has(key.toLowerCase())) {
      headers[key] = val;
    }
  }

  // Add auth header
  headers[authHeader.key] = authHeader.value;

  // Set content type if not present
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }

  const targetUrl = capture.targetUrl;
  console.log(`Replaying: ${capture.method} ${targetUrl}`);
  if (model) console.log(`Model swapped to: ${model}`);
  console.log("");

  try {
    const response = await makeRequest(
      targetUrl,
      capture.method,
      headers,
      bodyStr,
    );

    console.log(`Status: ${response.status}`);

    if (diff) {
      console.log("\n--- Response diff ---");
      const originalBody = capture.responseBody;
      const diffResult = findJsonDiff(originalBody, response.body);
      console.log(diffResult || "(responses are identical)");
    } else {
      console.log("\n--- Response body ---");
      console.log(formatJson(response.body));
    }
  } catch (err) {
    console.error(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
