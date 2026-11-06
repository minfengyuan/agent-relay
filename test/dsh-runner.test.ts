import { readFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dshAdapter, dshSpawnSpec } from "../src/adapters/dsh.js";
import { dshPolicyPatch } from "../src/adapters/dsh-policy.js";
import { DshRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { baseConfig, dshFixture, tempDir, useRunnerCleanup, waitForLog } from "./helpers.js";

const dirs: string[] = [];
useRunnerCleanup(dirs);
vi.setConfig({ testTimeout: 15_000 });

async function transcript(name: string) {
  return JSON.parse(await readFile(join(import.meta.dirname, "fixtures/transcripts/dsh-0.2.2-rc.1", `${name}.json`), "utf8")) as {
    lines: Array<{ json: Record<string, unknown> }>;
  };
}

async function setup(options: Partial<ReturnType<typeof baseConfig>> = {}) {
  const root = await tempDir(dirs);
  const cwd = await tempDir(dirs);
  const log = join(root, "dsh.log");
  vi.stubEnv("FAKE_DSH_LOG", log);
  const config = baseConfig(root, options);
  const store = new SessionStore(root, "dsh");
  return { root, cwd, log, config, store, runner: new DshRunner(config, store) };
}

async function events(log: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe.skipIf(process.platform === "win32")("DSH headless runner", () => {
  it("replays success, persists the session, and returns final text without duplicate chunks or usage", async () => {
    const fixture = await setup();
    const progress: string[] = [];
    const result = await fixture.runner.delegate({ cwd: fixture.cwd, task: "task\n" }, undefined, (message) => { progress.push(message); });
    const trace = await transcript("credential-restore-run");
    const final = trace.lines.at(-1)!.json;
    expect(result).toMatchObject({ provider: "dsh", sessionId: "fake-session-1", text: final.text, stopReason: "end_turn" });
    expect(result.usage).toBeUndefined();
    expect(result.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "bash" }), expect.objectContaining({ status: "completed" }),
    ]));
    expect(progress.length).toBeGreaterThan(0);
    await expect(fixture.store.read("fake-session-1", fixture.cwd)).resolves.toMatchObject({ cwd: fixture.cwd });
    const traceEvents = await events(fixture.log);
    expect(traceEvents).toContainEqual({ event: "stdin", task: "task\n" });
    const spawn = traceEvents[0]!;
    const args = spawn.args as string[];
    const patches = spawn.patches as Array<{ path: string; mode: number; contents: string }>;
    expect(args).toEqual(["--profile", "headless", "--patch", patches[0]!.path,
      "--json", "--permission-mode", "workspace-write", "--approval-policy", "never", "-"]);
    expect(args).not.toContain("task\n");
    expect(spawn.permissionMode).toBe("workspace-write");
    expect(patches[0]).toMatchObject({ mode: 0o600, contents: dshPolicyPatch });
    expect(dshPolicyPatch).not.toContain("sandbox-policy");
    for (const id of ["credentials", "authorization", "deepseek-account"]) {
      expect(dshPolicyPatch).toContain(`- id: ${id}\n  disabled: false`);
    }
    await expect(stat(patches[0]!.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes confirmed IDs with policy flags repeated and preserves the namespace", async () => {
    const fixture = await setup();
    await fixture.store.writeNew("acp-bare-uuid", fixture.cwd);
    const touch = vi.spyOn(fixture.store, "touch");
    await fixture.runner.delegate({ cwd: fixture.cwd, task: "resume", sessionId: "acp-bare-uuid" });
    const args = (await events(fixture.log))[0]!.args as string[];
    expect(args.slice(-8)).toEqual(["--json", "--permission-mode", "workspace-write", "--approval-policy", "never", "--session-id", "acp-bare-uuid", "-"]);
    expect(touch).toHaveBeenCalledTimes(1);
    await expect(new SessionStore(fixture.root).read("acp-bare-uuid", fixture.cwd)).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
  });

  it("returns bounded final text and propagates truncation", async () => {
    const fixture = await setup({ textLimitBytes: 80 });
    const result = await fixture.runner.delegate({ cwd: fixture.cwd, task: "task" });
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("Both operations succeeded.")).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(80);
  });

  it("rejects a final session ID mismatch while retaining the confirmed session", async () => {
    const fixture = await setup();
    vi.stubEnv("FAKE_DSH_MISMATCH", "1");
    await expect(fixture.runner.delegate({ cwd: fixture.cwd, task: "task" })).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH", partial: { sessionId: "fake-session-1" },
    });
    await expect(fixture.store.read("fake-session-1", fixture.cwd)).resolves.toMatchObject({ cwd: fixture.cwd });
    await expect(fixture.store.read("wrong-id", fixture.cwd)).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
  });

  it.each([
    ["resume-unknown", "UNKNOWN_SESSION"],
    ["resume-session-other-cwd", "CWD_MISMATCH"],
    ["missing-credential", "AUTH_UNAVAILABLE"],
    ["bad-model", "ACP_FAILURE"],
    ["resume-acp-session", "AUTH_UNAVAILABLE"],
    ["resume-headless-session", "AUTH_UNAVAILABLE"],
  ])("maps transcript %s to %s", async (name, code) => {
    const fixture = await setup();
    vi.stubEnv("FAKE_DSH_TRANSCRIPT", name);
    await expect(fixture.runner.delegate({ cwd: fixture.cwd, task: "task" })).rejects.toMatchObject({ code });
  });

  it("includes DSH's INVALID_REQUEST code for a bad model without local model validation", async () => {
    const fixture = await setup();
    vi.stubEnv("FAKE_DSH_TRANSCRIPT", "bad-model");
    await expect(fixture.runner.delegate({ cwd: fixture.cwd, task: "task", model: "no-such-model-xyz" }))
      .rejects.toMatchObject({ code: "ACP_FAILURE", message: expect.stringContaining("INVALID_REQUEST") });
  });

  it("returns PERMISSION_REQUIRED after sandbox denial even though final says completed", async () => {
    const fixture = await setup();
    vi.stubEnv("FAKE_DSH_TRANSCRIPT", "sandbox-deny");
    await expect(fixture.runner.delegate({ cwd: fixture.cwd, task: "task" })).rejects.toMatchObject({
      code: "PERMISSION_REQUIRED",
      partial: {
        text: expect.stringContaining("The write was denied"),
        toolCalls: expect.arrayContaining([expect.objectContaining({ status: "failed" })]),
      },
    });
    const adapter = dshAdapter(fixture.config);
    const denial = (await transcript("sandbox-deny")).lines.find((line) => line.json.type === "tool_result")!.json;
    expect(adapter.decode({ ...denial, error: { code: "AUTO_REVIEW_DENIED" } })).toMatchObject({ type: "permissionDenied" });
    expect(adapter.decode({ ...denial, error: { code: "OTHER_ERROR" } })).toMatchObject({ type: "permissionDenied" });
    expect(adapter.decode({ ...denial, result: "Error: no such file", error: { code: "OTHER_ERROR" } }))
      .toMatchObject({ type: "toolResult", status: "failed" });
  });

  it("returns PERMISSION_REQUIRED when a shell command is denied inside a completed tool result", async () => {
    const fixture = await setup();
    vi.stubEnv("FAKE_DSH_TRANSCRIPT", "shell-sandbox-deny");
    await expect(fixture.runner.delegate({ cwd: fixture.cwd, task: "task" })).rejects.toMatchObject({
      code: "PERMISSION_REQUIRED",
      partial: { text: expect.stringContaining("blocked by the file sandbox") },
    });
    const adapter = dshAdapter(fixture.config);
    const denial = (await transcript("shell-sandbox-deny")).lines.find((line) => line.json.type === "tool_result")!.json;
    expect(adapter.decode(denial)).toMatchObject({ type: "permissionDenied" });
    expect(adapter.decode({ ...denial, result: "[exit code: 1]" })).toMatchObject({ type: "toolResult", status: "completed" });
  });

  it("cancels with root SIGTERM and does not mistake exit 0 without final for success", async () => {
    const fixture = await setup();
    vi.stubEnv("FAKE_DSH_TRANSCRIPT", "sigterm-tool");
    const controller = new AbortController();
    const task = fixture.runner.delegate({ cwd: fixture.cwd, task: "wait" }, controller.signal);
    const outcome = task.catch((error: unknown) => error);
    await waitForLog(fixture.log, "prompt:fake-session-1");
    controller.abort();
    expect(await outcome).toMatchObject({ code: "CANCELLED" });
    expect(await readFile(fixture.log, "utf8")).toContain("cancel:fake-session-1");
    vi.stubEnv("FAKE_DSH_REPLAY_CANCEL", "1");
    vi.stubEnv("FAKE_SESSION_ID", "fake-session-2");
    await expect(fixture.runner.delegate({ cwd: fixture.cwd, task: "check exit" }))
      .rejects.toMatchObject({ code: "ACP_FAILURE" });
  });

  it("removes an empty key from helper and worker environments without changing the parent", async () => {
    const fixture = await setup();
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    await fixture.runner.delegate({ cwd: fixture.cwd, task: "task", model: "deepseek-flash" });
    const spawns = (await events(fixture.log)).filter((event) => event.event === "spawn");
    expect(spawns).toHaveLength(2);
    expect(spawns.every((event) => event.keyPresent === false && event.emptyKeyPresent === false)).toBe(true);
    expect(process.env.DEEPSEEK_API_KEY).toBe("");
  });

  it("preserves a nonempty key without inspecting or logging its value", async () => {
    const fixture = await setup();
    vi.stubEnv("DEEPSEEK_API_KEY", "fake-test-key");
    await fixture.runner.delegate({ cwd: fixture.cwd, task: "task" });
    expect((await events(fixture.log))[0]!.keyPresent).toBe(true);
    expect(await readFile(fixture.log, "utf8")).not.toContain("fake-test-key");
  });

  it("runs dump-config only for requested options and writes an ordered private model patch", async () => {
    const fixture = await setup();
    await fixture.runner.delegate({ cwd: fixture.cwd, task: "task", model: "deepseek-flash", reasoningEffort: "high" });
    const spawns = (await events(fixture.log)).filter((event) => event.event === "spawn");
    expect(spawns).toHaveLength(2);
    const patches = spawns[1]!.patches as Array<{ path: string; mode: number; contents: string }>;
    expect(spawns[0]!.args).toEqual(["--profile", "headless", "--patch", patches[0]!.path, "--dump-config"]);
    expect(JSON.parse(patches[1]!.contents)).toEqual([{
      id: "agent-default-model", config: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" },
    }]);
    expect(patches[1]!.mode).toBe(0o600);
    const args = spawns[1]!.args as string[];
    expect(args.indexOf(patches[1]!.path)).toBeLessThan(args.indexOf("--json"));
  });

  it("omits empty reasoningEffort from the patch", async () => {
    const fixture = await setup();
    await fixture.runner.delegate({ cwd: fixture.cwd, task: "task", reasoningEffort: "" });
    const spawns = (await events(fixture.log)).filter((event) => event.event === "spawn");
    const patches = spawns[1]!.patches as Array<{ contents: string }>;
    expect(JSON.parse(patches[1]!.contents)[0].config).toEqual({ provider: "deepseek-official" });
  });

  it.each([["invalid", "INVALID_CONFIG"], ["exit", "ACP_FAILURE"], ["hang", "CONFIG_TIMEOUT"]])(
    "fails closed for dump-config %s", async (mode, code) => {
      const fixture = await setup({ phaseTimeoutMs: 300 });
      vi.stubEnv("FAKE_DSH_DUMP", mode);
      await expect(fixture.runner.delegate({ cwd: fixture.cwd, task: "task", model: "model" }))
        .rejects.toMatchObject({ code });
      expect((await events(fixture.log)).filter((event) => event.event === "spawn")).toHaveLength(1);
      const lease = await fixture.store.acquire(fixture.cwd);
      await lease.markReaped("no-worker-created");
      await lease.release();
    },
  );

  it("holds the workspace lease throughout preflight", async () => {
    const fixture = await setup({ phaseTimeoutMs: 500 });
    vi.stubEnv("FAKE_DSH_DUMP", "hang");
    const task = fixture.runner.delegate({ cwd: fixture.cwd, task: "task", model: "model" });
    const outcome = task.catch((error: unknown) => error);
    await waitForLog(fixture.log, "--dump-config");
    await expect(new SessionStore(fixture.root).acquire(fixture.cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(await outcome).toMatchObject({ code: "CONFIG_TIMEOUT" });
  });

  it("uses canonical cwd for direct runner calls", async () => {
    const fixture = await setup();
    const alias = join(fixture.root, "workspace-link");
    await symlink(fixture.cwd, alias);
    await fixture.runner.delegate({ cwd: alias, task: "task" });
    expect((await events(fixture.log))[0]!.cwd).toBe(fixture.cwd);
  });

  it("reports no-events startup failure with the bounded stderr tail", async () => {
    const fixture = await setup();
    vi.stubEnv("FAKE_DSH_NO_EVENTS", "1");
    await expect(fixture.runner.delegate({ cwd: fixture.cwd, task: "task" }))
      .rejects.toMatchObject({ code: "ACP_FAILURE", message: expect.stringContaining("DSH stderr:") });
  });

  it("uses headless defaults without changing explicit launcher arguments", () => {
    const { dshCommandArgs: _dshCommandArgs, ...config } = baseConfig("state", { dshCommand: "dsh" });
    void _dshCommandArgs;
    expect(dshSpawnSpec(config)).toEqual({
      command: "dsh", args: ["--profile", "headless"],
    });
    expect(dshSpawnSpec(baseConfig("state"))).toEqual({ command: process.execPath, args: [dshFixture] });
  });
});
