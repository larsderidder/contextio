/**
 * Argument parser for the Contextio CLI.
 *
 * Hand-rolled for zero dependencies, with Commander used only for
 * version and help display.
 */

import { Command } from "commander";

// Re-export types for external use
export interface ProxyOptions {
  port: number;
  bind: string;
  redact: boolean;
  redactPreset: string;
  redactPolicy: string | null;
  redactReversible: boolean;
  log: boolean;
  noLog: boolean;
  logDir: string | null;
  logMaxSessions: number;
  verbose: boolean;
}

export interface ProxyArgs extends ProxyOptions {
  command: "proxy";
  wrap: string[] | null;
}

export interface AttachArgs {
  command: "attach";
  port: number;
  wrap: string[];
}

export interface BackgroundArgs {
  command: "background";
  action: "start" | "stop" | "status";
}

export interface MonitorArgs {
  command: "monitor";
  session: string | null;
  last: string | null;
  source: string | null;
}

export interface InspectArgs {
  command: "inspect";
  session: string | null;
  last: boolean;
  source: string | null;
  full: boolean;
}

export interface ReplayArgs {
  command: "replay";
  captureFile: string;
  diff: boolean;
  model: string | null;
}

export interface ExportArgs {
  command: "export";
  session: string | null;
  last: boolean;
  outputPath: string | null;
  redact: boolean;
}

export interface HelpArgs {
  command: "help";
  topic: string | null;
}

export interface VersionArgs {
  command: "version";
}

export interface DoctorArgs {
  command: "doctor";
}

export type ParsedArgs =
  | ProxyArgs
  | AttachArgs
  | BackgroundArgs
  | MonitorArgs
  | InspectArgs
  | ReplayArgs
  | ExportArgs
  | HelpArgs
  | VersionArgs
  | DoctorArgs;

export interface ParseError {
  error: string;
}

export type ParseResult = ParsedArgs | ParseError;

export function isError(result: ParseResult): result is ParseError {
  return "error" in result;
}

// --- Help text using Commander ---

const program = new Command();

export function getHelp(topic?: string | null): string {
  // Use Commander to generate help
  try {
    const helpCmd = new Command();
    helpCmd.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
    helpCmd
      .name("ctxio")
      .description("LLM API proxy toolkit")
      .version("0.0.1")
      .command("proxy", { isDefault: true })
      .description("Start the LLM API proxy")
      .option("-p, --port <number>", "Port to listen on", "4040")
      .option("--bind <host>", "Bind address", "127.0.0.1")
      .option("-r, --redact", "Enable PII/secret redaction")
      .option("-P, --preset <name>", "Preset: secrets, pii, strict", "pii")
      .option("-f, --redact-policy <path>", "Policy file")
      .option("-R, --redact-reversible", "Restore redacted values")
      .option("--no-log", "Disable capture logging")
      .option("--log-dir <path>", "Capture directory")
      .option("--log-max-sessions <n>", "Max sessions", "0")
      .option("--verbose", "Show detailed activity")
      .argument("[args...]", "Command to wrap");
    
    if (topic) {
      // Try to get help for specific command
      if (topic === "proxy") {
        return helpCmd.command("proxy").helpInformation();
      }
      return `Unknown help topic: ${topic}`;
    }
    return helpCmd.helpInformation();
  } catch {
    // Fallback to simple help
  }
  
  return `
ctxio - LLM API proxy toolkit

Usage:
  ctxio <command> [options]

Commands:
  proxy      Start the LLM API proxy
  attach     Run a command through an already-running proxy
  background Manage a detached shared proxy process
  monitor    Watch capture directory for live API traffic
  inspect    Inspect session prompts and tool definitions
  replay     Re-send captured requests to the API
  export     Bundle session captures into a shareable file
  doctor     Run local diagnostics
  version    Show version

Run 'ctxio help <command>' for details.
`.trim();
}

