import * as acp from "@agentclientprotocol/sdk";
import type { RelayConfig } from "../config.js";
import type { SessionStore } from "../store.js";
import { RelayFailure, type ClaudeDelegateInput, type ClaudeRelayResult } from "../types.js";
import { AcpRunner } from "../runner/acp-runner.js";
import {
  abortFailure,
  cancelledPermission,
  configSelectValues,
  hasCloseCapability,
  hasLoadCapability,
  hasResumeCapability,
} from "../runner/helpers.js";
import { boundedString, withTimeout } from "../runner/limits.js";
import { StandardSummaries } from "../runner/summaries.js";
import type { ProgressReporter, ProviderAdapter } from "../runner/types.js";
import { resolveWindowsPackageLauncher } from "./windows-command.js";

export function claudeSpawnSpec(
  config: RelayConfig,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const command = config.claudeCommand?.trim() || "claude-agent-acp";
  const args = config.claudeCommandArgs ?? [];
  if (process.platform !== "win32") return { command, args };
  const resolved = resolveWindowsPackageLauncher(command, {
    displayName: "Claude",
    commandEnv: "AGENT_RELAY_CLAUDE_COMMAND",
    packageName: "@agentclientprotocol/claude-agent-acp",
    binName: "claude-agent-acp",
    entryPath: "dist/index.js",
  }, env);
  return { command: resolved.command, args: [...resolved.prefixArgs, ...args] };
}

function claudeAdapter(config: RelayConfig): ProviderAdapter<ClaudeDelegateInput, ClaudeRelayResult> {
  return {
    provider: "claude",
    displayName: "Claude Code",
    command: () => claudeSpawnSpec(config),
    authenticate: () => undefined,
    capabilities: {},
    prompt: (task) => `This is a noninteractive delegated task. Do not ask the user questions. Resolve minor ambiguity conservatively. If a material decision is unresolved, stop and report it.\n\n${task}`,
    sessionMetadata: () => ({}),
    persistNewSessionBeforeConfigure: true,
    permissionWarning: () => "Claude Code uses acceptEdits and refuses extra ACP approvals. Native allow rules, hooks, shell networking and external MCP services still apply; this is not filesystem or network isolation.",
    validateInitialized(initialized) {
      if (!hasCloseCapability(initialized.agentCapabilities)) {
        throw new RelayFailure("SESSION_CLOSE_UNSUPPORTED", "Claude Code did not advertise session close capability");
      }
    },
    existingSession(initialized) {
      if (hasResumeCapability(initialized.agentCapabilities)) return "resume";
      if (hasLoadCapability(initialized.agentCapabilities)) return "load";
      throw new RelayFailure("RESUME_UNSUPPORTED", "Claude Code did not advertise session resume or loadSession capability");
    },
    mapError(error) {
      if (error instanceof acp.RequestError && error.code === acp.RequestError.authRequired().code) {
        return new RelayFailure("AUTH_UNAVAILABLE", "Claude Code requires authentication. Sign in outside the relay with the bridge's --cli auth login command, or configure provider credentials.");
      }
      return undefined;
    },
    createSummarizer: (limitBytes) => new StandardSummaries(limitBytes, "claude"),
    handlePermission(params, rt) {
      if (params.sessionId !== rt.sessionId || rt.signal.aborted || rt.hasFailure()) return cancelledPermission();
      rt.markRequested();
      const reject = params.options.find((option) => option.kind === "reject_once");
      const failure = new RelayFailure(
        "PERMISSION_REQUIRED",
        `Claude Code permission was rejected: ${boundedString(params.toolCall.title ?? params.toolCall.toolCallId, 256)}`,
        rt.partial(),
      );
      rt.setFailure(failure);
      setImmediate(() => rt.abort(failure));
      return reject
        ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
        : cancelledPermission();
    },
    async configureSession(ctx, sessionId, input, extras, signal) {
      let options = [...(extras.configOptions ?? [])];
      const requested = [["model", input.model], ["effort", input.effort], ["mode", "acceptEdits"]] as const;
      for (const [id, value] of requested) {
        if (value === undefined) continue;
        if (signal?.aborted) abortFailure(signal);
        const option = options.find((entry) => entry.id === id);
        if (!option) {
          throw new RelayFailure("CONFIG_UNSUPPORTED", `Claude Code did not advertise the ${id} session option`);
        }
        if (!configSelectValues(option).includes(value)) {
          throw new RelayFailure("INVALID_CONFIG", `Claude Code ${id} value is not available`);
        }
        const response = await withTimeout(ctx.request(acp.methods.agent.session.setConfigOption, {
          sessionId, configId: id, value,
        }), config.phaseTimeoutMs, "CONFIG_TIMEOUT", `Claude Code ${id} configuration timed out`);
        if (signal?.aborted) abortFailure(signal);
        options = [...response.configOptions];
        if (options.find((entry) => entry.id === id)?.currentValue !== value) {
          throw new RelayFailure("INVALID_CONFIG", `Claude Code did not apply the requested ${id} value`);
        }
      }
    },
    async finalizeSession(ctx, sessionId) {
      try {
        await withTimeout(ctx.request(acp.methods.agent.session.close, { sessionId }),
          config.phaseTimeoutMs, "SESSION_CLOSE_TIMEOUT", "Claude Code session close timed out");
      } catch (error) {
        if (error instanceof RelayFailure) throw error;
        throw new RelayFailure("SESSION_CLOSE_FAILED", `Claude Code session close failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

export class ClaudeRunner extends AcpRunner<ClaudeDelegateInput, ClaudeRelayResult> {
  constructor(config: RelayConfig, store: SessionStore) {
    super(config, store, claudeAdapter(config));
  }

  override delegate(input: ClaudeDelegateInput, signal?: AbortSignal, reportProgress?: ProgressReporter): Promise<ClaudeRelayResult> {
    return super.delegate(input, signal, reportProgress);
  }
}
