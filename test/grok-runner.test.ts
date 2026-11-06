import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { grokAdapter, GrokRunner } from "../src/adapters/grok.js";
import { loadConfig } from "../src/config.js";
import type * as ProcessTree from "../src/runner/process-tree.js";
import { SessionStore } from "../src/store.js";
import { baseConfig, grokHeadlessFixture, tempDir, useRunnerCleanup, waitForLog } from "./helpers.js";

const observed = vi.hoisted(() => ({ beforeTermination: () => {} }));
vi.mock("../src/runner/process-tree.js", async (load) => {
  const actual = await load<typeof ProcessTree>();
  return {
    ...actual,
    createProcessTreeController: (...args: Parameters<typeof actual.createProcessTreeController>) => {
      const controller = actual.createProcessTreeController(...args);
      return { reference: controller.reference, terminate: () => {
        observed.beforeTermination();
        return controller.terminate();
      } };
    },
  };
});

const dirs: string[] = [];
useRunnerCleanup(dirs);

async function setup(overrides: Parameters<typeof baseConfig>[1] = {}) {
  const root = await tempDir(dirs);
  const cwd = await tempDir(dirs);
  const log = join(root, "grok.log");
  vi.stubEnv("FAKE_GROK_LOG", log);
  observed.beforeTermination = () => {};
  const config = baseConfig(root, {
    commandArgs: [grokHeadlessFixture, ...loadConfig({}).commandArgs], ...overrides,
  });
  const store = new SessionStore(root);
  return { root, cwd, log, config, store, runner: new GrokRunner(config, store) };
}

async function spawnEvent(log: string) {
  return JSON.parse((await readFile(log, "utf8")).split("\n")[0]!) as {
    args: string[]; id: string; mode: number; prompt: string; delegated: string;
  };
}

