import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { claudeAdapter, claudeSpawnSpec } from "../src/adapters/claude.js";
import { cleanupAllChildren } from "../src/runner.js";
import { HeadlessRunner } from "../src/runner/headless-runner.js";
import { SessionStore } from "../src/store.js";
import { tempDir } from "./helpers.js";
import { assertHeadlessVersion, observeHeadlessEvents } from "./headless-baseline.js";

const enabled = process.env.RUN_CLAUDE_REAL_TESTS === "1" || process.env.npm_lifecycle_event === "test:real:claude";
const roots: string[] = [];

afterEach(async () => {
  try {
    await cleanupAllChildren();
  } finally {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  }
});

describe.skipIf(!enabled)("real Claude Code headless smoke", () => {
  it("edits a disposable workspace and restores a persistent session across processes", async () => {
    if (process.env.AGENT_RELAY_DELEGATED === "1") throw new Error("Run real Claude smoke outside a delegated worker");
    const root = await tempDir(roots, "claude-real-");
    const cwd = join(root, "workspace");
    await mkdir(cwd);
    const config = { ...loadConfig(), stateDir: join(root, "state"), totalTimeoutMs: 150000 };
    await assertHeadlessVersion("claude", claudeSpawnSpec({ ...config, claudeCommandArgs: [] }));
    const store = new SessionStore(config.stateDir, "claude");
    const marker = randomUUID();
    const createdEvents = observeHeadlessEvents("claude", claudeAdapter(config));
    const created = await new HeadlessRunner(config, store, createdEvents.adapter).delegate({
      task: `Remember the marker ${marker} for a later turn. Create proof.txt containing exactly this marker. Use file editing tools directly. Do not run shell commands or ask questions.`,
      cwd,
      ...(process.env.CLAUDE_TEST_MODEL?.trim() ? { model: process.env.CLAUDE_TEST_MODEL.trim() } : {}),
      ...(process.env.CLAUDE_TEST_EFFORT?.trim() ? { effort: process.env.CLAUDE_TEST_EFFORT.trim() } : {}),
    });
    expect(created.sessionId).toBeTruthy();
    expect((await readFile(join(cwd, "proof.txt"), "utf8")).trim()).toBe(marker);
    createdEvents.assertEvents(["system", "assistant", "result"]);
    await rm(join(cwd, "proof.txt"));
    const restoredEvents = observeHeadlessEvents("claude", claudeAdapter(config));
    const restored = await new HeadlessRunner(config, store, restoredEvents.adapter).delegate({
      task: "Create restored.txt containing exactly the marker from the preceding turn. Use file editing tools directly. Do not run shell commands or ask questions.",
      cwd, sessionId: created.sessionId!,
    });
    expect(restored.sessionId).toBe(created.sessionId);
    expect((await readFile(join(cwd, "restored.txt"), "utf8")).trim()).toBe(marker);
    restoredEvents.assertEvents(["system", "assistant", "result"]);
    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  }, 360000);
});
