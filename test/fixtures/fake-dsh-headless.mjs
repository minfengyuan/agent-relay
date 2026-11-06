import { appendFileSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const log = process.env.FAKE_DSH_LOG;
const record = (event) => { if (log) appendFileSync(log, `${JSON.stringify(event)}\n`); };
const patches = args.flatMap((arg, index) => arg === "--patch" ? [args[index + 1]] : []);
record({
  event: "spawn", args, cwd: process.cwd(), pid: process.pid,
  emptyKeyPresent: process.env.DEEPSEEK_API_KEY === "",
  keyPresent: Object.hasOwn(process.env, "DEEPSEEK_API_KEY"),
  permissionMode: process.env.DSH_PERMISSION_MODE,
  patches: patches.map((path) => ({ path, contents: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777 })),
});
if (args.includes("--dump-config")) {
  const mode = process.env.FAKE_DSH_DUMP;
  if (mode === "hang") setInterval(() => {}, 1000);
  else {
    if (mode === "exit") process.exitCode = 1;
    process.stdout.write(mode === "invalid" ? "not a config\n" : "- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n");
  }
} else {
  const scenario = process.env.FAKE_DSH_TRANSCRIPT ?? "credential-restore-run";
  const transcript = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "transcripts/dsh-0.2.2-rc.1", `${scenario}.json`), "utf8"));
  const id = args.includes("--session-id") ? args[args.indexOf("--session-id") + 1]
    : process.env.FAKE_SESSION_ID ?? "fake-session-1";
  const remap = (event) => {
    const copy = structuredClone(event);
    if ("sessionId" in copy) {
      copy.sessionId = process.env.FAKE_DSH_MISMATCH === "1" && copy.type === "final" ? "wrong-id" : id;
    }
    if (copy.type === "session") copy.cwd = process.cwd();
    return copy;
  };
  const emit = (event) => process.stdout.write(`${JSON.stringify(remap(event))}\n`);
  let task = "";
  for await (const chunk of process.stdin) task += chunk.toString();
  record({ event: "stdin", task });
  if (args.includes("--session-id")) record(`resume:${id}`);
  if (scenario === "sigterm-tool" && process.env.FAKE_DSH_REPLAY_CANCEL !== "1") {
    for (const line of transcript.lines.filter((line) => line.t < transcript.signalSentMs)) emit(line.json);
    const timer = setInterval(() => {}, 1000);
    process.on("SIGTERM", () => {
      record(`cancel:${id}`);
      clearInterval(timer);
      const remaining = transcript.lines.filter((line) => line.t >= transcript.signalSentMs)
        .map((line) => `${JSON.stringify(remap(line.json))}\n`).join("");
      process.stdout.write(remaining, () => {
        process.stderr.write(transcript.stderr, () => process.exit(transcript.exitCode));
      });
    });
    record(`prompt:${id}`);
  } else {
    record(`prompt:${id}`);
    if (process.env.FAKE_DSH_NO_EVENTS !== "1") {
      for (const line of transcript.lines) emit(line.json);
    }
    process.stderr.write(transcript.stderr);
    process.exitCode = process.env.FAKE_DSH_NO_EVENTS === "1" ? 1 : transcript.exitCode;
  }
}
