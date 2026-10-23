import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { RelayFailure } from "../types.js";
import { boundedString } from "./limits.js";

export type CodexMessage = Record<string, unknown>;
export const CODEX_FRAME_LIMIT_BYTES = 8 * 1_024 * 1_024;

export function object(value: unknown): CodexMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayFailure("PROTOCOL_MISMATCH", "Codex returned an invalid protocol object");
  }
  return value as CodexMessage;
}

/** Codex app-server JSONL intentionally omits the JSON-RPC version header. */
export class CodexClient {
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private failure: RelayFailure | undefined;
  private readonly pending = new Map<number, {
    resolve: (value: CodexMessage) => void;
    reject: (error: RelayFailure) => void;
  }>();
  private readonly onData = (chunk: Buffer): void => {
    try {
      // Process each frame before retaining a partial frame; no unbounded readline buffer.
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        if (this.buffer.length + end - offset > CODEX_FRAME_LIMIT_BYTES) {
          throw new RelayFailure("PROTOCOL_MISMATCH", "Codex protocol frame exceeded 8 MiB");
        }
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)]);
        if (newline < 0) break;
        const line = this.buffer.toString("utf8");
        this.buffer = Buffer.alloc(0);
        if (line.trim()) this.receive(object(JSON.parse(line)));
        offset = end + 1;
        if (this.failure) break;
      }
    } catch (error) {
      this.fail(error instanceof RelayFailure ? error
        : new RelayFailure("PROTOCOL_MISMATCH", "Codex returned malformed JSONL"));
    }
  };
  private readonly onEnd = (): void => this.fail(new RelayFailure("CODEX_FAILURE", "Codex stdout closed"));
  private readonly onExit = (): void => this.fail(new RelayFailure("CODEX_FAILURE", "Codex process exited"));
  private readonly onError = (error: Error): void => this.fail(new RelayFailure("CODEX_FAILURE", boundedString(error.message, 1_024)));

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onMessage: (message: CodexMessage) => void,
    private readonly onFailure: (error: RelayFailure) => void,
  ) {
    child.stdout.on("data", this.onData);
    child.stdout.on("end", this.onEnd);
    child.stdout.on("error", this.onError);
    child.stdin.on("error", this.onError);
    child.on("error", this.onError);
    child.on("exit", this.onExit);
  }

  request(method: string, params: CodexMessage): Promise<CodexMessage> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params }).catch((error: RelayFailure) => this.fail(error));
    });
  }

  send(message: CodexMessage): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(new RelayFailure("CODEX_FAILURE", boundedString(error.message, 1_024)));
        else resolve();
      });
    });
  }

  dispose(): void {
    this.fail(new RelayFailure("CANCELLED", "Codex connection closed"), false);
    this.child.stdout.off("data", this.onData);
    this.child.stdout.off("end", this.onEnd);
    this.child.stdout.off("error", this.onError);
    // Retain error listeners until the streams close: pending writes can fail during cleanup.
    this.child.off("exit", this.onExit);
    this.buffer = Buffer.alloc(0);
  }

  private receive(message: CodexMessage): void {
    if (typeof message.method === "string") {
      if (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number") {
        throw new RelayFailure("PROTOCOL_MISMATCH", "Codex sent an invalid server request ID");
      }
      this.onMessage(message);
      return;
    }
    if (typeof message.id !== "number" || (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))) {
      throw new RelayFailure("PROTOCOL_MISMATCH", "Codex sent an invalid response");
    }
    const pending = this.pending.get(message.id);
    if (!pending) throw new RelayFailure("PROTOCOL_MISMATCH", "Codex sent an unknown response ID");
    if (message.error !== undefined) {
      const error = object(message.error);
      const failure = new RelayFailure(error.code === -32601 ? "PROTOCOL_MISMATCH" : "CODEX_FAILURE",
        boundedString(typeof error.message === "string" ? error.message : "Codex request failed", 2_048));
      this.pending.delete(message.id);
      pending.reject(failure);
    } else {
      const result = object(message.result);
      this.pending.delete(message.id);
      pending.resolve(result);
    }
  }

  private fail(error: RelayFailure, notify = true): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (notify) this.onFailure(error);
  }
}
