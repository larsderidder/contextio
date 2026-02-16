/**
 * Session inspector.
 *
 * Lists available sessions or deep-inspects a specific one, showing
 * the system prompt, tool definitions, first user message, and context
 * overhead estimates.
 */

import fs from "node:fs";
import { join } from "node:path";

import { estimateTokens, type CaptureData } from "@contextio/core";

import type { InspectArgs } from "./args.js";
import { captureDir, listCaptureFiles, readCapture } from "./captures.js";

/** Summary of a session extracted from its first capture. */
interface SessionInfo {
  sessionId: string;
  source: string;
  provider: string;
  apiFormat: string;
  systemPrompt: string | null;
  tools: ToolDefinition[];
  firstUserMessage: string | null;
  totalRequests: number;
}

/** A tool definition extracted from the request body. */
interface ToolDefinition {
  name: string;
  description: string;
  paramCount: number;
}

/** Find capture files matching the inspect arguments (session, source, --last). */
function findSessionFiles(args: InspectArgs): string[] {
  const dir = captureDir();
  const files = listCaptureFiles(dir);

  const captures: { file: string; capture: CaptureData }[] = [];

  for (const file of files) {
    const capture = readCapture(join(dir, file));
    if (!capture) continue;
    if (args.session && capture.sessionId !== args.session) continue;
    if (args.source && capture.source !== args.source) continue;
    captures.push({ file, capture });
  }

  if (args.session) {
    return captures.map((c) => join(dir, c.file));
  }

  if (args.last || args.source) {
    if (captures.length === 0) return [];
    const lastSessionId = captures[captures.length - 1].capture.sessionId;
    return captures
      .filter((c) => c.capture.sessionId === lastSessionId)
      .map((c) => join(dir, c.file));
  }

  return [];
}

/** Extract system prompt and tool definitions from an Anthropic Messages API request. */
function extractAnthropicSystemPrompt(body: Record<string, any>): { system: string | null; tools: ToolDefinition[] } {
  let system: string | null = null;
  const tools: ToolDefinition[] = [];

  if (typeof body.system === "string") {
    system = body.system;
  } else if (Array.isArray(body.system)) {
    const parts: string[] = [];
    for (const item of body.system) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item?.type === "text") {
        parts.push(item.text || "");
      }
    }
    system = parts.join("\n");
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      tools.push({
        name: tool.name || "?",
        description: tool.description || "",
        paramCount: tool.input_schema?.properties ? Object.keys(tool.input_schema.properties).length : 0,
      });
    }
  }

  return { system, tools };
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
      const text = (part as { text?: unknown }).text;
      parts.push(typeof text === "string" ? text : "");
    }
  }

  return parts.join("\n");
}

/** Extract system prompt and tool definitions from an OpenAI Chat Completions request. */
function extractOpenAISystemPrompt(body: Record<string, any>): { system: string | null; tools: ToolDefinition[] } {
  let system: string | null = null;
  const tools: ToolDefinition[] = [];

  const messages = body.messages || [];
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const contentText = extractTextContent(msg.content);
      if (contentText !== null) {
        system = contentText;
      }
      break;
    }
  }

  const toolList = body.tools || body.functions;
  if (Array.isArray(toolList)) {
    for (const tool of toolList) {
      tools.push({
        name: tool.name || "?",
        description: tool.description || "",
        paramCount: tool.parameters?.properties ? Object.keys(tool.parameters.properties).length : 0,
      });
    }
  }

  return { system, tools };
}

/** Extract system instruction and tool declarations from a Gemini API request. */
function extractGeminiSystemPrompt(body: Record<string, any>): { system: string | null; tools: ToolDefinition[] } {
  let system: string | null = null;
  const tools: ToolDefinition[] = [];

  if (body.systemInstruction) {
    if (typeof body.systemInstruction === "string") {
      system = body.systemInstruction;
    } else if (body.systemInstruction.parts) {
      const parts: string[] = [];
      for (const part of body.systemInstruction.parts) {
        if (part.text) parts.push(part.text);
      }
      system = parts.join("\n");
    }
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool.functionDeclarations) {
        for (const decl of tool.functionDeclarations) {
          tools.push({
            name: decl.name || "?",
            description: decl.description || "",
            paramCount: decl.parameters?.properties ? Object.keys(decl.parameters.properties).length : 0,
          });
        }
      }
    }
  }

  return { system, tools };
}

/** Extract system prompt and tools from a capture, dispatching by provider. */
function extractSystemPrompt(capture: CaptureData): { system: string | null; tools: ToolDefinition[] } {
  const body = capture.requestBody;
  if (!body || typeof body !== "object") {
    return { system: null, tools: [] };
  }

  const provider = capture.provider;

  if (provider === "anthropic") {
    return extractAnthropicSystemPrompt(body);
  }

  if (provider === "gemini") {
    return extractGeminiSystemPrompt(body);
  }

  // OpenAI, ChatGPT, OpenCode
  return extractOpenAISystemPrompt(body);
}

/** Extract the first user message from the conversation in a capture. */
function getFirstUserMessage(capture: CaptureData): string | null {
  const body = capture.requestBody;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const messages = body.messages;
  if (!Array.isArray(messages)) return null;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
    if (msg.role === "user") {
      const contentText = extractTextContent(msg.content);
      if (contentText !== null) {
        return contentText;
      }
    }
  }

  return null;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function printSection(title: string, content: string | null, full: boolean): void {
  if (!content) {
    console.log(`\n${title}: (none)`);
    return;
  }

  console.log(`\n${title}:`);
  if (full || content.length <= 1200) {
    console.log(content);
  } else {
    console.log(truncate(content, 1200));
    console.log(`\n[... truncated. Use --full to see entire prompt]`);
  }
}

