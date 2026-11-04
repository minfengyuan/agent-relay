import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ClaudeRunner } from "../src/runner.js";
import type * as ProcessTree from "../src/runner/process-tree.js";
import { SessionStore } from "../src/store.js";
import { baseConfig, tempDir, useRunnerCleanup } from "./helpers.js";

vi.mock("../src/runner/process-tree.js", async (load) => {
  const actual = await load<typeof ProcessTree>();
  return {
    ...actual,
    createProcessTreeController: (...args: Parameters<typeof actual.createProcessTreeController>) => {
      const controller = actual.createProcessTreeController(...args);
      return {
        reference: controller.reference,
        terminate: async () => {
          const report = await controller.terminate();
          return { ...report, confirmed: false, reason: "Fixture withheld cleanup confirmation" };
        },
      };
    },
  };
});

const dirs: string[] = [];
useRunnerCleanup(dirs);

it.each(["normal", "partial-fail"])("retains the lease when Claude cleanup is unconfirmed after %s", async (mode) => {
  const state = await tempDir(dirs);
  const cwd = await tempDir(dirs);
  vi.stubEnv("FAKE_ACP_MODE", mode);
  const store = new SessionStore(state, "claude");
  await expect(new ClaudeRunner(baseConfig(state), store).delegate({ task: "one", cwd })).rejects.toMatchObject({
    code: "PROCESS_CLEANUP_FAILED",
    partial: { provider: "claude", sessionId: "claude-session", text: "fresh answer" },
  });
  const locks = (await readdir(store.locksDir)).filter((entry) => entry.endsWith(".lock"));
  expect(locks).toHaveLength(1);
  const owner = JSON.parse(await readFile(join(store.locksDir, locks[0]!, "owner.json"), "utf8"));
  expect(owner.phase).toBe("orphaned");
  expect(() => process.kill(owner.worker.pid, 0)).toThrow();
  await expect(store.acquire(cwd)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
});