describe.skipIf(process.platform === "win32")("Grok headless runner", () => {
  it("replays success with private prompt, exact safety flags, UUID persistence, and no extra result fields", async () => {
    const fixture = await setup();
    const progress: string[] = [];
    const result = await fixture.runner.delegate({ task: "private task\n", cwd: fixture.cwd },
      undefined, (message) => { progress.push(message); });
    const spawn = await spawnEvent(fixture.log);
    expect(spawn.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(spawn).toMatchObject({ prompt: "private task\n", mode: 0o600, delegated: "1" });
    const prompt = spawn.args.at(-1)!;
    expect(spawn.args).toEqual([...loadConfig({}).commandArgs,
      "--cwd", fixture.cwd, "-s", spawn.id, "--prompt-file", prompt]);
    expect(spawn.args).not.toContain("private task\n");
    expect(spawn.args).not.toContain("--no-leader");
    const transcript = JSON.parse(await readFile(join(import.meta.dirname,
      "fixtures/transcripts/grok-1.0.77/new-session-success.json"), "utf8")) as {
      lines: Array<{ json: { type: string; data?: string } }>;
    };
    expect(result).toEqual({
      sessionId: spawn.id, stopReason: "end_turn",
      text: transcript.lines.filter((line) => line.json.type === "text").map((line) => line.json.data).join(""),
      truncated: false,
    });
    expect(progress).toContain("read_file");
    await expect(fixture.store.read(spawn.id, fixture.cwd)).resolves.toMatchObject({ cwd: fixture.cwd });
    await expect(stat(prompt)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["resume-success", "resume-acp-session"])("resumes %s UUIDs in the root namespace and touches the record", async (scenario) => {
    const fixture = await setup();
    const id = randomUUID();
    await fixture.store.writeNew(id, fixture.cwd);
    vi.stubEnv("FAKE_GROK_TRANSCRIPT", scenario);
    const touch = vi.spyOn(fixture.store, "touch");
    const result = await fixture.runner.delegate({ task: "continue", cwd: fixture.cwd, sessionId: id });
    expect(result.sessionId).toBe(id);
    expect((await spawnEvent(fixture.log)).args).toContain("-r");
    expect((await spawnEvent(fixture.log)).args).not.toContain("-s");
    expect(touch).toHaveBeenCalledTimes(1);
    await expect(new SessionStore(fixture.root, "grok").read(id, fixture.cwd))
      .rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
  });

  it("rejects a recorded title before spawn to avoid title-based resume", async () => {
    const fixture = await setup();
    await fixture.store.writeNew("a title", fixture.cwd);
    await expect(fixture.runner.delegate({ task: "continue", cwd: fixture.cwd, sessionId: "a title" }))
      .rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
    await expect(stat(fixture.log)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps unknown provider sessions without creating replacements", async () => {
    const fixture = await setup();
    const id = randomUUID();
    await fixture.store.writeNew(id, fixture.cwd);
    vi.stubEnv("FAKE_GROK_TRANSCRIPT", "resume-unknown");
    await expect(fixture.runner.delegate({ task: "continue", cwd: fixture.cwd, sessionId: id }))
      .rejects.toMatchObject({ code: "UNKNOWN_SESSION", partial: { sessionId: id } });
    expect((await spawnEvent(fixture.log)).args).not.toContain("-s");
  });

  it("maps unauthenticated error events and persists the preset ID at the first event", async () => {
    const fixture = await setup();
    vi.stubEnv("FAKE_GROK_TRANSCRIPT", "not-signed-in");
    await expect(fixture.runner.delegate({ task: "auth", cwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "AUTH_UNAVAILABLE", partial: { sessionId: expect.any(String) } });
    const spawn = await spawnEvent(fixture.log);
    await expect(fixture.store.read(spawn.id, fixture.cwd)).resolves.toMatchObject({ sessionId: spawn.id });
  });

  it.each(["nonzero", "missing-end", "error-after-end"])("fails on %s with useful partial text", async (mode) => {
    const fixture = await setup();
    vi.stubEnv(mode === "nonzero" ? "FAKE_GROK_EXIT" : mode === "missing-end" ? "FAKE_GROK_NO_END" : "FAKE_GROK_ERROR", "1");
    await expect(fixture.runner.delegate({ task: "fail", cwd: fixture.cwd }))
      .rejects.toMatchObject({
        code: mode === "error-after-end" ? "AUTH_UNAVAILABLE" : "ACP_FAILURE",
        partial: { text: expect.stringContaining("hello-spike") },
      });
  });

  it("bounds accumulated text, ignores thoughts/usage, and normalizes EndTurn", async () => {
    const fixture = await setup({ textLimitBytes: 5 });
    vi.stubEnv("FAKE_GROK_END_TURN", "1");
    const result = await fixture.runner.delegate({ task: "short", cwd: fixture.cwd });
    expect(result).toEqual({
      sessionId: expect.any(String), stopReason: "end_turn", text: "I'll ", truncated: true,
    });
  });

  it("rejects an inconsistent end session ID while preserving the confirmed preset", async () => {
    const fixture = await setup();
    vi.stubEnv("FAKE_GROK_MISMATCH", "1");
    await expect(fixture.runner.delegate({ task: "mismatch", cwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "PROTOCOL_MISMATCH", partial: { sessionId: expect.any(String) } });
    const spawn = await spawnEvent(fixture.log);
    await expect(fixture.store.read(spawn.id, fixture.cwd)).resolves.toBeDefined();
  });

  it("detects stderr permission diagnostics even with successful end and exit 0", async () => {
    const fixture = await setup();
    vi.stubEnv("FAKE_GROK_PERMISSION", "1");
    await expect(fixture.runner.delegate({ task: "permission", cwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "UNEXPECTED_PERMISSION", partial: { text: expect.stringContaining("hello-spike") } });
  });

  it.each(["cancel", "timeout"])("preserves %s and waits for daemon exit after end before tree termination", async (mode) => {
    const fixture = await setup({ totalTimeoutMs: mode === "timeout" ? 600 : 15_000 });
    vi.stubEnv("FAKE_GROK_TRANSCRIPT", "sigterm-during-tool");
    let gracefulExitBeforeTree = false;
    observed.beforeTermination = () => {
      gracefulExitBeforeTree = readFileSync(fixture.log, "utf8").includes("graceful-exit");
    };
    const controller = new AbortController();
    const pending = fixture.runner.delegate({ task: "wait", cwd: fixture.cwd }, controller.signal);
    const outcome = pending.catch((error: unknown) => error);
    await waitForLog(fixture.log, "waiting");
    const spawn = await spawnEvent(fixture.log);
    await vi.waitFor(async () => expect(await fixture.store.read(spawn.id, fixture.cwd)).toBeDefined());
    if (mode === "cancel") controller.abort();
    expect(await outcome).toMatchObject({ code: mode === "cancel" ? "CANCELLED" : "TIMEOUT" });
    expect(gracefulExitBeforeTree).toBe(true);
    expect((await readFile(fixture.log, "utf8")).match(/root-sigterm/g)).toHaveLength(1);
    expect(grokAdapter(fixture.config).gracefulStop.graceMs).toBeGreaterThanOrEqual(12_000);
    const lease = await fixture.store.acquire(fixture.cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("treats an unsolicited cancelled end and exit 143 as cancellation", async () => {
    const fixture = await setup();
    vi.stubEnv("FAKE_GROK_TRANSCRIPT", "sigterm-during-tool");
    vi.stubEnv("FAKE_GROK_REPLAY_CANCEL", "1");
    await expect(fixture.runner.delegate({ task: "cancelled", cwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "CANCELLED" });
  });
});
