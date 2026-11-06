import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dshSpawnSpec, resolveWindowsDshLauncher } from "../src/adapters/dsh.js";
import { loadConfig } from "../src/config.js";
import { tempDir as makeTempDir, useRunnerCleanup } from "./helpers.js";

const dirs: string[] = [];
vi.setConfig({ testTimeout: 15_000 });
useRunnerCleanup(dirs);
const tempDir = () => makeTempDir(dirs);

function launcherEnv(pathValue: string, pathext = ".com;.exe;.cmd;.js"): NodeJS.ProcessEnv {
  return { PATH: pathValue, PATHEXT: pathext };
}

function npmCmdShim(relativeEntry: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeEntry}" %*`,
    "",
  ].join("\r\n");
}

function pnpmCmdShim(relativeEntry: string): string {
  return [
    "@SETLOCAL",
    "@IF NOT DEFINED NODE_PATH (",
    '  @SET "NODE_PATH=C:\\unrelated\\node_modules"',
    ") ELSE (",
    '  @SET "NODE_PATH=C:\\unrelated\\node_modules;%NODE_PATH%"',
    ")",
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${relativeEntry}" %*`,
    ") ELSE (",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  node  "%~dp0\\${relativeEntry}" %*`,
    ")",
    "",
  ].join("\r\n");
}

async function writeDshPackage(
  pkgRoot: string,
  options: { name?: string; bin?: unknown; source?: string } = {},
): Promise<string> {
  const entry = join(pkgRoot, "lib", "bin.js");
  await mkdir(join(pkgRoot, "lib"), { recursive: true });
  await writeFile(join(pkgRoot, "package.json"), `${JSON.stringify({
    name: options.name ?? "@deepseek-ai/dsh",
    bin: options.bin ?? { dsh: "lib/bin.js" },
  })}\n`);
  await writeFile(entry, options.source ?? "console.log('dsh');\n");
  return entry;
}

function expectDshFailure(run: () => unknown, needle: string): void {
  try {
    run();
    expect.fail("expected ACP_FAILURE");
  } catch (error) {
    expect(error).toMatchObject({ code: "ACP_FAILURE", message: expect.stringContaining(needle) });
  }
}

describe("Windows DSH launcher resolution", () => {
  it("parses npm-style .cmd shims and keeps default --profile headless ordering", async () => {
    const root = await tempDir();
    const pkgRoot = join(root, "node_modules", "@deepseek-ai", "dsh");
    const entry = realpathSync(await writeDshPackage(pkgRoot));
    await writeFile(join(root, "dsh.cmd"), npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"));
    const env = launcherEnv(root);
    expect(resolveWindowsDshLauncher("dsh", env)).toEqual({
      command: process.execPath,
      prefixArgs: [entry],
    });
    expect(resolveWindowsDshLauncher("dsh", env).command.toLowerCase()).not.toContain("cmd.exe");
    const spec = dshSpawnSpec({ ...loadConfig({}), dshCommand: "dsh" }, env);
    if (process.platform === "win32") {
      expect(spec).toEqual({ command: process.execPath, args: [entry, "--profile", "headless"] });
    } else {
      expect(spec).toEqual({ command: "dsh", args: ["--profile", "headless"] });
    }
  });

  it("parses pnpm-style .cmd shims from node_modules/.bin", async () => {
    const root = await tempDir();
    const binDir = join(root, "node_modules", ".bin");
    const pkgRoot = join(root, "node_modules", "@deepseek-ai", "dsh");
    const entry = realpathSync(await writeDshPackage(pkgRoot));
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "dsh.cmd"), pnpmCmdShim("..\\@deepseek-ai\\dsh\\lib\\bin.js"));
    expect(resolveWindowsDshLauncher("dsh", launcherEnv(binDir))).toEqual({
      command: process.execPath,
      prefixArgs: [entry],
    });
  });

  it("resolves PATH/PATHEXT order, prefers native .exe, and ignores later PATH entries", async () => {
    const first = await tempDir();
    const second = await tempDir();
    const pkgRoot = join(first, "node_modules", "@deepseek-ai", "dsh");
    await writeDshPackage(pkgRoot);
    await writeFile(join(first, "dsh.cmd"), npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"));
    const exe = join(first, "dsh.exe");
    await writeFile(exe, "native");
    await writeFile(join(second, "dsh.cmd"), "malformed");
    expect(resolveWindowsDshLauncher("dsh", launcherEnv(`${first}${delimiter}${second}`, ".com;.exe;.cmd"))).toEqual({
      command: exe,
      prefixArgs: [],
    });
    expect(resolveWindowsDshLauncher("dsh", launcherEnv(first, ".cmd;.exe")).command).toBe(process.execPath);
  });

  it("resolves launchers in directories with spaces", async () => {
    const root = await tempDir();
    const spaced = join(root, "my bin");
    const pkgRoot = join(spaced, "node_modules", "@deepseek-ai", "dsh");
    const entry = realpathSync(await writeDshPackage(pkgRoot));
    await writeFile(join(spaced, "dsh.cmd"), npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"));
    expect(resolveWindowsDshLauncher("dsh", launcherEnv(spaced))).toEqual({
      command: process.execPath,
      prefixArgs: [entry],
    });
    expect(resolveWindowsDshLauncher(join(spaced, "dsh.cmd"))).toEqual({
      command: process.execPath,
      prefixArgs: [entry],
    });
  });

  it("launches direct .js/.mjs files via process.execPath and preserves native .com", async () => {
    const root = await tempDir();
    const js = join(root, "dsh.js");
    const mjs = join(root, "dsh.mjs");
    const com = join(root, "dsh.com");
    await writeFile(js, "console.log('js');\n");
    await writeFile(mjs, "console.log('mjs');\n");
    await writeFile(com, "native");
    expect(resolveWindowsDshLauncher(js)).toEqual({ command: process.execPath, prefixArgs: [js] });
    expect(resolveWindowsDshLauncher(mjs)).toEqual({ command: process.execPath, prefixArgs: [mjs] });
    expect(resolveWindowsDshLauncher(com)).toEqual({ command: com, prefixArgs: [] });
    expect(resolveWindowsDshLauncher(process.execPath)).toEqual({ command: process.execPath, prefixArgs: [] });
  });

  it("preserves dshCommandArgs after the resolved entry", async () => {
    const root = await tempDir();
    const pkgRoot = join(root, "node_modules", "@deepseek-ai", "dsh");
    const entry = realpathSync(await writeDshPackage(pkgRoot));
    await writeFile(join(root, "dsh.cmd"), npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"));
    const env = launcherEnv(root);
    const help = dshSpawnSpec({ ...loadConfig({}), dshCommand: "dsh", dshCommandArgs: ["--help"] }, env);
    const profileHelp = dshSpawnSpec({
      ...loadConfig({}),
      dshCommand: "dsh",
      dshCommandArgs: ["--profile", "headless", "--help"],
    }, env);
    if (process.platform === "win32") {
      expect(help).toEqual({ command: process.execPath, args: [entry, "--help"] });
      expect(profileHelp).toEqual({
        command: process.execPath,
        args: [entry, "--profile", "headless", "--help"],
      });
    } else {
      expect(help).toEqual({ command: "dsh", args: ["--help"] });
      expect(profileHelp).toEqual({ command: "dsh", args: ["--profile", "headless", "--help"] });
    }
  });

  it("rejects arbitrary shim content without executing it or selecting cmd.exe", async () => {
    const root = await tempDir();
    const pkgRoot = join(root, "node_modules", "@deepseek-ai", "dsh");
    await writeDshPackage(pkgRoot);
    const victim = join(root, "this-must-not-run.txt");
    await writeFile(victim, "safe\n");
    await writeFile(join(root, "dsh.cmd"), [
      "@echo off",
      `del /q "${victim}"`,
      `node "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*`,
      "",
    ].join("\r\n"));
    expectDshFailure(
      () => resolveWindowsDshLauncher("dsh", launcherEnv(root)),
      "not a supported npm/pnpm .cmd shim",
    );
    expect(await readFile(victim, "utf8")).toBe("safe\n");
    expectDshFailure(
      () => resolveWindowsDshLauncher(join(root, "missing.cmd")),
      "Cannot find the DSH command",
    );
    const interpolated = join(root, "env.cmd");
    await writeFile(interpolated, 'node "%USERPROFILE%\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n');
    expectDshFailure(() => resolveWindowsDshLauncher(interpolated), "unsupported environment placeholder");
  });

  it("fails closed for unsupported .bat, malformed shim, missing entry, and mismatched package", async () => {
    const root = await tempDir();
    const bat = join(root, "dsh.bat");
    await writeFile(bat, "@echo off\r\n");
    expectDshFailure(() => resolveWindowsDshLauncher(bat), ".bat script");
    await writeFile(join(root, "dsh.cmd"), "@echo off\r\necho not a shim\r\n");
    expectDshFailure(
      () => resolveWindowsDshLauncher(join(root, "dsh.cmd")),
      "not a supported npm/pnpm .cmd shim",
    );

    const missingRoot = await tempDir();
    await writeFile(
      join(missingRoot, "dsh.cmd"),
      npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"),
    );
    expectDshFailure(() => resolveWindowsDshLauncher(join(missingRoot, "dsh.cmd")), "missing entry");

    const mismatched = await tempDir();
    const otherPkg = join(mismatched, "node_modules", "@deepseek-ai", "dsh");
    await writeDshPackage(otherPkg, { name: "@other/dsh" });
    await writeFile(join(mismatched, "dsh.cmd"), npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"));
    expectDshFailure(() => resolveWindowsDshLauncher(join(mismatched, "dsh.cmd")), "not the bin.dsh");

    const wrongBin = await tempDir();
    const wrongPkg = join(wrongBin, "node_modules", "@deepseek-ai", "dsh");
    await writeDshPackage(wrongPkg, { bin: { dsh: "lib/other.js" } });
    await writeFile(join(wrongPkg, "lib", "other.js"), "console.log('other');\n");
    await writeFile(join(wrongBin, "dsh.cmd"), npmCmdShim("node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"));
    expectDshFailure(() => resolveWindowsDshLauncher(join(wrongBin, "dsh.cmd")), "not the bin.dsh");
  });
});
