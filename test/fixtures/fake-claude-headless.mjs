import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const log = process.env.FAKE_CLAUDE_LOG;
const record = (event) => { if (log) appendFileSync(log, `${JSON.stringify(event)}\n`); };
const option = (name) => args[args.indexOf(name) + 1];
const resume = args.includes("--resume");
const id = option(resume ? "--resume" : "--session-id")
  ?? process.env.FAKE_SESSION_ID ?? "00000000-0000-4000-8000-000000000001";
let task = "";
for await (const chunk of process.stdin) task += chunk.toString();
record({
  event: "spawn", args, id, cwd: process.cwd(), pid: process.pid,
  delegated: process.env.AGENT_RELAY_DELEGATED, task,
  model: option("--model") ?? null, effort: option("--effort") ?? null,
});

const scenario = process.env.FAKE_CLAUDE_TRANSCRIPT ?? (resume ? "resume-success" : "new-session-success");
const transcript = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),
  "transcripts/claude-2.1.318", `${scenario}.json`), "utf8"));
const emit = (event) => {
  const copy = structuredClone(event);
  if ("session_id" in copy) copy.session_id = process.env.FAKE_CLAUDE_MISMATCH === "1" ? "wrong-id" : id;
  if ("cwd" in copy) copy.cwd = process.cwd();
  if ("original_cwd" in copy) copy.original_cwd = process.cwd();
  process.stdout.write(`${JSON.stringify(copy)}\n`);
};
const finish = (code) => {
  record({ event: "exit", code });
  process.stderr.write(transcript.stderr, () => {
    process.stdout.end(() => process.exit(code));
  });
};
const replay = process.env.FAKE_CLAUDE_REPLAY_CANCEL === "1";
if (transcript.signalSentMs !== null && !replay) {
  for (const line of transcript.lines.filter((line) => line.t < transcript.signalSentMs)) emit(line.json);
  record(`prompt:${id}`);
  const held = setInterval(() => {}, 1_000);
  let stopping = false;
  process.on("SIGTERM", () => {
    record("root-sigterm");
    if (stopping) return;
    stopping = true;
    clearInterval(held);
    for (const line of transcript.lines.filter((line) => line.t >= transcript.signalSentMs)) emit(line.json);
    setTimeout(() => finish(transcript.exitCode), 150);
  });
  record("waiting");
} else {
  record(`prompt:${id}`);
  for (const line of transcript.lines) emit(line.json);
  finish(transcript.exitCode);
}
