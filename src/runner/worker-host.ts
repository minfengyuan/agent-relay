import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RelayConfig } from "../config.js";
import type { SessionRecord, SessionStore, WorkspaceLease } from "../store.js";
import { RelayFailure, type RelayErrorCode, type RelayResultPartial } from "../types.js";
import { appendLimited, boundedString, withTimeout } from "./limits.js";
import {
  assertRunnerAccepting, cleanupDiagnostics, registerActiveTask, unregisterActiveTask,
  type ActiveTask, type CleanupReport,
} from "./lifecycle.js";
import { createProcessTreeController, processTreeSpawnOptions, type ProcessTreeController, type TerminationReport } from "./process-tree.js";
import type { PreparedSpawn } from "./types.js";

export type WorkerContext = {
  child: ChildProcessWithoutNullStreams;
  record: SessionRecord | undefined;
  signal: AbortSignal;
  ready: Promise<void>;
  abort(failure: RelayFailure): void;
  run<T>(promise: Promise<T>): Promise<T>;
};

export type WorkerOptions = {
  cwd: string;
  sessionId?: string;
  displayName: string;
  failureCode: RelayErrorCode;
  invocation(record?: SessionRecord): { command: string; args: string[] };
  prepare?(env: NodeJS.ProcessEnv, record: SessionRecord | undefined, runHelper: PreparationHelper): Promise<PreparedSpawn>;
  partial?(record: SessionRecord | undefined): RelayResultPartial;
  onStderr?(tail: string): void;
};

export type PreparationHelper = (options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}) => Promise<HelperResult>;

export type WorkerDriver<T> = WorkerOptions & {
  drive(ctx: WorkerContext): Promise<T>;
  gracefulCancel?(ctx: WorkerContext): Promise<void>;
  cancelGraceMs?: number;
  dispose?(): Promise<void> | void;
};

export type HelperResult = { stdout: string; truncated: boolean };

export class WorkerHost {
  constructor(private readonly config: RelayConfig, private readonly store: SessionStore) {}

