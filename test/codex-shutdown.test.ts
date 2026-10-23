import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { beginRunnerShutdown, CodexRunner, GrokRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { baseConfig, cleanupDirs, clearDelegatedEnv, tempDir, waitForLog } from "./helpers.js";

it("shuts down native and ACP workers together and rejects new Codex tasks", async () => {
  clearDelegatedEnv();
  const dirs: string[] = [];
  const state = await tempDir(dirs), cwd = await tempDir(dirs), other = await tempDir(dirs);
  const config = baseConfig(state);
  const log = join(state, "codex.log"), acpLog = join(state, "acp.log");
  vi.stubEnv("CODEX_FIXTURE_LOG", log);
  vi.stubEnv("FAKE_ACP_MODE", "hang");
  vi.stubEnv("FAKE_ACP_LOG", acpLog);
  const runner = new CodexRunner(config, new SessionStore(state, "codex"));
  const native = runner.delegate({ task: "hang", cwd }).catch((error: unknown) => error);
  const acp = new GrokRunner(config, new SessionStore(state)).delegate({ task: "hang", cwd: other }).catch((error: unknown) => error);
  try {
    await Promise.all([waitForLog(log, '"prompt":"hang"'), waitForLog(acpLog, "prompt:fake-session-1")]);
    const shutdown = beginRunnerShutdown();
    expect(beginRunnerShutdown()).toBe(shutdown);
    await expect(runner.delegate({ task: "hello", cwd })).rejects.toMatchObject({ code: "CANCELLED" });
    await shutdown;
    expect(await native).toMatchObject({ code: "CANCELLED" });
    expect(await acp).toMatchObject({ code: "CANCELLED" });
    for (const path of [cwd, other]) {
      const lease = await new SessionStore(state).acquire(path);
      await lease.markReaped("no-worker-created"); await lease.release();
    }
  } finally {
    await beginRunnerShutdown().catch(() => undefined);
    await Promise.all([native, acp]);
    vi.unstubAllEnvs(); await cleanupDirs(dirs);
  }
});
