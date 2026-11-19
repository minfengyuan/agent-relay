import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgyRunner, cleanupAllChildren } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { tempDir } from "./helpers.js";

const enabled = process.env.RUN_AGY_REAL_TESTS === "1" || process.env.npm_lifecycle_event === "test:real:agy";
const describeReal = enabled ? describe : describe.skip;
const roots: string[] = [];

afterEach(async () => {
  try {
    await cleanupAllChildren();
  } finally {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }
});

describeReal("real AGY ACP smoke", () => {
  it("creates, resumes across processes, and edits a disposable workspace", async () => {
    if (process.env.AGENT_RELAY_DELEGATED === "1") throw new Error("Run real AGY smoke outside a delegated worker");
    const root = await tempDir(roots, "agy-real-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "README.md"), "workspace\n");
    const config = { ...loadConfig(), stateDir: join(root, "state"), totalTimeoutMs: 120_000 };
    const store = new SessionStore(config.stateDir, "agy");
    const nonce = randomUUID();

    const created = await new AgyRunner(config, store).delegate({
      task: `Remember ${nonce} and reply with exactly STORED. Do not write the nonce to a file.`,
      cwd: workspace,
      ...(process.env.AGY_TEST_MODEL?.trim() ? { model: process.env.AGY_TEST_MODEL.trim() } : {}),
      ...(process.env.AGY_TEST_EFFORT?.trim() ? { effort: process.env.AGY_TEST_EFFORT.trim() } : {}),
    });
    expect(created.provider).toBe("agy");
    expect(created.sessionId).toBeTruthy();
    expect(created.text).toContain("STORED");
    expect(await readdir(workspace)).toEqual(["README.md"]);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe("workspace\n");

    const resumed = await new AgyRunner(config, store).delegate({
      task: "Reply with the exact nonce I asked you to remember.",
      cwd: workspace,
      sessionId: created.sessionId as string,
    });
    expect(resumed.sessionId).toBe(created.sessionId);
    expect(resumed.text).toContain(nonce);

    const edited = await new AgyRunner(config, store).delegate({
      task: "Create smoke.txt containing exactly agy-smoke followed by a newline. Do not ask questions.",
      cwd: workspace,
      mode: "accept-edits",
    });
    expect(edited.error).toBeUndefined();
    expect(await readFile(join(workspace, "smoke.txt"), "utf8")).toBe("agy-smoke\n");

    const lease = await store.acquire(workspace);
    await lease.markReaped("no-worker-created");
    await lease.release();
  }, 360_000);
});
