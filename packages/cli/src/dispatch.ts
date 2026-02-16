import type {
  AttachArgs,
  ExportArgs,
  InspectArgs,
  MonitorArgs,
  ParsedArgs,
  ProxyArgs,
  ReplayArgs,
} from "./args.js";

interface ProxyHandlers {
  runBackground: (action: ProxyArgs["action"]) => Promise<number>;
  runStandalone: (args: ProxyArgs) => Promise<void>;
  runWrap: (args: ProxyArgs, wrap: string[]) => Promise<void>;
}

interface CommandHandlers {
  runDoctor: () => Promise<number>;
  runAttach: (args: AttachArgs) => Promise<void>;
  runProxy: ProxyHandlers;
  runMonitor: (args: MonitorArgs) => Promise<void>;
  runInspect: (args: InspectArgs) => Promise<void>;
  runReplay: (args: ReplayArgs) => Promise<void>;
  runExport: (args: ExportArgs) => Promise<number>;
}

export async function dispatchCommand(
  result: ParsedArgs,
  handlers: CommandHandlers,
): Promise<number | undefined> {
  switch (result.command) {
    case "doctor":
      return handlers.runDoctor();
    case "attach":
      await handlers.runAttach(result);
      return undefined;
    case "proxy":
      if (result.action === "stop" || result.action === "status") {
        return handlers.runProxy.runBackground(result.action);
      }
      if (result.detach) {
        return handlers.runProxy.runBackground("start");
      }
      if (result.wrap) {
        await handlers.runProxy.runWrap(result, result.wrap);
        return undefined;
      }
      await handlers.runProxy.runStandalone(result);
      return undefined;
    case "monitor":
      await handlers.runMonitor(result);
      return undefined;
    case "inspect":
      await handlers.runInspect(result);
      return undefined;
    case "replay":
      await handlers.runReplay(result);
      return undefined;
    case "export":
      return handlers.runExport(result);
  }
}
