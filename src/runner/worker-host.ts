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

type WorkerState = "not-attempted" | "pending" | "created" | "failed";

/** Lease-wide state shared by every child that one task supervises. */
type TaskLease = {
  cwd: string;
  lease: WorkspaceLease;
  signal: AbortSignal;
  leaseErrors: RelayFailure[];
  /** The lease is in the reaped phase because the last child's tree exit was confirmed. */
  reaped: boolean;
  /** State and termination of the last child that was attempted. */
  worker: WorkerState;
  termination?: TerminationReport | undefined;
  /** Set when a child's tree exit was not confirmed; no later child may start. */
  orphan?: string;
};

type ChildSpec<T> = {
  displayName: string;
  failureCode: RelayErrorCode;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  record: SessionRecord | undefined;
  timeoutMs?: number;
  onStderr?(tail: string): void;
  drive(ctx: WorkerContext): Promise<T>;
  gracefulCancel?(ctx: WorkerContext): Promise<void>;
  cancelGraceMs?: number;
};

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
    let record: SessionRecord | undefined;
    let lease: WorkspaceLease | undefined;
    let held: TaskLease | undefined;
    let prepared: PreparedSpawn | undefined;
    const leaseErrors: RelayFailure[] = [];
    let pendingError: RelayFailure | undefined;
    let cleanupError: unknown;
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
      const current: TaskLease = { cwd: options.cwd, lease, signal: abort.signal, leaseErrors, reaped: false, worker: "not-attempted" };
      held = current;
      if (abort.signal.aborted) throw abort.signal.reason;
      record = options.sessionId ? await this.store.read(options.sessionId, options.cwd) : undefined;
      if (abort.signal.aborted) throw abort.signal.reason;
      // Preparation helpers run under the lease this task already holds, one child at a time.
      const runHelper: PreparationHelper = (helper) => this.supervise(current, {
        displayName: options.displayName, failureCode: options.failureCode,
        command: helper.command, args: helper.args, env: helper.env, record, timeoutMs: helper.timeoutMs,
        drive: (ctx) => this.driveHelper(ctx, options),
      });
      prepared = await options.prepare?.({ ...process.env, AGENT_RELAY_DELEGATED: "1" }, record, runHelper);
      if (abort.signal.aborted) throw abort.signal.reason;
      const invocation = options.invocation(record);
      result = await this.supervise(current, {
        displayName: options.displayName, failureCode: options.failureCode,
        command: invocation.command, args: [...invocation.args, ...(prepared?.extraArgs ?? [])],
        env: prepared?.env ?? process.env, record,
        ...(options.onStderr ? { onStderr: options.onStderr } : {}),
        drive: options.drive,
        ...(options.gracefulCancel ? { gracefulCancel: options.gracefulCancel } : {}),
        ...(options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs }),
      });
    } catch (error) {
      pendingError = asFailure(error, options.failureCode);
      abort.abort(pendingError);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      // A child whose reap failed leaves the lease in an unknown phase; do not force further transitions.
      const reapFailed = held !== undefined && !held.reaped
        && (held.worker === "created" || held.worker === "pending");
      if (held?.orphan === undefined) {
        try { await prepared?.dispose(); } catch (error) { cleanupError = error; }
        if (lease && !reapFailed) {
          try {
            if (!held?.reaped) {
              try { await lease.markTerminating(); } catch (error) { leaseErrors.push(leaseFailure(error)); }
              await lease.markReaped("no-worker-created");
            }
            await lease.release();
          } catch (error) { leaseErrors.push(leaseFailure(error)); }
        }
      }
      try { await options.dispose?.(); } catch (error) { cleanupError = error; }
      const diagnostics = cleanupDiagnostics(held?.worker ?? "not-attempted", held?.termination,
        leaseErrors, cleanupError, cleanupError !== undefined);
      unregisterActiveTask(task);
      task.resolveSettled({ diagnostics });
    }
    if (held?.orphan !== undefined) {
      throw new RelayFailure("PROCESS_CLEANUP_FAILED", boundedString(
        `Cannot confirm ${options.displayName} worker process-tree cleanup: ${held.orphan}${pendingError ? `; original error ${pendingError.code}: ${pendingError.message}` : ""}`,
        Math.min(8 * 1_024, this.config.stderrLimitBytes)), partial());
    }
    const leaseError = leaseErrors.find((entry) => entry.code === "LOCK_OWNERSHIP_LOST") ?? leaseErrors[0];
    if (leaseError) throw new RelayFailure(leaseError.code, boundedString(leaseError.message, 2_048), partial());
    if (cleanupError !== undefined) throw new RelayFailure("INTERNAL", boundedString(String(cleanupError), 2_048), partial());
    if (pendingError) throw new RelayFailure(pendingError.code, boundedString(
      pendingError.message, Math.min(8 * 1_024, this.config.stderrLimitBytes)), partial());
    return result as T;
  }

  runHelper(options: WorkerOptions, signal?: AbortSignal): Promise<HelperResult> {
    return this.run({ ...options, drive: (ctx) => this.driveHelper(ctx, options) }, signal);
  }

  /**
   * Spawns one child under a lease the task already holds, drives it, and confirms its tree exit.
   * On confirmed exit the lease is left reaped; otherwise it is marked orphaned and `orphan` is set.
   * The lease itself is acquired and released by `run`.
   */
  private async supervise<T>(held: TaskLease, spec: ChildSpec<T>): Promise<T> {
    if (held.orphan !== undefined) {
      throw new RelayFailure("PROCESS_CLEANUP_FAILED", `Cannot start ${spec.displayName} after unconfirmed worker cleanup`);
    }
    const abort = new AbortController();
    const aborted = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
    });
    void aborted.catch(() => undefined);
    const forward = () => abort.abort(held.signal.reason);
    if (held.signal.aborted) forward();
    else held.signal.addEventListener("abort", forward, { once: true });
    const timer = spec.timeoutMs === undefined ? undefined : setTimeout(() => abort.abort(new RelayFailure(
      "TIMEOUT", `${spec.displayName} task exceeded the total timeout`,
    )), spec.timeoutMs);
    const run = <V>(promise: Promise<V>): Promise<V> => Promise.race([promise, aborted]);
    const worker: { state: WorkerState } = { state: "not-attempted" };
    let tree: ProcessTreeController | undefined;
    let context: WorkerContext | undefined;
    let termination: TerminationReport | undefined;
    let pending: RelayFailure | undefined;
    let stderr = "";
    let result: T | undefined;
    try {
      if (abort.signal.aborted) throw abort.signal.reason;
      await held.lease.markSpawning();
      held.reaped = false;
      if (abort.signal.aborted) throw abort.signal.reason;
      worker.state = "pending";
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(spec.command, spec.args, {
          cwd: held.cwd, env: { ...spec.env, AGENT_RELAY_DELEGATED: "1" },
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
        spec.onStderr?.(stderr);
      });
      const ready = (async () => {
        await run(withTimeout(spawned, this.config.phaseTimeoutMs, "SPAWN_TIMEOUT", `${spec.displayName} spawn timed out`));
        const reference = tree!.reference();
        if (!reference) throw new RelayFailure("LOCK_IO", `${spec.displayName} worker has no process-tree reference`);
        await held.lease.bindWorker(reference);
      })();
      void ready.catch(() => undefined);
      context = { child, record: spec.record, signal: abort.signal, ready, run, abort: (failure) => abort.abort(failure) };
      result = await spec.drive(context);
    } catch (error) {
      pending = asFailure(error, spec.failureCode);
      abort.abort(pending);
    } finally {
      clearTimeout(timer);
      held.signal.removeEventListener("abort", forward);
      if (abort.signal.aborted && context && spec.gracefulCancel) {
        await withTimeout(spec.gracefulCancel(context), spec.cancelGraceMs ?? this.config.cancelGraceMs,
          "CANCELLED", `${spec.displayName} cancellation grace expired`).catch(() => undefined);
      }
      if (worker.state === "created" || worker.state === "pending") {
        try { await held.lease.markTerminating(); } catch (error) { held.leaseErrors.push(leaseFailure(error)); }
        try {
          termination = tree ? await tree.terminate()
            : { confirmed: false, forced: false, reason: "Worker process-tree controller unavailable" };
        } catch (error) {
          termination = { confirmed: false, forced: false, reason: String(error) };
        }
        if (termination.confirmed) {
          try {
            await held.lease.markReaped("tree-exit-confirmed");
            held.reaped = true;
          } catch (error) { held.leaseErrors.push(leaseFailure(error)); }
        } else {
          held.orphan = termination.reason ?? "unknown failure";
          try { await held.lease.markOrphaned(); } catch (error) { held.leaseErrors.push(leaseFailure(error)); }
        }
      }
      if (worker.state !== "not-attempted") {
        held.worker = worker.state;
        held.termination = termination;
      }
    }
    if (pending) {
      throw new RelayFailure(pending.code, boundedString(
        `${pending.message}${stderr ? `; ${spec.displayName} stderr: ${stderr}` : ""}`,
        Math.min(8 * 1_024, this.config.stderrLimitBytes)));
    }
    return result as T;
  }

  private async driveHelper(ctx: WorkerContext, options: Pick<WorkerOptions, "displayName" | "failureCode">): Promise<HelperResult> {
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
  }
}

function asFailure(error: unknown, code: RelayErrorCode): RelayFailure {
  return error instanceof RelayFailure ? error
    : new RelayFailure(code, error instanceof Error ? error.message : String(error));
}

function leaseFailure(error: unknown): RelayFailure {
  return error instanceof RelayFailure && (error.code === "LOCK_IO" || error.code === "LOCK_OWNERSHIP_LOST")
    ? error : new RelayFailure("LOCK_IO", String(error));
}
