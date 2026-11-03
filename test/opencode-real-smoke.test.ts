import type * as acp from "@agentclientprotocol/sdk";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { cleanupAllChildren, OpenCodeRunner } from "../src/runner.js";
import { configSelectValues } from "../src/runner/helpers.js";
import { SessionStore } from "../src/store.js";
import { waitForLog } from "./helpers.js";

const enabled = process.env.RUN_OPENCODE_REAL_TESTS === "1" || process.env.npm_lifecycle_event === "test:real:opencode";
const describeReal = enabled ? describe : describe.skip;
const roots: string[] = [];
const proxy = fileURLToPath(new URL("./fixtures/opencode-smoke-proxy.mjs", import.meta.url));

type Trace = {
  direction?: string;
  method?: string;
  id?: number | string;
  update?: string;
  title?: string;
  options?: { optionId: string; kind: string }[];
  outcome?: { outcome: string; optionId?: string };
  configOptions?: acp.SessionConfigOption[];
  agentInfo?: { name: string; version: string };
  pids?: number[];
};

async function trace(log: string): Promise<Trace[]> {
  return (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Trace);
}

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-real-")));
  roots.push(root);
  const workspace = join(root, "工作目录 with spaces");
  await mkdir(workspace);
  const log = join(root, "acp.jsonl");
  vi.stubEnv("OPENCODE_RELAY_SMOKE_LOG", log);
  const original = loadConfig();
  const config = {
    ...original,
    opencodeCommand: process.execPath,
    opencodeCommandArgs: [proxy, original.opencodeCommand ?? "opencode"],
    totalTimeoutMs: 90_000,
  };
  const store = new SessionStore(join(root, "state"), "opencode");
  return { workspace, log, config, store };
}

async function assertCleaned(log: string, store: SessionStore, workspace: string) {
  const entries = await trace(log);
  const pids = new Set(entries.flatMap((entry) => entry.pids ?? []));
  expect(pids.size).toBeGreaterThanOrEqual(process.platform === "win32" ? 2 : 3);
  for (const pid of pids) {
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }
  const lease = await store.acquire(workspace);
  await lease.markReaped("no-worker-created");
  await lease.release();
}

afterEach(async () => {
  try {
    await cleanupAllChildren();
  } finally {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }
});

