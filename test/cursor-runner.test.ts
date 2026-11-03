import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CursorRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { baseConfig as config, tempDir as makeTempDir, useRunnerCleanup, waitForLog } from "./helpers.js";

const dirs: string[] = [];
vi.setConfig({ testTimeout: 15_000 });
useRunnerCleanup(dirs);
const tempDir = () => makeTempDir(dirs);

describe("CursorRunner", () => {
  it("starts Cursor ACP with disabled client capabilities, authenticates, and resumes saved options", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "cursor.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "cursor");
    const first = await new CursorRunner(config(state), store).delegate({
      task: "one",
      cwd,
      model: "test-model",
      mode: "ask",
    });
    expect(first).toMatchObject({
      provider: "cursor",
      sessionId: "fake-session-1",
      stopReason: "end_turn",
      text: "fresh answer",
      truncated: false,
    });
    await new CursorRunner(config(state), store).delegate({ task: "two", cwd, sessionId: "fake-session-1" });
    const events = await readFile(log, "utf8");
    expect(events).toContain(`argv:${JSON.stringify(["--sandbox", "enabled", "--workspace", cwd, "--model", "test-model", "--mode", "ask", "acp"])}`);
    expect(events).toContain('"fs":{"readTextFile":false,"writeTextFile":false}');
    expect(events).toContain('"terminal":false');
    expect(events).toContain("auth:cursor_login");
    expect(events).toContain("load:fake-session-1");
    expect(events).toContain("delegated:1");
    expect(events).toContain('"name":"agent-relay"');
    expect(events).toContain("Work non-interactively.");
  }, 15_000);

  it("isolates the native configuration, preserves existing restrictions, and cleans it after resume", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const source = join(await tempDir(), "cursor config with spaces");
    await mkdir(source);
    vi.stubEnv("CURSOR_CONFIG_DIR", source);
    vi.stubEnv("FAKE_CURSOR_CONFIG_MUTATE", "1");
    const original = JSON.stringify({
      version: 1,
      model: { displayModelId: "custom" },
      authInfo: { activeTeamId: 42 },
      approvalMode: "unrestricted",
      permissions: { allow: ["Shell(ls)"], deny: ["Write(**/*.key)"] },
      sandbox: { mode: "disabled", networkAccess: "allow_all", readBoundary: "workspace" },
    });
    await writeFile(join(source, "cli-config.json"), original);
    const log = join(state, "config.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const runner = new CursorRunner(config(state), new SessionStore(state, "cursor"));
    const first = await runner.delegate({ task: "one", cwd });
    await runner.delegate({ task: "two", cwd, sessionId: first.sessionId! });
    const events = (await readFile(log, "utf8")).split("\n");
    const snapshots = events.filter((line) => line.startsWith("cursor-config:"))
      .map((line) => JSON.parse(line.slice("cursor-config:".length)));
    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(snapshot).toMatchObject({
        model: { displayModelId: "custom" }, authInfo: { activeTeamId: 42 },
        approvalMode: "allowlist",
        permissions: { allow: ["Shell(ls)"], deny: ["Write(**/*.key)", "WebFetch(*)"] },
        sandbox: { mode: "enabled", networkAccess: "user_config_only", readBoundary: "workspace" },
      });
    }
    expect(await readFile(join(source, "cli-config.json"), "utf8")).toBe(original);
    expect((await readdir(state)).filter((entry) => entry.startsWith("cursor-config-"))).toEqual([]);
    const directories = events.filter((line) => line.startsWith("cursor-config-dir:"));
    expect(new Set(directories).size).toBe(2);
  });

  it.each(["{private-invalid", '{"permissions":{"deny":"private-invalid"}}', '{"sandbox":[]}'])(
    "rejects invalid native configuration without spawning or exposing contents: %s",
    async (contents) => {
      const state = await tempDir();
      const cwd = await tempDir();
      await writeFile(join(process.env.CURSOR_CONFIG_DIR!, "cli-config.json"), contents);
      const log = join(state, "invalid.log");
      vi.stubEnv("FAKE_ACP_LOG", log);
      await expect(new CursorRunner(config(state), new SessionStore(state, "cursor")).delegate({ task: "one", cwd }))
        .rejects.toMatchObject({ code: "CONFIG_UNSUPPORTED", message: "Cannot prepare cursor native permission configuration" });
      await expect(readFile(log)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(state)).filter((entry) => entry.startsWith("cursor-config-"))).toEqual([]);
      const lease = await new SessionStore(state).acquire(cwd);
      await lease.markReaped("no-worker-created");
      await lease.release();
    },
  );

  it("removes native configuration after authentication failure", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    vi.stubEnv("FAKE_ACP_MODE", "no-auth");
    await expect(new CursorRunner(config(state), new SessionStore(state, "cursor")).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({ code: "AUTH_UNAVAILABLE" });
    expect((await readdir(state)).filter((entry) => entry.startsWith("cursor-config-"))).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("retains native configuration and the lock when process cleanup cannot be confirmed", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    vi.stubEnv("FAKE_ACP_MODE", "no-auth");
    const kill = process.kill.bind(process);
    const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 0) throw Object.assign(new Error("Probe unavailable"), { code: "EPERM" });
      return kill(pid, signal);
    });
    try {
      const store = new SessionStore(state, "cursor");
      await expect(new CursorRunner(config(state, { killConfirmMs: 50 }), store).delegate({ task: "one", cwd }))
        .rejects.toMatchObject({ code: "PROCESS_CLEANUP_FAILED" });
      expect((await readdir(state)).filter((entry) => entry.startsWith("cursor-config-"))).toHaveLength(1);
      await expect(store.acquire(cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    } finally {
      probe.mockRestore();
    }
  });

  it.each(["cancel", "timeout", "spawn"])("cleans native configuration and releases the workspace after %s", async (failure) => {
    const state = await tempDir();
    const cwd = await tempDir();
    const settings = config(state, { ...(failure === "timeout" ? { totalTimeoutMs: 1_000 } : {}) });
    const log = join(state, "cleanup.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "hang");
    if (failure === "spawn") settings.cursorCommand = join(state, "missing-executable");
    const controller = new AbortController();
    const store = new SessionStore(state, "cursor");
    const pending = new CursorRunner(settings, store).delegate({ task: "hang", cwd }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      code: failure === "cancel" ? "CANCELLED" : failure === "timeout" ? "TIMEOUT" : "ACP_FAILURE",
    });
    if (failure === "cancel") {
      await waitForLog(log, "new:");
      controller.abort();
    }
    await rejected;
    expect((await readdir(state)).filter((entry) => entry.startsWith("cursor-config-"))).toEqual([]);
    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("requires an explicit Cursor command and rejects nested delegation", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const settings = config(state);
    delete settings.cursorCommand;
    await expect(new CursorRunner(settings, new SessionStore(state, "cursor")).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({ code: "CURSOR_COMMAND_REQUIRED" });
    vi.stubEnv("GROK_RELAY_DELEGATED", "1");
    vi.stubEnv("CODEX_AGENT_RELAY_DELEGATED", "1");
    await expect(new CursorRunner(config(state), new SessionStore(state, "cursor")).delegate({ task: "one", cwd }))
      .resolves.toMatchObject({ sessionId: "fake-session-1" });
    vi.stubEnv("AGENT_RELAY_DELEGATED", "1");
    await expect(new CursorRunner(config(state), new SessionStore(state, "cursor")).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({ code: "NESTED_DELEGATION" });
  });

  it("rejects option conflicts before spawning and restores the saved session mode", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "mode.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "cursor");
    await new CursorRunner(config(state), store).delegate({ task: "one", cwd, model: "m1", mode: "ask" });
    await expect(new CursorRunner(config(state), store).delegate({ task: "two", cwd, sessionId: "fake-session-1", model: "m2" }))
      .rejects.toMatchObject({ code: "SESSION_OPTION_CONFLICT" });
    vi.stubEnv("FAKE_CURSOR_CURRENT_MODE", "agent");
    await new CursorRunner(config(state), store).delegate({ task: "two", cwd, sessionId: "fake-session-1" });
    expect(await readFile(log, "utf8")).toContain("set-mode:fake-session-1:ask");
  });

  it("fails closed for unavailable auth, ask mode, and malformed Cursor metadata", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const store = new SessionStore(state, "cursor");
    vi.stubEnv("FAKE_ACP_MODE", "no-auth");
    await expect(new CursorRunner(config(state), store).delegate({ task: "auth", cwd }))
      .rejects.toMatchObject({ code: "AUTH_UNAVAILABLE" });

    vi.stubEnv("FAKE_ACP_MODE", "normal");
    vi.stubEnv("FAKE_CURSOR_CURRENT_MODE", "agent");
    vi.stubEnv("FAKE_CURSOR_NO_ASK", "1");
    await expect(new CursorRunner(config(state), store).delegate({ task: "ask", cwd, mode: "ask" }))
      .rejects.toMatchObject({ code: "MODE_UNAVAILABLE" });

    vi.stubEnv("FAKE_CURSOR_NO_ASK", "0");
    await store.writeNew("metadata-without-mode", cwd);
    await expect(new CursorRunner(config(state), store).delegate({ task: "resume", cwd, sessionId: "metadata-without-mode" }))
      .rejects.toMatchObject({ code: "CORRUPT_SESSION" });
  });

  it.each([
    ["permission", "selected", "deny-actual", "touch denied.txt"],
    ["permission-basic", "selected", "deny-actual", "Permission requested for Shell"],
    ["permission-no-reject", "cancelled", undefined, "touch denied.txt"],
  ])("rejects Cursor permissions for %s and sends the response before cancellation", async (mode, outcome, optionId, summary) => {
    vi.stubEnv("FAKE_ACP_MODE", mode);
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, `${mode}.log`);
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new CursorRunner(config(state), new SessionStore(state, "cursor")).delegate({ task: "permission", cwd }))
      .rejects.toMatchObject({
        code: "PERMISSION_REQUIRED",
        partial: {
          provider: "cursor",
          sessionId: "fake-session-1",
          truncated: false,
          interactions: [expect.objectContaining({ type: "permission", outcome: "rejected", summary: expect.stringContaining(summary) })],
        },
      });
    const events = await readFile(log, "utf8");
    const response = optionId
      ? `permission-response:{"outcome":{"outcome":"${outcome}","optionId":"${optionId}"}}`
      : `permission-response:{"outcome":{"outcome":"${outcome}"}}`;
    expect(events.indexOf(response)).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("cancel:fake-session-1")).toBeGreaterThan(events.indexOf(response));
  });

  it("collects Cursor extensions and keeps current merged todo state", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "extensions");
    const state = await tempDir();
    const cwd = await tempDir();
    const result = await new CursorRunner(config(state), new SessionStore(state, "cursor")).delegate({ task: "extensions", cwd });
    expect(result.interactions).toEqual([
      expect.objectContaining({ type: "question", outcome: "skipped", summary: "Pick one" }),
      expect.objectContaining({ type: "plan", outcome: "rejected", summary: "Do the work" }),
    ]);
    expect(result.todos).toEqual([{ id: "one", content: "Work", status: "completed" }]);
    expect(result.subagents).toEqual([expect.objectContaining({ agentId: "agent-1", subagentType: "explore" })]);
    expect(result.images).toEqual([expect.objectContaining({ filePath: "/tmp/icon.png", referenceImageCount: 1 })]);
  });

  it("bounds Cursor summaries and exposes truncation", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "summary-large");
    const state = await tempDir();
    const cwd = await tempDir();
    const result = await new CursorRunner(config(state, { textLimitBytes: 100 }), new SessionStore(state, "cursor"))
      .delegate({ task: "large", cwd });
    expect(result.summariesTruncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.subagents))).toBeLessThan(64 * 1_024);
  });
});
