import { resolveWindowsPackageLauncher, type WindowsLauncher } from "./windows-command.js";

export type WindowsDshLauncher = WindowsLauncher;

export function resolveWindowsDshLauncher(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): WindowsDshLauncher {
  return resolveWindowsPackageLauncher(command, {
    displayName: "DSH",
    commandEnv: "AGENT_RELAY_DSH_COMMAND",
    packageName: "@deepseek-ai/dsh",
    binName: "dsh",
    entryPath: "lib/bin.js",
  }, env);
}
