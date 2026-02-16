/**
 * Argument parser for the Contextio CLI.
 */

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

// --- Help text ---

const MAIN_HELP = `
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
  doctor     Run local diagnostics (ports, certs, capture dir)
  version    Show version

Run 'ctxio help <command>' for details.
`.trim();

const PROXY_HELP = `
ctxio proxy [options] [-- <command> [args...]]

Start the LLM API proxy. If a command is given after --, the proxy starts,
routes the tool through it, runs the command, and shuts down when it exits.
Tools that ignore base URL overrides (Codex, Copilot, OpenCode) are routed
through mitmproxy automatically.

Options:
  -p, --port <number>        Port to listen on (default: 4040)
  --bind <host>              Bind address (default: 127.0.0.1)
  -r, --redact               Enable PII/secret redaction (default preset: pii)
  -P, --redact-preset <name> Preset: secrets, pii, strict (default: pii)
  -f, --redact-policy <path> Path to a redaction policy JSON file
  -R, --redact-reversible    Restore redacted values in responses
  --no-log                   Disable capture logging (logging is on by default)
  --log-dir <path>           Directory for capture files (default: ~/.contextio/captures)
  --log-max-sessions <n>     Keep only the last N sessions (default: 0 = unlimited)
  --verbose                  Show per-request traffic logs
  -h, --help                 Show this help

Examples:
  ctxio proxy                            Start proxy with logging
  ctxio proxy --redact -- claude         Wrap claude with redaction
  ctxio proxy --redact -- codex          Wrap codex (via mitmproxy)
  ctxio proxy -- copilot                 Wrap copilot with logging
  ctxio proxy --redact-reversible -- pi  Transparent redaction
`.trim();

const ATTACH_HELP = `
ctxio attach [options] <command> [args...]

Run a command routed through an already-running proxy. The proxy must be
started separately (e.g. 'ctxio proxy --redact' in another terminal).

Options:
  -p, --port <number>  Port the proxy is listening on (default: 4040)
  -h, --help           Show this help

Examples:
  ctxio attach claude                Attach claude to running proxy
  ctxio attach codex                 Attach codex (starts mitmproxy)
  ctxio attach --port 5050 claude    Use non-default port
`.trim();

const MONITOR_HELP = `
ctxio monitor [options]

Watch for API traffic in real-time. Without --last or --session, only
shows new captures as they arrive.

Options:
  --session <id>     Show captures for a specific session
  --last <duration>  Show recent captures, then keep watching (e.g. 1h, 30m, 60s)
  --source <name>    Filter by source tool (e.g. claude, codex, copilot)
  -h, --help         Show this help

Examples:
  ctxio monitor                         Watch for new captures
  ctxio monitor --last 1h               Show last hour + watch
  ctxio monitor --session a1b2c3d4      Show a specific session
  ctxio monitor --source codex          Only show codex traffic
`.trim();

const INSPECT_HELP = `
ctxio inspect [options]

List sessions or inspect a specific one. Shows system prompts, tool
definitions, and context overhead.

Without options, lists all captured sessions. Use --source to filter,
--session or --last to inspect a specific session.

Options:
  --session <id>   Inspect a specific session (8 hex chars)
  --last           Inspect the most recent session
  --source <name>  Filter sessions by tool (e.g. claude, codex)
  --full           Show full system prompt (don't truncate)
  -h, --help       Show this help

Examples:
  ctxio inspect                       List all sessions
  ctxio inspect --source codex        List codex sessions
  ctxio inspect --last                Inspect most recent session
  ctxio inspect --session a1b2c3d4    Inspect specific session
  ctxio inspect --source claude --last  Inspect latest claude session
`.trim();

const REPLAY_HELP = `
ctxio replay <capture-file> [options]

Re-send a captured request to the API and show or diff the response.

Options:
  --diff           Show diff between original and new response
  --model <name>   Swap the model in the request
  -h, --help       Show this help

Examples:
  ctxio replay captures/abc123.json          Re-send and print response
  ctxio replay captures/abc123.json --diff   Compare with original
`.trim();

const EXPORT_HELP = `
ctxio export <sessionId> [options]

Bundle a session's captures into a single shareable file.

Options:
  --last              Export the most recent session
  -o, --output <path> Output file path (default: session-<id>.json)
  --redact            Strip request/response bodies, keep metadata only
  -h, --help          Show this help

Examples:
  ctxio export a1b2c3d4                  Export session
  ctxio export --last                    Export most recent session
  ctxio export a1b2c3d4 -o report.json   Custom output path
`.trim();

export function getHelp(topic?: string | null): string {
  switch (topic) {
    case "proxy": return PROXY_HELP;
    case "attach": return ATTACH_HELP;
    case "monitor": return MONITOR_HELP;
    case "inspect": return INSPECT_HELP;
    case "replay": return REPLAY_HELP;
    case "export": return EXPORT_HELP;
    default: return MAIN_HELP;
  }
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
