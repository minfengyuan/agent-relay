import type * as acp from "@agentclientprotocol/sdk";
import type { DelegateInput, RelayErrorCode, RelayFailure, RelayResult, UsageSummary } from "../types.js";
import type { SessionRecord } from "../store.js";
import type { PreparationHelper } from "./worker-host.js";

export type ProgressReporter = (message: string) => Promise<void> | void;

export type Provider = "grok" | "cursor" | "opencode" | "dsh" | "claude";
export type ExistingSessionAction = "resume" | "load";

export type ToolCallUpdate = {
  toolCallId: string;
  title?: string;
  status?: string;
};

export type ProviderSummarizer<R extends RelayResult> = {
  truncated: boolean;
  result(): Partial<R>;
  onToolCall?(update: ToolCallUpdate): void;
  onUsage?(update: Extract<acp.SessionUpdate, { sessionUpdate: "usage_update" }>): void;
};

export type PermissionRuntime<R extends RelayResult> = {
  sessionId: string | null;
  signal: AbortSignal;
  partial: () => Partial<R>;
  abort: (failure: RelayFailure) => void;
  markRequested: () => void;
  setFailure: (failure: RelayFailure) => void;
  hasFailure: () => boolean;
  summarizer: ProviderSummarizer<R>;
};

export type SessionExtras = {
  agentCapabilities: acp.AgentCapabilities | null | undefined;
  configOptions: readonly acp.SessionConfigOption[] | null | undefined;
  modes: acp.SessionModeState | null | undefined;
  metadata: Pick<SessionRecord, "model" | "mode">;
};

export type PreparedSpawn = {
  env: NodeJS.ProcessEnv;
  extraArgs?: string[];
  dispose(): Promise<void>;
};

export type HeadlessStdin = "ignore" | "close" | { write: string };

export type HeadlessEvent = (
  | { type: "session"; id: string }
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; title: string }
  | { type: "toolResult"; id: string; status: string }
  | { type: "permissionDenied"; id?: string; title: string }
  | { type: "usage"; usage: UsageSummary }
  | { type: "final"; stopReason: string; ok: boolean; error?: string; errorCode?: string; text?: string }
  | { type: "error"; message: string }
  | { type: "ignore" }
) & { sessionId?: string };

export type HeadlessState<R extends RelayResult> = {
  sessionId: string | null;
  text: string;
  truncated: boolean;
  final: Extract<HeadlessEvent, { type: "final" }> | undefined;
  error: string | undefined;
  permissionDenied: string | undefined;
  summarizer: ProviderSummarizer<R>;
};

export type HeadlessExit = { code: number | null; signal: NodeJS.Signals | null };

export type HeadlessAdapter<I extends DelegateInput, R extends RelayResult> = {
  displayName: string;
  failureCode: RelayErrorCode;
  prepare(input: I, record: SessionRecord | undefined, directory: string, context: {
    env: NodeJS.ProcessEnv;
    runHelper: PreparationHelper;
  }): Promise<Omit<PreparedSpawn, "dispose"> & {
    stdin: HeadlessStdin;
  }>;
  spawnEnv?(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  command(input: I, record?: SessionRecord): { command: string; args: string[] };
  presetSessionId?(input: I, record?: SessionRecord): string | undefined;
  decode(event: unknown): HeadlessEvent;
  complete(state: Readonly<HeadlessState<R>>, exit: HeadlessExit): R;
  gracefulStop: { signal: NodeJS.Signals; graceMs: number };
  createSummarizer(limitBytes: number): ProviderSummarizer<R>;
};

export type ProviderAdapter<I extends DelegateInput, R extends RelayResult> = {
  provider: Provider;
  displayName: string;
  command(input: I, record?: SessionRecord): { command: string; args: string[] };
  authenticate(initialized: acp.InitializeResponse): string | undefined;
  authenticateParams?(methodId: string): acp.AuthenticateRequest;
  capabilities: acp.ClientCapabilities;
  prompt(task: string): string;
  sessionMetadata(input: I, record?: SessionRecord): Pick<SessionRecord, "model" | "mode">;
  persistNewSessionBeforeConfigure?: boolean;
  spawnEnv?(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  prepareSpawn?(input: I, env: NodeJS.ProcessEnv): Promise<PreparedSpawn>;
  permissionWarning?(input: I): string;
  existingSession?(initialized: acp.InitializeResponse, input: I): ExistingSessionAction;
  validateInitialized?(initialized: acp.InitializeResponse): void;
  validateInput?(input: I): void;
  mapError?(error: unknown): RelayFailure | undefined;
  createSummarizer(limitBytes: number): ProviderSummarizer<R>;
  handlePermission(params: acp.RequestPermissionRequest, rt: PermissionRuntime<R>): acp.RequestPermissionResponse;
  extendClient?(app: acp.ClientApp, summarizer: ProviderSummarizer<R>): acp.ClientApp;
  configureSession?(
    ctx: acp.ClientContext,
    sessionId: string,
    input: I,
    extras: SessionExtras,
    signal?: AbortSignal,
  ): Promise<void>;
  finalizeSession?(
    ctx: acp.ClientContext,
    sessionId: string,
  ): Promise<void>;
};
