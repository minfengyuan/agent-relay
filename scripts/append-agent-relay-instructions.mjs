#!/usr/bin/env node
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process, { argv } from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const START_MARKER = "<!-- AGENT-RELAY_START -->";
const END_MARKER = "<!-- AGENT-RELAY_END -->";
const LEGACY_MARKERS = [
  ["<!-- CODEX-AGENT-RELAY_START -->", "<!-- CODEX-AGENT-RELAY_END -->"],
  ["<!-- GROK-BUILD_START -->", "<!-- GROK-BUILD_END -->"],
];
const INSTRUCTIONS = `<!-- AGENT-RELAY_START -->
## External coding agents

The calling agent owns planning, delegation, review, and integration. External agents execute bounded tasks in the supplied workspace/worktree.

Delegate only to an agent the user explicitly mentions (Grok, Cursor, OpenCode, DSH, or Codex). If the user does not name an agent, the calling agent performs the task itself; do not infer delegation from task type or complexity.

- Use \`grok_delegate\` for Grok implementation tasks.
- Use \`cursor_delegate\` for Cursor implementation tasks or focused analysis in \`ask\` mode; an optional \`model\` selects the startup model.
- Use \`opencode_delegate\` for OpenCode implementation work. Optional \`model\`, \`effort\`, and \`agent\` change the live session configuration; omitted fields keep OpenCode's restored or default state.
- Use \`dsh_delegate\` for DSH implementation work. Optional \`model\` and \`reasoningEffort\` change the live session configuration; omitted fields keep DSH's restored or default state. Existing sessions resume only when DSH advertises resume; the relay does not load or recreate them.
- Use \`codex_delegate\` for Codex implementation work through its native app-server. Optional \`model\` and \`reasoningEffort\` change the live thread configuration; omitted fields preserve the restored or default state. Pass the returned \`sessionId\` to resume the same thread.

When delegating:

- Pass the absolute workspace/worktree path as cwd and a complete task specification.
- Use separate worktrees for parallel writers; a worktree is not a security boundary.
- Let the selected agent edit files directly, then inspect the diff and verify relevant tests before integration.
- Do not duplicate completed implementation work unless the result is incomplete.
- Cursor uses its native permission rules and sandbox. On PERMISSION_REQUIRED, review the returned request and coordinate any policy change before resuming; do not retry to bypass the rejection.
- OpenCode auto-selects the request's \`allow_once\` permission option. On PERMISSION_REQUIRED, \`allow_once\` was missing; review the failure and do not treat a retry as extra approval.
- OpenCode's child \`question: deny\` overlay can be overridden by agent-specific rules. The worker is noninteractive and will time out if it waits for a user; this is not hard isolation.
- DSH permission requests are refused (\`reject_once\` when offered). On PERMISSION_REQUIRED, review the request and coordinate any policy change before resuming; do not retry to bypass the rejection. The relay refuses automatic approvals; it does not provide hard filesystem or network isolation. Saved DSH sessions and deployment configuration still apply.
- Codex uses workspace-write sandboxing with sandbox network access disabled and default temporary-directory access. Extra permissions are refused with PERMISSION_REQUIRED; interactive questions fail with INTERACTION_REQUIRED. Do not retry to bypass these failures. Local Codex authentication and inherited MCP configuration still apply.
- Keep this relay out of downstream agents' MCP configuration to avoid recursive delegation.
<!-- AGENT-RELAY_END -->`;

function locateBlock(content, startMarker, endMarker, targetPath) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);

  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error(`Cannot update ${targetPath}: found an incomplete or misordered ${startMarker} block`);
  }

  if (start === -1) return null;

  const duplicateStart = content.indexOf(startMarker, start + startMarker.length);
  const duplicateEnd = content.indexOf(endMarker, end + endMarker.length);
  if (duplicateStart !== -1 || duplicateEnd !== -1) {
    throw new Error(`Cannot update ${targetPath}: found multiple ${startMarker} blocks`);
  }

  return { start, end: end + endMarker.length };
}

