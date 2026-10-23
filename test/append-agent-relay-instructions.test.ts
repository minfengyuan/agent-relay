import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const scriptUrl = new URL("../scripts/append-agent-relay-instructions.mjs", import.meta.url);
const script = fileURLToPath(scriptUrl);
const execFileAsync = promisify(execFile);
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
  return runCli(dirname(agentsDirectory), ["--clients", "codex"], { env: { CODEX_HOME: agentsDirectory } });
}

async function runCli(root: string, args: string[] = [], options: {
  env?: NodeJS.ProcessEnv; input?: string; interactive?: boolean; failWrite?: string;
} = {}) {
  const preload = Buffer.from(`
    import os from "node:os";
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    os.homedir = () => process.env.AGENT_RELAY_TEST_HOME;
    if (process.env.AGENT_RELAY_TEST_TTY === "1") {
      Object.defineProperty(process.stdin, "isTTY", { value: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true });
    }
    if (process.env.AGENT_RELAY_TEST_FAIL_WRITE) {
      const originalWrite = fs.writeFile;
      fs.writeFile = (path, ...args) => {
        if (path === process.env.AGENT_RELAY_TEST_FAIL_WRITE) throw new Error("simulated write failure");
        return originalWrite(path, ...args);
      };
    }
    syncBuiltinESMExports();
  `).toString("base64");
  const result = execFileAsync(process.execPath, ["--import", `data:text/javascript;base64,${preload}`, script, ...args], {
    env: { ...process.env, PATH: "", Path: "", CODEX_HOME: "", GROK_HOME: "", DSH_HOME: "", DSH_AGENTS_HOME: "",
      XDG_CONFIG_HOME: "", OPENCODE_CONFIG_DIR: "", OPENCODE_DISABLE_CLAUDE_CODE: "", OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "",
      ...options.env, AGENT_RELAY_TEST_HOME: root, AGENT_RELAY_TEST_TTY: options.interactive ? "1" : "0",
      AGENT_RELAY_TEST_FAIL_WRITE: options.failWrite ?? "" },
    timeout: 10000,
  });
  result.child.stdin?.end(options.input ?? "");
  return result;
}

async function tempHome() {
  const root = await mkdtemp(join(tmpdir(), "agent-relay-home-"));
  tempDirectories.push(root);
  return root;
}

async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

