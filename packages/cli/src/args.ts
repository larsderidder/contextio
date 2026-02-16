/**
 * CLI argument parsing.
 *
 * Uses Commander to define subcommands (proxy, attach, monitor, inspect,
 * replay, export, doctor) and parse argv into typed result objects.
 * The parser never calls process.exit; instead it returns ParseResult
 * which is either a typed args object or a ParseError.
 */

import { Command } from "commander";

/** Parsed arguments for `ctxio proxy`. */
export interface ProxyArgs {
  command: "proxy";
  /** "start" for normal operation, "stop"/"status" for background control. */
  action: "start" | "stop" | "status";
  port: number;
  bind: string;
  /** Run in background (detached) mode. */
  detach: boolean;
  redact: boolean;
  redactPreset: string;
  redactPolicy: string | null;
  redactReversible: boolean;
  log: boolean;
  noLog: boolean;
  logDir: string | null;
  logMaxSessions: number;
  verbose: boolean;
  /** Command and args after "--" to wrap, or null for standalone proxy. */
  wrap: string[] | null;
}

/** Parsed arguments for `ctxio attach <tool>`. */
export interface AttachArgs {
  command: "attach";
  port: number;
  /** Command and args to run through the proxy. */
  wrap: string[];
}

/** Parsed arguments for `ctxio monitor`. */
export interface MonitorArgs {
  command: "monitor";
  session: string | null;
  /** Duration filter like "1h", "30m". Show recent captures then watch. */
  last: string | null;
  source: string | null;
}

/** Parsed arguments for `ctxio inspect`. */
export interface InspectArgs {
  command: "inspect";
  session: string | null;
  /** Inspect the most recent session. */
  last: boolean;
  source: string | null;
  /** Show full system prompt without truncation. */
  full: boolean;
}

/** Parsed arguments for `ctxio replay`. */
export interface ReplayArgs {
  command: "replay";
  captureFile: string;
  /** Show diff between original and new response. */
  diff: boolean;
  /** Swap the model before replaying. */
  model: string | null;
}

/** Parsed arguments for `ctxio export`. */
export interface ExportArgs {
  command: "export";
  session: string | null;
  last: boolean;
  outputPath: string | null;
  /** Strip request/response bodies, keep metadata only. */
  redact: boolean;
}

/** Parsed arguments for `ctxio doctor`. */
export interface DoctorArgs {
  command: "doctor";
}

/** Union of all successfully parsed command types. */
export type ParsedArgs =
  | ProxyArgs
  | AttachArgs
  | MonitorArgs
  | InspectArgs
  | ReplayArgs
  | ExportArgs
  | DoctorArgs;

/** Returned when argument parsing fails. */
export interface ParseError {
  error: string;
}

/** Either a successfully parsed command or a parse error. */
export type ParseResult = ParsedArgs | ParseError;

/** Type guard for ParseError. */
export function isError(result: ParseResult): result is ParseError {
  return "error" in result;
}

