import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { grokAdapter } from "../src/adapters/grok.js";
import { HeadlessRunner } from "../src/runner/headless-runner.js";
import { SessionStore, resolveCwd } from "../src/store.js";
import { assertHeadlessVersion, observeHeadlessEvents } from "./headless-baseline.js";

const enabled = process.env.RUN_GROK_REAL_TESTS === "1" || process.env.npm_lifecycle_event === "test:real";
const stateDir = enabled ? await mkdtemp(join(tmpdir(), "relay-real-")) : "";
const workspaceDir = enabled ? await mkdtemp(join(tmpdir(), "relay-real-workspace-")) : "";
afterAll(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
  if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true });
});

describe.skipIf(!enabled)("real Grok headless smoke", () => {
  it("creates and resumes a session across child processes", async () => {
    const cwd = await resolveCwd(workspaceDir);
    const nonce = `relay-${randomBytes(12).toString("hex")}`;
    const config = { ...loadConfig(), stateDir };
    await assertHeadlessVersion("grok", { command: config.command, args: [] });
    const observed = observeHeadlessEvents("grok", grokAdapter(config));
    const first = await new HeadlessRunner(config, new SessionStore(stateDir), observed.adapter).delegate({
      task: `Remember this secret nonce for the next turn: ${nonce}. Do not write it to a file and do not repeat it now. Reply only READY.`, cwd,
    });
    expect(first.sessionId).toBeTruthy();
    expect(first.text).toContain("READY");
    expect(first.text).not.toContain(nonce);
    observed.assertEvents(["text", "end"]);
    const resumedEvents = observeHeadlessEvents("grok", grokAdapter(config));
    const second = await new HeadlessRunner(config, new SessionStore(stateDir), resumedEvents.adapter).delegate({
      task: "Reply with only the secret nonce I asked you to remember in the previous turn.", cwd, sessionId: first.sessionId as string,
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.text).toContain(nonce);
    resumedEvents.assertEvents(["text", "end"]);
  }, 120_000);
});
