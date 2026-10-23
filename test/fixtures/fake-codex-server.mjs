import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.env.CODEX_FIXTURE_MODE;
let threadId = `codex-thread-${process.pid}`;
const turnId = "codex-turn-1";
let currentTask = "";
const log = (event) => {
  if (process.env.CODEX_FIXTURE_LOG) appendFileSync(process.env.CODEX_FIXTURE_LOG, `${JSON.stringify(event)}\n`);
};
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params: { threadId, turnId, ...params } });
const complete = (status = "completed") => notify("turn/completed", {
  turn: { id: turnId, status, error: status === "failed" ? { message: "fixture turn failed" } : null },
});
const usage = { totalTokens: 30, inputTokens: 20, cachedInputTokens: 4, outputTokens: 10, reasoningOutputTokens: 2 };
function events(task) {
  notify("item/agentMessage/delta", { threadId: "foreign", itemId: "foreign", delta: "WRONG" });
  notify("item/agentMessage/delta", { turnId: "foreign", itemId: "foreign", delta: "WRONG" });
  notify("item/agentMessage/delta", { itemId: "message-1", delta: "hello " });
  if (task === "hang" || task === "backpressure") {
    if (task === "backpressure") process.stdin.pause();
    return;
  }
  if (task === "descendant") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    log({ descendantPid: child.pid });
  }
  const actions = {
    permission: "item/commandExecution/requestApproval",
    "file-permission": "item/fileChange/requestApproval",
    "extra-permission": "item/permissions/requestApproval",
    "legacy-permission": "execCommandApproval",
    question: "item/tool/requestUserInput",
    elicitation: "mcpServer/elicitation/request",
    unsupported: "item/tool/call",
    refresh: "account/chatgptAuthTokens/refresh",
  };
  if (actions[task]) {
    send({ id: "permission-1", method: actions[task], params: { threadId, turnId } });
    return;
  }
  if (task === "malformed") { process.stdout.write("not-json\n"); return; }
  if (task === "oversized") { process.stdout.write("x".repeat(8 * 1024 * 1024 + 1)); return; }
  if (task === "exit") { process.exit(3); }
  if (task === "large") {
    for (let index = 0; index < 1_100; index++) {
      notify("item/started", { item: { id: `tool-${index}`, type: "commandExecution", command: "x".repeat(600), status: "inProgress" } });
    }
  }
  const suffix = task === "large" ? "猫".repeat(1_000) : "世界";
  notify("item/agentMessage/delta", { itemId: "message-1", delta: suffix });
  notify("item/completed", { item: { id: "message-1", type: "agentMessage", text: `hello ${suffix}` } });
  notify("item/completed", { item: { id: "message-1", type: "agentMessage", text: `hello ${suffix}` } });
  notify("item/started", { item: { id: "tool-1", type: "commandExecution", command: "node --version", status: "inProgress" } });
  notify("item/completed", { item: { id: "tool-1", type: "commandExecution", command: "node --version", status: "completed" } });
  notify("thread/tokenUsage/updated", { tokenUsage: { total: usage, last: usage, modelContextWindow: 100_000 } });
  if (task === "failed") complete("failed");
  else if (task === "interrupted") complete("interrupted");
  else complete();
}

log({ startup: true, delegated: process.env.AGENT_RELAY_DELEGATED, args: process.argv.slice(2) });
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  if (!message.method) return;
  const params = message.params ?? {};
  const reply = (result) => send({ id: message.id, result });
  if (message.method === "initialize") {
    if (mode === "initialize-hang") return;
    if (mode === "invalid-result") return reply(null);
    reply({ userAgent: "fake-codex" });
  } else if (message.method === "initialized") {
    return;
  } else if (message.method === "account/read") {
    reply({ requiresOpenaiAuth: true, account: mode === "unauthenticated" ? null : { type: "apiKey" } });
  } else if (message.method === "thread/start" || message.method === "thread/resume") {
    if (mode === "resume-failure") return send({ id: message.id, error: { code: -1, message: "resume failed" } });
    if (params.threadId) threadId = params.threadId;
    reply({ thread: { id: threadId, sessionId: "root-id-do-not-use" } });
  } else if (message.method === "turn/start") {
    currentTask = params.input[0].text.split("\n\n").at(-1);
    log({ prompt: currentTask });
    if (currentTask === "start-hang") return;
    if (currentTask === "early") events(currentTask);
    reply({ turn: { id: turnId, status: "inProgress" } });
    if (currentTask !== "early") events(currentTask);
  } else if (message.method === "turn/interrupt") {
    log({ interrupted: true });
    reply({});
    complete("interrupted");
  } else {
    send({ id: message.id, error: { code: -32601, message: "Unknown method" } });
  }
});
