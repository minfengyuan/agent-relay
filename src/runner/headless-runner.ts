import { prepareNativeConfig } from "../adapters/native-config.js";
import type { RelayConfig } from "../config.js";
import type { Readable } from "node:stream";
import type { SessionRecord, SessionStore } from "../store.js";
import { RelayFailure, type DelegateInput, type RelayResult } from "../types.js";
import { appendLimited, boundedString } from "./limits.js";
import { ndjsonLines } from "./ndjson-lines.js";
import type { HeadlessAdapter, HeadlessExit, HeadlessState, HeadlessStdin, ProgressReporter } from "./types.js";
import { WorkerHost } from "./worker-host.js";

export class HeadlessRunner<I extends DelegateInput, R extends RelayResult> {
  private readonly host: WorkerHost;

  constructor(
    private readonly config: RelayConfig,
    private readonly store: SessionStore,
    private readonly adapter: HeadlessAdapter<I, R>,
  ) {
    this.host = new WorkerHost(config, store);
  }

  delegate(input: I, signal?: AbortSignal, progress?: ProgressReporter): Promise<R> {
    const state: HeadlessState<R> = {
      sessionId: null, text: "", truncated: false,
      final: undefined, error: undefined, permissionDenied: undefined,
      summarizer: this.adapter.createSummarizer(this.config.textLimitBytes),
    };
    let expectedId: string | undefined;
    let effectiveInput = input;
    let stdin: HeadlessStdin = "ignore";
    let reading: Promise<void> | undefined;
    let output: Readable | undefined;
    let stopped = false;
    let lastProgress = 0;
    let progressPending = false;
    let terminalReceived!: () => void;
    const terminal = new Promise<void>((resolve) => { terminalReceived = resolve; });
    const partial = (record?: SessionRecord): Partial<R> => ({
      ...state.summarizer.result(),
      sessionId: state.sessionId ?? record?.sessionId ?? null,
      text: state.text,
      truncated: state.truncated || state.summarizer.truncated,
    } as Partial<R>);
    const validateId = (id: string): void => {
      if (!id || id.trim() !== id || id.length > 256 || (expectedId !== undefined && id !== expectedId)) {
        throw new RelayFailure("PROTOCOL_MISMATCH", "Worker returned an inconsistent session ID");
      }
      expectedId = id;
    };

    return this.host.run({
      cwd: input.cwd,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      displayName: this.adapter.displayName,
      failureCode: this.adapter.failureCode,
      partial,
      prepare: async (env, record, runHelper) => {
        if (input.sessionId !== undefined && !input.sessionId.trim()) {
          throw new RelayFailure("INVALID_INPUT", "A resumed session ID must be nonempty");
        }
        if (record) {
          validateId(record.sessionId);
          state.sessionId = record.sessionId;
        }
        const preset = this.adapter.presetSessionId?.(input, record);
        if (preset !== undefined) validateId(preset);
        effectiveInput = { ...input, ...(expectedId === undefined ? {} : { sessionId: expectedId }) };
        return prepareNativeConfig(this.config.stateDir, "headless", async (directory) => {
          const prepared = await this.adapter.prepare(effectiveInput, record, directory, { env, runHelper });
          stdin = prepared.stdin;
          const merged = { ...env, ...prepared.env };
          return { ...prepared, env: this.adapter.spawnEnv?.(merged) ?? merged };
        });
      },
      invocation: (record) => this.adapter.command(effectiveInput, record),
      cancelGraceMs: this.adapter.gracefulStop.graceMs,
      gracefulCancel: async (ctx) => {
        if (ctx.child.exitCode !== null || ctx.child.signalCode !== null) return;
        ctx.child.kill(this.adapter.gracefulStop.signal);
        await terminal;
      },
      dispose: async () => {
        stopped = true;
        output?.destroy();
        await reading?.catch(() => undefined);
      },
      drive: async (ctx) => {
        output = ctx.child.stdout;
        const exit = new Promise<HeadlessExit>((resolve, reject) => {
          ctx.child.once("exit", (code, signal) => resolve({ code, signal }));
          ctx.child.once("error", reject);
        });
        void exit.catch(() => undefined);
        ctx.child.stdin.on("error", (error: Error) => ctx.abort(new RelayFailure(this.adapter.failureCode, error.message)));
        reading = (async () => {
          for await (const raw of ndjsonLines(ctx.child.stdout)) {
            if (stopped) break;
            const event = this.adapter.decode(raw);
            if (event.sessionId !== undefined) validateId(event.sessionId);
            if (event.type === "session") validateId(event.id);
            if (expectedId !== undefined && state.sessionId === null) {
              await this.store.writeNew(expectedId, input.cwd);
              state.sessionId = expectedId;
            }
            switch (event.type) {
              case "text": {
                const appended = appendLimited(state.text, event.text, this.config.textLimitBytes);
                state.text = appended.value;
                state.truncated ||= appended.truncated;
                break;
              }
              case "toolCall":
              case "toolResult": {
                state.summarizer.onToolCall?.({
                  toolCallId: event.id,
                  ...(event.type === "toolCall" ? { title: event.title } : { status: event.status }),
                });
                if (progress && !progressPending && Date.now() - lastProgress >= this.config.progressIntervalMs) {
                  lastProgress = Date.now();
                  progressPending = true;
                  const message = boundedString(event.type === "toolCall" ? event.title : event.status, 1_024);
                  void Promise.resolve().then(() => progress(message)).catch(() => undefined)
                    .finally(() => { progressPending = false; });
                }
                break;
              }
              case "permissionDenied":
                state.permissionDenied ??= boundedString(event.title, 2_048);
                if (event.id) state.summarizer.onToolCall?.({ toolCallId: event.id, status: "failed" });
                break;
              case "usage":
                state.summarizer.onUsage?.({ sessionUpdate: "usage_update", ...event.usage });
                break;
              case "final":
                if (event.text !== undefined) {
                  const appended = appendLimited("", event.text, this.config.textLimitBytes);
                  state.text = appended.value;
                  state.truncated ||= appended.truncated;
                }
                state.final = {
                  type: "final", stopReason: boundedString(event.stopReason, 256), ok: event.ok,
                  ...(event.error === undefined ? {} : { error: boundedString(event.error, 2_048) }),
                  ...(event.errorCode === undefined ? {} : { errorCode: boundedString(event.errorCode, 256) }),
                };
                terminalReceived();
                break;
              case "error":
                state.error = boundedString(event.message, 2_048);
                terminalReceived();
                break;
            }
          }
        })();
        void reading.catch(() => undefined);
        await ctx.ready;
        if (stdin !== "ignore") {
          const mode = stdin;
          const written = new Promise<void>((resolve, reject) => {
            ctx.child.stdin.end(typeof mode === "object" ? mode.write : undefined, (error?: Error | null) => {
              if (error) reject(error);
              else resolve();
            });
          });
          await ctx.run(written);
        }
        const [, exited] = await ctx.run(Promise.all([reading, exit]));
        if (state.permissionDenied !== undefined) {
          throw new RelayFailure("PERMISSION_REQUIRED", state.permissionDenied);
        }
        const result = this.adapter.complete(state, exited);
        if (!state.final?.ok || state.error !== undefined) {
          throw new RelayFailure(this.adapter.failureCode, state.error ?? state.final?.error ?? "Worker did not complete successfully");
        }
        if (state.sessionId === null) throw new RelayFailure("INVALID_SESSION", "Worker completed without a session ID");
        if (ctx.record) await this.store.touch(ctx.record);
        return { ...result, ...partial() } as R;
      },
    }, signal);
  }
}
