import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RelayConfig } from "../config.js";
import { resolveCwd, type SessionStore } from "../store.js";
import { RelayFailure, type DshDelegateInput, type DshRelayResult } from "../types.js";
import { HeadlessRunner } from "../runner/headless-runner.js";
import { StandardSummaries } from "../runner/summaries.js";
import type { HeadlessAdapter, HeadlessEvent, ProgressReporter } from "../runner/types.js";
import { resolveWindowsDshLauncher } from "./dsh-windows-command.js";
import { dshPolicyPatch } from "./dsh-policy.js";

export { resolveWindowsDshLauncher };

export function dshSpawnSpec(
  config: RelayConfig,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const command = config.dshCommand?.trim() || "dsh";
  const args = config.dshCommandArgs ?? ["--profile", "headless"];
  if (process.platform !== "win32") return { command, args };
  const resolved = resolveWindowsDshLauncher(command, env);
  return { command: resolved.command, args: [...resolved.prefixArgs, ...args] };
}

function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env, DSH_PERMISSION_MODE: "workspace-write" };
  if (child.DEEPSEEK_API_KEY === "") delete child.DEEPSEEK_API_KEY;
  return child;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function defaultProvider(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*-\s+id:\s*["']?agent-default-model["']?\s*$/.test(line));
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (/^\s*-\s+id:/.test(line)) break;
      const match = /^\s+provider:\s*(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_.:/-]+))\s*(?:#.*)?$/.exec(line);
      const provider = match?.[1] ?? match?.[2] ?? match?.[3];
      if (provider) return provider;
    }
  }
  throw new RelayFailure("INVALID_CONFIG", "Cannot read agent-default-model.provider from DSH --dump-config");
}

export function dshAdapter(config: RelayConfig): HeadlessAdapter<DshDelegateInput, DshRelayResult> {
  return {
    displayName: "DSH",
    failureCode: "ACP_FAILURE",
    spawnEnv: childEnvironment,
    command: () => dshSpawnSpec({
      ...config,
      dshCommandArgs: [...(config.dshCommandArgs ?? []), "--profile", "headless"],
    }),
    prepare: async (input, record, directory, context) => {
      const env = childEnvironment(context.env);
      const permissions = join(directory, "permissions.patch.yml");
      await writeFile(permissions, dshPolicyPatch, { mode: 0o600 });
      const extraArgs = ["--patch", permissions];
      if (input.model !== undefined || input.reasoningEffort !== undefined) {
        const invocation = dshSpawnSpec({
          ...config,
          dshCommandArgs: [...(config.dshCommandArgs ?? []), "--profile", "headless"],
        }, env);
        let stdout: string;
        try {
          const result = await context.runHelper({
            ...invocation, args: [...invocation.args, "--patch", permissions, "--dump-config"],
            env, timeoutMs: config.phaseTimeoutMs,
          });
          if (result.truncated) throw new RelayFailure("INVALID_CONFIG", "DSH --dump-config output was truncated");
          stdout = result.stdout;
        } catch (error) {
          if (error instanceof RelayFailure && error.code === "TIMEOUT") {
            throw new RelayFailure("CONFIG_TIMEOUT", "DSH --dump-config timed out");
          }
          throw error;
        }
        const modelPatch = join(directory, "model.patch.yml");
        const route = {
          provider: defaultProvider(stdout),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        };
        await writeFile(modelPatch, JSON.stringify([{ id: "agent-default-model", config: route }]), { mode: 0o600 });
        extraArgs.push("--patch", modelPatch);
      }
      extraArgs.push("--json", "--permission-mode", "workspace-write", "--approval-policy", "never");
      if (record) extraArgs.push("--session-id", record.sessionId);
      extraArgs.push("-");
      return { env, extraArgs, stdin: { write: input.task } };
    },
    decode(raw): HeadlessEvent {
      const event = object(raw);
      const session = typeof event.sessionId === "string" ? { sessionId: event.sessionId } : {};
      switch (event.type) {
        case "session":
          return { type: "session", id: string(event.sessionId), ...session };
        case "text":
          return { type: "text", text: string(event.text), ...session };
        case "tool_call":
          return { type: "toolCall", id: string(event.callId), title: string(event.tool), ...session };
        case "tool_result": {
          const error = object(event.error);
          if (error.code === "FS_SANDBOX_DENIED" || error.code === "AUTO_REVIEW_DENIED") {
            return {
              type: "permissionDenied", id: string(event.callId),
              title: `DSH ${error.code}: ${string(event.result) || string(event.callId)}`, ...session,
            };
          }
          // A shell command denied by the sandbox returns a completed tool_result with no error code;
          // DSH 0.2.2-rc.1 only marks it in the result text (shell-sandbox-deny.json).
          if (string(event.result).includes("[sandbox: file access denied under")) {
            return {
              type: "permissionDenied", id: string(event.callId),
              title: `DSH shell sandbox denial: ${string(event.result)}`, ...session,
            };
          }
          return {
            type: "toolResult", id: string(event.callId),
            status: event.status === "completed" ? "completed" : event.status === "error" ? "failed" : string(event.status),
            ...session,
          };
        }
        case "final": {
          const reason = object(event.reason);
          const error = object(reason.error);
          const errorCode = typeof error.code === "string" ? error.code : "";
          const errorMessage = typeof error.message === "string" ? error.message : "";
          return {
            type: "final", ok: reason.kind === "completed", stopReason: reason.kind === "completed" ? "end_turn" : string(reason.kind),
            text: string(event.text), ...session,
            ...(errorCode ? { errorCode } : {}),
            ...(errorCode || errorMessage
              ? { error: [errorCode, errorMessage].filter(Boolean).join(": ") }
              : {}),
          };
        }
        case "error":
          return { type: "error", message: string(event.message), ...session };
        default:
          return { type: "ignore", ...session };
      }
    },
    complete(state, exit) {
      if (state.final?.errorCode === "MISSING_CREDENTIAL") {
        throw new RelayFailure("AUTH_UNAVAILABLE", state.final.error ?? "DSH credentials are unavailable");
      }
      if (!state.final && state.error) {
        const code = state.error.includes("does not exist") ? "UNKNOWN_SESSION"
          : state.error.includes("was recorded in") ? "CWD_MISMATCH" : "ACP_FAILURE";
        throw new RelayFailure(code, state.error);
      }
      if (exit.code !== 0 || !state.final?.ok) {
        throw new RelayFailure("ACP_FAILURE", state.final?.error ?? state.error ?? `DSH exited with ${exit.code ?? exit.signal} without a completed final event`);
      }
      return {
        provider: "dsh", sessionId: state.sessionId, text: state.text,
        stopReason: state.final.stopReason, truncated: state.truncated,
      };
    },
    gracefulStop: { signal: "SIGTERM", graceMs: config.cancelGraceMs },
    createSummarizer: (limit) => new StandardSummaries(limit, "dsh"),
  };
}

export class DshRunner extends HeadlessRunner<DshDelegateInput, DshRelayResult> {
  constructor(config: RelayConfig, store: SessionStore) {
    super(config, store, dshAdapter(config));
  }

  override async delegate(input: DshDelegateInput, signal?: AbortSignal, progress?: ProgressReporter): Promise<DshRelayResult> {
    return super.delegate({ ...input, cwd: await resolveCwd(input.cwd) }, signal, progress);
  }
}
