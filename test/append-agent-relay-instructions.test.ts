import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import type * as NodeOs from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const scriptUrl = new URL("../scripts/append-agent-relay-instructions.mjs", import.meta.url);
const script = fileURLToPath(scriptUrl);
const execFileAsync = promisify(execFile);
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
const { installInstructions } = await import(scriptUrl.href) as {
  installInstructions: (agentsDirectory?: string) => Promise<void>;
};
const startMarker = "<!-- AGENT-RELAY_START -->";
const endMarker = "<!-- AGENT-RELAY_END -->";
const legacyStartMarker = "<!-- GROK-BUILD_START -->";
const legacyEndMarker = "<!-- GROK-BUILD_END -->";
const tempDirectories: string[] = [];

async function tempAgentsDirectory(): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/agent-relay-`);
  tempDirectories.push(root);
  return `${root}/.agents`;
}

async function run(agentsDirectory: string) {
  return installInstructions(agentsDirectory);
}

describe("append-agent-relay-instructions", () => {
  afterEach(async () => {
    vi.mocked(homedir).mockReset();
    vi.unstubAllEnvs();
    await Promise.all(
      tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("creates AGENTS.md and remains idempotent", async () => {
    const agentsDirectory = await tempAgentsDirectory();

    await run(agentsDirectory);
    const first = await readFile(`${agentsDirectory}/AGENTS.md`, "utf8");
    await run(agentsDirectory);
    const second = await readFile(`${agentsDirectory}/AGENTS.md`, "utf8");

    expect(first).toContain("## External coding agents");
    expect(first).toContain("`grok_delegate`");
    expect(first).toContain("`cursor_delegate`");
    expect(first).toContain("`opencode_delegate`");
    expect(first).toContain("`dsh_delegate`");
    expect(first).toContain("PERMISSION_REQUIRED");
    expect(first).toContain("allow_once");
    expect(first).toContain(startMarker);
    expect(first).toContain(endMarker);
    expect(first).not.toContain(legacyStartMarker);
    expect(first).not.toContain(legacyEndMarker);
    expect(first.match(new RegExp(startMarker, "g"))).toHaveLength(1);
    expect(second).toBe(first);
  });

  it("preserves existing instructions and updates the managed block in place", async () => {
    const agentsDirectory = await tempAgentsDirectory();
    await mkdir(agentsDirectory);
    await writeFile(
      `${agentsDirectory}/AGENTS.md`,
      `# Existing\n\n${startMarker}\nOld instructions\n${endMarker}\n\nAfter\n`,
    );

    await run(agentsDirectory);
    const content = await readFile(`${agentsDirectory}/AGENTS.md`, "utf8");

    expect(content).toMatch(/^# Existing\n\n/);
    expect(content).toContain("Pass the absolute workspace/worktree path as cwd");
    expect(content).not.toContain("Old instructions");
    expect(content).toMatch(/\n\nAfter\n$/);
    expect(content).toContain(startMarker);
    expect(content).not.toContain(legacyStartMarker);
  });

  it.each(["CODEX-AGENT-RELAY", "GROK-BUILD"])("replaces a legacy %s block in place", async (prefix) => {
    const legacyStartMarker = `<!-- ${prefix}_START -->`;
    const legacyEndMarker = `<!-- ${prefix}_END -->`;
    const agentsDirectory = await tempAgentsDirectory();
    await mkdir(agentsDirectory);
    await writeFile(
      `${agentsDirectory}/AGENTS.md`,
      `# Existing\n\n${legacyStartMarker}\nOld instructions\n${legacyEndMarker}\n\nAfter\n`,
    );

    await run(agentsDirectory);
    const content = await readFile(`${agentsDirectory}/AGENTS.md`, "utf8");

    expect(content).toMatch(/^# Existing\n\n/);
    expect(content).toContain("Pass the absolute workspace/worktree path as cwd");
    expect(content).toContain(startMarker);
    expect(content).toContain(endMarker);
    expect(content).not.toContain("Old instructions");
    expect(content).not.toContain(legacyStartMarker);
    expect(content).not.toContain(legacyEndMarker);
    expect(content).toMatch(/\n\nAfter\n$/);
    expect(content.match(new RegExp(startMarker, "g"))).toHaveLength(1);

    await run(agentsDirectory);
    expect(await readFile(`${agentsDirectory}/AGENTS.md`, "utf8")).toBe(content);
  });

  it("rejects malformed managed markers without changing the file", async () => {
    const agentsDirectory = await tempAgentsDirectory();
    const original = `# Existing\n\n${startMarker}\nIncomplete\n`;
    await mkdir(agentsDirectory);
    await writeFile(`${agentsDirectory}/AGENTS.md`, original);

    await expect(run(agentsDirectory)).rejects.toThrow("Cannot update AGENTS.md");
    await expect(readFile(`${agentsDirectory}/AGENTS.md`, "utf8")).resolves.toBe(original);
  });

  it("rejects malformed legacy managed markers without changing the file", async () => {
    const agentsDirectory = await tempAgentsDirectory();
    const original = `# Existing\n\n${legacyStartMarker}\nIncomplete\n`;
    await mkdir(agentsDirectory);
    await writeFile(`${agentsDirectory}/AGENTS.md`, original);

    await expect(run(agentsDirectory)).rejects.toThrow("Cannot update AGENTS.md");
    await expect(readFile(`${agentsDirectory}/AGENTS.md`, "utf8")).resolves.toBe(original);
  });

  it("rejects mixed new and legacy managed blocks without changing the file", async () => {
    const agentsDirectory = await tempAgentsDirectory();
    const original = `${startMarker}\nnew\n${endMarker}\n${legacyStartMarker}\nold\n${legacyEndMarker}\n`;
    await mkdir(agentsDirectory);
    await writeFile(`${agentsDirectory}/AGENTS.md`, original);

    await expect(run(agentsDirectory)).rejects.toThrow("Cannot update AGENTS.md");
    await expect(readFile(`${agentsDirectory}/AGENTS.md`, "utf8")).resolves.toBe(original);
  });

  it.each(["AGENT-RELAY", "CODEX-AGENT-RELAY", "GROK-BUILD"])(
    "rejects duplicate and misordered %s blocks without changing the file", async (prefix) => {
      const start = `<!-- ${prefix}_START -->`;
      const end = `<!-- ${prefix}_END -->`;
      const agentsDirectory = await tempAgentsDirectory();
      await mkdir(agentsDirectory);
      for (const original of [`${start}\n${end}\n${start}\n${end}\n`, `${end}\n${start}\n`, `${end}\n`]) {
        await writeFile(`${agentsDirectory}/AGENTS.md`, original);
        await expect(run(agentsDirectory)).rejects.toThrow("Cannot update AGENTS.md");
        await expect(readFile(`${agentsDirectory}/AGENTS.md`, "utf8")).resolves.toBe(original);
      }
    },
  );

  it("defaults to ~/.agents/AGENTS.md and ignores CODEX_HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-relay-home-"));
    tempDirectories.push(root);
    vi.mocked(homedir).mockReturnValue(root);
    const oldHome = join(root, "old-codex-home");
    vi.stubEnv("CODEX_HOME", oldHome);

    await installInstructions();

    const content = await readFile(join(root, ".agents", "AGENTS.md"), "utf8");
    expect(content).toContain(startMarker);
    expect(content).toContain("the calling agent performs the task itself");
    expect(content).not.toContain("Codex");
    await expect(readFile(join(oldHome, "AGENTS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs the CLI entry point against an isolated home directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-relay-cli-home-"));
    tempDirectories.push(root);
    const preload = Buffer.from(`
      import os from "node:os";
      import { syncBuiltinESMExports } from "node:module";
      os.homedir = () => process.env.AGENT_RELAY_TEST_HOME;
      syncBuiltinESMExports();
    `).toString("base64");
    await execFileAsync(process.execPath, ["--import", `data:text/javascript;base64,${preload}`, script], {
      env: { ...process.env, AGENT_RELAY_TEST_HOME: root },
    });
    expect(await readFile(join(root, ".agents", "AGENTS.md"), "utf8")).toContain(startMarker);
  });
});
