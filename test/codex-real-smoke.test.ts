import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { CodexRunner } from "../src/runner.js";
import { SessionStore } from "../src/store.js";
import { tempDir, useRunnerCleanup } from "./helpers.js";

const enabled = process.env.RUN_CODEX_REAL_TESTS === "1" || process.env.npm_lifecycle_event === "test:real:codex";
const dirs: string[] = [];
useRunnerCleanup(dirs);

describe.skipIf(!enabled)("real native Codex smoke", () => {
  it("creates, resumes, edits a disposable workspace, and releases its process/lease", async () => {
    const stateDir = await tempDir(dirs, "codex-real-state-");
    const cwd = await tempDir(dirs, "codex-real-workspace-");
    const config = { ...loadConfig(), stateDir };
    const store = new SessionStore(stateDir, "codex");
    const nonce = randomBytes(12).toString("hex");
    const first = await new CodexRunner(config, store).delegate({
      task: `Remember this nonce for the next turn: ${nonce}. Do not write it to a file or repeat it. Reply only READY.`, cwd,
    });
    expect(first.provider).toBe("codex"); expect(first.stopReason).toBe("completed");
    expect(first.sessionId).toBeTruthy(); expect(first.text).toContain("READY");
    expect(first.text).not.toContain(nonce);
    const second = await new CodexRunner(config, store).delegate({
      task: "Reply with only the nonce I asked you to remember in the previous turn.", cwd, sessionId: first.sessionId!,
    });
    expect(second.sessionId).toBe(first.sessionId); expect(second.text).toContain(nonce);
    await new CodexRunner(config, store).delegate({
      task: "Create codex-smoke.txt containing exactly codex-smoke followed by a newline. Do not ask questions.", cwd, sessionId: first.sessionId!,
    });
    expect(await readFile(join(cwd, "codex-smoke.txt"), "utf8")).toBe("codex-smoke\n");
    const lease = await store.acquire(cwd);
    await lease.markReaped("no-worker-created"); await lease.release();
  }, 240_000);
});
