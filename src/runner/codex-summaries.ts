import { z } from "zod";
import type { CodexRelayResult, ToolCallSummary } from "../types.js";
import { appendLimited, boundedString, jsonSize } from "./limits.js";
import { object, type CodexMessage } from "./codex-client.js";

const tokenUsage = z.object({
  totalTokens: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  cacheWriteInputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative(),
  reasoningOutputTokens: z.number().nonnegative(),
});

export const codexUsageSchema = z.object({
  total: tokenUsage,
  last: tokenUsage,
  modelContextWindow: z.number().nonnegative().nullable(),
});

const toolTypes = new Set([
  "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall",
  "collabAgentToolCall", "webSearch", "imageView", "imageGeneration",
]);

export class CodexSummaries {
  text = "";
  truncated = false;
  private summariesTruncated = false;
  private usage: CodexRelayResult["usage"];
  private readonly tools = new Map<string, ToolCallSummary>();
  // Byte counts suffice for delta/completed deduplication; do not retain a second transcript.
  private readonly messageBytes = new Map<string, number>();
  private readonly completedMessages = new Set<string>();

  constructor(private readonly textLimit: number, private readonly summaryLimit = Math.max(64 * 1_024, textLimit)) {}

  update(method: string, params: CodexMessage): string | undefined {
    if (method === "item/agentMessage/delta") {
      if (typeof params.itemId !== "string" || typeof params.delta !== "string" || this.completedMessages.has(params.itemId)) return;
      if (!this.trackMessage(params.itemId)) return;
      this.messageBytes.set(params.itemId, (this.messageBytes.get(params.itemId) ?? 0) + Buffer.byteLength(params.delta));
      this.append(params.delta);
    } else if (method === "thread/tokenUsage/updated") {
      const parsed = codexUsageSchema.safeParse(params.tokenUsage);
      if (parsed.success) this.usage = parsed.data;
    } else if (method === "item/started" || method === "item/completed") {
      const item = object(params.item);
      if (typeof item.id !== "string") return;
      if (item.type === "agentMessage" && method === "item/completed") {
        if (!this.trackMessage(item.id) || this.completedMessages.has(item.id)) return;
        if (typeof item.text === "string") {
          const bytes = Buffer.from(item.text);
          this.append(bytes.subarray(this.messageBytes.get(item.id) ?? 0).toString("utf8"));
        }
        this.completedMessages.add(item.id);
      } else if (typeof item.type === "string" && toolTypes.has(item.type)) {
        if (item.id.length > 256) { this.summariesTruncated = true; return; }
        const rawTitle = typeof item.command === "string" ? item.command
          : typeof item.tool === "string" ? item.tool : item.type;
        const title = boundedString(rawTitle, 512);
        const rawStatus = typeof item.status === "string" ? item.status
          : method === "item/completed" ? "completed" : "inProgress";
        const status = boundedString(rawStatus, 64);
        this.summariesTruncated ||= title !== rawTitle || status !== rawStatus;
        const summary: ToolCallSummary = {
          toolCallId: boundedString(item.id, 256), title,
          status,
        };
        const prior = this.tools.get(item.id);
        this.tools.set(item.id, summary);
        if (this.tools.size > 1_024 || jsonSize([...this.tools.values()]) > this.summaryLimit) {
          if (prior) this.tools.set(item.id, prior);
          else this.tools.delete(item.id);
          this.summariesTruncated = true;
        }
        return title;
      }
    }
    return undefined;
  }

  result(): Pick<CodexRelayResult, "provider" | "text" | "truncated"> & Partial<CodexRelayResult> {
    return {
      provider: "codex", text: this.text, truncated: this.truncated || this.summariesTruncated,
      ...(this.tools.size ? { toolCalls: [...this.tools.values()] } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.summariesTruncated ? { summariesTruncated: true } : {}),
    };
  }

  private trackMessage(id: string): boolean {
    if (this.messageBytes.has(id)) return true;
    if (id.length > 256 || this.messageBytes.size >= 1_024) {
      this.truncated = true;
      return false;
    }
    this.messageBytes.set(id, 0);
    return true;
  }

  private append(text: string): void {
    const next = appendLimited(this.text, text, this.textLimit);
    this.text = next.value;
    this.truncated ||= next.truncated;
  }
}
