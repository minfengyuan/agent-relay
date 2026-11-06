import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claudeSpawnSpec, ClaudeRunner } from "../src/adapters/claude.js";
import { loadConfig } from "../src/config.js";
import { CodexRunner, cleanupAllChildren } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import type { ClaudeRelayResult } from "../src/types.js";
import {
  TestAcpRunner, baseConfig, claudeFixture, tempDir, useRunnerCleanup, waitForLog,
} from "./helpers.js";

const dirs: string[] = [];
vi.setConfig({ testTimeout: 15_000 });
useRunnerCleanup(dirs);

async function harness(overrides: Partial<ReturnType<typeof baseConfig>> = {}) {
  const state = await tempDir(dirs);
  const cwd = await tempDir(dirs);
  const log = join(state, "claude.log");
  vi.stubEnv("FAKE_CLAUDE_LOG", log);
  const config = baseConfig(state, overrides);
  const store = new SessionStore(state, "claude");
  const runner = new ClaudeRunner(config, store);
  const spawn = async () => JSON.parse((await readFile(log, "utf8")).split("\n")[0]!) as {
    args: string[]; id: string; cwd: string; task: string; delegated: string;
    model: string | null; effort: string | null;
  };
  const assertReleased = async () => {
    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  };
  return { state, cwd, log, config, store, runner, spawn, assertReleased };
}

