import { readFileSync, realpathSync, statSync } from "node:fs";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  resolve,
} from "node:path";
import { RelayFailure } from "../types.js";

const OTHER_PERCENT = /%(?:~[^%]*|[^%]+)%/;
const SHIM_MAX_BYTES = 64 * 1024;
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

export type WindowsLauncher = {
  command: string;
  prefixArgs: string[];
};

export type WindowsLauncherPolicy = {
  displayName: string;
  commandEnv: string;
  packageName: string;
  binName: string;
  entryPath: string;
};

export function resolveWindowsPackageLauncher(
  command: string,
  policy: WindowsLauncherPolicy,
  env: NodeJS.ProcessEnv = process.env,
): WindowsLauncher {
  const found = locateCommand(command, env);
  if (!found) {
    throw fail(
      `Cannot find the ${policy.displayName} command ${JSON.stringify(command)} on PATH. Set ${policy.commandEnv} to a native .exe/.com, a .js/.mjs entry, or a supported npm/pnpm ${policy.binName}.cmd shim.`,
    );
  }
  return interpretLauncher(found, policy);
}

function interpretLauncher(found: string, policy: WindowsLauncherPolicy): WindowsLauncher {
  const ext = extname(found).toLowerCase();
  if (ext === ".exe" || ext === ".com") {
    return { command: found, prefixArgs: [] };
  }
  if (ext === ".js" || ext === ".mjs") {
    return { command: process.execPath, prefixArgs: [found] };
  }
  if (ext === ".bat") {
    throw fail(
      `Windows ${policy.displayName} launcher ${found} is a .bat script; the relay cannot spawn batch files with shell:false. Set ${policy.commandEnv} to a native .exe/.com, a .js/.mjs entry, or a supported npm/pnpm ${policy.binName}.cmd shim.`,
    );
  }
  if (ext === ".cmd") {
    const entry = parseAndVerifyCmdShim(found, policy);
    return { command: process.execPath, prefixArgs: [entry] };
  }
  if (ext === "") {
    return { command: found, prefixArgs: [] };
  }
  throw fail(
    `Windows ${policy.displayName} launcher ${found} uses unsupported extension ${ext}. Set ${policy.commandEnv} to a native .exe/.com, a .js/.mjs entry, or a supported npm/pnpm ${policy.binName}.cmd shim.`,
  );
}

function locateCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathext = pathextList(env);
  if (hasPathSeparator(command)) {
    return firstExisting(pathCandidates(resolve(command), pathext, true));
  }
  const name = command;
  for (const dir of pathDirs(env)) {
    const found = firstExisting(pathCandidates(join(dir, name), pathext, false));
    if (found) return found;
  }
  return undefined;
}

function pathCandidates(target: string, pathext: string[], allowExactWithoutExt: boolean): string[] {
  const ext = extname(target);
  if (ext !== "") return [target];
  const candidates: string[] = [];
  // Bare PATH lookup skips the extensionless npm bash shim and follows PATHEXT like cmd.exe.
  if (allowExactWithoutExt) candidates.push(target);
  for (const entry of pathext) {
    const suffix = entry.startsWith(".") ? entry : `.${entry}`;
    candidates.push(target + suffix);
  }
  return candidates;
}

