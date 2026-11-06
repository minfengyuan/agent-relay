import type { RelayConfig } from "../config.js";
import type { SessionStore } from "../store.js";
import { RelayFailure, type CodexDelegateInput, type CodexRelayResult, type RelayErrorCode } from "../types.js";
import { CODEX_FRAME_LIMIT_BYTES, CodexClient, object, type CodexMessage } from "./codex-client.js";
import { CodexSummaries } from "./codex-summaries.js";
import { boundedString, withTimeout } from "./limits.js";
import type { ProgressReporter } from "./types.js";
import { WorkerHost, type WorkerContext } from "./worker-host.js";

export class CodexRunner {
  private readonly host: WorkerHost;

  constructor(private readonly config: RelayConfig, private readonly store: SessionStore) {
    this.host = new WorkerHost(config, store);
  }

  delegate(input: CodexDelegateInput, signal?: AbortSignal, progress?: ProgressReporter): Promise<CodexRelayResult> {
    const summaries = new CodexSummaries(this.config.textLimitBytes);
    let sessionId: string | null = null;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let awaitingTurn = false;
    let turnFinished = false;
    let earlyBytes = 0;
    const earlyEvents: CodexMessage[] = [];
    let client: CodexClient | undefined;
    let interactionFailure: RelayFailure | undefined;
    let lastProgress = 0;
    let progressPending = false;
    let finishTurn!: (turn: CodexMessage) => void;
    const finished = new Promise<CodexMessage>((resolve) => { finishTurn = resolve; });
    const partial = () => ({ sessionId, ...summaries.result() });

    const onMessage = (message: CodexMessage, ctx: WorkerContext): void => {
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
          .catch(() => undefined).finally(() => ctx.abort(interactionFailure!));
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

    return this.host.run({
      cwd: input.cwd,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      displayName: "Codex",
      failureCode: "CODEX_FAILURE",
      partial,
      invocation: () => {
        const command = this.config.codexCommand?.trim() || "codex";
        if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
          throw new RelayFailure("INVALID_INPUT", "Set AGENT_RELAY_CODEX_COMMAND to a native codex.exe; shell launchers are unsupported");
        }
        return { command, args: this.config.codexCommandArgs ?? ["app-server", "--listen", "stdio://"] };
      },
      dispose: () => client?.dispose(),
      gracefulCancel: async () => {
        if (!client || !threadId || !turnId || turnFinished) return;
        // A stuck write or unresponsive server must not hold up process-tree cleanup.
        const deadline = Date.now() + this.config.cancelGraceMs;
        await withTimeout(client.request("turn/interrupt", { threadId, turnId }), this.config.cancelGraceMs,
          "CANCELLED", "Codex interrupt timed out").catch(() => undefined);
        await withTimeout(finished, Math.max(1, deadline - Date.now()), "CANCELLED", "Codex cancellation grace expired")
          .catch(() => undefined);
      },
      drive: async (ctx) => {
        if (ctx.record) sessionId = ctx.record.sessionId;
        client = new CodexClient(ctx.child, (message) => onMessage(message, ctx), (error) => {
          if (!turnFinished) ctx.abort(error);
        });
        const request = (method: string, params: CodexMessage, code: RelayErrorCode): Promise<CodexMessage> => {
          if (ctx.signal.aborted) return Promise.reject(ctx.signal.reason);
          return withTimeout(ctx.run(client!.request(method, params)), this.config.phaseTimeoutMs,
            code, `Codex ${method} timed out`);
        };
        await request("initialize", {
          clientInfo: { name: "agent-relay", title: "Agent Relay", version: "0.1.0" },
          capabilities: { experimentalApi: false, requestAttestation: false, explicitGatewayOauth: true },
        }, "INITIALIZE_TIMEOUT");
        await ctx.run(client.send({ method: "initialized" }));
        const account = await request("account/read", { refreshToken: false }, "AUTH_TIMEOUT");
        if (account.requiresOpenaiAuth === true && !account.account) {
          throw new RelayFailure("AUTH_UNAVAILABLE", "Codex requires authentication; sign in with the Codex CLI before delegating");
        }
        const policy = {
          cwd: input.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write",
          config: { "sandbox_workspace_write.network_access": false, web_search: "disabled" },
          ...(input.model === undefined ? {} : { model: input.model }),
        };
        const response = ctx.record
          ? await request("thread/resume", { ...policy, threadId: ctx.record.sessionId, excludeTurns: true }, "RESUME_TIMEOUT")
          : await request("thread/start", { ...policy, ephemeral: false }, "NEW_SESSION_TIMEOUT");
        const thread = object(response.thread);
        if (typeof thread.id !== "string" || !thread.id || thread.id.length > 256
          || (ctx.record && thread.id !== ctx.record.sessionId)) {
          throw new RelayFailure("INVALID_SESSION", "Codex returned an invalid thread ID");
        }
        threadId = thread.id;
        if (!ctx.record) {
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
        if (typeof startedTurn.id !== "string" || !startedTurn.id || startedTurn.id.length > 256) {
          throw new RelayFailure("PROTOCOL_MISMATCH", "Codex returned an invalid turn ID");
        }
        turnId = startedTurn.id;
        awaitingTurn = false;
        for (const event of earlyEvents) onMessage(event, ctx);
        earlyEvents.length = 0;
        const turn = await ctx.run(finished);
        if (interactionFailure) throw interactionFailure;
        if (turn.status !== "completed") {
          const message = turn.error && typeof object(turn.error).message === "string"
            ? object(turn.error).message as string : "Codex turn did not complete";
          throw new RelayFailure(turn.status === "interrupted" ? "CANCELLED" : "CODEX_FAILURE", message);
        }
        if (ctx.record) await this.store.touch(ctx.record);
        return { sessionId, stopReason: "completed", ...summaries.result() };
      },
    }, signal);
  }
}
