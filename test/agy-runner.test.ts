import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgyRunner, cleanupAllChildren, OpenCodeRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { baseConfig as config, tempDir as makeTempDir, useRunnerCleanup, waitForLog } from "./helpers.js";

const dirs: string[] = [];
vi.setConfig({ testTimeout: 15_000 });
useRunnerCleanup(dirs);
const tempDir = () => makeTempDir(dirs);

describe("AgyRunner", () => {
  it("starts agy acp --sandbox with optional --agent, empty capabilities, and policy warning", async () => {
    const state = await tempDir();
    const cwd = join(await tempDir(), "工作目录 with spaces");
    await mkdir(cwd);
    const log = join(state, "start.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const store = new SessionStore(state, "agy");
      const first = await new AgyRunner(config(state), store).delegate({
        task: "one",
        cwd,
        agent: "reviewer",
      });
      expect(first).toMatchObject({
        provider: "agy",
        sessionId: "fake-session-1",
        stopReason: "end_turn",
        text: "fresh answer",
        truncated: false,
        usage: { used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } },
        toolCalls: [expect.objectContaining({ toolCallId: "t1", title: "Fake tool" })],
      });
      expect(first.text).not.toContain("OTHER SESSION");
      expect(first.toolCalls?.some((call) => call.toolCallId === "other-tool")).toBe(false);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("AGY runs with --sandbox and ACP mode auto"));
      const events = await readFile(log, "utf8");
      expect(events).toContain(',"acp","--sandbox","--agent","reviewer"]');
      expect(events).toContain(`process-cwd:${cwd}`);
      expect(events).toContain(`new:${cwd}:${cwd}:0`);
      expect(events).toContain("delegated:1");
      expect(events).not.toContain("auth:");
      expect(events).toContain("set-config:mode:auto");
      expect(events).toContain("This is a noninteractive delegated task.");
      const initLine = events.split("\n").find((line) => line.startsWith("initialize:"))!;
      expect(JSON.parse(initLine.slice("initialize:".length))).toEqual({
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: false },
      });
      expect(events).not.toContain('"readTextFile":true');
      expect(events).not.toContain('"writeTextFile":true');
      expect(events).not.toContain('"terminal":true');
      expect(events).not.toContain('"elicitation"');
      expect(events).not.toContain('"terminal-auth"');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("omits --agent by default and reports missing executable failures", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "default-args.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await new AgyRunner(config(state), new SessionStore(state, "agy")).delegate({ task: "one", cwd });
    const events = await readFile(log, "utf8");
    expect(events).toContain(',"acp","--sandbox"]');
    expect(events).not.toContain("--agent");

    await expect(new AgyRunner(config(state, {
      agyCommand: join(state, "missing-agy"),
      agyCommandArgs: [],
    }), new SessionStore(state, "agy")).delegate({ task: "missing", cwd }))
      .rejects.toMatchObject({ code: "ACP_FAILURE" });
  });

  it("maps JSON-RPC authRequired (-32000) to AUTH_UNAVAILABLE without calling authenticate", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "auth.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "auth-required");
    await expect(new AgyRunner(config(state), new SessionStore(state, "agy")).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({
        code: "AUTH_UNAVAILABLE",
        message: expect.stringContaining("agy acp --login"),
      });
    const events = await readFile(log, "utf8");
    expect(events).not.toContain("auth:");
  });

  it("resumes cross-process via session/resume, re-applies default mode auto, and never falls back to load", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "resume.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "agy");
    const created = await new AgyRunner(config(state), store).delegate({ task: "one", cwd });
    const resumed = await new AgyRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    });
    expect(resumed).toMatchObject({
      provider: "agy",
      sessionId: "fake-session-1",
      text: "fresh answer",
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("resume:fake-session-1");
    expect(events).not.toContain("load:");
    expect(events.match(/set-config:mode:auto/g)).toHaveLength(2);

    vi.stubEnv("FAKE_ACP_MODE", "resume-fail");
    await expect(new AgyRunner(config(state), store).delegate({
      task: "three",
      cwd,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({
      code: "ACP_FAILURE",
      partial: { provider: "agy", sessionId: "fake-session-1" },
    });
    const afterFail = await readFile(log, "utf8");
    expect(afterFail).not.toContain("load:");
    expect(afterFail.match(/new:/g)).toHaveLength(1);
    expect(afterFail.match(/prompt:/g)).toHaveLength(2);

    vi.stubEnv("FAKE_ACP_MODE", "no-resume");
    await expect(new AgyRunner(config(state), store).delegate({
      task: "four",
      cwd,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({
      code: "RESUME_UNSUPPORTED",
      partial: { provider: "agy", sessionId: "fake-session-1" },
    });
  });

  it("rejects unknown session, cwd mismatch, and nested delegation", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const other = await tempDir();
    const store = new SessionStore(state, "agy");
    await expect(new AgyRunner(config(state), store).delegate({
      task: "missing",
      cwd,
      sessionId: "unknown-session",
    })).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });

    const created = await new AgyRunner(config(state), store).delegate({ task: "one", cwd });
    await expect(new AgyRunner(config(state), store).delegate({
      task: "two",
      cwd: other,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "CWD_MISMATCH" });

    vi.stubEnv("AGENT_RELAY_DELEGATED", "1");
    await expect(new AgyRunner(config(state), store).delegate({ task: "nested", cwd }))
      .rejects.toMatchObject({ code: "NESTED_DELEGATION" });
  });

  it("configures model, thought_level, then mode across flat/grouped options and supports explicit modes", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "config.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "grouped");
    const store = new SessionStore(state, "agy");
    await new AgyRunner(config(state), store).delegate({
      task: "one",
      cwd,
      model: "gemini-4-neon",
      effort: "xhigh",
      mode: "accept-edits",
    });
    await new AgyRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: "fake-session-1",
      model: "gemini-3.8-flash",
      mode: "plan",
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("set-config:model:gemini-4-neon");
    expect(events).toContain("set-config:thought_level:xhigh");
    expect(events).toContain("set-config:mode:accept-edits");
    expect(events).toContain("set-config:model:gemini-3.8-flash");
    expect(events).toContain("set-config:mode:plan");
    expect(events.indexOf("set-config:model:gemini-4-neon"))
      .toBeLessThan(events.indexOf("set-config:thought_level:xhigh"));
    expect(events.indexOf("set-config:thought_level:xhigh"))
      .toBeLessThan(events.indexOf("set-config:mode:accept-edits"));
    expect(events.indexOf("set-config:mode:accept-edits"))
      .toBeLessThan(events.indexOf("prompt:fake-session-1"));
  });

  it("rejects dynamic thought_level disappearance, invalid/missing/unapplied config, and timeouts without prompting", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "invalid-config.log");
    vi.stubEnv("FAKE_ACP_LOG", log);

    await expect(new AgyRunner(config(state), new SessionStore(state, "agy")).delegate({
      task: "dynamic",
      cwd,
      model: "gemini-pro-orchestrator-neon",
      effort: "high",
    })).rejects.toMatchObject({ code: "CONFIG_UNSUPPORTED" });

    await expect(new AgyRunner(config(state), new SessionStore(state, "agy")).delegate({
      task: "bad-model",
      cwd,
      model: "missing/model",
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    vi.stubEnv("FAKE_ACP_MODE", "no-mode");
    await expect(new AgyRunner(config(state), new SessionStore(state, "agy")).delegate({
      task: "no-mode",
      cwd,
    })).rejects.toMatchObject({ code: "CONFIG_UNSUPPORTED" });

    vi.stubEnv("FAKE_ACP_MODE", "ignore-mode");
    await expect(new AgyRunner(config(state), new SessionStore(state, "agy")).delegate({
      task: "ignore-mode",
      cwd,
      mode: "auto",
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    vi.stubEnv("FAKE_ACP_MODE", "config-timeout");
    await expect(new AgyRunner(config(state, { phaseTimeoutMs: 1_500 }), new SessionStore(state, "agy")).delegate({
      task: "timeout",
      cwd,
      model: "gemini-4-neon",
    })).rejects.toMatchObject({ code: "CONFIG_TIMEOUT" });

    const events = await readFile(log, "utf8");
    expect(events).not.toContain("prompt:");
    expect(events).not.toContain("set-config:model:missing/model");
    expect(events).not.toContain("set-config:thought_level:high");
  });

  it("rejects configuration drift when a later option resets an earlier value", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "drift.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "mode-resets-effort");
    await expect(new AgyRunner(config(state), new SessionStore(state, "agy")).delegate({
      task: "drift",
      cwd,
      model: "gemini-4-neon",
      effort: "high",
      mode: "auto",
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    const events = await readFile(log, "utf8");
    expect(events).toContain("set-config:thought_level:high");
    expect(events).toContain("set-config:mode:auto");
    expect(events).not.toContain("prompt:");
  });

  it("stops remaining configuration calls when aborted mid-configuration and releases the lease", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "config-hang-effort");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "config-abort.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "agy");
    const controller = new AbortController();
    const pending = new AgyRunner(config(state, { cancelGraceMs: 500 }), store).delegate({
      task: "configure",
      cwd,
      model: "gemini-4-neon",
      effort: "high",
      mode: "auto",
    }, controller.signal);
    await waitForLog(log, "set-config:thought_level:high");
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
      message: "MCP request was cancelled",
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("set-config:model:gemini-4-neon");
    expect(events).toContain("set-config:thought_level:high");
    expect(events).not.toContain("set-config:mode:");
    expect(events).not.toContain("prompt:");
    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("rejects permissions via reject_once, cancels when missing, handles late/other-session requests", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "permission");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "perm.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "agy");
    await expect(new AgyRunner(config(state), store).delegate({ task: "permission", cwd }))
      .rejects.toMatchObject({
        code: "PERMISSION_REQUIRED",
        partial: { provider: "agy", sessionId: "fake-session-1" },
      });
    const permEvents = await readFile(log, "utf8");
    expect(permEvents).toContain('permission-response:{"outcome":{"outcome":"selected","optionId":"reject-actual"}}');
    expect(permEvents).not.toContain("allow-once-actual");
    expect(permEvents).not.toContain("always-actual");

    vi.stubEnv("FAKE_ACP_MODE", "permission-no-reject");
    vi.stubEnv("FAKE_SESSION_ID", "fake-session-2");
    const noRejectLog = join(state, "no-reject.log");
    vi.stubEnv("FAKE_ACP_LOG", noRejectLog);
    await expect(new AgyRunner(config(state, { cancelGraceMs: 1_000 }), store).delegate({ task: "no-reject", cwd }))
      .rejects.toMatchObject({
        code: "PERMISSION_REQUIRED",
        partial: { provider: "agy", sessionId: "fake-session-2" },
      });
    const noRejectEvents = await readFile(noRejectLog, "utf8");
    expect(noRejectEvents).toContain('permission-response:{"outcome":{"outcome":"cancelled"}}');
    expect(noRejectEvents.indexOf("cancel:fake-session-2")).toBeGreaterThan(noRejectEvents.indexOf("permission-response:"));

    vi.stubEnv("FAKE_ACP_MODE", "permission-after-cancel");
    vi.stubEnv("FAKE_SESSION_ID", "fake-session-3");
    const lateLog = join(state, "late-perm.log");
    vi.stubEnv("FAKE_ACP_LOG", lateLog);
    const controller = new AbortController();
    const pending = new AgyRunner(config(state, { cancelGraceMs: 500 }), store).delegate({ task: "hang", cwd }, controller.signal);
    await waitForLog(lateLog, "prompt:fake-session-3");
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    const lateEvents = await readFile(lateLog, "utf8");
    expect(lateEvents).toContain('permission-response:{"outcome":{"outcome":"cancelled"}}');
    expect(lateEvents).not.toContain('"outcome":"selected"');

    vi.stubEnv("FAKE_ACP_MODE", "permission-other-session");
    vi.stubEnv("FAKE_SESSION_ID", "fake-session-4");
    const otherLog = join(state, "other-perm.log");
    vi.stubEnv("FAKE_ACP_LOG", otherLog);
    const result = await new AgyRunner(config(state), store).delegate({ task: "other", cwd });
    expect(result.stopReason).toBe("end_turn");
    expect(await readFile(otherLog, "utf8")).toContain('permission-other-response:{"outcome":{"outcome":"cancelled"}}');

    vi.stubEnv("FAKE_ACP_MODE", "permission-prompt-reject");
    vi.stubEnv("FAKE_SESSION_ID", "fake-session-5");
    const promptRejectLog = join(state, "prompt-reject.log");
    vi.stubEnv("FAKE_ACP_LOG", promptRejectLog);
    await expect(new AgyRunner(config(state), store).delegate({ task: "prompt-reject", cwd }))
      .rejects.toMatchObject({
        code: "PERMISSION_REQUIRED",
        partial: { provider: "agy", sessionId: "fake-session-5" },
      });
    expect(await readFile(promptRejectLog, "utf8")).toContain(
      'permission-response:{"outcome":{"outcome":"selected","optionId":"reject-actual"}}',
    );

    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("bounds summaries, truncates text on UTF-8 boundaries, and preserves partial output on failure", async () => {
    const state = await tempDir();
    const cwd = await tempDir();

    vi.stubEnv("FAKE_ACP_MODE", "summary-large");
    vi.stubEnv("FAKE_SESSION_ID", "summary-session");
    const large = await new AgyRunner(config(state, { textLimitBytes: 100 }), new SessionStore(state, "agy"))
      .delegate({ task: "large", cwd });
    expect(large.summariesTruncated).toBe(true);
    expect(large.truncated).toBe(true);
    expect(large.provider).toBe("agy");

    vi.stubEnv("FAKE_ACP_MODE", "unicode");
    vi.stubEnv("FAKE_SESSION_ID", "unicode-session");
    const unicode = await new AgyRunner(config(state, { textLimitBytes: 101 }), new SessionStore(state, "agy"))
      .delegate({ task: "unicode", cwd });
    expect(Buffer.byteLength(unicode.text)).toBeLessThanOrEqual(101);
    expect(unicode.text).not.toContain("\uFFFD");
    expect(unicode.truncated).toBe(true);

    vi.stubEnv("FAKE_ACP_MODE", "partial-fail");
    vi.stubEnv("FAKE_SESSION_ID", "partial-session");
    await expect(new AgyRunner(config(state), new SessionStore(state, "agy")).delegate({ task: "fail", cwd }))
      .rejects.toMatchObject({
        code: "ACP_FAILURE",
        partial: {
          provider: "agy",
          sessionId: "partial-session",
          text: "partial text",
          toolCalls: [expect.objectContaining({ toolCallId: "t1" })],
          usage: { used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } },
        },
      });
  });

  it("cancels hung prompts, cleans up descendants, handles exit/malformed failures, and shares cwd locks", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const hangLog = join(state, "hang.log");
    vi.stubEnv("FAKE_ACP_LOG", hangLog);
    vi.stubEnv("FAKE_ACP_MODE", "hang");
    await expect(new AgyRunner(config(state, { totalTimeoutMs: 1_500 }), new SessionStore(state, "agy"))
      .delegate({ task: "hang", cwd })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(await readFile(hangLog, "utf8")).toContain("cancel:fake-session-1");

    vi.stubEnv("FAKE_ACP_MODE", "descendant");
    vi.stubEnv("FAKE_SESSION_ID", "descendant-session");
    const descendantLog = join(state, "descendant.log");
    vi.stubEnv("FAKE_ACP_LOG", descendantLog);
    await new AgyRunner(config(state), new SessionStore(state, "agy")).delegate({ task: "descendant", cwd });
    const match = /descendant:(\d+)/.exec(await readFile(descendantLog, "utf8"));
    expect(match).not.toBeNull();
    expect(() => process.kill(Number(match?.[1]), 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));

    if (process.platform !== "win32") {
      vi.stubEnv("FAKE_ACP_MODE", "normal");
      vi.stubEnv("FAKE_SESSION_ID", "shared-id");
      const agyStore = new SessionStore(state, "agy");
      const openCodeStore = new SessionStore(state, "opencode");
      const agyRes = await new AgyRunner(config(state), agyStore).delegate({ task: "agy", cwd });
      await expect(openCodeStore.read("shared-id", cwd)).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
      const ocRes = await new OpenCodeRunner(config(state), openCodeStore).delegate({ task: "opencode", cwd });
      expect(agyRes.sessionId).toBe(ocRes.sessionId);
      await expect(agyStore.read("shared-id", cwd)).resolves.toMatchObject({ sessionId: "shared-id", cwd });
      await expect(openCodeStore.read("shared-id", cwd)).resolves.toMatchObject({ sessionId: "shared-id", cwd });

      vi.stubEnv("FAKE_ACP_MODE", "hang");
      vi.stubEnv("FAKE_SESSION_ID", "lock-session");
      const lockLog = join(state, "lock.log");
      vi.stubEnv("FAKE_ACP_LOG", lockLog);
      const active = new AgyRunner(config(state), agyStore).delegate({ task: "lock", cwd });
      await waitForLog(lockLog, "prompt:lock-session");
      await expect(new OpenCodeRunner(config(state), openCodeStore).delegate({ task: "blocked", cwd }))
        .rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
      await cleanupAllChildren();
      await expect(active).rejects.toMatchObject({ code: "CANCELLED" });
    }
  });

  it.each(["exit", "malformed"] as const)("reports %s child failure without claiming Windows cleanup success", async (mode) => {
    vi.stubEnv("FAKE_ACP_MODE", mode);
    const state = await tempDir();
    const cwd = await tempDir();
    await expect(new AgyRunner(config(state), new SessionStore(state, "agy")).delegate({ task: mode, cwd }))
      .rejects.toMatchObject({ code: process.platform === "win32" ? "PROCESS_CLEANUP_FAILED" : "ACP_FAILURE" });
    if (process.platform === "win32") {
      await expect(new SessionStore(state).acquire(cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    } else {
      const lease = await new SessionStore(state).acquire(cwd);
      await lease.markReaped("no-worker-created");
      await lease.release();
    }
  });
});