function firstExisting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function parseAndVerifyCmdShim(shimPath: string, policy: WindowsLauncherPolicy): string {
  let content: string;
  try {
    const stat = statSync(shimPath);
    if (stat.size > SHIM_MAX_BYTES) {
      throw fail(unsupportedShimMessage(shimPath, policy));
    }
    content = readFileSync(shimPath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if (error instanceof RelayFailure) throw error;
    throw fail(
      `Windows ${policy.displayName} launcher ${shimPath} is not a readable npm/pnpm .cmd shim. Point ${policy.commandEnv} at the official ${policy.displayName} .js/.mjs entry or a native ${policy.displayName} .exe/.com.`,
    );
  }
  const extracted = extractShimEntry(content, shimPath, policy);
  if (!isFile(extracted)) {
    throw fail(
      `Windows ${policy.displayName} .cmd shim ${shimPath} points at missing entry ${extracted}. Reinstall ${policy.packageName} or set ${policy.commandEnv} to a working launcher.`,
    );
  }
  return verifyPackageEntry(extracted, shimPath, policy);
}

function extractShimEntry(content: string, shimPath: string, policy: WindowsLauncherPolicy): string {
  const shimDir = dirname(shimPath);
  for (const raw of shimPathTokens(content)) {
    if (!isPackageEntry(raw, policy)) continue;
    if (expandShimDirectoryPlaceholders(raw, shimDir) === undefined) {
      throw fail(
        `Windows ${policy.displayName} launcher ${shimPath} uses an unsupported environment placeholder. The relay expands only the npm/pnpm shim-directory placeholders %dp0% and %~dp0. Point ${policy.commandEnv} at the official ${policy.displayName} .js/.mjs entry or a native ${policy.displayName} .exe/.com.`,
      );
    }
  }

  const rawEntries = npmShimEntries(content) ?? pnpmShimEntries(content);
  if (!rawEntries) throw fail(unsupportedShimMessage(shimPath, policy));

  const expanded: string[] = [];
  for (const raw of rawEntries) {
    if (!isPackageEntry(raw, policy)) continue;
    const resolved = expandShimDirectoryPlaceholders(raw, shimDir);
    if (resolved === undefined) throw fail(unsupportedShimMessage(shimPath, policy));
    expanded.push(resolved);
  }
  const unique = [...new Set(expanded)];
  const entry = unique.length === 1 ? unique[0] : undefined;
  if (!entry || !isPackageEntry(entry, policy)) {
    throw fail(unsupportedShimMessage(shimPath, policy));
  }
  return entry;
}

function npmShimEntries(content: string): string[] | undefined {
  const lines = shimLines(content);
  const invocation = /^endLocal\s+&\s+goto\s+#_undefined_#\s+2>NUL\s+\|\|\s+title\s+%COMSPEC%\s+&\s+"%_prog%"\s+"([^"]+)"\s+%\*$/i;
  const allowed = [
    /^@ECHO off$/i,
    /^GOTO start$/i,
    /^:find_dp0$/i,
    /^SET dp0=%~dp0$/i,
    /^EXIT \/b$/i,
    /^:start$/i,
    /^SETLOCAL$/i,
    /^CALL :find_dp0$/i,
    /^IF EXIST "%dp0%\\node\.exe" \($/i,
    /^SET "_prog=%dp0%\\node\.exe"$/i,
    /^\) ELSE \($/i,
    /^SET "_prog=node"$/i,
    /^SET PATHEXT=%PATHEXT:;\.JS;=;%$/i,
    /^\)$/,
    invocation,
  ];
  if (!hasAllLines(lines, [
    /^@ECHO off$/i,
    /^SET dp0=%~dp0$/i,
    /^CALL :find_dp0$/i,
    /^IF EXIST "%dp0%\\node\.exe" \($/i,
    /^SET "_prog=%dp0%\\node\.exe"$/i,
    /^SET "_prog=node"$/i,
    /^SET PATHEXT=%PATHEXT:;\.JS;=;%$/i,
  ]) || !lines.every((line) => allowed.some((pattern) => pattern.test(line)))) {
    return undefined;
  }
  const matches = lines.map((line) => invocation.exec(line)).filter((match): match is RegExpExecArray => match !== null);
  return matches.length === 1 && matches[0]?.[1] ? [matches[0][1]] : undefined;
}

function pnpmShimEntries(content: string): string[] | undefined {
  const lines = shimLines(content);
  const localInvocation = /^"%~dp0\\node\.exe"\s+"([^"]+)"\s+%\*$/i;
  const pathInvocation = /^node(?:\.exe)?\s+"([^"]+)"\s+%\*$/i;
  const allowed = [
    /^@SETLOCAL$/i,
    /^@IF NOT DEFINED NODE_PATH \($/i,
    /^@SET "NODE_PATH=[^"]*"$/i,
    /^\) ELSE \($/i,
    /^\)$/,
    /^@IF EXIST "%~dp0\\node\.exe" \($/i,
    /^@SET PATHEXT=%PATHEXT:;\.JS;=;%$/i,
    localInvocation,
    pathInvocation,
  ];
  if (!hasAllLines(lines, [
    /^@SETLOCAL$/i,
    /^@IF EXIST "%~dp0\\node\.exe" \($/i,
    /^@SET PATHEXT=%PATHEXT:;\.JS;=;%$/i,
  ]) || !lines.every((line) => allowed.some((pattern) => pattern.test(line)))) {
    return undefined;
  }
  const local = lines.map((line) => localInvocation.exec(line)).filter((match): match is RegExpExecArray => match !== null);
  const path = lines.map((line) => pathInvocation.exec(line)).filter((match): match is RegExpExecArray => match !== null);
  return local.length === 1 && path.length === 1 && local[0]?.[1] && path[0]?.[1]
    ? [local[0][1], path[0][1]]
    : undefined;
}

