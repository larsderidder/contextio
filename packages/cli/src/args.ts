/**
 * Argument parser for the Contextio CLI.
 *
 * Hand-rolled to keep the project zero external dependencies.
 * Supports subcommands, boolean flags, and key=value options.
 */

// --- Shared proxy options (used by both `proxy` and `proxy -- cmd`) ---

interface ProxyOptions {
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
  /** Command to wrap (everything after --). Null means standalone proxy. */
  wrap: string[] | null;
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

export interface AttachArgs {
  command: "attach";
  port: number;
  /** The command and its arguments. */
  wrap: string[];
}

export interface BackgroundArgs {
  command: "background";
  action: "start" | "stop" | "status";
}

export type ParsedArgs =
  | ProxyArgs
  | HelpArgs
  | VersionArgs
  | DoctorArgs
  | AttachArgs
  | BackgroundArgs;

export interface ParseError {
  error: string;
}

export type ParseResult = ParsedArgs | ParseError;

export function isError(result: ParseResult): result is ParseError {
  return "error" in result;
}

const PROXY_HELP = `
ctxio proxy [options] [-- <command> [args...]]

Start the LLM API proxy. If a command is given after --, the proxy starts,
sets ANTHROPIC_BASE_URL / OPENAI_BASE_URL to route through it, runs the
command, and shuts down when it exits. Codex is handled via mitmproxy
(https_proxy) because subscription mode does not honor base URL overrides.

Options:
  --port <number>        Port to listen on (default: 4040, env: CONTEXT_PROXY_PORT)
  --bind <host>          Bind address (default: 127.0.0.1, env: CONTEXT_PROXY_BIND_HOST)
  --redact               Enable PII/secret redaction (default preset: pii)
  --redact-preset <name> Preset: secrets, pii, strict (default: pii)
  --redact-policy <path> Path to a redaction policy JSON file
  --redact-reversible    Restore redacted values in responses (transparent mode)
  --no-log               Disable capture logging (logging is on by default)
  --log-dir <path>       Directory for capture files (default: ~/.contextio/captures)
  --log-max-sessions <n> Keep only the last N sessions (default: 0 = unlimited)
  --verbose              Show detailed plugin activity and per-request traffic logs
  -h, --help             Show this help

Examples:
  ctxio proxy                                Start proxy with logging on :4040
  ctxio proxy --redact                       Add PII redaction
  ctxio proxy --redact -- claude             Wrap claude with redaction
  ctxio proxy -- pi                          Wrap pi with logging
  ctxio proxy --redact -- aider --model opus Wrap aider with options
  ctxio proxy --no-log                       Bare proxy, no logging
`.trim();

const ATTACH_HELP = `
ctxio attach [options] <command> [args...]

Run a command routed through an already-running proxy. The proxy must be
started separately (e.g. 'ctxio proxy --redact-reversible' in another
terminal). Attach sets the right env vars, spawns the command, and exits
when it finishes. It does not manage the proxy lifecycle.

Options:
  --port <number>  Port the proxy is listening on (default: 4040)
  -h, --help       Show this help

Examples:
  ctxio attach claude                   Attach claude to running proxy
  ctxio attach aider --model opus       Attach aider with options
  ctxio attach --port 5050 claude       Use non-default port
`.trim();

const MAIN_HELP = `
ctxio - LLM API proxy toolkit

Usage:
  ctxio <command> [options]
  ctxio proxy [options]
  ctxio attach <command> [args...]

Commands:
  proxy      Start the LLM API proxy
  attach     Run a command through an already-running proxy
  background Manage a detached shared proxy process
  doctor     Run local diagnostics (ports, mitmproxy, certs, capture dir)
  version    Show version
  help       Show help for a command

Run 'ctxio help <command>' for details on a specific command.
`.trim();

export function getHelp(topic: string | null): string {
  if (topic === "proxy") return PROXY_HELP;
  if (topic === "attach") return ATTACH_HELP;
  return MAIN_HELP;
}

export function parseArgs(argv: string[]): ParseResult {
  // Strip node and script path
  const args = argv.slice(2);

  if (args.length === 0) {
    return { command: "help", topic: null };
  }

  const sub = args[0];

  if (sub === "--version" || sub === "-v" || sub === "version") {
    return { command: "version" };
  }

  if (sub === "doctor") {
    return { command: "doctor" };
  }

  if (sub === "background") {
    const action = args[1] ?? "status";
    if (action !== "start" && action !== "stop" && action !== "status") {
      return {
        error:
          "background requires one of: start, stop, status",
      };
    }
    return { command: "background", action };
  }

  if (sub === "--help" || sub === "-h" || sub === "help") {
    return { command: "help", topic: args[1] ?? null };
  }

  if (sub === "proxy") {
    return parseProxyArgs(args.slice(1));
  }

  if (sub === "attach") {
    return parseAttachArgs(args.slice(1));
  }

  return { error: `Unknown command: ${sub}\n\n${MAIN_HELP}` };
}

function parseProxyArgs(args: string[]): ParseResult {
  const result: ProxyArgs = {
    command: "proxy",
    port: 0, // 0 means "use default from env or 4040"
    bind: "",
    redact: false,
    redactPreset: "pii",
    redactPolicy: null,
    redactReversible: false,
    log: true, // logging on by default
    noLog: false,
    logDir: null,
    logMaxSessions: 0,
    verbose: false,
    wrap: null,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    // -- separator: everything after is the command to wrap
    if (arg === "--") {
      const rest = args.slice(i + 1);
      if (rest.length === 0) {
        return { error: "No command specified after --\n\n" + PROXY_HELP };
      }
      result.wrap = rest;
      break;
    }

    if (arg === "--help" || arg === "-h") {
      return { command: "help", topic: "proxy" };
    }

    if (arg === "--port" || arg === "-p") {
      i++;
      if (i >= args.length) return { error: "--port requires a value" };
      const port = parseInt(args[i], 10);
      if (isNaN(port) || port < 0 || port > 65535) {
        return { error: `Invalid port: ${args[i]}` };
      }
      result.port = port;
    } else if (arg === "--bind") {
      i++;
      if (i >= args.length) return { error: "--bind requires a value" };
      result.bind = args[i];
    } else if (arg === "--redact") {
      result.redact = true;
    } else if (arg === "--redact-preset") {
      i++;
      if (i >= args.length) return { error: "--redact-preset requires a value" };
      const valid = ["secrets", "pii", "strict"];
      if (!valid.includes(args[i])) {
        return { error: `Invalid preset: ${args[i]}. Must be one of: ${valid.join(", ")}` };
      }
      result.redactPreset = args[i];
      result.redact = true;
    } else if (arg === "--redact-policy") {
      i++;
      if (i >= args.length) return { error: "--redact-policy requires a value" };
      result.redactPolicy = args[i];
      result.redact = true;
    } else if (arg === "--redact-reversible") {
      result.redactReversible = true;
      result.redact = true;
    } else if (arg === "--no-log") {
      result.log = false;
      result.noLog = true;
    } else if (arg === "--log-dir") {
      i++;
      if (i >= args.length) return { error: "--log-dir requires a value" };
      result.logDir = args[i];
      result.log = true; // --log-dir implies --log
    } else if (arg === "--log-max-sessions") {
      i++;
      if (i >= args.length) return { error: "--log-max-sessions requires a value" };
      const n = parseInt(args[i], 10);
      if (isNaN(n) || n < 0) {
        return { error: `Invalid value for --log-max-sessions: ${args[i]}` };
      }
      result.logMaxSessions = n;
    } else if (arg === "--verbose") {
      result.verbose = true;
    } else if (arg.startsWith("-")) {
      return { error: `Unknown option: ${arg}\n\n${PROXY_HELP}` };
    } else {
      return { error: `Unexpected argument: ${arg}\n\n${PROXY_HELP}` };
    }

    i++;
  }

  return result;
}

function parseAttachArgs(args: string[]): ParseResult {
  let port = 0; // 0 means use default (4040)
  let i = 0;

  // Parse options before the command
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      return { command: "help", topic: "attach" };
    }

    if (arg === "--port" || arg === "-p") {
      i++;
      if (i >= args.length) return { error: "--port requires a value" };
      const p = parseInt(args[i], 10);
      if (isNaN(p) || p < 0 || p > 65535) {
        return { error: `Invalid port: ${args[i]}` };
      }
      port = p;
      i++;
      continue;
    }

    // First non-option is the command; everything from here is the wrap
    if (!arg.startsWith("-")) {
      break;
    }

    return { error: `Unknown option: ${arg}\n\n${ATTACH_HELP}` };
  }

  const wrap = args.slice(i);
  if (wrap.length === 0) {
    return { error: `No command specified\n\n${ATTACH_HELP}` };
  }

  return { command: "attach", port, wrap };
}
