import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import type { HeadlessAdapter } from "../src/runner/types.js";
import type { DelegateInput, RelayResult } from "../src/types.js";

const execFileAsync = promisify(execFile);
export const HEADLESS_BASELINES = {
  grok: "1.0.77",
  dsh: "0.2.2-rc.1",
  claude: "2.1.318",
} as const;
type Provider = keyof typeof HEADLESS_BASELINES;

export async function assertHeadlessVersion(
  provider: Provider,
  invocation: { command: string; args: string[] },
): Promise<void> {
  const { stdout, stderr } = await execFileAsync(invocation.command, [...invocation.args, "--version"], {
    timeout: 15_000, maxBuffer: 64 * 1_024, shell: false,
  });
  const versions = `${stdout}\n${stderr}`.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/g) ?? [];
  expect(versions, `${provider} version drift: review transcripts before updating the baseline`)
    .toContain(HEADLESS_BASELINES[provider]);
}

export function observeHeadlessEvents<I extends DelegateInput, R extends RelayResult>(
  provider: Provider,
  adapter: HeadlessAdapter<I, R>,
) {
  const directory = join(import.meta.dirname, "fixtures/transcripts", `${provider}-${HEADLESS_BASELINES[provider]}`);
  const baseline = new Set<string>();
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
    const trace = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
      lines: Array<{ json: { type: string } }>;
    };
    for (const line of trace.lines) baseline.add(line.json.type);
  }
  const observed = new Set<string>();
  return {
    adapter: {
      ...adapter,
      decode(raw: unknown) {
        if (raw !== null && typeof raw === "object" && "type" in raw && typeof raw.type === "string") {
          observed.add(raw.type);
        }
        return adapter.decode(raw);
      },
    },
    assertEvents(required: string[]) {
      expect([...observed].filter((type) => !baseline.has(type)), `${provider} event types outside committed baseline`)
        .toEqual([]);
      for (const type of required) expect(observed, `${provider} missing required event ${type}`).toContain(type);
    },
  };
}
