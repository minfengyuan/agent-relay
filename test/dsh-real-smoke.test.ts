import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dshAdapter, dshSpawnSpec } from "../src/adapters/dsh.js";
import { loadConfig } from "../src/config.js";
import { cleanupAllChildren } from "../src/runner.js";
import { HeadlessRunner } from "../src/runner/headless-runner.js";
import { SessionStore, resolveCwd } from "../src/store.js";
import { assertHeadlessVersion, observeHeadlessEvents } from "./headless-baseline.js";

const execFileAsync = promisify(execFile);
const enabled = process.env.RUN_DSH_REAL_TESTS === "1" || process.env.npm_lifecycle_event === "test:real:dsh";
const describeReal = enabled ? describe : describe.skip;
const roots: string[] = [];
// Three sequential turns, CLI preflight, and cleanup must fit inside the test.
const TEST_TIMEOUT_MS = 600_000;
const TASK_TIMEOUT_MS = 150_000;

afterEach(async () => {
  vi.unstubAllEnvs();
  try {
    await cleanupAllChildren();
  } finally {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }
});

async function assertNoActiveLease(state: string, cwd: string): Promise<void> {
  const lease = await new SessionStore(state, "dsh").acquire(cwd);
  await lease.markReaped("no-worker-created");
  await lease.release();
}

describeReal("real DSH headless smoke", () => {
  it("creates, resumes across processes, and edits a disposable workspace", async () => {
    if (process.env.AGENT_RELAY_DELEGATED === "1") {
      throw new Error("Real DSH smoke is unavailable inside a delegated worker (NESTED_DELEGATION); run it from the parent environment");
    }
    const loaded = loadConfig();
    await assertHeadlessVersion("dsh", dshSpawnSpec({ ...loaded, dshCommandArgs: [] }));
    const help = dshSpawnSpec({ ...loaded, dshCommandArgs: ["--profile", "headless", "--help"] });
    await execFileAsync(help.command, help.args, { timeout: 15_000 });

    const root = await resolveCwd(await mkdtemp(join(tmpdir(), "dsh-real-")));
    roots.push(root);
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "README.md"), "workspace\n");
    const config = { ...loaded, stateDir: state, totalTimeoutMs: TASK_TIMEOUT_MS };
    const observed = observeHeadlessEvents("dsh", dshAdapter(config));
    const nonce = randomUUID();
    try {
      const created = await new HeadlessRunner(config, new SessionStore(state, "dsh"), observed.adapter).delegate({
        task: `Remember ${nonce} and reply with exactly STORED. Do not write the nonce to a file.`,
        cwd: workspace,
      });
      expect(created.provider).toBe("dsh");
      expect(created.sessionId).toBeTruthy();
      expect(created.text).toContain("STORED");
      expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("workspace\n");
      const names = await readdir(workspace);
      expect(names.filter((name) => !name.startsWith("."))).toEqual(["README.md"]);
      observed.assertEvents(["session", "text", "final"]);
      await assertNoActiveLease(state, workspace);

      await cleanupAllChildren();
      const resumedEvents = observeHeadlessEvents("dsh", dshAdapter(config));
      const resumed = await new HeadlessRunner(config, new SessionStore(state, "dsh"), resumedEvents.adapter).delegate({
        task: "Reply with the exact nonce I asked you to remember. Do not read files to recover it.",
        cwd: workspace,
        sessionId: created.sessionId as string,
      });
      expect(resumed.sessionId).toBe(created.sessionId);
      expect(resumed.text).toContain(nonce);
      resumedEvents.assertEvents(["session", "text", "final"]);
      await assertNoActiveLease(state, workspace);

      const editEvents = observeHeadlessEvents("dsh", dshAdapter(config));
      const edit = await new HeadlessRunner(config, new SessionStore(state, "dsh"), editEvents.adapter).delegate({
        task: "Create smoke.txt containing exactly dsh-smoke followed by a newline. Do not ask questions.",
        cwd: workspace,
      });
      expect(edit.error).toBeUndefined();
      expect(await readFile(join(workspace, "smoke.txt"), "utf8")).toBe("dsh-smoke\n");
      editEvents.assertEvents(["session", "tool_call", "tool_result", "final"]);
      await assertNoActiveLease(state, workspace);
    } finally {
      await cleanupAllChildren();
    }
  }, TEST_TIMEOUT_MS);

  it("optionally resumes after setting DSH_TEST_MODEL and DSH_TEST_REASONING_EFFORT", async (context) => {
    if (process.env.AGENT_RELAY_DELEGATED === "1") {
      throw new Error("Real DSH smoke is unavailable inside a delegated worker (NESTED_DELEGATION); run it from the parent environment");
    }
    const model = process.env.DSH_TEST_MODEL?.trim();
    const reasoningEffort = process.env.DSH_TEST_REASONING_EFFORT?.trim();
    if (!model && !reasoningEffort) {
      context.skip("DSH_TEST_MODEL / DSH_TEST_REASONING_EFFORT not set; config resume unverified");
      return;
    }
    const root = await resolveCwd(await mkdtemp(join(tmpdir(), "dsh-real-config-")));
    roots.push(root);
    const state = join(root, "state");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const config = { ...loadConfig(), stateDir: state, totalTimeoutMs: TASK_TIMEOUT_MS };
    await assertHeadlessVersion("dsh", dshSpawnSpec({ ...config, dshCommandArgs: [] }));
    const observed = observeHeadlessEvents("dsh", dshAdapter(config));
    try {
      const created = await new HeadlessRunner(config, new SessionStore(state, "dsh"), observed.adapter).delegate({
        task: "Reply with exactly READY.",
        cwd: workspace,
      });
      await assertNoActiveLease(state, workspace);
      observed.assertEvents(["session", "text", "final"]);
      await cleanupAllChildren();
      const resumedEvents = observeHeadlessEvents("dsh", dshAdapter(config));
      const resumed = await new HeadlessRunner(config, new SessionStore(state, "dsh"), resumedEvents.adapter).delegate({
        task: "Reply with exactly CONFIGURED.",
        cwd: workspace,
        sessionId: created.sessionId as string,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
      expect(resumed.text).toContain("CONFIGURED");
      resumedEvents.assertEvents(["session", "text", "final"]);
      await assertNoActiveLease(state, workspace);
    } finally {
      await cleanupAllChildren();
    }
  }, TEST_TIMEOUT_MS);
});
