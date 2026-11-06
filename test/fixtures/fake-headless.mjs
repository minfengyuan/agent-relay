import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { once } from "node:events";

const [mode, sessionId, log, promptFile] = process.argv.slice(2);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const record = (message) => appendFileSync(log, `${message}\n`);
const held = setInterval(() => {}, 1000);
record(`start:${sessionId}`);
record(`prompt:${readFileSync(promptFile, "utf8")}`);
process.on("SIGTERM", () => {
  record("root-sigterm");
  if (mode === "cancel") {
    setTimeout(() => {
      emit({ type: "final", stopReason: "cancelled", ok: false });
      record("cancel-final");
    }, 50);
  } else {
    clearInterval(held);
    process.exit(0);
  }
});
process.stdin.on("data", (chunk) => record(`stdin:${chunk.toString()}`));
process.stdin.on("end", () => record("stdin-eof"));
if (mode === "stdin") await once(process.stdin, "end");

if (mode !== "no-session" && mode !== "preset-first") {
  emit({ type: "session", id: mode === "mismatch" ? "wrong-id" : sessionId });
}
if (mode === "preset-first") emit({ type: "future-event" });
if (mode === "mismatch-late") emit({ type: "text", text: "bad", sessionId: "wrong-id" });
if (mode === "malformed") process.stdout.write("not-json\n");
if (mode === "oversize") process.stdout.write(`"${"x".repeat(8 * 1024 * 1024)}"\n`);
if (mode === "unknown") emit({ type: "future-event", data: "ignored" });
if (mode === "descendant") {
  const child = spawn(process.execPath, ["-e", `
    const { appendFileSync } = require("node:fs");
    setInterval(() => {}, 1000);
    process.on("SIGTERM", () => {
      appendFileSync(process.argv[1], "descendant-sigterm\\n");
      process.exit(0);
    });
    appendFileSync(process.argv[1], "descendant-ready\\n");
    process.send("ready");
  `, log], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(child, "message");
  child.disconnect();
  child.unref();
  record(`descendant:${child.pid}`);
}
if (mode === "hang" || mode === "cancel" || mode === "preset-first") {
  emit({ type: "text", text: "partial" });
  record("waiting");
} else {
  emit({ type: "text", text: mode === "large" ? "世界".repeat(200) : "answer" });
  emit({ type: "toolCall", id: "tool-1", title: "test tool" });
  emit({ type: "toolResult", id: "tool-1", status: "completed" });
  emit({ type: "usage", usage: { used: 10, size: 100 } });
  if (mode === "large" || mode === "summary-large") {
    for (let index = 0; index < 100; index++) {
      emit({ type: "toolCall", id: `tool-${index}`, title: "x".repeat(100) });
    }
  }
  if (mode === "permission") {
    emit({ type: "permissionDenied", title: "operation denied" });
    emit({ type: "text", text: " after denial" });
  }
  if (mode === "error") emit({ type: "error", message: "terminal error" });
  else if (mode !== "missing-final") emit({ type: "final", stopReason: "end_turn", ok: mode !== "failed-final" });
  record("done");
  if (mode === "nonzero" || mode === "error") {
    process.exitCode = 1;
    clearInterval(held);
    process.stdin.destroy();
  } else {
    clearInterval(held);
    process.stdin.destroy();
    process.stdout.end();
  }
}
