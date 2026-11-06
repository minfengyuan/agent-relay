import { appendFileSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const log = process.env.FAKE_GROK_LOG;
const record = (event) => { if (log) appendFileSync(log, `${JSON.stringify(event)}\n`); };
const option = (name) => args[args.indexOf(name) + 1];
const id = option(args.includes("-r") ? "-r" : "-s");
const prompt = option("--prompt-file");
record({
  event: "spawn", args, id, cwd: process.cwd(), delegated: process.env.AGENT_RELAY_DELEGATED,
  prompt: readFileSync(prompt, "utf8"), mode: statSync(prompt).mode & 0o777,
});
const scenario = process.env.FAKE_GROK_TRANSCRIPT ?? (args.includes("-r") ? "resume-success" : "new-session-success");
const trace = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),
  "transcripts/grok-1.0.77", `${scenario}.json`), "utf8"));
const emit = (event) => {
  const copy = structuredClone(event);
  if ("sessionId" in copy) copy.sessionId = process.env.FAKE_GROK_MISMATCH === "1" ? "wrong-id" : id;
  if ("cwd" in copy) copy.cwd = process.cwd();
  if (copy.type === "end" && process.env.FAKE_GROK_END_TURN === "1") copy.stopReason = "EndTurn";
  process.stdout.write(`${JSON.stringify(copy)}\n`);
};
const finish = (code) => {
  const stderr = process.env.FAKE_GROK_PERMISSION === "1" ? "permission required: write_file\n" : trace.stderr;
  process.stderr.write(stderr, () => {
    process.stdout.end(() => process.exit(code));
  });
};
if (trace.signalSentMs !== null && process.env.FAKE_GROK_REPLAY_CANCEL !== "1") {
  const held = setInterval(() => {}, 1000);
  let stopping = false;
  process.on("SIGTERM", () => {
    record("root-sigterm");
    if (stopping) return;
    stopping = true;
    for (const line of trace.lines.filter((line) => line.t >= trace.signalSentMs)) emit(line.json);
    record("cancel-end");
    setTimeout(() => {
      record("graceful-exit");
      clearInterval(held);
      finish(trace.exitCode);
    }, 150);
  });
  for (const line of trace.lines.filter((line) => line.t < trace.signalSentMs)) emit(line.json);
  record("waiting");
} else {
  for (const line of trace.lines) {
    if (process.env.FAKE_GROK_NO_EVENTS === "1") continue;
    if (process.env.FAKE_GROK_NO_END === "1" && line.json.type === "end") continue;
    emit(line.json);
  }
  if (process.env.FAKE_GROK_ERROR === "1") {
    const errorTrace = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),
      "transcripts/grok-1.0.77/not-signed-in.json"), "utf8"));
    for (const line of errorTrace.lines) emit(line.json);
  }
  finish(process.env.FAKE_GROK_EXIT ? Number(process.env.FAKE_GROK_EXIT) : trace.exitCode);
}