  async run<T>(options: WorkerDriver<T>, signal?: AbortSignal): Promise<T> {
    assertRunnerAccepting();
    if (process.env.AGENT_RELAY_DELEGATED === "1") {
      throw new RelayFailure("NESTED_DELEGATION", "Delegation is disabled inside a delegated worker process");
    }
    if (signal?.aborted) throw new RelayFailure("CANCELLED", "MCP request was cancelled");
    const abort = new AbortController();
    const cancel = () => abort.abort(new RelayFailure("CANCELLED", "MCP request was cancelled"));
    const aborted = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
    });
    void aborted.catch(() => undefined);
    const run = <V>(promise: Promise<V>): Promise<V> => Promise.race([promise, aborted]);
    let record: SessionRecord | undefined;
    let context: WorkerContext | undefined;
    let tree: ProcessTreeController | undefined;
    let lease: WorkspaceLease | undefined;
    let prepared: PreparedSpawn | undefined;
    const worker: { state: "not-attempted" | "pending" | "created" | "failed" } = { state: "not-attempted" };
    const leaseErrors: RelayFailure[] = [];
    let termination: TerminationReport | undefined;
    let pendingError: RelayFailure | undefined;
    let cleanupError: unknown;
    let stderr = "";
    let result: T | undefined;
    const partial = () => options.partial?.(record);
    let resolveSettled!: (report: CleanupReport) => void;
    const task: ActiveTask = {
      cancel: async () => { abort.abort(new RelayFailure("CANCELLED", "Relay is shutting down")); },
      settled: new Promise((resolve) => { resolveSettled = resolve; }),
      resolveSettled: (report) => resolveSettled(report),
    };
    registerActiveTask(task);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => abort.abort(new RelayFailure(
      "TIMEOUT", `${options.displayName} task exceeded the total timeout`,
    )), this.config.totalTimeoutMs);
    try {
      lease = await this.store.acquire(options.cwd);
      if (abort.signal.aborted) throw abort.signal.reason;
      record = options.sessionId ? await this.store.read(options.sessionId, options.cwd) : undefined;
      if (abort.signal.aborted) throw abort.signal.reason;
      const runHelper: PreparationHelper = async (helper) => {
        const borrowedStore = new Proxy(this.store, {
          get: (target, key) => key === "acquire" ? async () => ({
            ...lease!,
            release: () => lease!.markSpawning(),
          }) : Reflect.get(target, key, target),
        });
        try {
          return await new WorkerHost({ ...this.config, totalTimeoutMs: helper.timeoutMs }, borrowedStore).runHelper({
            cwd: options.cwd, displayName: options.displayName, failureCode: options.failureCode,
            invocation: () => ({ command: helper.command, args: helper.args }),
            prepare: async () => ({ env: helper.env, dispose: async () => {} }),
          }, abort.signal);
        } catch (error) {
          if (error instanceof RelayFailure && error.code === "PROCESS_CLEANUP_FAILED") {
            worker.state = "created";
          }
          if (error instanceof RelayFailure
            && (error.code === "PROCESS_CLEANUP_FAILED"
              || error.code === "LOCK_IO"
              || error.code === "LOCK_OWNERSHIP_LOST")) {
            throw error;
          }
          const outerFailure = abort.signal.aborted ? abort.signal.reason : undefined;
          if (outerFailure instanceof RelayFailure) throw outerFailure;
          throw error;
        }
      };
      prepared = await options.prepare?.({ ...process.env, AGENT_RELAY_DELEGATED: "1" }, record, runHelper);
      if (abort.signal.aborted) throw abort.signal.reason;
      const invocation = options.invocation(record);
      await lease.markSpawning();
      if (abort.signal.aborted) throw abort.signal.reason;
      worker.state = "pending";
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(invocation.command, [...invocation.args, ...(prepared?.extraArgs ?? [])], {
          cwd: options.cwd, env: { ...(prepared?.env ?? process.env), AGENT_RELAY_DELEGATED: "1" },
          shell: false, stdio: ["pipe", "pipe", "pipe"], ...processTreeSpawnOptions(),
        });
      } catch (error) { worker.state = "failed"; throw error; }
      tree = createProcessTreeController(child, this.config);
      const spawned = new Promise<void>((resolve, reject) => {
        child.once("spawn", () => { worker.state = "created"; resolve(); });
        child.once("error", (error) => { worker.state = tree!.reference() ? "created" : "failed"; reject(error); });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const bytes = Buffer.concat([Buffer.from(stderr), chunk]);
        stderr = bytes.subarray(Math.max(0, bytes.length - this.config.stderrLimitBytes)).toString("utf8");
        options.onStderr?.(stderr);
      });
      const ready = (async () => {
        await run(withTimeout(spawned, this.config.phaseTimeoutMs, "SPAWN_TIMEOUT", `${options.displayName} spawn timed out`));
        const reference = tree!.reference();
        if (!reference) throw new RelayFailure("LOCK_IO", `${options.displayName} worker has no process-tree reference`);
        await lease!.bindWorker(reference);
      })();
      void ready.catch(() => undefined);
      context = { child, record, signal: abort.signal, ready, run, abort: (failure) => abort.abort(failure) };
      result = await options.drive(context);
    } catch (error) {
      pendingError = error instanceof RelayFailure ? error
        : new RelayFailure(options.failureCode, error instanceof Error ? error.message : String(error));
      abort.abort(pendingError);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      try {
        if (abort.signal.aborted && context && options.gracefulCancel) {
          await withTimeout(options.gracefulCancel(context), options.cancelGraceMs ?? this.config.cancelGraceMs,
            "CANCELLED", `${options.displayName} cancellation grace expired`).catch(() => undefined);
        }
        if (lease) {
          try { await lease.markTerminating(); } catch (error) { leaseErrors.push(leaseFailure(error)); }
        }
        if (worker.state === "created" || worker.state === "pending") {
          try {
            termination = tree ? await tree.terminate()
              : { confirmed: false, forced: false, reason: "Worker process-tree controller unavailable" };
          } catch (error) {
            termination = { confirmed: false, forced: false, reason: String(error) };
          }
        }
        const noWorker = worker.state === "not-attempted" || worker.state === "failed";
        if (noWorker || termination?.confirmed) {
          try { await prepared?.dispose(); } catch (error) { cleanupError = error; }
          if (lease) {
            try {
              await lease.markReaped(noWorker ? "no-worker-created" : "tree-exit-confirmed");
              await lease.release();
            } catch (error) { leaseErrors.push(leaseFailure(error)); }
          }
        } else if (lease) {
          try { await lease.markOrphaned(); } catch (error) { leaseErrors.push(leaseFailure(error)); }
        }
      } catch (error) { cleanupError = error; }
      try { await options.dispose?.(); } catch (error) { cleanupError = error; }
      const diagnostics = cleanupDiagnostics(worker.state, termination, leaseErrors, cleanupError, cleanupError !== undefined);
      unregisterActiveTask(task);
      task.resolveSettled({ diagnostics });
    }
    if ((worker.state === "created" || worker.state === "pending") && !termination?.confirmed) {
      throw new RelayFailure("PROCESS_CLEANUP_FAILED", boundedString(
        `Cannot confirm ${options.displayName} worker process-tree cleanup: ${termination?.reason ?? "unknown failure"}${pendingError ? `; original error ${pendingError.code}: ${pendingError.message}` : ""}`,
        Math.min(8 * 1_024, this.config.stderrLimitBytes)), partial());
    }
    const leaseError = leaseErrors.find((entry) => entry.code === "LOCK_OWNERSHIP_LOST") ?? leaseErrors[0];
    if (leaseError) throw new RelayFailure(leaseError.code, boundedString(leaseError.message, 2_048), partial());
    if (cleanupError !== undefined) throw new RelayFailure("INTERNAL", boundedString(String(cleanupError), 2_048), partial());
    if (pendingError) throw new RelayFailure(pendingError.code, boundedString(
      `${pendingError.message}${stderr ? `; ${options.displayName} stderr: ${stderr}` : ""}`,
      Math.min(8 * 1_024, this.config.stderrLimitBytes)), partial());
    return result as T;
  }

  runHelper(options: WorkerOptions, signal?: AbortSignal): Promise<HelperResult> {
    return this.run({
      ...options,
      drive: async (ctx) => {
        let stdout = "";
        let truncated = false;
        ctx.child.stdout.setEncoding("utf8");
        ctx.child.stdout.on("data", (chunk: string) => {
          const appended = appendLimited(stdout, chunk, this.config.textLimitBytes);
          stdout = appended.value;
          truncated ||= appended.truncated;
        });
        const exited = ctx.child.exitCode !== null || ctx.child.signalCode !== null
          ? Promise.resolve().then(() => {
            if (ctx.child.exitCode === 0) return;
            throw new RelayFailure(options.failureCode,
              `${options.displayName} exited with ${ctx.child.exitCode ?? ctx.child.signalCode}`);
          })
          : new Promise<void>((resolve, reject) => {
            ctx.child.once("exit", (code, signal) => {
              if (code === 0) resolve();
              else reject(new RelayFailure(options.failureCode, `${options.displayName} exited with ${code ?? signal}`));
            });
            ctx.child.once("error", reject);
          });
        void exited.catch(() => undefined);
        await ctx.ready;
        await ctx.run(exited);
        return { stdout, truncated };
      },
    }, signal);
  }
}

function leaseFailure(error: unknown): RelayFailure {
  return error instanceof RelayFailure && (error.code === "LOCK_IO" || error.code === "LOCK_OWNERSHIP_LOST")
    ? error : new RelayFailure("LOCK_IO", String(error));
}