/** Build the Commander program with all subcommands. Results are emitted via callback. */
export function buildProgram(
  onResult: (result: ParseResult) => void,
): Command {
  const program = new Command()
    .name("ctxio")
    .description("LLM API proxy toolkit")
    .version("0.1.0", "-v, --version")
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });

  // --- proxy ---
  const proxy = program
    .command("proxy")
    .description("Start the LLM API proxy")
    .usage("[options] [-- <command> [args...]]")
    .option("-p, --port <number>", "port to listen on (default: 4040)")
    .option("--bind <host>", "bind address (default: 127.0.0.1)")
    .option("-d, --detach", "daemonize the proxy (run in background)")
    .option("-r, --redact", "enable PII/secret redaction (default preset: pii)")
    .option("-P, --redact-preset <name>", "preset: secrets, pii, strict")
    .option("-f, --redact-policy <path>", "path to a redaction policy JSON file")
    .option("-R, --redact-reversible", "restore redacted values in responses")
    .option("--no-log", "disable capture logging (on by default)")
    .option("--log-dir <path>", "directory for capture files")
    .option("--log-max-sessions <n>", "keep only the last N sessions (default: 0)")
    .option("--verbose", "show per-request traffic logs")
    .allowUnknownOption(false)
    .passThroughOptions()
    .argument("[command-args...]")
    .exitOverride();

  proxy.action((commandArgs, opts) => {
    // "proxy stop" and "proxy status" are special actions
    if (
      commandArgs.length === 1 &&
      (commandArgs[0] === "stop" || commandArgs[0] === "status")
    ) {
      onResult({
        command: "proxy",
        action: commandArgs[0],
        port: opts.port ? parseInt(opts.port, 10) : 0,
        bind: "",
        detach: false,
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
      });
      return;
    }

    const wrap = commandArgs.length > 0 ? commandArgs : null;

    const redact =
      opts.redact ||
      !!opts.redactPreset ||
      !!opts.redactPolicy ||
      opts.redactReversible ||
      false;

    const noLog = opts.log === false;
    const log = opts.logDir ? true : !noLog;

    onResult({
      command: "proxy",
      action: "start",
      port: opts.port ? parseInt(opts.port, 10) : 0,
      bind: opts.bind || "",
      detach: opts.detach || false,
      redact,
      redactPreset: opts.redactPreset || "pii",
      redactPolicy: opts.redactPolicy || null,
      redactReversible: opts.redactReversible || false,
      log,
      noLog,
      logDir: opts.logDir || null,
      logMaxSessions: opts.logMaxSessions ? parseInt(opts.logMaxSessions, 10) : 0,
      verbose: opts.verbose || false,
      wrap,
    });
  });

  // --- attach ---
  program
    .command("attach")
    .description("Run a command through an already-running proxy")
    .usage("[options] <command> [args...]")
    .option("-p, --port <number>", "port the proxy is listening on")
    .passThroughOptions()
    .argument("<command-args...>")
    .exitOverride()
    .action((commandArgs, opts) => {
      onResult({
        command: "attach",
        port: opts.port ? parseInt(opts.port, 10) : 4040,
        wrap: commandArgs,
      });
    });

  // --- monitor ---
  program
    .command("monitor")
    .description("Watch for API traffic in real-time")
    .argument("[session]", "session ID to watch")
    .option("--last <duration>", "show recent captures, then watch (1h, 30m, 60s)")
    .option("--source <name>", "filter by source tool (claude, codex, copilot)")
    .exitOverride()
    .action((session, opts) => {
      onResult({
        command: "monitor",
        session: session || null,
        last: opts.last || null,
        source: opts.source || null,
      });
    });

  // --- inspect ---
  program
    .command("inspect")
    .description("List sessions or inspect prompts and tool definitions")
    .argument("[session]", "session ID to inspect")
    .option("--last", "inspect the most recent session")
    .option("--source <name>", "filter by tool (claude, codex, copilot)")
    .option("--full", "show full system prompt (don't truncate)")
    .exitOverride()
    .action((session, opts) => {
      onResult({
        command: "inspect",
        session: session || null,
        last: opts.last || false,
        source: opts.source || null,
        full: opts.full || false,
      });
    });

  // --- replay ---
  program
    .command("replay")
    .description("Re-send a captured request to the API")
    .usage("<capture-file> [options]")
    .argument("<capture-file>", "path to the capture JSON file")
    .option("--diff", "show diff between original and new response")
    .option("--model <name>", "swap the model in the request")
    .exitOverride()
    .action((captureFile, opts) => {
      onResult({
        command: "replay",
        captureFile,
        diff: opts.diff || false,
        model: opts.model || null,
      });
    });

  // --- export ---
  program
    .command("export")
    .description("Bundle session captures into a shareable file")
    .usage("[sessionId] [options]")
    .argument("[sessionId]", "session ID to export")
    .option("--last", "export the most recent session")
    .option("-o, --output <path>", "output file path")
    .option("--redact", "strip request/response bodies, keep metadata only")
    .exitOverride()
    .action((sessionId, opts) => {
      if (!sessionId && !opts.last) {
        onResult({ error: "Must specify session ID or --last" });
        return;
      }
      onResult({
        command: "export",
        session: sessionId || null,
        last: opts.last || false,
        outputPath: opts.output || null,
        redact: opts.redact || false,
      });
    });

  // --- doctor ---
  program
    .command("doctor")
    .description("Run local diagnostics (ports, certs, capture dir)")
    .exitOverride()
    .action(() => {
      onResult({ command: "doctor" });
    });

  return program;
}

/** Parse process.argv into a typed result. Never calls process.exit on parse errors. */
export function parseArgs(argv: string[]): ParseResult {
  let result: ParseResult | null = null;

  const program = buildProgram((r) => {
    result = r;
  });

  // Capture Commander output so we can print it ourselves on
  // help/version instead of letting it call process.exit.
  let helpOutput = "";
  program.configureOutput({
    writeOut: (s: string) => { helpOutput += s; },
    writeErr: (s: string) => { helpOutput += s; },
  });

  try {
    program.parse(argv);
  } catch (err: unknown) {
    if (result) return result;

    const code = (err as { code?: string }).code;
    if (
      code === "commander.helpDisplayed" ||
      code === "commander.help" ||
      code === "commander.version"
    ) {
      process.stdout.write(helpOutput);
      process.exit(0);
    }

    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }

  if (result) return result;

  return { error: "No command specified" };
}

/** Get help text for a specific command or the top-level program. */
export function getHelp(topic?: string | null): string {
  const program = buildProgram(() => {});
  if (topic) {
    const cmd = program.commands.find((c) => c.name() === topic);
    if (cmd) return cmd.helpInformation();
    return `Unknown command: ${topic}\n\n${program.helpInformation()}`;
  }
  return program.helpInformation();
}
