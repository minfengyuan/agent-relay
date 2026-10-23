import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexRunner, GrokRunner, cleanupAllChildren } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { RelayFailure } from "../src/types.js";
import { probeProcess } from "../src/runner/process-tree.js";
import { baseConfig, tempDir, useRunnerCleanup, waitForLog } from "./helpers.js";

const dirs: string[] = [];
useRunnerCleanup(dirs);
async function setup() {
  const state = await tempDir(dirs), cwd = await tempDir(dirs);
  const log = join(state, "codex.log");
  vi.stubEnv("CODEX_FIXTURE_LOG", log);
  const config = baseConfig(state);
  const store = new SessionStore(state, "codex");
  const runner = new CodexRunner(config, store);
  const events = async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const unlocked = async () => {
    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created"); await lease.release();
  };
  return { state, cwd, log, config, store, runner, events, unlocked };
}

describe("CodexRunner", () => {
  it("creates and resumes native threads, applies sandbox overrides, and deduplicates bounded summaries", async () => {
    const { cwd, config, store, runner, events, unlocked } = await setup();
    const progress = vi.fn();
    const first = await runner.delegate({ task: "early", cwd, model: "model-a", reasoningEffort: "high" }, undefined, progress);
    expect(first).toMatchObject({ provider: "codex", stopReason: "completed", text: "hello 世界", truncated: false,
      toolCalls: [{ toolCallId: "tool-1", status: "completed" }], usage: { total: { totalTokens: 30 }, last: { inputTokens: 20 }, modelContextWindow: 100_000 } });
    expect(first.sessionId).toMatch(/^codex-thread-/);
    expect(progress).toHaveBeenCalled();
    const second = await new CodexRunner(config, store).delegate({ task: "hello", cwd, sessionId: first.sessionId! });
    expect(second.sessionId).toBe(first.sessionId);
    const all = await events();
    expect(all.filter((event) => event.startup).every((event) => event.delegated === "1")).toBe(true);
    expect(all.filter((event) => event.method === "thread/start")).toHaveLength(1);
    expect(all.find((event) => event.method === "thread/start").params).toMatchObject({ cwd, model: "model-a", sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user", ephemeral: false });
    expect(all.find((event) => event.method === "thread/resume").params).toMatchObject({ threadId: first.sessionId, excludeTurns: true, cwd, approvalsReviewer: "user" });
    const starts = all.filter((event) => event.method === "turn/start").map((event) => event.params);
    expect(starts[0]).toMatchObject({ model: "model-a", effort: "high", sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeSlashTmp: false, excludeTmpdirEnvVar: false } });
    expect(starts[1]).not.toHaveProperty("model"); expect(starts[1]).not.toHaveProperty("effort");
    await unlocked();
  });

  it.each(["permission", "file-permission", "extra-permission", "legacy-permission", "question", "elicitation", "unsupported", "refresh"])("refuses %s before interrupting and preserves partial output", async (task) => {
    const { runner, cwd, events, unlocked } = await setup();
    const code = ["question", "elicitation"].includes(task) ? "INTERACTION_REQUIRED"
      : task === "unsupported" ? "PROTOCOL_MISMATCH" : task === "refresh" ? "AUTH_UNAVAILABLE" : "PERMISSION_REQUIRED";
    await expect(runner.delegate({ task, cwd })).rejects.toMatchObject({ code, partial: { provider: "codex", text: "hello ", sessionId: expect.any(String) } });
    const all = await events();
    const response = all.findIndex((event) => event.id === "permission-1");
    expect(response).toBeGreaterThan(-1);
    expect(all.findIndex((event) => event.method === "turn/interrupt")).toBeGreaterThan(response);
    if (task === "permission" || task === "file-permission") expect(all[response].result).toEqual({ decision: "decline" });
    if (task === "extra-permission") expect(all[response].result).toEqual({ permissions: {}, scope: "turn" });
    await unlocked();
  });

  it.each(["failed", "interrupted", "malformed", "oversized"])("fails on %s and releases its lock", async (task) => {
    const { runner, cwd, unlocked } = await setup();
    await expect(runner.delegate({ task, cwd })).rejects.toMatchObject({ code: task === "failed" ? "CODEX_FAILURE" : task === "interrupted" ? "CANCELLED" : "PROTOCOL_MISMATCH", partial: { text: ["failed", "interrupted"].includes(task) ? "hello 世界" : "hello " } });
    await unlocked();
  });

  it("caps Unicode text and tool summaries independently", async () => {
    const { cwd, config, store } = await setup();
    const result = await new CodexRunner({ ...config, textLimitBytes: 10 }, store).delegate({ task: "large", cwd });
    expect(result.text).toBe("hello 猫");
    expect(result.truncated).toBe(true); expect(result.summariesTruncated).toBe(true);
    expect(JSON.stringify(result.toolCalls).length).toBeLessThan(66_000);
  });

  it("cleans up descendants after a completed turn", async () => {
    const { runner, cwd, events, unlocked } = await setup();
    await runner.delegate({ task: "descendant", cwd });
    const pid = (await events()).find((event) => event.descendantPid)?.descendantPid as number;
    expect(pid).toBeTypeOf("number");
    expect(probeProcess(pid)).toBe("gone");
    await unlocked();
  });

  it("registers blocked acquisition before shutdown and releases a lease acquired after cancellation", async () => {
    const { cwd, config, state, unlocked } = await setup();
    let acquired!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let spawnAttempted = false;
    class DelayedStore extends SessionStore {
      override async acquire(path: string) {
        const lease = await super.acquire(path);
        const mark = lease.markSpawning.bind(lease);
        lease.markSpawning = async () => { spawnAttempted = true; await mark(); };
        acquired(); await gate;
        return lease;
      }
    }
    const outcome = new CodexRunner(config, new DelayedStore(state, "codex"))
      .delegate({ task: "hello", cwd }).catch((error: unknown) => error);
    await ready;
    let settled = false;
    const cleanup = cleanupAllChildren().finally(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    release();
    await cleanup;
    expect(await outcome).toMatchObject({ code: "CANCELLED" });
    expect(spawnAttempted).toBe(false);
    await unlocked();
  });

  it("settles global cleanup with structured diagnostics when lease release fails", async () => {
    const { cwd, config, state, log } = await setup();
    class BrokenStore extends SessionStore {
      override async acquire(path: string) {
        const lease = await super.acquire(path);
        lease.release = async () => { throw new RelayFailure("LOCK_IO", "fixture release failure"); };
        return lease;
      }
    }
    const outcome = new CodexRunner(config, new BrokenStore(state, "codex"))
      .delegate({ task: "hang", cwd }).catch((error: unknown) => error);
    await waitForLog(log, '"prompt":"hang"');
    await expect(cleanupAllChildren()).rejects.toMatchObject({ primaryCode: "LOCK_IO", failureCount: 1 });
    expect(await outcome).toMatchObject({ code: "LOCK_IO", partial: { provider: "codex", sessionId: expect.any(String) } });
    await expect(cleanupAllChildren()).resolves.toBeUndefined();
  });

  it("does not start a turn when cancelled during session persistence", async () => {
    const { cwd, config, state, events, unlocked } = await setup();
    let persisted!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { persisted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class DelayedStore extends SessionStore {
      override async writeNew(id: string, path: string) {
        await super.writeNew(id, path);
        persisted(); await gate;
      }
    }
    const controller = new AbortController();
    const outcome = new CodexRunner(config, new DelayedStore(state, "codex"))
      .delegate({ task: "hello", cwd }, controller.signal).catch((error: unknown) => error);
    await ready;
    controller.abort(); release();
    expect(await outcome).toMatchObject({ code: "CANCELLED", partial: { sessionId: expect.any(String) } });
    expect((await events()).some((event) => event.method === "turn/start")).toBe(false);
    await unlocked();
  });

  it.each(["unauthenticated", "invalid-result", "initialize-hang"])("handles %s before creating a session", async (mode) => {
    const { cwd, config, store, unlocked } = await setup();
    vi.stubEnv("CODEX_FIXTURE_MODE", mode);
    await expect(new CodexRunner({ ...config, phaseTimeoutMs: 200 }, store).delegate({ task: "hello", cwd }))
      .rejects.toMatchObject({ code: mode === "unauthenticated" ? "AUTH_UNAVAILABLE" : mode === "invalid-result" ? "PROTOCOL_MISMATCH" : "INITIALIZE_TIMEOUT", partial: { sessionId: null } });
    await unlocked();
  });

  it("only exposes confirmed session IDs and never replaces a failed resumed thread", async () => {
    const { cwd, runner, store, events } = await setup();
    await expect(runner.delegate({ task: "hello", cwd, sessionId: "unknown" })).rejects.toMatchObject({ code: "UNKNOWN_SESSION", partial: { sessionId: null } });
    const first = await runner.delegate({ task: "hello", cwd });
    const other = await tempDir(dirs);
    await expect(runner.delegate({ task: "hello", cwd: other, sessionId: first.sessionId! })).rejects.toMatchObject({ code: "CWD_MISMATCH", partial: { sessionId: null } });
    vi.stubEnv("CODEX_FIXTURE_MODE", "resume-failure");
    await expect(runner.delegate({ task: "hello", cwd, sessionId: first.sessionId! })).rejects.toMatchObject({ code: "CODEX_FAILURE", partial: { sessionId: first.sessionId } });
    expect((await store.read(first.sessionId!, cwd)).sessionId).toBe(first.sessionId);
    expect((await events()).filter((event) => event.method === "thread/start")).toHaveLength(1);
  });

  it.each(["hang", "start-hang", "backpressure"])("cancels %s without leaking children or locks", async (task) => {
    const { cwd, runner, log, unlocked } = await setup();
    const controller = new AbortController();
    const result = runner.delegate({ task, cwd }, controller.signal);
    const outcome = result.catch((error: unknown) => error);
    await waitForLog(log, '"method":"turn/start"');
    controller.abort();
    expect(await outcome).toMatchObject({ code: "CANCELLED", partial: { sessionId: expect.any(String) } });
    await unlocked();
  });

  it("times out and participates in global cleanup alongside ACP workers", async () => {
    const { cwd, config, runner, store, log, unlocked } = await setup();
    await expect(new CodexRunner({ ...config, totalTimeoutMs: 300 }, store).delegate({ task: "hang", cwd }))
      .rejects.toMatchObject({ code: "TIMEOUT" });
    const task = runner.delegate({ task: "hang", cwd });
    const outcome = task.catch((error: unknown) => error);
    await waitForLog(log, '"method":"turn/start"');
    const other = await tempDir(dirs);
    const acpTask = new GrokRunner(config, new SessionStore(config.stateDir)).delegate({ task: "hang", cwd: other });
    const acpOutcome = acpTask.catch((error: unknown) => error);
    await cleanupAllChildren();
    expect(await outcome).toMatchObject({ code: "CANCELLED" });
    expect(await acpOutcome).toMatchObject({ code: "CANCELLED" });
    await unlocked();
  });

  it("shares workspace locks with ACP and permits independent workspaces", async () => {
    const { cwd, config, runner, state, log, unlocked } = await setup();
    const controller = new AbortController();
    const task = runner.delegate({ task: "hang", cwd }, controller.signal);
    const outcome = task.catch((error: unknown) => error);
    try {
      await waitForLog(log, '"method":"turn/start"');
      await expect(new GrokRunner(config, new SessionStore(state)).delegate({ task: "hello", cwd })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
      const other = await tempDir(dirs);
      expect((await runner.delegate({ task: "hello", cwd: other })).text).toBe("hello 世界");
    } finally { controller.abort(); await outcome; }
    await unlocked();
  });

  it("rejects nested delegation, pre-cancellation, and missing executables", async () => {
    const { cwd, runner, config, store, unlocked } = await setup();
    vi.stubEnv("AGENT_RELAY_DELEGATED", "1");
    await expect(runner.delegate({ task: "hello", cwd })).rejects.toMatchObject({ code: "NESTED_DELEGATION" });
    vi.stubEnv("AGENT_RELAY_DELEGATED", "");
    await expect(runner.delegate({ task: "hello", cwd }, AbortSignal.abort())).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(new CodexRunner({ ...config, codexCommand: "/does/not/exist" }, store).delegate({ task: "hello", cwd })).rejects.toMatchObject({ code: "CODEX_FAILURE", partial: { sessionId: null } });
    await unlocked();
  });
});