// --- Parser ---

export function parseArgs(argv: string[]): ParseResult {
  // Strip node and script path
  const args = argv.slice(2);

  if (args.length === 0) {
    return { command: "help", topic: null };
  }

  const sub = args[0];

  // Handle version
  if (sub === "--version" || sub === "-v" || sub === "version") {
    return { command: "version" };
  }

  // Handle help
  if (sub === "--help" || sub === "-h" || sub === "help") {
    return { command: "help", topic: args[1] ?? null };
  }

  if (sub === "doctor") {
    return { command: "doctor" };
  }

  if (sub === "background") {
    const action = args[1] ?? "status";
    if (action !== "start" && action !== "stop" && action !== "status") {
      return { error: "background requires one of: start, stop, status" };
    }
    return { command: "background", action };
  }

  if (sub === "proxy") {
    return parseProxyArgs(args.slice(1));
  }

  if (sub === "attach") {
    return parseAttachArgs(args.slice(1));
  }

  if (sub === "monitor") {
    return parseMonitorArgs(args.slice(1));
  }

  if (sub === "inspect") {
    return parseInspectArgs(args.slice(1));
  }

  if (sub === "replay") {
    return parseReplayArgs(args.slice(1));
  }

  if (sub === "export") {
    return parseExportArgs(args.slice(1));
  }

  return { error: `Unknown command: ${sub}` };
}

function parseProxyArgs(args: string[]): ParseResult {
  const result: ProxyArgs = {
    command: "proxy",
    port: 0,
    bind: "",
    redact: false,
    redactPreset: "pii",
    redactPolicy: null,
    redactReversible: false,
    log: true,
    noLog: false,
    logDir: null,
    logMaxSessions: 0,
    verbose: false,
    wrap: null,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    // Handle -- separator
    if (arg === "--") {
      const rest = args.slice(i + 1);
      if (rest.length === 0) {
        return { error: "No command specified after --" };
      }
      result.wrap = rest;
      break;
    }

    if (arg === "--help" || arg === "-h") {
      return { command: "help", topic: "proxy" };
    }

    // Port
    if (arg === "--port" || arg === "-p") {
      i++;
      if (i >= args.length) return { error: "--port requires a value" };
      const port = parseInt(args[i], 10);
      if (isNaN(port) || port < 0 || port > 65535) {
        return { error: `Invalid port: ${args[i]}` };
      }
      result.port = port;
    }
    // Bind
    else if (arg === "--bind") {
      i++;
      if (i >= args.length) return { error: "--bind requires a value" };
      result.bind = args[i];
    }
    // Redact
    else if (arg === "--redact" || arg === "-r") {
      result.redact = true;
    }
    // Preset
    else if (arg === "--redact-preset" || arg === "--preset" || arg === "-P") {
      i++;
      if (i >= args.length) return { error: "--redact-preset requires a value" };
      const valid = ["secrets", "pii", "strict"];
      if (!valid.includes(args[i])) {
        return { error: `Invalid preset: ${args[i]}. Must be one of: ${valid.join(", ")}` };
      }
      result.redactPreset = args[i];
      result.redact = true;
    }
    // Policy file
    else if (arg === "--redact-policy" || arg === "-f") {
      i++;
      if (i >= args.length) return { error: "--redact-policy requires a value" };
      result.redactPolicy = args[i];
      result.redact = true;
    }
    // Reversible
    else if (arg === "--redact-reversible" || arg === "-R") {
      result.redactReversible = true;
      result.redact = true;
    }
    // No log
    else if (arg === "--no-log") {
      result.log = false;
      result.noLog = true;
    }
    // Log dir
    else if (arg === "--log-dir") {
      i++;
      if (i >= args.length) return { error: "--log-dir requires a value" };
      result.logDir = args[i];
      result.log = true;
    }
    // Log max sessions
    else if (arg === "--log-max-sessions") {
      i++;
      if (i >= args.length) return { error: "--log-max-sessions requires a value" };
      result.logMaxSessions = parseInt(args[i], 10) || 0;
    }
    // Verbose
    else if (arg === "--verbose") {
      result.verbose = true;
    }
    else {
      return { error: `Unknown option: ${arg}` };
    }

    i++;
  }

  return result;
}

