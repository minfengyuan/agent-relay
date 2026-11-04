import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claudeSpawnSpec } from "../src/adapters/claude.js";
import { loadConfig } from "../src/config.js";
import { ClaudeRunner, CodexRunner, GrokRunner, cleanupAllChildren } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { baseConfig, claudeFixture, tempDir, useRunnerCleanup, waitForLog } from "./helpers.js";

const dirs: string[] = [];
vi.setConfig({ testTimeout: 15000 });
useRunnerCleanup(dirs);

async function harness(overrides: Partial<ReturnType<typeof baseConfig>> = {}) {
  const state = await tempDir(dirs);
  const cwd = await tempDir(dirs);
  const log = join(state, "claude.log");
  vi.stubEnv("FAKE_ACP_LOG", log);
  const config = baseConfig(state, overrides);
  const store = new SessionStore(state, "claude");
  const runner = new ClaudeRunner(config, store);
  const events = () => readFile(log, "utf8");
  const assertReleased = async () => {
    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  };
  return { state, cwd, log, config, store, runner, events, assertReleased };
}

describe("ClaudeRunner", () => {
  it("uses the bridge command without native CLI flags", () => {
    if (process.platform !== "win32") {
      expect(claudeSpawnSpec(loadConfig({}))).toEqual({ command: "claude-agent-acp", args: [] });
    }
    expect(claudeSpawnSpec(baseConfig("unused"))).toEqual({ command: process.execPath, args: [claudeFixture] });
  });

  it("rejects missing commands and nested relay delegation without leaking a lease", async () => {
    const { config, store, cwd, assertReleased } = await harness();
    const runner = new ClaudeRunner({
      ...config, claudeCommand: join(cwd, "missing-bridge"), claudeCommandArgs: [],
    }, store);
    await expect(runner.delegate({ task: "one", cwd })).rejects.toMatchObject({ code: "ACP_FAILURE" });
    await assertReleased();
    vi.stubEnv("AGENT_RELAY_DELEGATED", "1");
    await expect(runner.delegate({ task: "one", cwd })).rejects.toMatchObject({ code: "NESTED_DELEGATION" });
    await assertReleased();
  });

  it("executes with acceptEdits, no interactive authentication, bounded summaries and progress", async () => {
    const { runner, cwd, events, assertReleased } = await harness();
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/custom/claude");
    const progress = vi.fn();
    const result = await runner.delegate({ task: "one", cwd, model: "sonnet", effort: "high" }, undefined, progress);
    expect(result).toMatchObject({
      provider: "claude", sessionId: "claude-session", text: "fresh answer", stopReason: "end_turn", truncated: false,
      toolCalls: [{ toolCallId: "tool-1", title: "Fake tool", status: "completed" }],
      usage: { used: 42, size: 128, cost: { amount: 0.25, currency: "USD" } },
    });
    const log = await events();
    const capabilities = JSON.parse(log.split("\n").find((line) => line.startsWith("initialize:"))!.slice("initialize:".length));
    expect(capabilities.terminal).not.toBe(true);
    expect(capabilities.auth?.terminal).not.toBe(true);
    expect(capabilities.fs?.readTextFile).not.toBe(true);
    expect(capabilities.fs?.writeTextFile).not.toBe(true);
    expect(capabilities.elicitation).toBeUndefined();
    expect(log).toContain("delegated:1");
    expect(log).toContain("executable:/custom/claude");
    expect(log).toContain("This is a noninteractive delegated task.");
    expect(log).not.toContain("authenticate");
    expect(log).toContain("set:model:sonnet\nset:effort:high\nset:mode:acceptEdits\nprompt:");
    expect(log).toContain('"mode":"acceptEdits"');
    expect(log).toContain("close:claude-session");
    expect(progress).toHaveBeenCalledWith("Fake tool");
    await assertReleased();
  });

  it("restores across processes and preserves omitted model/effort while resetting the saved mode", async () => {
    const { runner, cwd, state, config, store, events } = await harness();
    const saved = join(state, "options.json");
    vi.stubEnv("FAKE_CLAUDE_STATE", saved);
    const created = await runner.delegate({ task: "one", cwd, model: "fast", effort: "low" });
    await writeFile(saved, JSON.stringify({ model: "fast", effort: "low", mode: "bypassPermissions" }));
    const restored = await new ClaudeRunner(config, store).delegate({ task: "two", cwd, sessionId: created.sessionId! });
    expect(restored.sessionId).toBe(created.sessionId);
    const log = await events();
    expect(log.match(/set:model:/g)).toHaveLength(1);
    expect(log.match(/set:effort:/g)).toHaveLength(1);
    expect(log.match(/set:mode:acceptEdits/g)).toHaveLength(2);
    expect(log.match(/"mode":"acceptEdits"/g)).toHaveLength(2);
    expect(log).toContain("resume:claude-session");
    expect(log).not.toContain("load:");
  });

  it("loads only when resume is absent and excludes history replay", async () => {
    const { runner, store, cwd, events } = await harness();
    await store.writeNew("claude-session", cwd);
    vi.stubEnv("FAKE_ACP_MODE", "load-only");
    const result = await runner.delegate({ task: "one", cwd, sessionId: "claude-session" });
    expect(result.text).toBe("fresh answer");
    expect(result.toolCalls).toHaveLength(1);
    expect(await events()).toContain("load:claude-session");
    expect(await events()).not.toContain("new:");
  });

  it.each([
    ["resume-fail", "ACP_FAILURE"],
    ["no-restore", "RESUME_UNSUPPORTED"],
  ])("never replaces an existing session after %s", async (mode, code) => {
    const { runner, store, cwd, events } = await harness();
    await store.writeNew("claude-session", cwd);
    vi.stubEnv("FAKE_ACP_MODE", mode);
    await expect(runner.delegate({ task: "one", cwd, sessionId: "claude-session" })).rejects.toMatchObject({
      code, partial: { sessionId: "claude-session" },
    });
    expect(await events()).not.toContain("new:");
    expect(await events()).not.toContain("load:");
  });

  it.each(["UNKNOWN_SESSION", "CWD_MISMATCH"] as const)("rejects %s before launching a worker", async (code) => {
    const { runner, store, cwd, events, assertReleased } = await harness();
    if (code === "CWD_MISMATCH") await store.writeNew("claude-session", await tempDir(dirs));
    await expect(runner.delegate({ task: "one", cwd, sessionId: "claude-session" })).rejects.toMatchObject({
      code, partial: { sessionId: null },
    });
    await expect(events()).rejects.toMatchObject({ code: "ENOENT" });
    await assertReleased();
  });

  it("refreshes grouped model choices and effort choices after model changes", async () => {
    const { runner, cwd } = await harness();
    vi.stubEnv("FAKE_ACP_MODE", "grouped");
    await expect(runner.delegate({ task: "one", cwd, model: "fast", effort: "high" })).rejects.toMatchObject({
      code: "INVALID_CONFIG", partial: { sessionId: "claude-session" },
    });
  });

  it.each([
    ["no-effort", { effort: "high" }, "CONFIG_UNSUPPORTED"],
    ["normal", { effort: "invalid" }, "INVALID_CONFIG"],
    ["normal", { model: "invalid" }, "INVALID_CONFIG"],
    ["no-mode", {}, "CONFIG_UNSUPPORTED"],
    ["no-accept-edits", {}, "INVALID_CONFIG"],
    ["mode-ignored", {}, "INVALID_CONFIG"],
    ["mode-fail", {}, "ACP_FAILURE"],
    ["config-timeout", {}, "CONFIG_TIMEOUT"],
  ])("stops before prompting on %s configuration errors", async (mode, options, code) => {
    const { runner, cwd, store, events, assertReleased } = await harness({ phaseTimeoutMs: 700 });
    vi.stubEnv("FAKE_ACP_MODE", mode);
    await expect(runner.delegate({ task: "one", cwd, ...options })).rejects.toMatchObject({
      code, partial: { sessionId: "claude-session" },
    });
    expect((await store.read("claude-session", cwd)).sessionId).toBe("claude-session");
    expect(await events()).not.toContain("prompt:");
    expect(await events()).toContain("close:claude-session");
    await assertReleased();
  });

  it.each(["auth-new", "auth-prompt"])("maps structured %s errors without starting login", async (mode) => {
    const { runner, cwd, events } = await harness();
    vi.stubEnv("FAKE_ACP_MODE", mode);
    await expect(runner.delegate({ task: "one", cwd })).rejects.toMatchObject({
      code: "AUTH_UNAVAILABLE", partial: { sessionId: mode === "auth-new" ? null : "claude-session" },
    });
    expect(await events()).not.toContain("authenticate");
  });

  it.each(["permission", "permission-missing"])("refuses %s and retains partial output", async (mode) => {
    const { runner, cwd, events, assertReleased } = await harness();
    vi.stubEnv("FAKE_ACP_MODE", mode);
    await expect(runner.delegate({ task: "one", cwd })).rejects.toMatchObject({
      code: "PERMISSION_REQUIRED", partial: { provider: "claude", sessionId: "claude-session", text: "fresh answer" },
    });
    const log = await events();
    expect(log).toContain(mode === "permission" ? '"optionId":"reject"' : '"outcome":"cancelled"');
    expect(log).not.toContain('"optionId":"allow"');
    expect(log).toContain("cancel:claude-session");
    await assertReleased();
  });

  it.each([
    ["no-close", "SESSION_CLOSE_UNSUPPORTED"],
    ["wrong-protocol", "PROTOCOL_MISMATCH"],
    ["close-fail", "SESSION_CLOSE_FAILED"],
    ["close-timeout", "SESSION_CLOSE_TIMEOUT"],
    ["partial-fail", "ACP_FAILURE"],
    ["new-timeout", "NEW_SESSION_TIMEOUT"],
  ])("cleans up on %s", async (mode, code) => {
    const { runner, cwd, assertReleased } = await harness({ phaseTimeoutMs: 700 });
    vi.stubEnv("FAKE_ACP_MODE", mode);
    await expect(runner.delegate({ task: "one", cwd })).rejects.toMatchObject({ code });
    await assertReleased();
  });

  it.each(["large", "summary-large"])("bounds %s output", async (mode) => {
    const { runner, cwd } = await harness({ textLimitBytes: 100 });
    vi.stubEnv("FAKE_ACP_MODE", mode);
    const result = await runner.delegate({ task: "one", cwd });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(100);
    if (mode === "summary-large") expect(result.summariesTruncated).toBe(true);
  });

  it.each(["caller", "shutdown", "timeout"])("cleans hanging descendants on %s cancellation", async (source) => {
    const { runner, cwd, log, events, assertReleased } = await harness({ totalTimeoutMs: source === "timeout" ? 2000 : 15000 });
    vi.stubEnv("FAKE_ACP_MODE", "descendant-hang");
    const controller = new AbortController();
    const result = runner.delegate({ task: "one", cwd }, controller.signal).catch((error: unknown) => error);
    await waitForLog(log, "descendant:");
    if (source === "caller") controller.abort();
    if (source === "shutdown") await cleanupAllChildren();
    expect(await result).toMatchObject({ code: source === "timeout" ? "TIMEOUT" : "CANCELLED" });
    const descendant = Number((await events()).match(/descendant:(\d+)/)?.[1]);
    expect(() => process.kill(descendant, 0)).toThrow();
    await assertReleased();
  });

  it("cleans descendants after success", async () => {
    const { runner, cwd, events, assertReleased } = await harness();
    vi.stubEnv("FAKE_ACP_MODE", "descendant");
    await runner.delegate({ task: "one", cwd });
    const descendant = Number((await events()).match(/descendant:(\d+)/)?.[1]);
    expect(() => process.kill(descendant, 0)).toThrow();
    await assertReleased();
  });

  it("shares the cwd lock with ACP and native runners while allowing other workspaces", async () => {
    const { runner, cwd, log, config, state } = await harness();
    vi.stubEnv("FAKE_ACP_MODE", "hang");
    const controller = new AbortController();
    const running = runner.delegate({ task: "one", cwd }, controller.signal).catch((error: unknown) => error);
    await waitForLog(log, "prompt:claude-session");
    try {
      for (const other of [
        new GrokRunner(config, new SessionStore(state)),
        new CodexRunner(config, new SessionStore(state, "codex")),
      ]) {
        await expect(other.delegate({ task: "two", cwd })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
      }
      vi.stubEnv("FAKE_ACP_MODE", "normal");
      vi.stubEnv("FAKE_SESSION_ID", "other-claude-session");
      await expect(runner.delegate({ task: "three", cwd: await tempDir(dirs) })).resolves.toMatchObject({
        sessionId: "other-claude-session", text: "fresh answer",
      });
    } finally {
      controller.abort();
      await running;
    }
  });
});