describe.skipIf(process.platform === "win32")("Claude headless runner", () => {
  it("uses the native CLI by default and the configured headless fixture", () => {
    expect(claudeSpawnSpec(loadConfig({}))).toEqual({ command: "claude", args: [] });
    expect(claudeSpawnSpec(baseConfig("unused"))).toEqual({ command: process.execPath, args: [claudeFixture] });
  });

  it("rejects missing commands and nested relay delegation without leaking a lease", async () => {
    const fixture = await harness();
    const runner = new ClaudeRunner({
      ...fixture.config, claudeCommand: join(fixture.cwd, "missing-claude"), claudeCommandArgs: [],
    }, fixture.store);
    await expect(runner.delegate({ task: "one", cwd: fixture.cwd })).rejects.toMatchObject({ code: "ACP_FAILURE" });
    await fixture.assertReleased();
    vi.stubEnv("AGENT_RELAY_DELEGATED", "1");
    await expect(runner.delegate({ task: "one", cwd: fixture.cwd })).rejects.toMatchObject({ code: "NESTED_DELEGATION" });
    await fixture.assertReleased();
  });

  it("replays success with exact headless flags, stdin, UUID persistence, summaries, and progress", async () => {
    const fixture = await harness();
    const progress: string[] = [];
    const result = await fixture.runner.delegate(
      { task: "read a.txt\n", cwd: fixture.cwd, model: "sonnet", effort: "high" },
      undefined,
      (message) => { progress.push(message); },
    );
    const spawn = await fixture.spawn();
    expect(spawn.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(spawn).toMatchObject({
      cwd: fixture.cwd, task: "read a.txt\n", delegated: "1", model: "sonnet", effort: "high",
    });
    expect(spawn.args).toEqual([
      "-p", "--output-format", "stream-json", "--verbose",
      "--permission-mode", "acceptEdits", "--permission-prompts", "none",
      "--model", "sonnet", "--effort", "high", "--session-id", spawn.id,
    ]);
    expect(spawn.args).not.toContain("read a.txt\n");
    expect(spawn.args).not.toContain("acp");
    expect(result).toMatchObject({
      provider: "claude", sessionId: spawn.id, stopReason: "end_turn",
      text: "hello-spike", truncated: false,
      toolCalls: [
        { title: "Read" },
        { status: "completed" },
      ],
    });
    expect(result.usage).toBeUndefined();
    expect(progress).toContain("Read");
    await expect(fixture.store.read(spawn.id, fixture.cwd)).resolves.toMatchObject({ cwd: fixture.cwd });
  });

  it("resumes a relay-recorded UUID in the Claude namespace and touches the record", async () => {
    const fixture = await harness();
    const id = randomUUID();
    await fixture.store.writeNew(id, fixture.cwd);
    vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "resume-success");
    const touch = vi.spyOn(fixture.store, "touch");
    const result = await fixture.runner.delegate({ task: "continue", cwd: fixture.cwd, sessionId: id });
    expect(result).toMatchObject({ provider: "claude", sessionId: id, text: "hello-spike", stopReason: "end_turn" });
    const spawn = await fixture.spawn();
    expect(spawn.args).toEqual([
      "-p", "--output-format", "stream-json", "--verbose",
      "--permission-mode", "acceptEdits", "--permission-prompts", "none",
      "--resume", id,
    ]);
    expect(spawn.args).not.toContain("--session-id");
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it("rejects a recorded title before spawning so --resume never performs title matching", async () => {
    const fixture = await harness();
    await fixture.store.writeNew("a saved conversation", fixture.cwd);
    await expect(fixture.runner.delegate({
      task: "continue", cwd: fixture.cwd, sessionId: "a saved conversation",
    })).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
    await expect(stat(fixture.log)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps an unknown provider session without creating a replacement", async () => {
    const fixture = await harness();
    const id = randomUUID();
    await fixture.store.writeNew(id, fixture.cwd);
    vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "resume-unknown");
    await expect(fixture.runner.delegate({ task: "continue", cwd: fixture.cwd, sessionId: id }))
      .rejects.toMatchObject({ code: "UNKNOWN_SESSION", partial: { provider: "claude", sessionId: id } });
    expect((await fixture.spawn()).args).not.toContain("--session-id");
  });

  it("passes an unknown model through because the gateway decides whether it is valid", async () => {
    const fixture = await harness();
    vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "unknown-model-accepted");
    const result = await fixture.runner.delegate({
      task: "read", cwd: fixture.cwd, model: "no-such-model-xyz",
    });
    expect(result).toMatchObject({ provider: "claude", text: "hello-spike", stopReason: "end_turn" });
    expect((await fixture.spawn()).args).toContain("no-such-model-xyz");
  });

  it("rejects an unsupported effort locally before spawning", async () => {
    const fixture = await harness();
    await expect(fixture.runner.delegate({ task: "one", cwd: fixture.cwd, effort: "extreme-xyz" }))
      .rejects.toMatchObject({ code: "INVALID_CONFIG", message: expect.stringContaining("low, medium, high, xhigh, max") });
    await expect(stat(fixture.log)).rejects.toMatchObject({ code: "ENOENT" });
    await fixture.assertReleased();
  });

  it("defensively fails when Claude ignores an effort value and warns on stderr", async () => {
    const fixture = await harness({ textLimitBytes: 16 });
    vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "unknown-effort-ignored");
    await expect(fixture.runner.delegate({ task: "one", cwd: fixture.cwd, effort: "high" }))
      .rejects.toMatchObject({ code: "INVALID_CONFIG", message: expect.stringContaining("unknown effort") });
  });

  it("reports post-turn permission denials while preserving output after the model continued", async () => {
    const fixture = await harness();
    vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "permission-denied-continues");
    const error = await fixture.runner.delegate({ task: "denied", cwd: fixture.cwd })
      .catch((failure: unknown) => failure);
    const spawn = await fixture.spawn();
    expect(error).toMatchObject({
      code: "PERMISSION_REQUIRED",
      partial: {
        provider: "claude", text: expect.stringContaining("b.txt"),
        sessionId: spawn.id,
      },
    });
    expect((error as Error).message).toContain("Bash");
    expect((error as { partial: ClaudeRelayResult }).partial.toolCalls).toEqual([
      { toolCallId: "call_00_FmnQtuplrg74S1JOc49s6145", title: "Bash" },
      { toolCallId: "call_00_FmnQtuplrg74S1JOc49s6145", status: "failed" },
      { toolCallId: "toolu_013xEx22fgxQ6QdQhaQr9Kbk", title: "Write" },
      { toolCallId: "toolu_013xEx22fgxQ6QdQhaQr9Kbk", status: "completed" },
      { toolCallId: "call_00_FmnQtuplrg74S1JOc49s6145", status: "failed" },
    ]);
  });

  it("waits for SIGTERM exit 143 without a result and maps caller cancellation to CANCELLED", async () => {
    const fixture = await harness();
    vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "sigterm-before-tool");
    const controller = new AbortController();
    const pending = fixture.runner.delegate({ task: "wait", cwd: fixture.cwd }, controller.signal)
      .catch((error: unknown) => error);
    await waitForLog(fixture.log, "waiting");
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      code: "CANCELLED", partial: { provider: "claude", sessionId: expect.any(String) },
    });
    expect(await readFile(fixture.log, "utf8")).toContain("root-sigterm");
  });

  it("never treats SIGTERM exit 143 without a result as success", async () => {
    const fixture = await harness();
    vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "sigterm-before-tool");
    vi.stubEnv("FAKE_CLAUDE_REPLAY_CANCEL", "1");
    await expect(fixture.runner.delegate({ task: "wait", cwd: fixture.cwd })).rejects.toMatchObject({
      code: "ACP_FAILURE", message: expect.stringContaining("143"),
      partial: { provider: "claude", sessionId: expect.any(String) },
    });
  });

  it("cancels during a tool after SIGTERM and never returns a successful result", async () => {
    const fixture = await harness();
    vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "sigterm-during-tool");
    const controller = new AbortController();
    const pending = fixture.runner.delegate({ task: "tool", cwd: fixture.cwd }, controller.signal)
      .catch((error: unknown) => error);
    await waitForLog(fixture.log, "waiting");
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      code: "CANCELLED", partial: { provider: "claude", sessionId: expect.any(String) },
    });
    expect(await readFile(fixture.log, "utf8")).toContain("root-sigterm");
  });

  it("bounds result text and rejects an inconsistent init session ID", async () => {
    const fixture = await harness({ textLimitBytes: 5 });
    const result = await fixture.runner.delegate({ task: "one", cwd: fixture.cwd });
    expect(result.text).toBe("hello");
    expect(result.truncated).toBe(true);

    vi.stubEnv("FAKE_CLAUDE_MISMATCH", "1");
    await expect(fixture.runner.delegate({ task: "two", cwd: fixture.cwd }))
      .rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
  });

  it("cleans up caller cancellation through shared shutdown", async () => {
    const fixture = await harness();
    vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "sigterm-before-tool");
    const pending = fixture.runner.delegate({ task: "wait", cwd: fixture.cwd }).catch((error: unknown) => error);
    await waitForLog(fixture.log, "waiting");
    await cleanupAllChildren();
    await expect(pending).resolves.toMatchObject({ code: "CANCELLED" });
    await fixture.assertReleased();
  });

  it("shares the cwd lock with ACP and native runners while allowing other workspaces", async () => {
    const fixture = await harness();
    vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "sigterm-before-tool");
    const controller = new AbortController();
    const running = fixture.runner.delegate({ task: "one", cwd: fixture.cwd }, controller.signal)
      .catch((error: unknown) => error);
    await waitForLog(fixture.log, "waiting");
    try {
      for (const other of [
        new TestAcpRunner(fixture.config, new SessionStore(fixture.state)),
        new CodexRunner(fixture.config, new SessionStore(fixture.state, "codex")),
      ]) {
        await expect(other.delegate({ task: "two", cwd: fixture.cwd })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
      }
      vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "new-session-success");
      await expect(fixture.runner.delegate({ task: "three", cwd: await tempDir(dirs) })).resolves.toMatchObject({
        provider: "claude", text: "hello-spike",
      });
    } finally {
      controller.abort();
      await running;
    }
  });
});
