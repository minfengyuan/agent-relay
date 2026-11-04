import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { beginRunnerShutdown, ClaudeRunner, CodexRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { baseConfig, cleanupDirs, clearDelegatedEnv, tempDir, waitForLog } from "./helpers.js";

it("shuts down Claude and native workers together and closes admission", async () => {
  clearDelegatedEnv();
  const dirs: string[] = [];
  const state = await tempDir(dirs);
  const cwd = await tempDir(dirs);
  const other = await tempDir(dirs);
  const config = baseConfig(state);
  const log = join(state, "claude.log");
  const nativeLog = join(state, "native.log");
  vi.stubEnv("FAKE_ACP_LOG", log);
  vi.stubEnv("FAKE_ACP_MODE", "hang");
  vi.stubEnv("CODEX_FIXTURE_LOG", nativeLog);
  const runner = new ClaudeRunner(config, new SessionStore(state, "claude"));
  const claude = runner.delegate({ task: "hang", cwd }).catch((error: unknown) => error);
  const native = new CodexRunner(config, new SessionStore(state, "codex")).delegate({ task: "hang", cwd: other }).catch((error: unknown) => error);
  try {
    await Promise.all([waitForLog(log, "prompt:claude-session"), waitForLog(nativeLog, '"prompt":"hang"')]);
    const shutdown = beginRunnerShutdown();
    expect(beginRunnerShutdown()).toBe(shutdown);
    await expect(runner.delegate({ task: "late", cwd })).rejects.toMatchObject({ code: "CANCELLED" });
    await shutdown;
    expect(await claude).toMatchObject({ code: "CANCELLED" });
    expect(await native).toMatchObject({ code: "CANCELLED" });
    for (const path of [cwd, other]) {
      const lease = await new SessionStore(state).acquire(path);
      await lease.markReaped("no-worker-created");
      await lease.release();
    }
  } finally {
    await beginRunnerShutdown().catch(() => undefined);
    await Promise.all([claude, native]);
    vi.unstubAllEnvs();
    await cleanupDirs(dirs);
  }
});
