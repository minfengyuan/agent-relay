import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.js";
import { dshAdapter } from "../src/adapters/dsh.js";
import { grokAdapter } from "../src/adapters/grok.js";
import { baseConfig } from "./helpers.js";
import { assertHeadlessVersion, HEADLESS_BASELINES, observeHeadlessEvents } from "./headless-baseline.js";

describe("headless smoke baseline checks", () => {
  const config = baseConfig("unused");
  const providers = [
    ["grok", grokAdapter(config)],
    ["dsh", dshAdapter(config)],
    ["claude", claudeAdapter(config)],
  ] as const;

  it.each(providers)("accepts all committed %s event types and ignores future types at runtime", (provider, adapter) => {
    const directory = join(import.meta.dirname, "fixtures/transcripts", `${provider}-${HEADLESS_BASELINES[provider]}`);
    const observed = observeHeadlessEvents(provider, adapter);
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
      const trace = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
        lines: Array<{ json: Record<string, unknown> }>;
      };
      for (const line of trace.lines) observed.adapter.decode(line.json);
    }
    observed.assertEvents([]);
    const future = { type: "future_event" };
    expect(observed.adapter.decode(future)).toEqual({ type: "ignore" });
    expect(() => observed.assertEvents([])).toThrow("event types outside committed baseline");
  });

  it("allows optional baseline types to be absent but requires terminal events", () => {
    const observed = observeHeadlessEvents("grok", grokAdapter(config));
    const trace = JSON.parse(readFileSync(join(import.meta.dirname,
      "fixtures/transcripts/grok-1.0.77/new-session-success.json"), "utf8")) as {
      lines: Array<{ json: { type: string } }>;
    };
    for (const line of trace.lines.filter((line) => ["text", "end"].includes(line.json.type))) {
      observed.adapter.decode(line.json);
    }
    observed.assertEvents(["text", "end"]);
    expect(() => observed.assertEvents(["error"])).toThrow("missing required event error");
  });

  it.each(["1.0.77", "1.0.770"])("checks the exact CLI version %s without running a real CLI", async (version) => {
    const checked = assertHeadlessVersion("grok", {
      command: process.execPath, args: ["-e", `console.log("grok ${version}")`, "--"],
    });
    if (version === HEADLESS_BASELINES.grok) await expect(checked).resolves.toBeUndefined();
    else await expect(checked).rejects.toThrow("version drift");
  });
});