function shimLines(content: string): string[] {
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function hasAllLines(lines: string[], required: RegExp[]): boolean {
  return required.every((pattern) => lines.some((line) => pattern.test(line)));
}

function shimPathTokens(content: string): string[] {
  const tokens: string[] = [];
  for (const match of content.matchAll(/"([^"]+)"/g)) {
    const token = match[1];
    if (token) tokens.push(token);
  }
  for (const match of content.matchAll(/(?:%~dp0|%dp0%)[^\s"&|<>^]*/gi)) {
    tokens.push(match[0]);
  }
  return tokens;
}

function expandShimDirectoryPlaceholders(raw: string, shimDir: string): string | undefined {
  const stripped = raw.replace(/%~dp0/gi, "").replace(/%dp0%/gi, "");
  if (OTHER_PERCENT.test(stripped) || /%~/.test(stripped)) return undefined;
  const dir = shimDir.endsWith("\\") || shimDir.endsWith("/") ? shimDir : `${shimDir}\\`;
  const expanded = raw.replace(/%~dp0/gi, dir).replace(/%dp0%/gi, dir);
  return resolve(expanded.replace(/\\/g, "/"));
}

function verifyPackageEntry(entryPath: string, shimPath: string, policy: WindowsLauncherPolicy): string {
  let entryReal: string;
  try {
    entryReal = realpathSync(entryPath);
  } catch {
    throw fail(
      `Windows ${policy.displayName} .cmd shim ${shimPath} points at missing entry ${entryPath}. Reinstall ${policy.packageName} or set ${policy.commandEnv} to a working launcher.`,
    );
  }
  if (!isPackageEntry(entryReal, policy)) {
    throw fail(mismatchMessage(entryReal, policy));
  }
  const pkgRoot = findPackageRoot(entryReal, policy);
  if (!pkgRoot) throw fail(mismatchMessage(entryReal, policy));
  const pkg = readJson(join(pkgRoot, "package.json"));
  if (!pkg || pkg.name !== policy.packageName) throw fail(mismatchMessage(entryReal, policy));
  const mapped = mappedBin(pkg.bin, pkgRoot, policy.binName);
  if (!mapped) throw fail(mismatchMessage(entryReal, policy));
  let mappedReal: string;
  try {
    mappedReal = realpathSync(mapped);
  } catch {
    throw fail(mismatchMessage(entryReal, policy));
  }
  if (mappedReal !== entryReal) throw fail(mismatchMessage(entryReal, policy));
  return entryReal;
}

function mappedBin(bin: unknown, pkgRoot: string, binName: string): string | undefined {
  if (typeof bin === "string") return resolve(pkgRoot, bin);
  if (!bin || typeof bin !== "object" || Array.isArray(bin)) return undefined;
  const entry = (bin as Record<string, unknown>)[binName];
  return typeof entry === "string" ? resolve(pkgRoot, entry) : undefined;
}

function findPackageRoot(entryRealPath: string, policy: WindowsLauncherPolicy): string | undefined {
  let dir = dirname(entryRealPath);
  const { root } = parse(entryRealPath);
  while (true) {
    const pkgFile = join(dir, "package.json");
    if (isFile(pkgFile)) {
      const pkg = readJson(pkgFile);
      if (pkg?.name === policy.packageName) return dir;
    }
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readJson(path: string): { name?: unknown; bin?: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as { name?: unknown; bin?: unknown }
      : undefined;
  } catch {
    return undefined;
  }
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  const dirs: string[] = [];
  for (const entry of raw.split(delimiter)) {
    const dir = entry.trim();
    if (!dir) continue;
    dirs.push(isAbsolute(dir) ? dir : resolve(dir));
  }
  return dirs;
}

function pathextList(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? env.Pathext ?? DEFAULT_PATHEXT;
  return raw.split(";").map((entry) => entry.trim()).filter(Boolean);
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\") || isAbsolute(command);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function posixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isPackageEntry(entry: string, policy: WindowsLauncherPolicy): boolean {
  return posixPath(entry).replace(/\/+/g, "/").toLowerCase()
    .endsWith(`/${policy.packageName}/${policy.entryPath}`.toLowerCase());
}

function mismatchMessage(entry: string, policy: WindowsLauncherPolicy): string {
  return `Windows ${policy.displayName} entry ${entry} is not the bin.${policy.binName} of an ${policy.packageName} package. Set ${policy.commandEnv} to the official ${policy.displayName} CLI, a native .exe/.com, or a .js/.mjs entry.`;
}

function unsupportedShimMessage(shimPath: string, policy: WindowsLauncherPolicy): string {
  return `Windows ${policy.displayName} launcher ${shimPath} is not a supported npm/pnpm .cmd shim for ${policy.packageName}. Point ${policy.commandEnv} at the official ${policy.displayName} .js/.mjs entry or a native ${policy.displayName} .exe/.com.`;
}

function fail(message: string): RelayFailure {
  return new RelayFailure("ACP_FAILURE", message);
}
