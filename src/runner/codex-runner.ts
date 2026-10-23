import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RelayConfig } from "../config.js";
import type { SessionStore, WorkspaceLease } from "../store.js";
import { RelayFailure, type CodexDelegateInput, type CodexRelayResult, type RelayErrorCode } from "../types.js";
import { CODEX_FRAME_LIMIT_BYTES, CodexClient, object, type CodexMessage } from "./codex-client.js";
import { CodexSummaries } from "./codex-summaries.js";
import { boundedString, withTimeout } from "./limits.js";
import {
  assertRunnerAccepting, cleanupDiagnostics, registerActiveTask, unregisterActiveTask,
  type ActiveTask, type CleanupReport,
} from "./lifecycle.js";
import { createProcessTreeController, processTreeSpawnOptions, type ProcessTreeController, type TerminationReport } from "./process-tree.js";
import type { ProgressReporter } from "./types.js";

export class CodexRunner {
  constructor(private readonly config: RelayConfig, private readonly store: SessionStore) {}

  async delegate(input: CodexDelegateInput, signal?: AbortSignal, progress?: ProgressReporter): Promise<CodexRelayResult> {
    assertRunnerAccepting();
    if (process.env.AGENT_RELAY_DELEGATED === "1") {
      throw new RelayFailure("NESTED_DELEGATION", "Delegation is disabled inside a delegated worker process");
    }
    if (signal?.aborted) throw new RelayFailure("CANCELLED", "MCP request was cancelled");
    const command = this.config.codexCommand?.trim() || "codex";
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
      throw new RelayFailure("INVALID_INPUT", "Set AGENT_RELAY_CODEX_COMMAND to a native codex.exe; shell launchers are unsupported");
    }
    const abort = new AbortController();
    const cancel = () => abort.abort(new RelayFailure("CANCELLED", "MCP request was cancelled"));
    const aborted = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
    });
    // It can reject while acquiring a lease; attach a handler before the first await.
    void aborted.catch(() => undefined);
    const run = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);
    const summaries = new CodexSummaries(this.config.textLimitBytes);
    let sessionId: string | null = null;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let awaitingTurn = false;
    let turnFinished = false;
    let earlyBytes = 0;
    const earlyEvents: CodexMessage[] = [];
    let client: CodexClient | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let tree: ProcessTreeController | undefined;
    let lease: WorkspaceLease | undefined;
    const worker: { state: "not-attempted" | "pending" | "created" | "failed" } = { state: "not-attempted" };
    const leaseErrors: RelayFailure[] = [];
    let termination: TerminationReport | undefined;
    let pendingError: RelayFailure | undefined;
    let cleanupError: unknown;
    let interactionFailure: RelayFailure | undefined;
    let stderr = "";
    let lastProgress = 0;
    let progressPending = false;
    let finishTurn!: (turn: CodexMessage) => void;
    const finished = new Promise<CodexMessage>((resolve) => { finishTurn = resolve; });
    const partial = (): Partial<CodexRelayResult> => ({ sessionId, ...summaries.result() });
    const failure = (error: unknown): RelayFailure => error instanceof RelayFailure ? error
      : new RelayFailure("CODEX_FAILURE", error instanceof Error ? error.message : String(error));
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      cleanupPromise ??= (async () => {
        if (abort.signal.aborted && client && threadId && turnId && !turnFinished) {
          // A stuck write or unresponsive server must not hold up process-tree cleanup.
          const deadline = Date.now() + this.config.cancelGraceMs;
          await withTimeout(client.request("turn/interrupt", { threadId, turnId }), this.config.cancelGraceMs,
            "CANCELLED", "Codex interrupt timed out").catch(() => undefined);
          await withTimeout(finished, Math.max(1, deadline - Date.now()), "CANCELLED", "Codex cancellation grace expired")
            .catch(() => undefined);
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
        if (lease) {
          if (noWorker || termination?.confirmed) {
            try {
              await lease.markReaped(noWorker ? "no-worker-created" : "tree-exit-confirmed");
              await lease.release();
            } catch (error) { leaseErrors.push(leaseFailure(error)); }
          } else {
            try { await lease.markOrphaned(); } catch (error) { leaseErrors.push(leaseFailure(error)); }
          }
        }
      })();
      return cleanupPromise;
    };
    const onMessage = (message: CodexMessage): void => {
      const method = message.method as string;
      if (message.id !== undefined) {
        if (interactionFailure) return;
        // All server-initiated approvals are refused, including requests routed from subagents.
        let result: CodexMessage | undefined;
        let code: RelayErrorCode = "PERMISSION_REQUIRED";
        if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
          result = { decision: "decline" };
        } else if (method === "execCommandApproval" || method === "applyPatchApproval") {
          result = { decision: "abort" };
        } else if (method === "item/permissions/requestApproval") {
          result = { permissions: {}, scope: "turn" };
        } else if (method === "item/tool/requestUserInput") {
          result = { answers: {} }; code = "INTERACTION_REQUIRED";
        } else if (method === "mcpServer/elicitation/request") {
          result = { action: "decline", content: null, _meta: null }; code = "INTERACTION_REQUIRED";
        } else {
          code = method === "account/chatgptAuthTokens/refresh" ? "AUTH_UNAVAILABLE" : "PROTOCOL_MISMATCH";
        }
        interactionFailure ??= new RelayFailure(code, `Codex requested unsupported noninteractive action: ${boundedString(method, 256)}`);
        const response = result ? { id: message.id, result }
          : { id: message.id, error: { code: -32601, message: "Unsupported server request" } };
        void withTimeout(client!.send(response), this.config.cancelGraceMs, "CODEX_FAILURE", "Codex response timed out")
          .catch(() => undefined).finally(() => abort.abort(interactionFailure));
        return;
      }
      if (!["turn/completed", "item/agentMessage/delta", "item/started", "item/completed", "thread/tokenUsage/updated"].includes(method)) return;
      const params = object(message.params ?? {});
      if (params.threadId !== threadId || threadId === undefined) return;
      if (awaitingTurn) {
        earlyBytes += Buffer.byteLength(JSON.stringify(message));
        if (earlyBytes > CODEX_FRAME_LIMIT_BYTES || earlyEvents.length >= 1_024) {
          throw new RelayFailure("PROTOCOL_MISMATCH", "Codex pending events exceeded the buffer limit");
        }
        earlyEvents.push(message);
        return;
      }
      const eventTurnId = method === "turn/completed" ? object(params.turn).id : params.turnId;
      if (!turnId || eventTurnId !== turnId) return;
      if (method === "turn/completed") {
        turnFinished = true;
        finishTurn(object(params.turn));
        return;
      }
      if (turnFinished) return;
      const title = summaries.update(method, params);
      if (title && progress && !progressPending && Date.now() - lastProgress >= this.config.progressIntervalMs) {
        lastProgress = Date.now();
        progressPending = true;
        // Keep slow MCP progress delivery out of the protocol read loop.
        void Promise.resolve().then(() => progress(title)).catch(() => undefined).finally(() => { progressPending = false; });
      }
    };
    let resolveSettled!: (report: CleanupReport) => void;
    const task: ActiveTask = {
      cancel: async () => { abort.abort(new RelayFailure("CANCELLED", "Relay is shutting down")); },
      settled: new Promise((resolve) => { resolveSettled = resolve; }),
      resolveSettled: (report) => resolveSettled(report),
    };
    registerActiveTask(task);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => abort.abort(new RelayFailure("TIMEOUT", "Codex task exceeded the total timeout")), this.config.totalTimeoutMs);
    try {
      // Await acquisition directly so a late-acquired lease is never left unowned on cancellation.
      lease = await this.store.acquire(input.cwd);
      if (abort.signal.aborted) throw abort.signal.reason;
      const record = input.sessionId ? await this.store.read(input.sessionId, input.cwd) : undefined;
      if (record) sessionId = record.sessionId;
      if (abort.signal.aborted) throw abort.signal.reason;
      await lease.markSpawning();
      if (abort.signal.aborted) throw abort.signal.reason;
      worker.state = "pending";
      try {
        child = spawn(command, this.config.codexCommandArgs ?? ["app-server", "--listen", "stdio://"], {
          cwd: input.cwd, env: { ...process.env, AGENT_RELAY_DELEGATED: "1" },
          shell: false, stdio: ["pipe", "pipe", "pipe"], ...processTreeSpawnOptions(),
        });
      } catch (error) { worker.state = "failed"; throw error; }
      tree = createProcessTreeController(child, this.config);
      const spawned = new Promise<void>((resolve, reject) => {
        child!.once("spawn", () => { worker.state = "created"; resolve(); });
        child!.once("error", (error) => { worker.state = tree!.reference() ? "created" : "failed"; reject(error); });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const bytes = Buffer.concat([Buffer.from(stderr), chunk]);
        stderr = bytes.subarray(Math.max(0, bytes.length - this.config.stderrLimitBytes)).toString("utf8");
      });
      client = new CodexClient(child, onMessage, (error) => { if (!turnFinished) abort.abort(error); });
      await run(withTimeout(spawned, this.config.phaseTimeoutMs, "SPAWN_TIMEOUT", "Codex spawn timed out"));
      const reference = tree.reference();
      if (!reference) throw new RelayFailure("LOCK_IO", "Codex worker has no process-tree reference");
      await lease.bindWorker(reference);
      const request = (method: string, params: CodexMessage, code: RelayErrorCode): Promise<CodexMessage> => {
        if (abort.signal.aborted) return Promise.reject(abort.signal.reason);
        return run(withTimeout(client!.request(method, params), this.config.phaseTimeoutMs, code, `Codex ${method} timed out`));
      };
      await request("initialize", {
        clientInfo: { name: "agent-relay", title: "Agent Relay", version: "0.1.0" },
        capabilities: { experimentalApi: false, requestAttestation: false, explicitGatewayOauth: true },
      }, "INITIALIZE_TIMEOUT");
      await run(client.send({ method: "initialized" }));
      const account = await request("account/read", { refreshToken: false }, "AUTH_TIMEOUT");
      if (account.requiresOpenaiAuth === true && !account.account) {
        throw new RelayFailure("AUTH_UNAVAILABLE", "Codex requires authentication; sign in with the Codex CLI before delegating");
      }
      const policy = {
        cwd: input.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write",
        config: { "sandbox_workspace_write.network_access": false },
        ...(input.model === undefined ? {} : { model: input.model }),
      };
      const response = record
        ? await request("thread/resume", { ...policy, threadId: record.sessionId, excludeTurns: true }, "RESUME_TIMEOUT")
        : await request("thread/start", { ...policy, ephemeral: false }, "NEW_SESSION_TIMEOUT");
      const thread = object(response.thread);
      if (typeof thread.id !== "string" || !thread.id || thread.id.length > 256 || (record && thread.id !== record.sessionId)) {
        throw new RelayFailure("INVALID_SESSION", "Codex returned an invalid thread ID");
      }
      threadId = thread.id;
      if (!record) {
        await this.store.writeNew(threadId, input.cwd);
        sessionId = threadId;
      }
      awaitingTurn = true;
      const started = await request("turn/start", {
        threadId, cwd: input.cwd, approvalPolicy: "on-request", approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite", writableRoots: [input.cwd], networkAccess: false,
          excludeTmpdirEnvVar: false, excludeSlashTmp: false,
        },
        input: [{ type: "text", text: `This is a noninteractive delegated task. Do not ask the user questions. Resolve minor ambiguity conservatively. If a material decision is unresolved, stop and report it.\n\n${input.task}`, text_elements: [] }],
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.reasoningEffort === undefined ? {} : { effort: input.reasoningEffort }),
      }, "CONFIG_TIMEOUT");
      const startedTurn = object(started.turn);
      if (typeof startedTurn.id !== "string" || !startedTurn.id || startedTurn.id.length > 256) throw new RelayFailure("PROTOCOL_MISMATCH", "Codex returned an invalid turn ID");
      turnId = startedTurn.id;
      awaitingTurn = false;
      for (const event of earlyEvents) onMessage(event);
      earlyEvents.length = 0;
      const turn = await run(finished);
      if (interactionFailure) throw interactionFailure;
      if (turn.status !== "completed") {
        const message = turn.error && typeof object(turn.error).message === "string" ? object(turn.error).message as string : "Codex turn did not complete";
        throw new RelayFailure(turn.status === "interrupted" ? "CANCELLED" : "CODEX_FAILURE", message);
      }
      if (record) await this.store.touch(record);
    } catch (error) {
      pendingError = failure(error);
      // Cancellation may happen before turn/start returns its id; process cleanup remains mandatory.
      abort.abort(pendingError);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      try { await cleanup(); } catch (error) { cleanupError = error; }
      client?.dispose();
      const diagnostics = cleanupDiagnostics(worker.state, termination, leaseErrors, cleanupError, cleanupError !== undefined);
      unregisterActiveTask(task);
      task.resolveSettled({ diagnostics });
    }
    if ((worker.state === "created" || worker.state === "pending") && !termination?.confirmed) {
      throw new RelayFailure("PROCESS_CLEANUP_FAILED", boundedString(
        `Cannot confirm Codex worker process-tree cleanup: ${termination?.reason ?? "unknown failure"}${pendingError ? `; original error ${pendingError.code}: ${pendingError.message}` : ""}`,
        Math.min(8 * 1_024, this.config.stderrLimitBytes)), partial());
    }
    const leaseError = leaseErrors.find((entry) => entry.code === "LOCK_OWNERSHIP_LOST") ?? leaseErrors[0];
    if (leaseError) throw new RelayFailure(leaseError.code, boundedString(leaseError.message, 2_048), partial());
    if (cleanupError !== undefined) throw new RelayFailure("INTERNAL", boundedString(String(cleanupError), 2_048), partial());
    if (pendingError) throw new RelayFailure(pendingError.code, boundedString(
      `${pendingError.message}${stderr ? `; Codex stderr: ${stderr}` : ""}`, Math.min(8 * 1_024, this.config.stderrLimitBytes)), partial());
    return { sessionId, stopReason: "completed", ...summaries.result() };
  }
}

function leaseFailure(error: unknown): RelayFailure {
  return error instanceof RelayFailure && (error.code === "LOCK_IO" || error.code === "LOCK_OWNERSHIP_LOST")
    ? error : new RelayFailure("LOCK_IO", String(error));
}
