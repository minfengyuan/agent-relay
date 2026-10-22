#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { log } from "node:console";

const START_MARKER = "<!-- AGENT-RELAY_START -->";
const END_MARKER = "<!-- AGENT-RELAY_END -->";
const LEGACY_MARKERS = [
  ["<!-- CODEX-AGENT-RELAY_START -->", "<!-- CODEX-AGENT-RELAY_END -->"],
  ["<!-- GROK-BUILD_START -->", "<!-- GROK-BUILD_END -->"],
];
const INSTRUCTIONS = `<!-- AGENT-RELAY_START -->
## External coding agents

The calling agent owns planning, delegation, review, and integration. External agents execute bounded tasks in the supplied workspace/worktree.

Delegate only to an agent the user explicitly mentions (Grok, Cursor, OpenCode, or DSH). If the user does not name an agent, the calling agent performs the task itself; do not infer delegation from task type or complexity.

- Use \`grok_delegate\` for Grok implementation tasks.
- Use \`cursor_delegate\` for Cursor implementation tasks or focused analysis in \`ask\` mode; an optional \`model\` selects the startup model.
- Use \`opencode_delegate\` for OpenCode implementation work. Optional \`model\`, \`effort\`, and \`agent\` change the live session configuration; omitted fields keep OpenCode's restored or default state.
- Use \`dsh_delegate\` for DSH implementation work. Optional \`model\` and \`reasoningEffort\` change the live session configuration; omitted fields keep DSH's restored or default state. Existing sessions resume only when DSH advertises resume; the relay does not load or recreate them.

When delegating:

- Pass the absolute workspace/worktree path as cwd and a complete task specification.
- Use separate worktrees for parallel writers; a worktree is not a security boundary.
- Let the selected agent edit files directly, then inspect the diff and verify relevant tests before integration.
- Do not duplicate completed implementation work unless the result is incomplete.
- Cursor uses its native permission rules and sandbox. On PERMISSION_REQUIRED, review the returned request and coordinate any policy change before resuming; do not retry to bypass the rejection.
- OpenCode auto-selects the request's \`allow_once\` permission option. On PERMISSION_REQUIRED, \`allow_once\` was missing; review the failure and do not treat a retry as extra approval.
- OpenCode's child \`question: deny\` overlay can be overridden by agent-specific rules. The worker is noninteractive and will time out if it waits for a user; this is not hard isolation.
- DSH permission requests are refused (\`reject_once\` when offered). On PERMISSION_REQUIRED, review the request and coordinate any policy change before resuming; do not retry to bypass the rejection. The relay refuses automatic approvals; it does not provide hard filesystem or network isolation. Saved DSH sessions and deployment configuration still apply.
- Keep this relay out of downstream agents' MCP configuration to avoid recursive delegation.
<!-- AGENT-RELAY_END -->`;

function locateBlock(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);

  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error(`Cannot update AGENTS.md: found an incomplete or misordered ${startMarker} block`);
  }

  if (start === -1) return null;

  const duplicateStart = content.indexOf(startMarker, start + startMarker.length);
  const duplicateEnd = content.indexOf(endMarker, end + endMarker.length);
  if (duplicateStart !== -1 || duplicateEnd !== -1) {
    throw new Error(`Cannot update AGENTS.md: found multiple ${startMarker} blocks`);
  }

  return { start, end: end + endMarker.length };
}

function applyInstructions(content) {
  const blocks = [[START_MARKER, END_MARKER], ...LEGACY_MARKERS]
    .map(([start, end]) => locateBlock(content, start, end))
    .filter(Boolean);

  if (blocks.length > 1) {
    throw new Error(`Cannot update AGENTS.md: found multiple ${START_MARKER} blocks`);
  }

  const [block] = blocks;
  if (block) {
    return `${content.slice(0, block.start)}${INSTRUCTIONS}${content.slice(block.end)}`;
  }

  const separator = content.length === 0 ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${INSTRUCTIONS}\n`;
}

async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export async function installInstructions(agentsDirectory = join(homedir(), ".agents")) {
  const agentsPath = join(agentsDirectory, "AGENTS.md");
  await mkdir(agentsDirectory, { recursive: true });
  const current = await readIfPresent(agentsPath);
  const updated = applyInstructions(current);

  if (updated === current) {
    log(`External coding agent instructions are already present in ${agentsPath}`);
  } else {
    await writeFile(agentsPath, updated, "utf8");
    log(`Updated ${agentsPath} with external coding agent instructions`);
  }
}

if (argv[1] && import.meta.url === pathToFileURL(resolve(argv[1])).href) {
  await installInstructions();
}