function applyInstructions(content, targetPath) {
  const blocks = [[START_MARKER, END_MARKER], ...LEGACY_MARKERS]
    .map(([start, end]) => locateBlock(content, start, end, targetPath))
    .filter(Boolean);

  if (blocks.length > 1) {
    throw new Error(`Cannot update ${targetPath}: found multiple ${START_MARKER} blocks`);
  }

  const [block] = blocks;
  if (block) {
    return `${content.slice(0, block.start)}${INSTRUCTIONS}${content.slice(block.end)}`;
  }

  const separator = content.length === 0 ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${INSTRUCTIONS}\n`;
}

async function readIfPresent(path, missing = "") {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return missing;
    throw error;
  }
}

const CLIENTS = [
  { id: "codex", name: "Codex", commands: ["codex"] },
  { id: "cursor", name: "Cursor", commands: ["cursor-agent", "cursor"] },
  { id: "opencode", name: "OpenCode", commands: ["opencode"] },
  { id: "grok", name: "Grok", commands: ["grok"] },
  { id: "dsh", name: "DSH", commands: ["dsh"] },
];
const CURSOR_HEADER = "---\nalwaysApply: true\n---\n\n";
const HELP = `Usage: pnpm setup:instructions [--clients codex,cursor,opencode,grok,dsh] [--project DIRECTORY] [--dry-run]

Without --clients, select clients interactively (Enter selects all detected clients).
--clients   Comma-separated client IDs; skips interactive selection, including for undetected clients.
--project   Existing project directory for Cursor's project-scoped rule.
--dry-run   Preview changes without creating directories or writing files.
--help      Show this help.

This installs guidance only. Configure the relay MCP server separately in each client.`;

function configuredDirectory(value, fallback, home) {
  const path = value?.trim() || fallback;
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(home, path.slice(2));
  return resolve(path);
}

function clientDirectories(home, env) {
  return {
    codex: configuredDirectory(env.CODEX_HOME, join(home, ".codex"), home),
    cursor: join(home, ".cursor"),
    opencode: configuredDirectory(env.OPENCODE_CONFIG_DIR,
      join(configuredDirectory(env.XDG_CONFIG_HOME, join(home, ".config"), home), "opencode"), home),
    grok: configuredDirectory(env.GROK_HOME, join(home, ".grok"), home),
    dsh: configuredDirectory(env.DSH_HOME, join(home, ".dsh"), home),
  };
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

async function findCommand(commands, env) {
  const extensions = process.platform === "win32"
    ? ["", ...(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")]
    : [""];
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const command of commands) {
      for (const extension of extensions) {
        const path = join(directory.replace(/^"|"$/g, ""), command + extension);
        try {
          await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
          if ((await stat(path)).isFile()) return path;
        } catch (error) {
          if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error?.code)) throw error;
        }
      }
    }
  }
  return null;
}

export async function detectClients({ home = homedir(), env = process.env } = {}) {
  const directories = clientDirectories(home, env);
  return Promise.all(CLIENTS.map(async (client) => {
    const command = await findCommand(client.commands, env);
    const directory = directories[client.id];
    const directoryExists = await isDirectory(directory);
    return { ...client, detected: Boolean(command || directoryExists),
      evidence: [command && `command: ${command}`, directoryExists && `directory: ${directory}`].filter(Boolean),
      directory };
  }));
}

function parseArguments(args) {
  const options = { dryRun: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help") options.help = true;
    else if (arg === "--clients" || arg === "--project") {
      const value = args[++index];
      if (!value?.trim() || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--clients") options.clients = validateClients(value.split(",").map((id) => id.trim()));
      else options.project = value;
    } else throw new Error(`Unknown argument: ${arg}. Use --help.`);
  }
  return options;
}

function validateClients(ids) {
  if (!ids.length || ids.some((id) => !CLIENTS.some((client) => client.id === id))) {
    throw new Error(`Unknown or empty client; supported clients: ${CLIENTS.map((client) => client.id).join(", ")}`);
  }
  return [...new Set(ids)];
}

async function resolveTargets(clients, { home, env, project }) {
  const directories = clientDirectories(home, env);
  if (clients.includes("cursor") && (!project?.trim() || !await isDirectory(resolve(project)))) {
    throw new Error("Cursor requires --project pointing to an existing project directory");
  }
  return Promise.all(clients.map(async (id) => {
    let path = join(directories[id], "AGENTS.md");
    if (id === "codex") {
      const override = join(directories.codex, "AGENTS.override.md");
      if ((await readIfPresent(override)).trim()) path = override;
    }
    if (id === "cursor") path = join(resolve(project), ".cursor", "rules", "agent-relay.mdc");
    return { id, path, scope: id === "cursor" ? "project" : "global" };
  }));
}

function cursorInstructions(content, targetPath, exists) {
  // Validate markers before checking ownership or modifying the frontmatter.
  const updated = applyInstructions(content, targetPath);
  if (!exists) return CURSOR_HEADER + updated;
  if (![[START_MARKER, END_MARKER], ...LEGACY_MARKERS].some(([start]) => content.includes(start))) {
    throw new Error(`Cannot update ${targetPath}: existing Cursor file has no relay managed block`);
  }
  // A dedicated relay rule must always apply. Preserve other frontmatter fields.
  const header = updated.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!header) return CURSOR_HEADER + updated;
  const fields = header[1];
  const matches = fields.match(/^alwaysApply:.*$/gm) || [];
  if (matches.length > 1) throw new Error(`Cannot update ${targetPath}: duplicate alwaysApply fields`);
  const fixed = matches.length ? fields.replace(/^alwaysApply:.*$/m, "alwaysApply: true") : `${fields}\nalwaysApply: true`;
  return `---\n${fixed}\n---\n` + updated.slice(header[0].length);
}

async function migrationWarnings({ home, env, targets }) {
  const warnings = [];
  const sharedPaths = new Set([join(home, ".agents", "AGENTS.md")]);
  if (env.DSH_AGENTS_HOME?.trim()) {
    sharedPaths.add(join(configuredDirectory(env.DSH_AGENTS_HOME, "", home), "AGENTS.md"));
  }
  for (const path of sharedPaths) {
    const content = await readIfPresent(path);
    if ([START_MARKER, ...LEGACY_MARKERS.map(([start]) => start)].some((marker) => content.includes(marker))) {
      warnings.push(`Historical relay guidance remains in ${path}; review clients that still load it. It will not be removed.`);
    }
  }
  const opencode = targets.find((target) => target.id === "opencode");
  if (opencode && !(await readIfPresent(opencode.path)).trim() &&
      !(env.OPENCODE_DISABLE_CLAUDE_CODE === "1" || env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT === "1")) {
    const fallback = join(home, ".claude", "CLAUDE.md");
    if ((await readIfPresent(fallback)).trim()) {
      warnings.push(`Creating ${opencode.path} takes precedence over OpenCode's ${fallback} fallback; review that guidance before selecting OpenCode.`);
    }
  }
  return warnings;
}

