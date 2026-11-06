import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claudeSpawnSpec } from "../src/adapters/claude.js";
import { resolveWindowsPackageLauncher } from "../src/adapters/windows-command.js";
import { baseConfig, tempDir, useRunnerCleanup } from "./helpers.js";

const dirs: string[] = [];
useRunnerCleanup(dirs);
const policy = {
  displayName: "Claude",
  commandEnv: "AGENT_RELAY_CLAUDE_COMMAND",
  packageName: "@anthropic-ai/claude-code",
  binName: "claude",
  entryPath: "cli.js",
};

function shim(entry: string, manager: "npm" | "pnpm") {
  return manager === "npm" ? [
    "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start",
    "SETLOCAL", "CALL :find_dp0", 'IF EXIST "%dp0%\\node.exe" (', 'SET "_prog=%dp0%\\node.exe"',
    ") ELSE (", 'SET "_prog=node"', "SET PATHEXT=%PATHEXT:;.JS;=;%", ")",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\${entry}" %*`,
  ].join("\r\n") : [
    "@SETLOCAL", '@IF EXIST "%~dp0\\node.exe" (',
    `"%~dp0\\node.exe" "%~dp0\\${entry}" %*`,
    ") ELSE (", "@SET PATHEXT=%PATHEXT:;.JS;=;%", `node "%~dp0\\${entry}" %*`, ")",
  ].join("\r\n");
}

describe("Claude Windows command", () => {
  it.each(["npm", "pnpm"] as const)("resolves a verified %s shim with spaces using Node", async (manager) => {
    const root = join(await tempDir(dirs), "path with spaces");
    const packageRoot = join(root, "node_modules", policy.packageName);
    const entry = join(packageRoot, policy.entryPath);
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: policy.packageName, bin: { [policy.binName]: policy.entryPath },
    }));
    const command = join(root, "claude.cmd");
    await writeFile(command, shim(`node_modules\\@anthropic-ai\\claude-code\\cli.js`, manager));
    const env = { PATH: root, PATHEXT: ".exe;.cmd" };
    expect(resolveWindowsPackageLauncher("claude", policy, env)).toEqual({
      command: process.execPath, prefixArgs: [await realpath(entry)],
    });
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      expect(claudeSpawnSpec(baseConfig(root, { claudeCommand: command, claudeCommandArgs: ["fixture-arg"] }), env)).toEqual({
        command: process.execPath, args: [await realpath(entry), "fixture-arg"],
      });
    } finally {
      vi.restoreAllMocks();
    }
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "wrong-package", bin: { [policy.binName]: policy.entryPath } }));
    expect(() => resolveWindowsPackageLauncher(command, policy, env)).toThrow("not the bin.claude");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: policy.packageName, bin: { [policy.binName]: "dist/other.js" } }));
    expect(() => resolveWindowsPackageLauncher(command, policy, env)).toThrow("not the bin.claude");
  });

  it.each(["exe", "com", "js", "mjs"])("supports explicit .%s launchers", async (extension) => {
    const root = await tempDir(dirs);
    const command = join(root, `bridge.${extension}`);
    await writeFile(command, "");
    expect(resolveWindowsPackageLauncher(command, policy, {})).toEqual(
      extension === "exe" || extension === "com" ? { command, prefixArgs: [] }
        : { command: process.execPath, prefixArgs: [command] },
    );
  });

  it.each([
    ["bat", "echo arbitrary", ".bat script"],
    ["cmd", "@echo arbitrary", "not a supported"],
    ["cmd", shim("node_modules\\@anthropic-ai\\claude-code\\cli.js", "npm"), "missing entry"],
    ["cmd", shim("node_modules\\other-package\\dist\\index.js", "pnpm"), "not a supported"],
    ["cmd", shim("%USERPROFILE%\\node_modules\\@anthropic-ai\\claude-code\\cli.js", "npm"), "unsupported environment"],
  ])("rejects invalid launcher %s: %s", async (extension, content, message) => {
    const root = await tempDir(dirs);
    const command = join(root, `bridge.${extension}`);
    await writeFile(command, content);
    expect(() => resolveWindowsPackageLauncher(command, policy, {})).toThrow(message);
  });

  it("reports a missing executable with its provider override", async () => {
    const root = await tempDir(dirs);
    expect(() => resolveWindowsPackageLauncher("claude", policy, { PATH: root })).toThrow("AGENT_RELAY_CLAUDE_COMMAND");
  });
});
