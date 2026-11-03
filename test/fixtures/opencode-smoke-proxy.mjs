import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const logPath = process.env.OPENCODE_RELAY_SMOKE_LOG;
const log = (entry) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
};
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
log({ pids: [process.pid, child.pid].filter(Boolean) });

function recordProcesses() {
  if (process.platform === "win32") return;
  const listing = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
  if (listing.status !== 0) return;
  const pairs = listing.stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const pids = new Set([process.pid, child.pid]);
  let size;
  do {
    size = pids.size;
    for (const [pid, parent] of pairs) if (pids.has(parent)) pids.add(pid);
  } while (size !== pids.size);
  log({ pids: [...pids] });
}

function observer(direction) {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString();
    let boundary;
    while ((boundary = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, boundary);
      pending = pending.slice(boundary + 1);
      try {
        const frame = JSON.parse(line);
        const params = frame.params;
        const update = params?.update;
        log({
          direction,
          method: frame.method,
          id: frame.id,
          sessionId: params?.sessionId,
          update: update?.sessionUpdate,
          toolCallId: update?.toolCallId,
          title: update?.title,
          options: params?.options,
          outcome: frame.result?.outcome,
          configOptions: frame.result?.configOptions,
          agentInfo: frame.result?.agentInfo,
          stopReason: frame.result?.stopReason,
          errorCode: frame.error?.code,
        });
        if (direction === "agent" && frame.result?.configOptions) recordProcesses();
      } catch {
        log({ invalidFrame: true, direction });
      }
    }
  };
}

process.stdin.on("data", observer("client"));
child.stdout.on("data", observer("agent"));
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
child.on("error", () => {
  log({ spawnFailed: true });
  process.exitCode = 1;
  process.stdin.destroy();
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
  process.stdin.destroy();
});