function printTools(tools: ToolDefinition[]): void {
  if (tools.length === 0) {
    console.log("\nTools: (none)");
    return;
  }

  console.log("\nTools:");
  for (const tool of tools) {
    const desc = tool.description ? truncate(tool.description, 60) : "(no description)";
    console.log(`  - ${tool.name} (${tool.paramCount} params): ${desc}`);
  }
}

/** Print estimated token overhead for system prompt, tools, and first user message. */
function printContextOverhead(system: string | null, tools: ToolDefinition[], firstUser: string | null): void {
  const sysTokens = system ? estimateTokens(system) : 0;
  const toolDescTokens = tools.reduce((sum, t) => sum + estimateTokens(t.description), 0);
  const firstUserTokens = firstUser ? estimateTokens(firstUser) : 0;
  const totalContext = sysTokens + toolDescTokens;
  const conversation = firstUserTokens;

  console.log("\nContext overhead (estimated):");
  console.log(`  System prompt: ~${sysTokens} tokens`);
  console.log(`  Tool definitions: ~${toolDescTokens} tokens`);
  console.log(`  First user message: ~${conversation} tokens`);
  if (totalContext > 0 && conversation > 0) {
    const ratio = ((totalContext / (totalContext + conversation)) * 100).toFixed(1);
    console.log(`  Overhead: ${ratio}% of context goes to system/tools`);
  }
}

/** List all sessions in a table (session ID, source, provider, request count, time). */
function listSessions(args: InspectArgs): void {
  const dir = captureDir();
  const files = listCaptureFiles(dir);

  // Group by session
  const sessions = new Map<string, { source: string; provider: string; count: number; firstTime: string; lastTime: string }>();

  for (const file of files) {
    const capture = readCapture(join(dir, file));
    if (!capture || !capture.sessionId) continue;
    if (args.source && capture.source !== args.source) continue;

    const existing = sessions.get(capture.sessionId);
    if (existing) {
      existing.count++;
      existing.lastTime = capture.timestamp;
    } else {
      sessions.set(capture.sessionId, {
        source: capture.source || "?",
        provider: capture.provider || "?",
        count: 1,
        firstTime: capture.timestamp,
        lastTime: capture.timestamp,
      });
    }
  }

  if (sessions.size === 0) {
    if (args.source) {
      console.log(`No sessions found for source: ${args.source}`);
    } else {
      console.log("No sessions found. Run some LLM traffic first.");
    }
    process.exit(1);
  }

  // Sort by first capture time (most recent last)
  const sorted = [...sessions.entries()].sort(
    (a, b) => new Date(a[1].firstTime).getTime() - new Date(b[1].firstTime).getTime(),
  );

  console.log(" SESSION     SOURCE      PROVIDER    REQUESTS  TIME");
  for (const [id, info] of sorted) {
    const time = new Date(info.firstTime).toLocaleString();
    console.log(
      ` ${id.padEnd(10)}  ${info.source.padEnd(10)}  ${info.provider.padEnd(10)}  ${String(info.count).padEnd(8)}  ${time}`,
    );
  }
  console.log(`\nUse 'ctxio inspect --session <id>' to inspect a session.`);
}

/**
 * Run the inspect command.
 *
 * Without a session argument: lists all sessions. With a session (or --last):
 * shows system prompt, tool definitions, context overhead, and first user message.
 */
export async function runInspect(args: InspectArgs): Promise<void> {
  const dir = captureDir();

  if (!fs.existsSync(dir)) {
    console.log(`Capture directory not found: ${dir}`);
    console.log("Run some LLM traffic first (e.g., ctxio proxy -- claude)");
    process.exit(1);
  }

  // No session specified: list all sessions
  if (!args.session && !args.last && !args.source) {
    listSessions(args);
    return;
  }

  // Source without --last or --session: list sessions for that source
  if (args.source && !args.last && !args.session) {
    listSessions(args);
    return;
  }

  const files = findSessionFiles(args);

  if (files.length === 0) {
    if (args.session) {
      console.log(`No captures found for session: ${args.session}`);
    } else if (args.source) {
      console.log(`No captures found for source: ${args.source}`);
    } else {
      console.log("No captures found. Run some LLM traffic first.");
    }
    process.exit(1);
  }

  const captures: CaptureData[] = [];

  for (const filepath of files) {
    const capture = readCapture(filepath);
    if (capture) captures.push(capture);
  }

  if (captures.length === 0) {
    console.log("No valid captures found.");
    process.exit(1);
  }

  // Get session info from first capture
  const first = captures[0];
  const { system, tools } = extractSystemPrompt(first);
  const firstUser = getFirstUserMessage(first);

  const sessionInfo: SessionInfo = {
    sessionId: first.sessionId || "?",
    source: first.source || "?",
    provider: first.provider,
    apiFormat: first.apiFormat,
    systemPrompt: system,
    tools,
    firstUserMessage: firstUser,
    totalRequests: captures.length,
  };

  console.log(`\x1b[1mSession: ${sessionInfo.sessionId}\x1b[0m`);
  console.log(`Source: ${sessionInfo.source} | Provider: ${sessionInfo.provider} | API: ${sessionInfo.apiFormat}`);
  console.log(`Requests in session: ${sessionInfo.totalRequests}`);

  printSection("System prompt", sessionInfo.systemPrompt, args.full);
  printTools(sessionInfo.tools);
  printContextOverhead(sessionInfo.systemPrompt, sessionInfo.tools, sessionInfo.firstUserMessage);
  printSection("First user message", sessionInfo.firstUserMessage, args.full);

  console.log("");
}
