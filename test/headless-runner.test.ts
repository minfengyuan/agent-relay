import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeadlessRunner } from "../src/runner/headless-runner.js";
import { cleanupAllChildren } from "../src/runner/lifecycle.js";
import type * as ProcessTree from "../src/runner/process-tree.js";
import { StandardSummaries } from "../src/runner/summaries.js";
import type { HeadlessAdapter, HeadlessEvent, HeadlessStdin } from "../src/runner/types.js";
import { SessionStore } from "../src/store.js";
import { RelayFailure, type DelegateInput, type DshRelayResult } from "../src/types.js";
import { baseConfig, cleanupDirs, clearDelegatedEnv, tempDir, waitForLog } from "./helpers.js";

const captured = vi.hoisted(() => ({
  unconfirmed: false,
  children: [] as ChildProcessWithoutNullStreams[],
  terminating: () => {},
}));
vi.mock("../src/runner/process-tree.js", async (load) => {
  const actual = await load<typeof ProcessTree>();
  return {
    ...actual,
    createProcessTreeController: (...args: Parameters<typeof actual.createProcessTreeController>) => {
      captured.children.push(args[0]);
      const real = actual.createProcessTreeController(...args);
      return { reference: real.reference, terminate: async () => {
        captured.terminating();
        const report = await real.terminate();
        return captured.unconfirmed ? { ...report, confirmed: false, reason: "injected cleanup failure" } : report;
      } };
    },
  };
});

const dirs: string[] = [];
beforeEach(() => { clearDelegatedEnv(); });
afterEach(async () => {
  await cleanupAllChildren().catch(() => undefined);
  captured.unconfirmed = false;
  captured.terminating = () => {};
  for (const child of captured.children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
  }
  vi.unstubAllEnvs();
  await cleanupDirs(dirs);
});

async function setup(mode = "normal", options: {
  preset?: string;
  stdin?: HeadlessStdin;
  textLimitBytes?: number;
  totalTimeoutMs?: number;
} = {}) {
  const root = await tempDir(dirs);
  const cwd = await tempDir(dirs);
  const log = join(root, "headless.log");
  const store = new SessionStore(root, "generic");
  let directory = "";
  const adapter: HeadlessAdapter<DelegateInput, DshRelayResult> = {
    displayName: "Test worker", failureCode: "ACP_FAILURE",
    prepare: async (input, _record, dir) => {
      directory = dir;
      await writeFile(join(dir, "prompt"), input.task, { mode: 0o600 });
      return { env: {}, extraArgs: [join(dir, "prompt")], stdin: options.stdin ?? "ignore" };
    },
    command: (input, record) => ({
      command: process.execPath,
      args: [join(import.meta.dirname, "fixtures/fake-headless.mjs"), mode, record?.sessionId ?? input.sessionId ?? "test-session", log],
    }),
    presetSessionId: () => options.preset,
    decode: (raw) => {
      if (!raw || typeof raw !== "object" || !("type" in raw)) return { type: "ignore" };
      return ["session", "text", "toolCall", "toolResult", "usage", "permissionDenied", "final", "error"].includes(String(raw.type))
        ? raw as HeadlessEvent : { type: "ignore" };
    },
    complete: (state, exit) => {
      if (exit.code !== 0 || !state.final?.ok || state.error !== undefined) {
        throw new RelayFailure("ACP_FAILURE", state.error ?? state.final?.error ?? `exit ${exit.code}`);
      }
      return {
        provider: "dsh", sessionId: state.sessionId, text: state.text,
        truncated: state.truncated, stopReason: state.final.stopReason,
      };
    },
    gracefulStop: { signal: "SIGTERM", graceMs: 800 },
    createSummarizer: (limit) => new StandardSummaries(limit, "dsh"),
  };
  const runner = new HeadlessRunner(baseConfig(root, {
    ...(options.textLimitBytes === undefined ? {} : { textLimitBytes: options.textLimitBytes }),
    ...(options.totalTimeoutMs === undefined ? {} : { totalTimeoutMs: options.totalTimeoutMs }),
  }), store, adapter);
  return { runner, store, adapter, cwd, root, log, directory: () => directory };
}