export async function installInstructions({ clients, project, dryRun = false,
  home = homedir(), env = process.env, output = process.stdout } = {}) {
  clients = validateClients(clients ?? []);
  const targets = await resolveTargets(clients, { home, env, project });
  // Preflight every file before creating any directories or writing any targets.
  const changes = await Promise.all(targets.map(async (target) => {
    const existing = await readIfPresent(target.path, null);
    const current = existing ?? "";
    const updated = target.id === "cursor" ? cursorInstructions(current, target.path, existing !== null) : applyInstructions(current, target.path);
    return { ...target, updated, status: updated === current ? "unchanged" : existing === null ? "create" : "update" };
  }));
  for (const warning of await migrationWarnings({ home, env, targets })) output.write(`Warning: ${warning}\n`);
  const results = [];
  for (const change of changes) {
    try {
      if (!dryRun && change.status !== "unchanged") {
        await mkdir(dirname(change.path), { recursive: true });
        await writeFile(change.path, change.updated, "utf8");
      }
      output.write(`${dryRun ? "[dry-run] " : ""}${change.id}: ${change.status} (${change.scope}) ${change.path}\n`);
      results.push({ client: change.id, path: change.path, status: change.status });
    } catch (error) {
      output.write(`${change.id}: failed (${change.scope}) ${change.path}: ${error.message}\n`);
      results.push({ client: change.id, path: change.path, status: "failed" });
    }
  }
  if (!dryRun) output.write("Start a new client session to load the rules. Configure the relay MCP server separately in each client.\n");
  return results;
}