function parseAttachArgs(args: string[]): ParseResult {
  let port = 4040;
  const wrap: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      return { command: "help", topic: "attach" };
    }

    if (arg === "--port" || arg === "-p") {
      i++;
      if (i >= args.length) return { error: "--port requires a value" };
      port = parseInt(args[i], 10) || 4040;
    } else if (!arg.startsWith("-")) {
      wrap.push(...args.slice(i));
      break;
    } else {
      return { error: `Unknown option: ${arg}` };
    }

    i++;
  }

  if (wrap.length === 0) {
    return { error: "No command specified" };
  }

  return { command: "attach", port, wrap };
}

function parseMonitorArgs(args: string[]): ParseResult {
  let session: string | null = null;
  let last: string | null = null;
  let source: string | null = null;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      return { command: "help", topic: "monitor" };
    }

    if (arg === "--session") {
      i++;
      if (i >= args.length) return { error: "--session requires a value" };
      session = args[i];
    } else if (arg === "--last") {
      i++;
      if (i >= args.length) return { error: "--last requires a value" };
      last = args[i];
    } else if (arg === "--source") {
      i++;
      if (i >= args.length) return { error: "--source requires a value" };
      source = args[i];
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}` };
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }

    i++;
  }

  return { command: "monitor", session, last, source };
}

function parseInspectArgs(args: string[]): ParseResult {
  let session: string | null = null;
  let last = false;
  let source: string | null = null;
  let full = false;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      return { command: "help", topic: "inspect" };
    }

    if (arg === "--session") {
      i++;
      if (i >= args.length) return { error: "--session requires a value" };
      session = args[i];
    } else if (arg === "--last") {
      last = true;
    } else if (arg === "--source") {
      i++;
      if (i >= args.length) return { error: "--source requires a value" };
      source = args[i];
    } else if (arg === "--full") {
      full = true;
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}` };
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }

    i++;
  }

  return { command: "inspect", session, last, source, full };
}

function parseReplayArgs(args: string[]): ParseResult {
  let captureFile = "";
  let diff = false;
  let model: string | null = null;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      return { command: "help", topic: "replay" };
    }

    if (arg === "--diff") {
      diff = true;
    } else if (arg === "--model") {
      i++;
      if (i >= args.length) return { error: "--model requires a value" };
      model = args[i];
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}` };
    } else {
      if (!captureFile) {
        captureFile = arg;
      } else {
        return { error: `Unexpected argument: ${arg}` };
      }
    }

    i++;
  }

  if (!captureFile) {
    return { error: "No capture file specified" };
  }

  return { command: "replay", captureFile, diff, model };
}

function parseExportArgs(args: string[]): ParseResult {
  let session: string | null = null;
  let last = false;
  let outputPath: string | null = null;
  let redact = false;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      return { command: "help", topic: "export" };
    }

    if (arg === "--session") {
      i++;
      if (i >= args.length) return { error: "--session requires a value" };
      session = args[i];
    } else if (arg === "--last") {
      last = true;
    } else if (arg === "-o" || arg === "--output") {
      i++;
      if (i >= args.length) return { error: "--output requires a value" };
      outputPath = args[i];
    } else if (arg === "--redact") {
      redact = true;
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}` };
    } else {
      if (!session) {
        session = arg;
      } else {
        return { error: `Unexpected argument: ${arg}` };
      }
    }

    i++;
  }

  if (!session && !last) {
    return { error: "Must specify session ID or --last" };
  }

  return { command: "export", session, last, outputPath, redact };
}