describe.skipIf(process.platform === "win32")("HeadlessRunner", () => {
  it("persists a session before subsequent events and removes private task files after cleanup", async () => {
    const fixture = await setup();
    const order: string[] = [];
    const write = fixture.store.writeNew.bind(fixture.store);
    vi.spyOn(fixture.store, "writeNew").mockImplementation(async (...args) => {
      order.push("persist"); await write(...args);
    });
    const decode = fixture.adapter.decode;
    fixture.adapter.decode = (raw) => {
      const event = decode(raw);
      if (event.type === "text") expect(order).toEqual(["persist"]);
      return event;
    };
    const result = await fixture.runner.delegate({ task: "private prompt", cwd: fixture.cwd });
    expect(result).toMatchObject({ sessionId: "test-session", text: "answer", stopReason: "end_turn" });
    await expect(fixture.store.read("test-session", fixture.cwd)).resolves.toMatchObject({ sessionId: "test-session" });
    await expect(stat(fixture.directory())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(fixture.log, "utf8")).toContain("prompt:private prompt");
  });

  it("persists a preset ID on the first event even when its type is unknown", async () => {
    const fixture = await setup("preset-first", { preset: "preset-id" });
    const controller = new AbortController();
    const task = fixture.runner.delegate({ task: "hold", cwd: fixture.cwd }, controller.signal);
    const outcome = task.catch((error: unknown) => error);
    await waitForLog(fixture.log, "waiting");
    await vi.waitFor(async () => {
      await expect(fixture.store.read("preset-id", fixture.cwd)).resolves.toMatchObject({ sessionId: "preset-id" });
    });
    controller.abort();
    expect(await outcome).toMatchObject({ code: "CANCELLED", partial: { sessionId: "preset-id" } });
  });

  it("resumes only recorded IDs and touches them after success", async () => {
    const fixture = await setup();
    const touch = vi.spyOn(fixture.store, "touch");
    await fixture.runner.delegate({ task: "first", cwd: fixture.cwd });
    await fixture.runner.delegate({ task: "second", cwd: fixture.cwd, sessionId: "test-session" });
    expect(touch).toHaveBeenCalledTimes(1);
    await expect(fixture.runner.delegate({ task: "unknown", cwd: fixture.cwd, sessionId: "title" }))
      .rejects.toMatchObject({ code: "UNKNOWN_SESSION", partial: { sessionId: null } });
    expect((await readFile(fixture.log, "utf8")).match(/start:/g)).toHaveLength(2);
  });

  it.each(["mismatch", "mismatch-late"])("rejects %s IDs without replacing the confirmed ID", async (mode) => {
    const fixture = await setup(mode, { preset: "test-session" });
    await expect(fixture.runner.delegate({ task: "check", cwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
    await expect(fixture.store.read("wrong-id", fixture.cwd)).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
  });

  it("keeps an unpersisted ID out of failure partials", async () => {
    const fixture = await setup();
    vi.spyOn(fixture.store, "writeNew").mockRejectedValue(new RelayFailure("STATE_IO", "injected persistence failure"));
    await expect(fixture.runner.delegate({ task: "check", cwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "STATE_IO", partial: { sessionId: null } });
  });

  it("requires a confirmed session ID even when a terminal event claims success", async () => {
    const fixture = await setup("no-session");
    await expect(fixture.runner.delegate({ task: "check", cwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "INVALID_SESSION", partial: { sessionId: null } });
  });

  it("rejects an empty resume ID before spawning", async () => {
    const fixture = await setup();
    await expect(fixture.runner.delegate({ task: "check", cwd: fixture.cwd, sessionId: "" }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(captured.children).toHaveLength(0);
  });

  it("reports permission denial after the worker finishes and preserves later output", async () => {
    const fixture = await setup("permission");
    await expect(fixture.runner.delegate({ task: "denied", cwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "PERMISSION_REQUIRED", partial: { text: "answer after denial", sessionId: "test-session" } });
    expect(await readFile(fixture.log, "utf8")).toContain("done");
  });

  it.each(["nonzero", "error", "failed-final", "missing-final"])("fails on %s rather than trusting exit alone", async (mode) => {
    const fixture = await setup(mode);
    await expect(fixture.runner.delegate({ task: "fail", cwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "ACP_FAILURE", partial: { sessionId: "test-session", text: "answer" } });
  });

  it.each(["malformed", "oversize"])("rejects %s frames", async (mode) => {
    const fixture = await setup(mode);
    await expect(fixture.runner.delegate({ task: "parse", cwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
  });

  it("ignores unknown events and collects bounded text, summaries, usage, and progress", async () => {
    const fixture = await setup("unknown");
    const progress: string[] = [];
    const result = await fixture.runner.delegate({ task: "check", cwd: fixture.cwd }, undefined, (message) => { progress.push(message); });
    expect(result).toMatchObject({ text: "answer", usage: { used: 10, size: 100 } });
    expect(result.toolCalls).toEqual([
      { toolCallId: "tool-1", title: "test tool" }, { toolCallId: "tool-1", status: "completed" },
    ]);
    expect(progress).toContain("test tool");
  });

  it("propagates both text and summary truncation without breaking UTF-8", async () => {
    const fixture = await setup("large", { textLimitBytes: 101 });
    const result = await fixture.runner.delegate({ task: "large", cwd: fixture.cwd });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(101);
    expect(result.text).not.toContain("�");
    expect(result.truncated).toBe(true);
    expect(result.summariesTruncated).toBe(true);
  });

  it("propagates summary truncation even when all text fits", async () => {
    const fixture = await setup("summary-large", { textLimitBytes: 101 });
    const result = await fixture.runner.delegate({ task: "summary", cwd: fixture.cwd });
    expect(result.text).toBe("answer");
    expect(result.truncated).toBe(true);
    expect(result.summariesTruncated).toBe(true);
  });

  it.each(["close", { write: "stdin task\n" }] as const)("supports stdin %j", async (stdin) => {
    const fixture = await setup("stdin", { stdin });
    await fixture.runner.delegate({ task: "check", cwd: fixture.cwd });
    const events = await readFile(fixture.log, "utf8");
    expect(events).toContain("stdin-eof");
    if (typeof stdin === "object") expect(events).toContain("stdin:stdin task\n");
  });

  it("sends root SIGTERM and waits for the cancellation terminal event before tree termination", async () => {
    const fixture = await setup("cancel");
    let terminalBeforeTree = false;
    captured.terminating = () => {
      terminalBeforeTree = readFileSync(fixture.log, "utf8").includes("cancel-final");
    };
    const controller = new AbortController();
    const task = fixture.runner.delegate({ task: "cancel", cwd: fixture.cwd }, controller.signal);
    const outcome = task.catch((error: unknown) => error);
    await waitForLog(fixture.log, "waiting");
    controller.abort();
    expect(await outcome).toMatchObject({ code: "CANCELLED" });
    expect(terminalBeforeTree).toBe(true);
    expect(await readFile(fixture.log, "utf8")).toContain("root-sigterm");
  });

  it("terminates a hung worker after its grace period and total timeout", async () => {
    const fixture = await setup("hang", { totalTimeoutMs: 300 });
    await expect(fixture.runner.delegate({ task: "timeout", cwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "TIMEOUT", partial: { text: "partial" } });
  });

  it("keeps cleanup failure ahead of the task error and retains prepared files", async () => {
    const fixture = await setup("permission");
    captured.unconfirmed = true;
    await expect(fixture.runner.delegate({ task: "fail", cwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "PROCESS_CLEANUP_FAILED", partial: { text: "answer after denial" } });
    await expect(stat(fixture.directory())).resolves.toBeDefined();
    await expect(new SessionStore(fixture.root).acquire(fixture.cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  });

  it("reaps a grandchild before releasing the workspace lock", async () => {
    const fixture = await setup("descendant");
    await fixture.runner.delegate({ task: "children", cwd: fixture.cwd });
    const events = await readFile(fixture.log, "utf8");
    const pid = Number(/descendant:(\d+)/.exec(events)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(events).toContain("descendant-sigterm");
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    const lease = await new SessionStore(fixture.root).acquire(fixture.cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });
});