async function interactiveSelection(detected, options, { input, output, home, env }) {
  const terminal = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  const lines = terminal[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    output.write(prompt);
    const answer = await lines.next();
    return answer.done ? null : answer.value.trim();
  };
  terminal.on("SIGINT", () => terminal.close());
  try {
    // Show migration caveats before selection, including OpenCode's fallback shadowing.
    const previewTargets = await resolveTargets(["opencode"], { home, env });
    for (const warning of await migrationWarnings({ home, env, targets: previewTargets })) output.write(`Warning: ${warning}\n`);
    output.write("Select comma-separated client numbers, Enter for all detected clients, or q to cancel.\n");
    let clients;
    while (!clients) {
      const answer = await ask("Clients: ");
      if (answer === null || answer.toLowerCase() === "q") return null;
      const numbers = answer ? answer.split(",").map((value) => value.trim()) : [];
      if (numbers.some((value) => !/^[1-5]$/.test(value))) {
        output.write("Choose client numbers 1-5, separated by commas.\n");
        continue;
      }
      clients = answer ? [...new Set(numbers.map((value) => CLIENTS[Number(value) - 1].id))]
        : detected.filter((client) => client.detected).map((client) => client.id);
      if (!clients.length) {
        output.write("No detected clients selected; nothing was written.\n");
        return null;
      }
    }
    let project = options.project;
    while (clients.includes("cursor") && (!project?.trim() || !await isDirectory(resolve(project)))) {
      project = await ask("Cursor project directory (existing directory; q to cancel): ");
      if (project === null || project.toLowerCase() === "q") return null;
      if (!project || !await isDirectory(resolve(project))) output.write("Enter an existing project directory.\n");
    }
    return { clients, project };
  } finally {
    terminal.close();
  }
}

export async function main(args = argv.slice(2), { input = process.stdin, output = process.stdout,
  home = homedir(), env = process.env } = {}) {
  const options = parseArguments(args);
  if (options.help) {
    output.write(`${HELP}\n`);
    return 0;
  }
  const detected = await detectClients({ home, env });
  output.write("Client detection (installation evidence only; authentication and MCP configuration are not checked):\n");
  for (const [index, client] of detected.entries()) {
    let target = "<project>/.cursor/rules/agent-relay.mdc (project)";
    if (client.id !== "cursor") {
      try {
        target = (await resolveTargets([client.id], { home, env }))[0].path + " (global)";
      } catch (error) {
        // An unavailable preview must not block installation for unrelated clients.
        target = `${join(client.directory, "AGENTS.md")} (global; unavailable: ${error.message})`;
      }
    }
    output.write(`${index + 1}. ${client.name}: ${client.detected ? client.evidence.join("; ") : "not detected"} -> ${target}\n`);
  }
  let selected = options;
  if (!options.clients) {
    if (!input.isTTY || !output.isTTY) throw new Error("Non-interactive input requires --clients; use --help for examples");
    selected = await interactiveSelection(detected, options, { input, output, home, env });
    if (!selected) {
      output.write("Cancelled; nothing was written.\n");
      return 0;
    }
  }
  const results = await installInstructions({ ...options, ...selected, home, env, output });
  return results.some((result) => result.status === "failed") ? 1 : 0;
}

if (argv[1] && import.meta.url === pathToFileURL(resolve(argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