describe("append-agent-relay-instructions", () => {
  afterEach(async () => {
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
    expect(first).toContain("`codex_delegate`");
    expect(first).toContain("INTERACTION_REQUIRED");
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

    await expect(run(agentsDirectory)).rejects.toThrow("Cannot update");
    await expect(readFile(`${agentsDirectory}/AGENTS.md`, "utf8")).resolves.toBe(original);
  });

  it("rejects malformed legacy managed markers without changing the file", async () => {
    const agentsDirectory = await tempAgentsDirectory();
    const original = `# Existing\n\n${legacyStartMarker}\nIncomplete\n`;
    await mkdir(agentsDirectory);
    await writeFile(`${agentsDirectory}/AGENTS.md`, original);

    await expect(run(agentsDirectory)).rejects.toThrow("Cannot update");
    await expect(readFile(`${agentsDirectory}/AGENTS.md`, "utf8")).resolves.toBe(original);
  });

  it("rejects mixed new and legacy managed blocks without changing the file", async () => {
    const agentsDirectory = await tempAgentsDirectory();
    const original = `${startMarker}\nnew\n${endMarker}\n${legacyStartMarker}\nold\n${legacyEndMarker}\n`;
    await mkdir(agentsDirectory);
    await writeFile(`${agentsDirectory}/AGENTS.md`, original);

    await expect(run(agentsDirectory)).rejects.toThrow("Cannot update");
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
        await expect(run(agentsDirectory)).rejects.toThrow("Cannot update");
        await expect(readFile(`${agentsDirectory}/AGENTS.md`, "utf8")).resolves.toBe(original);
      }
    },
  );

  it("installs all five clients into native locations and remains idempotent", async () => {
    const root = await tempHome();
    const project = join(root, "project with spaces");
    await mkdir(project);
    const args = ["--clients", "codex,cursor,opencode,grok,dsh", "--project", project];
    const first = await runCli(root, args);
    const paths = [join(root, ".codex", "AGENTS.md"), join(project, ".cursor", "rules", "agent-relay.mdc"),
      join(root, ".config", "opencode", "AGENTS.md"), join(root, ".grok", "AGENTS.md"), join(root, ".dsh", "AGENTS.md")];
    const contents = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    for (const content of contents) {
      expect(content).toContain(startMarker);
      expect(content).toContain("the calling agent performs the task itself");
    }
    expect(contents[1]).toMatch(/^---\nalwaysApply: true\n---\n/);
    const cursorContent = contents[1] ?? "";
    expect(cursorContent.slice(cursorContent.indexOf(startMarker))).toBe(contents[0]);
    expect(first.stdout).toContain("cursor: create (project)");
    expect(first.stdout).toContain("codex: create (global)");
    expect(first.stderr).toBe("");
    const second = await runCli(root, args);
    expect(second.stdout.match(/: unchanged /g)).toHaveLength(5);
    expect(await Promise.all(paths.map((path) => readFile(path, "utf8")))).toEqual(contents);
    await expect(readFile(join(root, ".agents", "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors CODEX_HOME, DSH_HOME, GROK_HOME and XDG_CONFIG_HOME with tilde expansion", async () => {
    const root = await tempHome();
    await runCli(root, ["--clients", "codex,opencode,grok,dsh"], { env: {
      CODEX_HOME: "~/custom codex", GROK_HOME: "~/custom grok", DSH_HOME: join(root, "custom dsh"), XDG_CONFIG_HOME: join(root, "config") } });
    for (const path of [join(root, "custom codex", "AGENTS.md"), join(root, "custom grok", "AGENTS.md"), join(root, "custom dsh", "AGENTS.md"),
      join(root, "config", "opencode", "AGENTS.md")]) expect(await readFile(path, "utf8")).toContain(startMarker);
    await expect(readFile(join(root, ".codex", "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs and detects OpenCode in OPENCODE_CONFIG_DIR before XDG_CONFIG_HOME", async () => {
    const root = await tempHome();
    const custom = join(root, "opencode profile");
    const xdg = join(root, "xdg");
    await mkdir(custom);
    const result = await runCli(root, ["--clients", "opencode"], {
      env: { OPENCODE_CONFIG_DIR: custom, XDG_CONFIG_HOME: xdg } });
    expect(result.stdout).toContain(`OpenCode: directory: ${custom}`);
    expect(await readFile(join(custom, "AGENTS.md"), "utf8")).toContain(startMarker);
    await expect(readFile(join(xdg, "opencode", "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["", "  ", "# Override\n"])("respects the first non-empty Codex global file (%j)", async (override) => {
    const root = await tempHome();
    const normalPath = join(root, ".codex", "AGENTS.md");
    const overridePath = join(root, ".codex", "AGENTS.override.md");
    await put(normalPath, "# Normal\n");
    await put(overridePath, override);
    await runCli(root, ["--clients", "codex"]);
    expect(await readFile(override.trim() ? overridePath : normalPath, "utf8")).toContain(startMarker);
    expect(await readFile(override.trim() ? normalPath : overridePath, "utf8")).toBe(override.trim() ? "# Normal\n" : override);
  });

  it("detects fake PATH commands and existing custom directories without invoking clients", async () => {
    const root = await tempHome();
    const bin = join(root, "bin");
    const command = join(bin, process.platform === "win32" ? "grok.cmd" : "grok");
    await put(command, "this must never execute");
    await chmod(command, 0o755);
    await mkdir(join(root, "custom codex"));
    const result = await runCli(root, ["--clients", "dsh", "--dry-run"], {
      env: { PATH: bin, CODEX_HOME: join(root, "custom codex") } });
    if (process.platform === "win32") {
      expect(result.stdout.toLowerCase()).toContain(`Grok: command: ${command}`.toLowerCase());
    } else {
      expect(result.stdout).toContain(`Grok: command: ${command}`);
    }
    expect(result.stdout).toContain(`Codex: directory: ${join(root, "custom codex")}`);
    expect(result.stdout).toContain("Cursor: not detected");
    expect(result.stdout).toContain("DSH: not detected");
  });

  it.each([false, true])("does not block DSH when an unselected Codex home is a file (interactive: %s)", async (interactive) => {
    const root = await tempHome();
    const invalidHome = join(root, "not a directory");
    await writeFile(invalidHome, "untouched");
    const result = await runCli(root, interactive ? [] : ["--clients", "dsh"], {
      env: { CODEX_HOME: invalidHome }, interactive, input: "5\n" });
    expect(result.stdout).toContain("Codex: not detected");
    expect(result.stdout).toContain("dsh: create");
    expect(await readFile(join(root, ".dsh", "AGENTS.md"), "utf8")).toContain(startMarker);
    expect(await readFile(invalidHome, "utf8")).toBe("untouched");
  });

  it("does not misidentify a generic agent command as Cursor", async () => {
    const root = await tempHome();
    const bin = join(root, "bin");
    const command = join(bin, process.platform === "win32" ? "agent.cmd" : "agent");
    await put(command, "never execute");
    await chmod(command, 0o755);
    const result = await runCli(root, ["--clients", "grok", "--dry-run"], { env: { PATH: bin } });
    expect(result.stdout).toContain("Cursor: not detected");
  });

  it("previews without creating directories, then reports an existing rule as unchanged", async () => {
    const root = await tempHome();
    const args = ["--clients", "codex,dsh"];
    const preview = await runCli(root, [...args, "--dry-run"]);
    expect(preview.stdout).toContain("[dry-run] codex: create");
    expect(preview.stdout).toContain("[dry-run] dsh: create");
    await expect(readFile(join(root, ".codex", "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, ".dsh", "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await runCli(root, args);
    expect((await runCli(root, [...args, "--dry-run"])).stdout).toContain("[dry-run] codex: unchanged");
  });

  it("previews an update without changing the existing file", async () => {
    const root = await tempHome();
    const path = join(root, ".codex", "AGENTS.md");
    const original = `Before\n${startMarker}\nOld\n${endMarker}\nAfter\n`;
    await put(path, original);
    const result = await runCli(root, ["--clients", "codex", "--dry-run"]);
    expect(result.stdout).toContain("[dry-run] codex: update");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it.each([
    [[], "Non-interactive input requires --clients"],
    [["--clients", "unknown"], "Unknown or empty client"],
    [["--clients", "codex,"], "Unknown or empty client"],
    [["--clients"], "Missing value"],
    [["--project"], "Missing value"],
    [["--unknown"], "Unknown argument"],
    [["--clients", "codex,cursor"], "Cursor requires --project"],
    [["--clients", "codex,cursor", "--project", "/nonexistent-agent-relay-project"], "Cursor requires --project"],
  ])("rejects invalid/non-interactive arguments %j before writing", async (args, message) => {
    const root = await tempHome();
    await expect(runCli(root, args)).rejects.toThrow(message);
    await expect(readFile(join(root, ".codex", "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preflights every target before writing any files", async () => {
    const root = await tempHome();
    const malformed = `${startMarker}\nbroken`;
    const path = join(root, ".dsh", "AGENTS.md");
    await put(path, malformed);
    await expect(runCli(root, ["--clients", "codex,dsh"])).rejects.toThrow("Cannot update");
    await expect(readFile(join(root, ".codex", "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path, "utf8")).toBe(malformed);
  });

  it.each(["", "---\nalwaysApply: false\n---\nMy rule\n"])("refuses to overwrite an unmanaged Cursor rule (%j)", async (original) => {
    const root = await tempHome();
    const path = join(root, ".cursor", "rules", "agent-relay.mdc");
    await put(path, original);
    await expect(runCli(root, ["--clients", "codex,cursor", "--project", root])).rejects.toThrow("no relay managed block");
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(readFile(join(root, ".codex", "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs managed Cursor activation while preserving other fields and content", async () => {
    const root = await tempHome();
    const path = join(root, ".cursor", "rules", "agent-relay.mdc");
    await put(path, `---\ndescription: My rule\nalwaysApply: false\n---\nBefore\n${startMarker}\nOld\n${endMarker}\nAfter\n`);
    await runCli(root, ["--clients", "cursor", "--project", root]);
    const content = await readFile(path, "utf8");
    expect(content).toContain("description: My rule\nalwaysApply: true");
    expect(content).toContain("Before\n");
    expect(content).toMatch(/After\n$/);
    expect(content).not.toContain("Old");
  });

  it("warns about historical shared guidance and OpenCode fallback shadowing without modifying them", async () => {
    const root = await tempHome();
    const shared = join(root, ".agents", "AGENTS.md");
    const fallback = join(root, ".claude", "CLAUDE.md");
    const original = `${startMarker}\nold\n${endMarker}\n`;
    await put(shared, original);
    await put(fallback, "My global preferences");
    const result = await runCli(root, ["--clients", "opencode"]);
    expect(result.stdout).toContain(`Historical relay guidance remains in ${shared}`);
    expect(result.stdout).toContain(`takes precedence over OpenCode's ${fallback} fallback`);
    expect(await readFile(shared, "utf8")).toBe(original);
    expect(await readFile(fallback, "utf8")).toBe("My global preferences");
  });

  it("reports partial write failures, continues other clients, and exits nonzero", async () => {
    const root = await tempHome();
    const failed = join(root, ".codex", "AGENTS.md");
    await expect(runCli(root, ["--clients", "codex,dsh"], { failWrite: failed })).rejects.toMatchObject({
      code: 1, stdout: expect.stringContaining("codex: failed (global)") });
    expect(await readFile(join(root, ".dsh", "AGENTS.md"), "utf8")).toContain(startMarker);
    await expect(readFile(failed)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("interactively selects all detected clients by default", async () => {
    const root = await tempHome();
    await mkdir(join(root, ".codex"));
    await mkdir(join(root, ".dsh"));
    const result = await runCli(root, [], { interactive: true, input: "\n" });
    expect(result.stdout).toContain("codex: create");
    expect(result.stdout).toContain("dsh: create");
    await expect(readFile(join(root, ".grok", "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("interactively installs selected undetected clients and asks for Cursor's project", async () => {
    const root = await tempHome();
    const result = await runCli(root, [], { interactive: true, input: `0\n1,2\n${root}\n` });
    expect(result.stdout).toContain("Choose client numbers");
    expect(result.stdout).toContain("Cursor project directory");
    expect(await readFile(join(root, ".codex", "AGENTS.md"), "utf8")).toContain(startMarker);
    expect(await readFile(join(root, ".cursor", "rules", "agent-relay.mdc"), "utf8")).toContain("alwaysApply: true");
  });

  it.each(["q\n", "", "2\nq\n", "\n", "\u0003"])("cancels or selects nothing without writing (%j)", async (input) => {
    const root = await tempHome();
    const result = await runCli(root, [], { interactive: true, input });
    expect(result.stdout).toContain("nothing was written");
    await expect(readFile(join(root, ".codex", "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, ".cursor", "rules", "agent-relay.mdc"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints help without writing", async () => {
    const root = await tempHome();
    const result = await runCli(root, ["--help"]);
    expect(result.stdout).toContain("Usage: pnpm setup:instructions");
    expect(result.stdout).toContain("--dry-run");
  });
});
