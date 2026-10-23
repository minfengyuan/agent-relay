import { RelayFailure } from "../types.js";
import { boundedString } from "./limits.js";
import type { TerminationReport } from "./process-tree.js";

export type CleanupFailureCode =
  | "PROCESS_CLEANUP_FAILED"
  | "LOCK_OWNERSHIP_LOST"
  | "LOCK_IO"
  | "INTERNAL";

export type CleanupDiagnostic = {
  code: CleanupFailureCode;
  message: string;
};

export type CleanupReport = {
  diagnostics: readonly CleanupDiagnostic[];
};

export type ActiveTask = {
  cancel: () => Promise<void>;
  settled: Promise<CleanupReport>;
  resolveSettled: (report: CleanupReport) => void;
};

const activeTasks = new Set<ActiveTask>();
let runnerAccepting = true;
let runnerShutdownPromise: Promise<void> | undefined;

const CLEANUP_DIAGNOSTIC_LIMIT = 16;
export const CLEANUP_DIAGNOSTIC_BYTES = 8 * 1_024;
const cleanupPriority: readonly CleanupFailureCode[] = [
  "PROCESS_CLEANUP_FAILED",
  "LOCK_OWNERSHIP_LOST",
  "LOCK_IO",
  "INTERNAL",
];

export class CleanupAggregateError extends Error {
  constructor(
    public readonly taskCount: number,
    public readonly failureCount: number,
    public readonly primaryCode: CleanupFailureCode,
    public readonly diagnostics: readonly CleanupDiagnostic[],
    public readonly omittedCount: number,
    public readonly truncated: boolean,
  ) {
    super(cleanupAggregateMessage(taskCount, failureCount, primaryCode, diagnostics, omittedCount, truncated));
    this.name = "CleanupAggregateError";
  }
}

export function registerActiveTask(task: ActiveTask): void {
  assertRunnerAccepting();
  activeTasks.add(task);
}

export function unregisterActiveTask(task: ActiveTask): void {
  activeTasks.delete(task);
}

export async function cleanupAllChildren(): Promise<void> {
  const entries = [...activeTasks];
  const reports = Promise.all(entries.map((entry) => entry.settled));
  await Promise.allSettled(entries.map((entry) => entry.cancel()));
  const settledReports = await reports;
  const failedReports = settledReports.filter((report) => report.diagnostics.length > 0);
  if (failedReports.length === 0) return;

  const allDiagnostics = failedReports.flatMap((report) => dedupeDiagnostics(report.diagnostics));
  const primaryCode = cleanupPriority.find((code) => allDiagnostics.some((item) => item.code === code)) ?? "INTERNAL";
  const bounded = boundCleanupDiagnostics(allDiagnostics);
  throw new CleanupAggregateError(
    entries.length,
    failedReports.length,
    primaryCode,
    bounded.diagnostics,
    bounded.omittedCount,
    bounded.truncated,
  );
}

export function beginRunnerShutdown(): Promise<void> {
  if (runnerShutdownPromise) return runnerShutdownPromise;
  runnerAccepting = false;
  let resolveShutdown: () => void = () => {};
  let rejectShutdown: (error: unknown) => void = () => {};
  runnerShutdownPromise = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve;
    rejectShutdown = reject;
  });
  try {
    cleanupAllChildren().then(resolveShutdown, rejectShutdown);
  } catch (error) {
    rejectShutdown(error);
  }
  return runnerShutdownPromise;
}

export function assertRunnerAccepting(): void {
  if (!runnerAccepting) {
    throw new RelayFailure("CANCELLED", "Relay is shutting down and cannot accept new delegation tasks");
  }
}

export function cleanupDiagnostics(
  workerState: "not-attempted" | "pending" | "created" | "failed",
  termination: TerminationReport | undefined,
  leaseErrors: readonly RelayFailure[],
  unexpectedError: unknown,
  hasUnexpectedError: boolean,
): CleanupDiagnostic[] {
  const diagnostics: CleanupDiagnostic[] = [];
  if ((workerState === "pending" || workerState === "created") && termination?.confirmed !== true) {
    diagnostics.push({
      code: "PROCESS_CLEANUP_FAILED",
      message: boundedString(
        `Cannot confirm worker process-tree cleanup: ${termination?.reason ?? "unknown cleanup failure"}`,
        CLEANUP_DIAGNOSTIC_BYTES,
      ),
    });
  }
  for (const failure of leaseErrors) {
    diagnostics.push({
      code: failure.code === "LOCK_OWNERSHIP_LOST" ? "LOCK_OWNERSHIP_LOST" : "LOCK_IO",
      message: boundedString(failure.message, CLEANUP_DIAGNOSTIC_BYTES),
    });
  }
  if (hasUnexpectedError) {
    diagnostics.push({
      code: "INTERNAL",
      message: boundedString(
        `Unexpected task cleanup failure: ${unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError)}`,
        CLEANUP_DIAGNOSTIC_BYTES,
      ),
    });
  }
  return dedupeDiagnostics(diagnostics);
}

function dedupeDiagnostics(diagnostics: readonly CleanupDiagnostic[]): CleanupDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}\u0000${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundCleanupDiagnostics(diagnostics: readonly CleanupDiagnostic[]): {
  diagnostics: CleanupDiagnostic[];
  omittedCount: number;
  truncated: boolean;
} {
  const result: CleanupDiagnostic[] = [];
  let bytes = 0;
  let truncated = false;
  for (const diagnostic of diagnostics) {
    if (result.length >= CLEANUP_DIAGNOSTIC_LIMIT) break;
    const prefixBytes = Buffer.byteLength(diagnostic.code) + 2;
    const remaining = CLEANUP_DIAGNOSTIC_BYTES - bytes - prefixBytes;
    if (remaining <= 0) break;
    const message = boundedString(diagnostic.message, remaining);
    truncated ||= message !== diagnostic.message;
    result.push({ ...diagnostic, message });
    bytes += prefixBytes + Buffer.byteLength(message);
  }
  const omittedCount = diagnostics.length - result.length;
  return { diagnostics: result, omittedCount, truncated: truncated || omittedCount > 0 };
}

function cleanupAggregateMessage(
  taskCount: number,
  failureCount: number,
  primaryCode: CleanupFailureCode,
  diagnostics: readonly CleanupDiagnostic[],
  omittedCount: number,
  truncated: boolean,
): string {
  const header = `Cleanup failed for ${failureCount} of ${taskCount} active task${taskCount === 1 ? "" : "s"}`
    + ` (primary ${primaryCode})`;
  const rawDetails = diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ");
  const initiallyAvailable = Math.max(0, CLEANUP_DIAGNOSTIC_BYTES - Buffer.byteLength(header) - 2);
  const actuallyTruncated = truncated || Buffer.byteLength(rawDetails) > initiallyAvailable;
  const footer = actuallyTruncated
    ? `; diagnostics truncated${omittedCount > 0 ? `; ${omittedCount} omitted` : ""}`
    : "";
  const available = Math.max(0, CLEANUP_DIAGNOSTIC_BYTES - Buffer.byteLength(header) - Buffer.byteLength(footer) - 2);
  const details = boundedString(rawDetails, available);
  return `${header}${details ? `: ${details}` : ""}${footer}`;
}
