import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ProcessTree from "../src/runner/process-tree.js";
import { SessionStore, type WorkspaceLease } from "../src/store.js";
import { RelayFailure } from "../src/types.js";
import { cleanupAllChildren } from "../src/runner.js";
import { WorkerHost, type WorkerContext } from "../src/runner/worker-host.js";
import { baseConfig, cleanupDirs, clearDelegatedEnv, tempDir } from "./helpers.js";

const state = vi.hoisted(() => ({
  children: [] as ChildProcessWithoutNullStreams[],
  cleanupConfirmed: true,
}));

vi.mock("../src/runner/process-tree.js", async (load) => {
  const actual = await load<typeof ProcessTree>();
  return {
    ...actual,
    createProcessTreeController: (...args: Parameters<typeof actual.createProcessTreeController>) => {
      state.children.push(args[0]);
      const real = actual.createProcessTreeController(...args);
      return {
        reference: real.reference,
        terminate: async () => {
          const report = await real.terminate();
          return state.cleanupConfirmed ? report
            : { forced: report.forced, confirmed: false, reason: "injected cleanup uncertainty" };
        },
      };
    },
  };
});

const dirs: string[] = [];
const helperArgs = () => ["-e", "setInterval(() => {}, 1000)"];

class FaultStore extends SessionStore {
  constructor(root: string, private readonly failLease: boolean) { super(root); }
  override async acquire(cwd: string): Promise<WorkspaceLease> {
    const lease = await super.acquire(cwd);
    if (this.failLease) {
      lease.markTerminating = async () => { throw new RelayFailure("LOCK_IO", "injected lease failure"); };
    }
    return lease;
  }
}

beforeEach(() => {
  clearDelegatedEnv();
  state.cleanupConfirmed = true;
});

afterEach(async () => {
  state.cleanupConfirmed = true;
  await cleanupAllChildren().catch(() => undefined);
  for (const child of state.children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  vi.unstubAllEnvs();
  await cleanupDirs(dirs);
});

async function setup(failLease = false) {
  const stateDir = await tempDir(dirs);
  const cwd = await tempDir(dirs);
  return { stateDir, cwd, host: new WorkerHost(baseConfig(stateDir), new FaultStore(stateDir, failLease)) };
}

function driver(displayName: string) {
  return {
    displayName,
    failureCode: "CODEX_FAILURE" as const,
    invocation: () => ({ command: process.execPath, args: helperArgs() }),
    drive: async (ctx: WorkerContext) => { await ctx.ready; throw new RelayFailure("CODEX_FAILURE", "original failure"); },
  };
}

describe("WorkerHost", () => {
  it("prefers cleanup failure over lease failure and the original error", async () => {
    state.cleanupConfirmed = false;
    const { cwd, host } = await setup(true);
    await expect(host.run({ ...driver("Worker"), cwd })).rejects.toMatchObject({
      code: "PROCESS_CLEANUP_FAILED",
      message: expect.stringContaining("original error CODEX_FAILURE"),
    });
  });

  it("prefers a lease failure over the original error", async () => {
    const { cwd, host } = await setup(true);
    await expect(host.run({ ...driver("Worker"), cwd })).rejects.toMatchObject({
      code: "LOCK_IO",
      message: "injected lease failure",
    });
  });

  it("reports the original error after confirmed cleanup and lease release", async () => {
    const { stateDir, cwd, host } = await setup();
    await expect(host.run({ ...driver("Worker"), cwd })).rejects.toMatchObject({
      code: "CODEX_FAILURE",
      message: "original failure",
    });
    const lease = await new SessionStore(stateDir).acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });

  it.each([
    { confirmed: false, disposed: false },
    { confirmed: true, disposed: true },
  ])("disposes prepared state only after confirmed tree cleanup ($confirmed)", async ({ confirmed, disposed }) => {
    state.cleanupConfirmed = confirmed;
    const { cwd, host } = await setup();
    let preparedDisposed = false;
    await expect(host.run({
      ...driver("Worker"),
      cwd,
      prepare: async (env) => ({ env, dispose: async () => { preparedDisposed = true; } }),
    })).rejects.toMatchObject({ code: confirmed ? "CODEX_FAILURE" : "PROCESS_CLEANUP_FAILED" });
    expect(preparedDisposed).toBe(disposed);
  });

  it("terminates a helper subprocess when the total timeout expires", async () => {
    const { stateDir, cwd } = await setup();
    const host = new WorkerHost(baseConfig(stateDir, { totalTimeoutMs: 200 }), new SessionStore(stateDir));
    await expect(host.runHelper({
      cwd, displayName: "Helper", failureCode: "CODEX_FAILURE",
      invocation: () => ({ command: process.execPath, args: helperArgs() }),
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    const child = state.children.at(-1);
    expect(child).toBeDefined();
    expect(child !== undefined && (child.exitCode !== null || child.signalCode !== null)).toBe(true);
    const lease = await new SessionStore(stateDir).acquire(cwd);
    await lease.markReaped("no-worker-created");
    await lease.release();
  });
});
