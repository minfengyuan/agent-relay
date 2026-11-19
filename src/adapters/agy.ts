import * as acp from "@agentclientprotocol/sdk";
import type { RelayConfig } from "../config.js";
import type { SessionStore } from "../store.js";
import { RelayFailure, type AgyDelegateInput, type AgyRelayResult } from "../types.js";
import { AcpRunner } from "../runner/acp-runner.js";
import {
  abortFailure,
  cancelledPermission,
  configSelectValues,
  hasResumeCapability,
} from "../runner/helpers.js";
import { boundedString, withTimeout } from "../runner/limits.js";
import { StandardSummaries } from "../runner/summaries.js";
import type { ProgressReporter, ProviderAdapter } from "../runner/types.js";

function agyAdapter(config: RelayConfig): ProviderAdapter<AgyDelegateInput, AgyRelayResult> {
  return {
    provider: "agy",
    displayName: "AGY",
    command(input) {
      return {
        command: config.agyCommand?.trim() || "agy",
        args: [
          ...(config.agyCommandArgs ?? []),
          "acp",
          "--sandbox",
          ...(input.agent ? ["--agent", input.agent] : []),
        ],
      };
    },
    authenticate() {
      return undefined;
    },
    mapError(error) {
      if (error instanceof acp.RequestError && error.code === acp.RequestError.authRequired().code) {
        return new RelayFailure(
          "AUTH_UNAVAILABLE",
          "AGY requires authentication. Sign in outside the relay with `agy acp --login` or configure provider credentials.",
        );
      }
      return undefined;
    },
    capabilities: {},
    prompt: (task) => `This is a noninteractive delegated task. Do not ask the user questions. Resolve minor ambiguity conservatively. If a material decision is unresolved, stop and report it.\n\n${task}`,
    sessionMetadata: () => ({}),
    permissionWarning: (input) => `AGY runs with --sandbox and ACP mode ${input.mode ?? "auto"}, refusing extra ACP approvals. Local AGY settings, hooks, skills, plugins, and external MCP services still apply; sandbox enforcement depends on the host platform.`,
    existingSession(initialized) {
      if (hasResumeCapability(initialized.agentCapabilities)) return "resume";
      throw new RelayFailure("RESUME_UNSUPPORTED", "AGY did not advertise session resume capability");
    },
    createSummarizer: (limitBytes) => new StandardSummaries(limitBytes, "agy"),
    handlePermission(params, rt) {
      if (params.sessionId !== rt.sessionId || rt.signal.aborted || rt.hasFailure()) {
        return cancelledPermission();
      }
      rt.markRequested();
      const reject = params.options.find((option) => option.kind === "reject_once");
      const permissionLabel = boundedString(params.toolCall.title ?? params.toolCall.toolCallId, 256);
      const permissionFailure = new RelayFailure(
        "PERMISSION_REQUIRED",
        reject
          ? `AGY permission was rejected: ${permissionLabel}`
          : `AGY requested permission without a reject_once option: ${permissionLabel}`,
        rt.partial(),
      );
      rt.setFailure(permissionFailure);
      setImmediate(() => rt.abort(permissionFailure));
      return reject
        ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } }
        : cancelledPermission();
    },
    async configureSession(ctx, sessionId, input, extras, signal) {
      const requested = [
        ["model", input.model],
        ["thought_level", input.effort],
        ["mode", input.mode ?? "auto"],
      ] as const;
      let options = [...(extras.configOptions ?? [])];
      for (const [id, value] of requested) {
        if (value === undefined) continue;
        if (signal?.aborted) abortFailure(signal);
        const option = options.find((entry) => entry.id === id);
        if (!option) {
          throw new RelayFailure("CONFIG_UNSUPPORTED", `AGY did not advertise the ${id} session option`);
        }
        if (!configSelectValues(option).includes(value)) {
          throw new RelayFailure("INVALID_CONFIG", `AGY ${id} value is not available`);
        }
        const response = await withTimeout(ctx.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: id,
          value,
        }), config.phaseTimeoutMs, "CONFIG_TIMEOUT", `AGY ${id} configuration timed out`);
        if (signal?.aborted) abortFailure(signal);
        options = [...response.configOptions];
        if (options.find((entry) => entry.id === id)?.currentValue !== value) {
          throw new RelayFailure("INVALID_CONFIG", `AGY did not apply the requested ${id} value`);
        }
      }
      for (const [id, value] of requested) {
        if (value === undefined) continue;
        if (options.find((entry) => entry.id === id)?.currentValue !== value) {
          throw new RelayFailure("INVALID_CONFIG", `AGY configuration did not retain the requested ${id} value`);
        }
      }
    },
  };
}

export class AgyRunner extends AcpRunner<AgyDelegateInput, AgyRelayResult> {
  constructor(config: RelayConfig, store: SessionStore) {
    super(config, store, agyAdapter(config));
  }

  override delegate(input: AgyDelegateInput, signal?: AbortSignal, reportProgress?: ProgressReporter): Promise<AgyRelayResult> {
    return super.delegate(input, signal, reportProgress);
  }
}
