import type { Readable } from "node:stream";
import { RelayFailure } from "../types.js";

export const NDJSON_FRAME_LIMIT_BYTES = 8 * 1_024 * 1_024;

export async function* ndjsonLines(
  source: Readable,
  limitBytes = NDJSON_FRAME_LIMIT_BYTES,
): AsyncGenerator<unknown> {
  let buffer = Buffer.alloc(0);
  let size = 0;
  const parse = (line: Buffer): unknown => {
    try { return JSON.parse(line.toString("utf8")); } catch {
      throw new RelayFailure("PROTOCOL_MISMATCH", "Worker returned malformed NDJSON");
    }
  };
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      const part = bytes.subarray(offset, end);
      size += part.length;
      if (size > limitBytes) throw new RelayFailure("PROTOCOL_MISMATCH", "Worker NDJSON frame exceeded the byte limit");
      if (size > buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(limitBytes, Math.max(4_096, buffer.length * 2, size)));
        buffer.copy(grown, 0, 0, size - part.length);
        buffer = grown;
      }
      part.copy(buffer, size - part.length);
      if (newline < 0) break;
      const line = buffer.subarray(0, size);
      size = 0;
      if (line.toString("utf8").trim()) yield parse(line);
      offset = end + 1;
    }
  }
  if (size > 0) {
    const line = buffer.subarray(0, size);
    if (line.toString("utf8").trim()) yield parse(line);
  }
}
