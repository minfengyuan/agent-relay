import { randomUUID } from "node:crypto";
import type { RelayConfig } from "../config.js";
import type { SessionStore } from "../store.js";
import { RelayFailure, type ClaudeDelegateInput, type ClaudeRelayResult } from "../types.js";
import { HeadlessRunner } from "../runner/headless-runner.js";
import { StandardSummaries } from "../runner/summaries.js";
import type { HeadlessAdapter, HeadlessEvent } from "../runner/types.js";
import { resolveWindowsPackageLauncher } from "./windows-command.js";

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const BASE_ARGS = [
  "-p", "--output-format", "stream-json", "--verbose",
  "--permission-mode", "acceptEdits", "--permission-prompts", "none",
];

export function claudeSpawnSpec(
  config: RelayConfig,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const command = config.claudeCommand?.trim() || "claude";
  const args = config.claudeCommandArgs ?? [];
  if (process.platform !== "win32") return { command, args };
  const resolved = resolveWindowsPackageLauncher(command, {
    displayName: "Claude",
    commandEnv: "AGENT_RELAY_CLAUDE_COMMAND",
    packageName: "@anthropic-ai/claude-code",
    binName: "claude",
    entryPath: "cli.js",
  }, env);
  return { command: resolved.command, args: [...resolved.prefixArgs, ...args] };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentBlocks(event: Record<string, unknown>): Record<string, unknown>[] {
  const content = object(event.message).content;
  return Array.isArray(content) ? content.map(object) : [];
}

function resultError(event: Record<string, unknown>): string {
  const errors = Array.isArray(event.errors) ? event.errors.filter((entry): entry is string => typeof entry === "string") : [];
  if (errors.length) return errors.join("\n");
  return string(event.result) || string(event.subtype) || "Claude Code returned an unsuccessful result";
}

function deniedTools(event: Record<string, unknown>): { names: string; id?: string } | undefined {
  const denials = Array.isArray(event.permission_denials)
    ? event.permission_denials.map(object) : [];
  if (!denials.length) return undefined;
  const names = denials.map((denial) => string(denial.tool_name) || "unknown").join(", ");
  const id = string(denials[0]?.tool_use_id);
  return { names, ...(id ? { id } : {}) };
}

export function claudeAdapter(config: RelayConfig): HeadlessAdapter<ClaudeDelegateInput, ClaudeRelayResult> {
  return {
    displayName: "Claude Code",
    failureCode: "ACP_FAILURE",
    command: () => claudeSpawnSpec(config),
    presetSessionId: (_input, record) => record?.sessionId ?? randomUUID(),
    prepare: async (input, record) => {
      if (input.effort !== undefined && !EFFORTS.has(input.effort)) {
        throw new RelayFailure("INVALID_CONFIG", `Claude Code effort must be one of ${[...EFFORTS].join(", ")}`);
      }
      if (record && !SESSION_UUID.test(record.sessionId)) {
        throw new RelayFailure("UNKNOWN_SESSION", "Claude Code resume requires a recorded UUID");
      }
      const extraArgs = [...BASE_ARGS];
      if (input.model !== undefined) extraArgs.push("--model", input.model);
      if (input.effort !== undefined) extraArgs.push("--effort", input.effort);
      extraArgs.push(record ? "--resume" : "--session-id", input.sessionId!);
      return { env: {}, extraArgs, stdin: { write: input.task } };
    },
    decode(raw): HeadlessEvent {
      const event = object(raw);
      const hooked = event.type === "system" && string(event.subtype).startsWith("hook_");
      const session = !hooked && typeof event.session_id === "string" ? { sessionId: event.session_id } : {};
      switch (event.type) {
        case "system": {
          if (event.subtype === "init") {
            return { type: "session", id: string(event.session_id), ...session };
          }
          return { type: "ignore", ...session };
        }
        case "assistant": {
          const blocks = contentBlocks(event);
          const tool = blocks.find((block) => block.type === "tool_use");
          if (tool) {
            return {
              type: "toolCall", id: string(tool.id), title: string(tool.name), ...session,
            };
          }
          const text = blocks
            .filter((block) => block.type === "text")
            .map((block) => string(block.text))
            .join("");
          return { type: "text", text, ...session };
        }
        case "user": {
          const result = contentBlocks(event).find((block) => block.type === "tool_result");
          if (!result) return { type: "ignore", ...session };
          return {
            type: "toolResult", id: string(result.tool_use_id),
            status: result.is_error === true ? "failed" : "completed", ...session,
          };
        }
        case "result": {
          const denied = deniedTools(event);
          if (denied) {
            return {
              type: "permissionDenied",
              title: `Claude Code denied tools: ${denied.names}`,
              ...(denied.id ? { id: denied.id } : {}),
              ...session,
            };
          }
          const ok = event.is_error === false;
          const stopReason = string(event.stop_reason) || string(event.subtype) || (ok ? "end_turn" : "error");
          return {
            type: "final", ok, stopReason, ...session,
            ...(typeof event.result === "string" ? { text: event.result } : {}),
            ...(!ok ? {
              error: resultError(event),
              ...(string(event.subtype) ? { errorCode: string(event.subtype) } : {}),
            } : {}),
          };
        }
        default:
          return { type: "ignore", ...session };
      }
    },
    stderrFailure(tail) {
      if (tail.includes("Unknown --effort value")) {
        return new RelayFailure("INVALID_CONFIG", "Claude Code ignored an unknown effort value");
      }
      return undefined;
    },
    complete(state, exit) {
      const failure = state.error ?? state.final?.error ?? "";
      const code = /No conversation found with session ID/i.test(failure) ? "UNKNOWN_SESSION"
        : /(?:not logged in|not signed in|please log in|please sign in|authentication (?:failed|required)|invalid api key|keychain is locked)/i.test(failure)
          ? "AUTH_UNAVAILABLE" : "ACP_FAILURE";
      if (exit.code !== 0 || !state.final?.ok) {
        throw new RelayFailure(code, failure || `Claude Code exited with ${exit.code ?? exit.signal} without a successful result`);
      }
      return {
        provider: "claude", sessionId: state.sessionId, text: state.text,
        stopReason: state.final.stopReason, truncated: state.truncated,
      };
    },
    gracefulStop: { signal: "SIGTERM", graceMs: Math.max(5_000, config.cancelGraceMs), waitForExit: true },
    createSummarizer: (limit) => new StandardSummaries(limit, "claude"),
  };
}

export class ClaudeRunner extends HeadlessRunner<ClaudeDelegateInput, ClaudeRelayResult> {
  constructor(config: RelayConfig, store: SessionStore) {
    super(config, store, claudeAdapter(config));
  }
}
