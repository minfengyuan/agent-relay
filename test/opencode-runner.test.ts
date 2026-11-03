import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { baseConfig as config, opencodeFixture, tempDir as makeTempDir, useRunnerCleanup, waitForLog } from "./helpers.js";

const dirs: string[] = [];
vi.setConfig({ testTimeout: 15_000 });
useRunnerCleanup(dirs);
const tempDir = () => makeTempDir(dirs);

describe("OpenCodeRunner", () => {
  it.each(["1", "2"])("starts OpenCode V%s ACP with matching cwd and noninteractive capabilities", async (version) => {
    vi.stubEnv("FAKE_OPENCODE_VERSION", version);
    const state = await tempDir();
    const cwd = join(await tempDir(), "工作目录 with spaces");
    await mkdir(cwd);
    const log = join(state, "start.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("OPENCODE_PERMISSION", JSON.stringify({ bash: "allow" }));
    const first = await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
    });
    expect(first).toMatchObject({
      provider: "opencode",
      sessionId: "fake-session-1",
      stopReason: "end_turn",
      text: "fresh answer",
      truncated: false,
      usage: { used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } },
      toolCalls: [expect.objectContaining({ toolCallId: "t1", title: "Fake tool" })],
    });
    expect(first.text).not.toContain("OTHER SESSION");
    expect(first.toolCalls?.some((call) => call.toolCallId === "other-tool")).toBe(false);
    const events = await readFile(log, "utf8");
    expect(events).toContain(',"acp"]');
    expect(events).not.toContain("--cwd");
    expect(events).toContain(`process-cwd:${cwd}`);
    expect(events).toContain(`new:${cwd}:${cwd}:0`);
    expect(events).toContain("delegated:1");
    expect(events).toContain("auth:opencode-login");
    expect(events).toContain("new:");
    expect(events).toContain('permission-env:{"bash":"allow","question":"deny"}');
    expect(events).toContain("This is a noninteractive delegated task.");
    expect(events).not.toContain("set-config:");
    expect(events).not.toContain('"readTextFile":true');
    expect(events).not.toContain('"terminal":true');
    expect(events).not.toContain('"elicitation"');
    expect(events).not.toContain('"terminal-auth"');
  });

  it("rejects resume without sessionId before spawning", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "resume-input.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
      resume: true,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
      resume: false,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(readFile(log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["1", "2"])("resumes V%s by default, loads when forced, and filters load replay", async (version) => {
    vi.stubEnv("FAKE_OPENCODE_VERSION", version);
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "restore.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "opencode");
    const created = await new OpenCodeRunner(config(state), store).delegate({ task: "one", cwd });
    const resumed = await new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    });
    expect(resumed.text).toBe("fresh answer");
    expect(resumed.text).not.toContain("OLD HISTORY");
    expect(resumed.toolCalls?.some((call) => call.toolCallId === "replay-tool")).toBe(false);
    expect(resumed.usage).toEqual({ used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } });
    const loaded = await new OpenCodeRunner(config(state), store).delegate({
      task: "three",
      cwd,
      sessionId: created.sessionId as string,
      resume: false,
    });
    expect(loaded.text).toBe("fresh answer");
    expect(loaded.text).not.toContain("OLD HISTORY");
    const events = await readFile(log, "utf8");
    expect(events).toContain("resume:fake-session-1");
    expect(events).toContain("load:fake-session-1");
  });

  it("does not fall back from resume or load failures", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const store = new SessionStore(state, "opencode");
    const created = await new OpenCodeRunner(config(state), store).delegate({ task: "one", cwd });
    const log = join(state, "fail.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "resume-fail");
    await expect(new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "ACP_FAILURE" });
    vi.stubEnv("FAKE_ACP_MODE", "load-fail");
    await expect(new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
      resume: false,
    })).rejects.toMatchObject({ code: "ACP_FAILURE" });
    const events = await readFile(log, "utf8");
    expect(events).toContain("resume:fake-session-1");
    expect(events).toContain("load:fake-session-1");
    expect(events).not.toContain("new:");
    expect(events).not.toContain("prompt:");
  });

  it("dispatches resume/load from advertised capabilities without creating a replacement session", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const store = new SessionStore(state, "opencode");
    const created = await new OpenCodeRunner(config(state), store).delegate({ task: "one", cwd });
    const log = join(state, "caps.log");
    vi.stubEnv("FAKE_ACP_LOG", log);

    vi.stubEnv("FAKE_ACP_MODE", "no-resume");
    await new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    });
    expect(await readFile(log, "utf8")).toContain("load:fake-session-1");
    expect(await readFile(log, "utf8")).not.toContain("resume:");

    vi.stubEnv("FAKE_ACP_MODE", "no-load");
    await expect(new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
      resume: false,
    })).rejects.toMatchObject({ code: "LOAD_UNSUPPORTED" });

    vi.stubEnv("FAKE_ACP_MODE", "no-load-no-resume");
    await expect(new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "LOAD_UNSUPPORTED" });
    const events = await readFile(log, "utf8");
    expect(events.match(/new:/g)).toBeNull();
  });

  it("skips empty auth, authenticates opencode-login, and rejects unknown methods", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "auth.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "no-auth");
    await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "one", cwd });
    expect(await readFile(log, "utf8")).not.toContain("auth:");

    vi.stubEnv("FAKE_ACP_MODE", "unknown-auth");
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({ code: "AUTH_UNAVAILABLE" });
  });

  it("configures model, effort, then mode from grouped options and allows later changes", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "config.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "grouped");
    const store = new SessionStore(state, "opencode");
    await new OpenCodeRunner(config(state), store).delegate({
      task: "one",
      cwd,
      model: "opencode/gpt",
      effort: "high",
      agent: "plan",
    });
    await new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd,
      sessionId: "fake-session-1",
      model: "opencode/fast",
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("set-config:model:opencode/gpt");
    expect(events).toContain("set-config:effort:high");
    expect(events).toContain("set-config:mode:plan");
    expect(events).toContain("set-config:model:opencode/fast");
    expect(events.indexOf("set-config:model:opencode/gpt"))
      .toBeLessThan(events.indexOf("set-config:effort:high"));
    expect(events.indexOf("set-config:effort:high"))
      .toBeLessThan(events.indexOf("set-config:mode:plan"));
    expect(events.indexOf("set-config:mode:plan")).toBeLessThan(events.indexOf("prompt:fake-session-1"));
  });

  it("rejects invalid or unsupported options and config timeouts without prompting", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "invalid.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
      model: "missing/model",
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    vi.stubEnv("FAKE_ACP_MODE", "no-effort");
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
      effort: "high",
    })).rejects.toMatchObject({ code: "CONFIG_UNSUPPORTED" });

    vi.stubEnv("FAKE_ACP_MODE", "grouped");
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
      model: "opencode/fast",
      effort: "high",
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });

    vi.stubEnv("FAKE_ACP_MODE", "config-timeout");
    await expect(new OpenCodeRunner(config(state, { phaseTimeoutMs: 1_500 }), new SessionStore(state, "opencode")).delegate({
      task: "one",
      cwd,
      model: "opencode/gpt",
    })).rejects.toMatchObject({ code: "CONFIG_TIMEOUT" });

    const events = await readFile(log, "utf8");
    expect(events).not.toContain("prompt:");
    expect(events).not.toContain("set-config:model:missing/model");
    expect(events).not.toContain("set-config:effort:high");
    expect(events).toContain("set-config:model:opencode/fast");
    expect(events).toContain("set-config:model:opencode/gpt");
  });

  it("uses the updated effort options when switching models", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "variants.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "no-effort");
    await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "variants",
      cwd,
      model: "opencode/variants",
      effort: "default",
    });
    expect(await readFile(log, "utf8")).toContain("set-config:effort:default");

    vi.stubEnv("FAKE_ACP_MODE", "normal");
    vi.stubEnv("FAKE_SESSION_ID", "without-variants");
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "no variants",
      cwd,
      model: "opencode/no-variants",
      effort: "high",
    })).rejects.toMatchObject({ code: "CONFIG_UNSUPPORTED" });
    expect(await readFile(log, "utf8")).not.toContain("prompt:without-variants");
  });

  it("rejects default effort when the provider does not advertise it", async () => {
    vi.stubEnv("FAKE_OPENCODE_VERSION", "1");
    const state = await tempDir();
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "default",
      cwd: await tempDir(),
      effort: "default",
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });

  it("records real-smoke protocol evidence without recording task or tool input", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "proxy.jsonl");
    vi.stubEnv("OPENCODE_RELAY_SMOKE_LOG", log);
    vi.stubEnv("FAKE_ACP_MODE", "permission");
    const proxy = fileURLToPath(new URL("./fixtures/opencode-smoke-proxy.mjs", import.meta.url));
    const result = await new OpenCodeRunner(config(state, {
      opencodeCommandArgs: [proxy, process.execPath, opencodeFixture],
    }), new SessionStore(state, "opencode")).delegate({ task: "private-task-content", cwd });
    expect(result.text).toBe("fresh answer");
    const recorded = await readFile(log, "utf8");
    const entries = recorded.trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toContainEqual(expect.objectContaining({ method: "session/request_permission" }));
    expect(entries).toContainEqual(expect.objectContaining({
      direction: "client",
      outcome: { outcome: "selected", optionId: "allow-once-actual" },
    }));
    expect(recorded).not.toContain("private-task-content");
    expect(recorded).not.toContain("allowed.txt");
    for (const pid of entries.flatMap((entry) => entry.pids ?? [])) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }
  });

  it.each(["success", "failure", "cancel", "timeout"])("cleans up the V2 private server after %s", async (outcome) => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "private-server.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const modes: Record<string, string> = {
      success: "private-server",
      failure: "private-server-fail",
      cancel: "private-server-hang",
      timeout: "private-server-hang",
    };
    vi.stubEnv("FAKE_ACP_MODE", modes[outcome]);
    const store = new SessionStore(state, "opencode");
    const controller = new AbortController();
    const pending = new OpenCodeRunner(config(state, {
      totalTimeoutMs: outcome === "timeout" ? 1_500 : 15_000,
    }), store).delegate({ task: "private server", cwd }, controller.signal);
    const settled = pending.then((result) => result, (error: unknown) => error);
    await waitForLog(log, "descendant:");
    if (outcome === "cancel") controller.abort();
    if (outcome === "success") {
      expect(await settled).toMatchObject({ stopReason: "end_turn" });
    } else {
      const codes: Record<string, string> = { failure: "ACP_FAILURE", cancel: "CANCELLED", timeout: "TIMEOUT" };
      expect(await settled).toMatchObject({ code: codes[outcome] });
    }
    const match = /descendant:(\d+)/.exec(await readFile(log, "utf8"));
    expect(match).not.toBeNull();
    expect(() => process.kill(Number(match?.[1]), 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("selects the actual allow_once option id and continues", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "permission");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "allow.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const result = await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "permission",
      cwd,
    });
    expect(result).toMatchObject({
      provider: "opencode",
      stopReason: "end_turn",
      text: "fresh answer",
    });
    expect(await readFile(log, "utf8")).toContain(
      'permission-response:{"outcome":{"outcome":"selected","optionId":"allow-once-actual"}}',
    );
    expect(await readFile(log, "utf8")).not.toContain("always-actual");
  });

  it("cancels when allow_once is missing and preserves partial output", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "permission-missing");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "missing.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "permission",
      cwd,
    })).rejects.toMatchObject({
      code: "PERMISSION_REQUIRED",
      partial: {
        provider: "opencode",
        sessionId: "fake-session-1",
      },
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain('permission-response:{"outcome":{"outcome":"cancelled"}}');
    expect(events.indexOf("cancel:fake-session-1")).toBeGreaterThan(events.indexOf("permission-response:"));
    expect(events).not.toContain("always-actual");
  });

  it("cancels a late permission request after caller abort and never selects allow_once", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "permission-after-cancel");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "late-permission.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "opencode");
    const controller = new AbortController();
    const pending = new OpenCodeRunner(config(state, { cancelGraceMs: 500 }), store).delegate({
      task: "hang",
      cwd,
    }, controller.signal);
    await waitForLog(log, "prompt:fake-session-1");
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
      message: "MCP request was cancelled",
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("cancel:fake-session-1");
    expect(events).toContain('permission-response:{"outcome":{"outcome":"cancelled"}}');
    expect(events).not.toContain('"outcome":"selected"');
    expect(events).not.toContain("allow-once-actual");
    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("does not send later OpenCode config options after abort between steps", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "config-hang-effort");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "config-cancel.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const store = new SessionStore(state, "opencode");
    const controller = new AbortController();
    const pending = new OpenCodeRunner(config(state, { cancelGraceMs: 500 }), store).delegate({
      task: "configure",
      cwd,
      model: "opencode/gpt",
      effort: "high",
      agent: "plan",
    }, controller.signal);
    await waitForLog(log, "set-config:effort:high");
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "CANCELLED",
      message: "MCP request was cancelled",
    });
    const events = await readFile(log, "utf8");
    expect(events).toContain("set-config:model:opencode/gpt");
    expect(events).toContain("set-config:effort:high");
    expect(events).not.toContain("set-config:mode:");
    expect(events).not.toContain("prompt:");
    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it("cancels a permission request from another session without approving it", async () => {
    vi.stubEnv("FAKE_ACP_MODE", "permission-other-session");
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "other-permission.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    const result = await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "other",
      cwd,
    });
    expect(result.stopReason).toBe("end_turn");
    expect(await readFile(log, "utf8")).toContain(
      'permission-other-response:{"outcome":{"outcome":"cancelled"}}',
    );
  });

  it("rejects invalid OPENCODE_PERMISSION without leaking contents or spawning", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "env.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    vi.stubEnv("OPENCODE_PERMISSION", "not-json {secret:1}");
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({
        code: "OPENCODE_PERMISSION_INVALID",
        message: "OPENCODE_PERMISSION must be a JSON object",
      });
    vi.stubEnv("OPENCODE_PERMISSION", "[1,2]");
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "one", cwd }))
      .rejects.toMatchObject({ code: "OPENCODE_PERMISSION_INVALID" });
    await expect(readFile(log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps latest usage, bounds tool summaries, and preserves partial provider fields", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const result = await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({
      task: "usage",
      cwd,
    });
    expect(result.usage).toEqual({ used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } });

    vi.stubEnv("FAKE_ACP_MODE", "summary-large");
    vi.stubEnv("FAKE_SESSION_ID", "summary-session");
    const large = await new OpenCodeRunner(config(state, { textLimitBytes: 100 }), new SessionStore(state, "opencode"))
      .delegate({ task: "large", cwd });
    expect(large.summariesTruncated).toBe(true);
    expect(large.truncated).toBe(true);
    expect(large.provider).toBe("opencode");

    vi.stubEnv("FAKE_ACP_MODE", "partial-fail");
    vi.stubEnv("FAKE_SESSION_ID", "partial-session");
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "fail", cwd }))
      .rejects.toMatchObject({
        code: "ACP_FAILURE",
        partial: {
          provider: "opencode",
          sessionId: "partial-session",
          text: "partial text",
          toolCalls: [expect.objectContaining({ toolCallId: "t1" })],
          usage: { used: 42, size: 128, cost: { amount: 3.5, currency: "USD" } },
        },
      });
  });

  it("rejects a cwd mismatch and nested delegation", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const other = await tempDir();
    const store = new SessionStore(state, "opencode");
    const created = await new OpenCodeRunner(config(state), store).delegate({ task: "one", cwd });
    await expect(new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd: other,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "CWD_MISMATCH" });
    vi.stubEnv("GROK_RELAY_DELEGATED", "1");
    vi.stubEnv("CODEX_AGENT_RELAY_DELEGATED", "1");
    await expect(new OpenCodeRunner(config(state), store).delegate({
      task: "two",
      cwd: other,
      sessionId: created.sessionId as string,
    })).rejects.toMatchObject({ code: "CWD_MISMATCH" });
    vi.stubEnv("AGENT_RELAY_DELEGATED", "1");
    await expect(new OpenCodeRunner(config(state), store).delegate({ task: "nested", cwd }))
      .rejects.toMatchObject({ code: "NESTED_DELEGATION" });
  });

  it("cancels a hung prompt and kills leftover descendants", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const hangLog = join(state, "hang.log");
    vi.stubEnv("FAKE_ACP_LOG", hangLog);
    vi.stubEnv("FAKE_ACP_MODE", "hang");
    await expect(new OpenCodeRunner(config(state, { totalTimeoutMs: 1_500 }), new SessionStore(state, "opencode"))
      .delegate({ task: "hang", cwd })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(await readFile(hangLog, "utf8")).toContain("cancel:fake-session-1");
    const lease = await new SessionStore(state, "opencode").acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();

    vi.stubEnv("FAKE_ACP_MODE", "descendant");
    vi.stubEnv("FAKE_SESSION_ID", "descendant-session");
    const descendantLog = join(state, "descendant.log");
    vi.stubEnv("FAKE_ACP_LOG", descendantLog);
    await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "descendant", cwd });
    const match = /descendant:(\d+)/.exec(await readFile(descendantLog, "utf8"));
    expect(match).not.toBeNull();
    expect(() => process.kill(Number(match?.[1]), 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it.each(["exit", "malformed"])("reports %s child failure without claiming Windows cleanup success", async (mode) => {
    vi.stubEnv("FAKE_ACP_MODE", mode);
    const state = await tempDir();
    const cwd = await tempDir();
    await expect(new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: mode, cwd }))
      .rejects.toMatchObject({ code: process.platform === "win32" ? "PROCESS_CLEANUP_FAILED" : "ACP_FAILURE" });
    if (process.platform === "win32") {
      await expect(new SessionStore(state).acquire(cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    }
  });
});

describe("OpenCode permission overlay", () => {
  it("sets question deny when OPENCODE_PERMISSION is absent", async () => {
    const state = await tempDir();
    const cwd = await tempDir();
    const log = join(state, "default-env.log");
    vi.stubEnv("FAKE_ACP_LOG", log);
    await new OpenCodeRunner(config(state), new SessionStore(state, "opencode")).delegate({ task: "one", cwd });
    expect(await readFile(log, "utf8")).toContain('permission-env:{"question":"deny"}');
  });
});
