import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ndjsonLines, NDJSON_FRAME_LIMIT_BYTES } from "../src/runner/ndjson-lines.js";

async function read(chunks: Array<Buffer | string>, limit?: number) {
  const events: unknown[] = [];
  for await (const event of ndjsonLines(Readable.from(chunks), limit)) events.push(event);
  return events;
}

describe("NDJSON lines", () => {
  it("uses an 8 MiB frame limit", () => {
    expect(NDJSON_FRAME_LIMIT_BYTES).toBe(8 * 1_024 * 1_024);
  });

  it("handles split frames, CRLF, blank lines, and a final line without a newline", async () => {
    await expect(read(['{"type":', '"first"}\r\n\n  \n{"type":"last"}']))
      .resolves.toEqual([{ type: "first" }, { type: "last" }]);
  });

  it("preserves UTF-8 characters split across chunks", async () => {
    const bytes = Buffer.from('{"text":"世界"}\n');
    await expect(read([...bytes].map((byte) => Buffer.from([byte])))).resolves.toEqual([{ text: "世界" }]);
  });

  it("limits each frame rather than the whole stream", async () => {
    await expect(read(['123\n456\n'], 3)).resolves.toEqual([123, 456]);
  });

  it.each([["1234\n"], ["12", "34"], ["1234"]])("rejects an oversized frame (%j)", async (...chunks) => {
    await expect(read(chunks, 3)).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
  });

  it.each(["not-json\n", '{"broken":', "true false\n"])("rejects malformed JSON (%s)", async (line) => {
    await expect(read([line])).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
  });
});