describeReal("real OpenCode ACP smoke", () => {
  it("creates, resumes across processes, force-loads, and edits a disposable workspace", async () => {
    const { workspace, log, config, store } = await setup();
    await writeFile(join(workspace, "README.md"), "workspace\n");
    const nonce = randomUUID();
    const created = await new OpenCodeRunner(config, store).delegate({
      task: `Remember ${nonce} and reply with exactly STORED. Do not write the nonce to a file.`,
      cwd: workspace,
    });
    expect(created.provider).toBe("opencode");
    expect(created.sessionId).toBeTruthy();
    expect(created.text).toContain("STORED");
    const resumed = await new OpenCodeRunner(config, store).delegate({
      task: "Reply with the exact nonce I asked you to remember.",
      cwd: workspace,
      sessionId: created.sessionId as string,
    });
    expect(resumed.sessionId).toBe(created.sessionId);
    expect(resumed.text).toContain(nonce);
    const loaded = await new OpenCodeRunner(config, store).delegate({
      task: "Reply with exactly LOADED.",
      cwd: workspace,
      sessionId: created.sessionId as string,
      resume: false,
    });
    expect(loaded.sessionId).toBe(created.sessionId);
    expect(loaded.text).toContain("LOADED");
    const edit = await new OpenCodeRunner(config, store).delegate({
      task: "Create smoke.txt containing exactly opencode-smoke followed by a newline. Do not ask questions.",
      cwd: workspace,
    });
    expect(edit.error).toBeUndefined();
    expect(await readFile(join(workspace, "smoke.txt"), "utf8")).toBe("opencode-smoke\n");
    console.log("OpenCode real version:", (await trace(log)).find((entry) => entry.agentInfo)?.agentInfo);
    await assertCleaned(log, store, workspace);
  }, 360_000);

  it("refuses permission requests even when allow_once is offered", async () => {
    const { workspace, log, config, store } = await setup();
    await writeFile(join(workspace, "opencode.json"), `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      agents: {
        build: {
          permissions: [
            { action: "edit", resource: "*", effect: "ask" },
            { action: "shell", resource: "*", effect: "deny" },
          ],
        },
      },
    })}\n`);
    await expect(new OpenCodeRunner(config, store).delegate({
      task: "Using the built-in edit or write tool only (not bash or a shell command), create permission-probe.txt containing exactly probe followed by a newline. Do not ask questions.",
      cwd: workspace,
      agent: "build",
    })).rejects.toMatchObject({ code: "PERMISSION_REQUIRED" });
    await expect(readFile(join(workspace, "permission-probe.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const entries = await trace(log);
    const permission = entries.find((entry) => entry.method === "session/request_permission");
    expect(permission).toBeDefined();
    expect(permission?.options?.some((option) => option.kind === "allow_once")).toBe(true);
    const reject = permission?.options?.find((option) => option.kind === "reject_once");
    expect(entries).toContainEqual(expect.objectContaining({
      direction: "client",
      id: permission?.id,
      outcome: reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" },
    }));
    await assertCleaned(log, store, workspace);
  }, 180_000);

  it("sets advertised model, default effort, and agent and preserves them on resume", async () => {
    const { workspace, log, config, store } = await setup();
    const created = await new OpenCodeRunner(config, store).delegate({
      task: "Reply with exactly OPTIONS.",
      cwd: workspace,
    });
    const options = (await trace(log)).find((entry) => entry.configOptions)?.configOptions ?? [];
    const model = options.find((option) => option.id === "model")?.currentValue;
    const agent = options.find((option) => option.id === "mode")?.currentValue;
    const effort = options.find((option) => option.id === "effort");
    console.log("OpenCode advertised configuration:", {
      model,
      agent,
      efforts: effort ? configSelectValues(effort) : [],
    });
    expect(typeof model).toBe("string");
    expect(typeof agent).toBe("string");
    expect(effort, "real effort validation requires a default model with variants").toBeDefined();
    expect(configSelectValues(effort!)).toContain("default");
    const configured = await new OpenCodeRunner(config, store).delegate({
      task: "Reply with exactly CONFIGURED.",
      cwd: workspace,
      sessionId: created.sessionId as string,
      model: model as string,
      effort: "default",
      agent: agent as string,
    });
    expect(configured.text).toContain("CONFIGURED");
    const resumed = await new OpenCodeRunner(config, store).delegate({
      task: "Reply with exactly RESTORED.",
      cwd: workspace,
      sessionId: created.sessionId as string,
    });
    expect(resumed.text).toContain("RESTORED");
    const restored = (await trace(log)).filter((entry) => entry.configOptions).at(-1)?.configOptions ?? [];
    expect(restored.find((option) => option.id === "model")?.currentValue).toBe(model);
    expect(restored.find((option) => option.id === "mode")?.currentValue).toBe(agent);
    expect(restored.find((option) => option.id === "effort")?.currentValue).toBe("default");
    await assertCleaned(log, store, workspace);
  }, 300_000);

  it("cancels a real question tool without waiting for an answer", async () => {
    const { workspace, log, config, store } = await setup();
    const result = await new OpenCodeRunner(config, store).delegate({
      task: "Exercise the question tool exactly once now: ask which color to use, with red and blue options. This is a test of automatic question cancellation, so call the question tool even though this task is noninteractive. If the question is cancelled, stop and report that outcome.",
      cwd: workspace,
      agent: "build",
    });
    expect(result.stopReason).toBe("cancelled");
    expect((await trace(log)).some((entry) => entry.update === "tool_call" && /question/i.test(entry.title ?? "")),
      "the model must actually invoke the question tool").toBe(true);
    await assertCleaned(log, store, workspace);
  }, 120_000);

  it.each(["cancel", "timeout"])("cleans up the real private server after %s", async (outcome) => {
    const { workspace, log, config, store } = await setup();
    const controller = new AbortController();
    const pending = new OpenCodeRunner({
      ...config,
      totalTimeoutMs: outcome === "timeout" ? 20_000 : 90_000,
    }, store).delegate({
      task: "Use the shell tool to run node -e 'setTimeout(() => {}, 120000)' and wait for completion. Do not replace this command with a different operation.",
      cwd: workspace,
    }, controller.signal);
    const settled = pending.then((result) => result, (error: unknown) => error);
    await waitForLog(log, '"update":"tool_call"', 60_000);
    if (outcome === "cancel") controller.abort();
    expect(await settled).toMatchObject({ code: outcome === "cancel" ? "CANCELLED" : "TIMEOUT" });
    await assertCleaned(log, store, workspace);
  }, 120_000);
});
