import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RelayConfig } from "../config.js";
import type { SessionStore } from "../store.js";
import { RelayFailure, type DelegateInput, type GrokRelayResult } from "../types.js";
import { HeadlessRunner } from "../runner/headless-runner.js";
import { EmptySummarizer } from "../runner/summaries.js";
import type { HeadlessAdapter } from "../runner/types.js";

export function grokAdapter(config: RelayConfig): HeadlessAdapter<DelegateInput, GrokRelayResult> {
  return {
    displayName: "Grok",
    failureCode: "ACP_FAILURE",
    command: () => ({ command: config.command, args: config.commandArgs }),
    presetSessionId: (_input, record) => record?.sessionId ?? randomUUID(),
    prepare: async (input, record, directory) => {
      if (record && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.sessionId)) {
        throw new RelayFailure("UNKNOWN_SESSION", "Grok resume requires a recorded UUID, not a session title");
      }
      const prompt = join(directory, "prompt.txt");
      await writeFile(prompt, input.task, { mode: 0o600 });
      return {
        env: {},
        extraArgs: ["--cwd", input.cwd, record ? "-r" : "-s", input.sessionId!, "--prompt-file", prompt],
        stdin: "ignore",
      };
    },
    decode(raw) {
      const event = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const session = typeof event.sessionId === "string" ? { sessionId: event.sessionId } : {};
      switch (event.type) {
        case "text":
          return { type: "text", text: typeof event.data === "string" ? event.data : "", ...session };
        case "tool_call":
          return {
            type: "toolCall", id: typeof event.toolCallId === "string" ? event.toolCallId : "",
            title: typeof event.title === "string" ? event.title : "", ...session,
          };
        case "tool_call_update":
          return {
            type: "toolResult", id: typeof event.toolCallId === "string" ? event.toolCallId : "",
            status: typeof event.status === "string" ? event.status : "", ...session,
          };
        case "end": {
          const stopReason = typeof event.stopReason === "string"
            ? event.stopReason.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase() : "";
          if (!session.sessionId || !stopReason) {
            throw new RelayFailure("PROTOCOL_MISMATCH", "Grok end event is missing its session ID or stop reason");
          }
          return { type: "final", ok: stopReason !== "cancelled", stopReason, ...session };
        }
        case "error":
          return { type: "error", message: typeof event.message === "string" ? event.message : "", ...session };
        default:
          return { type: "ignore", ...session };
      }
    },
    stderrFailure: (tail) => tail.includes("permission required:")
      ? new RelayFailure("UNEXPECTED_PERMISSION", "Grok reported permission required despite --always-approve")
      : undefined,
    complete(state, exit) {
      if (state.error !== undefined) {
        const code = state.error.startsWith("Not signed in") ? "AUTH_UNAVAILABLE"
          : state.error.includes("No saved copy of session") ? "UNKNOWN_SESSION" : "ACP_FAILURE";
        throw new RelayFailure(code, state.error);
      }
      if (state.final?.stopReason === "cancelled") {
        throw new RelayFailure("CANCELLED", "Grok turn was cancelled");
      }
      if (exit.code !== 0 || !state.final?.ok) {
        throw new RelayFailure("ACP_FAILURE", `Grok exited with ${exit.code ?? exit.signal} without a successful end event`);
      }
      return {
        sessionId: state.sessionId, stopReason: state.final.stopReason,
        text: state.text, truncated: state.truncated,
      };
    },
    gracefulStop: { signal: "SIGTERM", graceMs: Math.max(12_000, config.cancelGraceMs), waitForExit: true },
    createSummarizer: () => new EmptySummarizer(),
  };
}

export class GrokRunner extends HeadlessRunner<DelegateInput, GrokRelayResult> {
  constructor(config: RelayConfig, store: SessionStore) {
    super(config, store, grokAdapter(config));
  }
}
