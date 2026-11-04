import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

const mode = process.env.FAKE_ACP_MODE ?? "normal";
const sessionId = process.env.FAKE_SESSION_ID ?? "claude-session";
const log = (event) => {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${event}\n`);
};
const pending = () => new Promise(() => {});
const statePath = process.env.FAKE_CLAUDE_STATE;
const configOptions = [
  {
    id: "model", name: "Model", category: "model", type: "select", currentValue: "sonnet",
    options: [{ value: "sonnet", name: "Sonnet" }, { value: "fast", name: "Fast" }],
  },
  ...(mode === "no-effort" ? [] : [{
    id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "medium",
    options: [{ value: "default", name: "Default" }, { value: "low", name: "Low" }, { value: "high", name: "High" }],
  }]),
  ...(mode === "no-mode" ? [] : [{
    id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "bypassPermissions",
    options: [
      { value: "default", name: "Default" },
      ...(mode === "no-accept-edits" ? [] : [{ value: "acceptEdits", name: "Accept edits" }]),
      { value: "bypassPermissions", name: "Bypass" },
    ],
  }]),
];
if (mode === "grouped") {
  configOptions[0].options = [{ group: "claude", name: "Claude", options: configOptions[0].options }];
}

function restoreOptions() {
  if (statePath && existsSync(statePath)) {
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    for (const option of configOptions) option.currentValue = saved[option.id] ?? option.currentValue;
  }
}

async function update(ctx, update, target = sessionId) {
  await ctx.client.notify(acp.methods.client.session.update, { sessionId: target, update });
}

if (mode === "malformed") {
  process.stdout.write("{invalid-json}\n");
} else if (mode === "exit") {
  process.exit(19);
} else {
  setInterval(() => {}, 1000);
  acp.agent({ name: "fake-claude" })
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      log(`initialize:${JSON.stringify(ctx.params.clientCapabilities)}`);
      log(`argv:${JSON.stringify(process.argv.slice(1))}`);
      log(`cwd:${process.cwd()}`);
      log(`delegated:${process.env.AGENT_RELAY_DELEGATED ?? ""}`);
      log(`executable:${process.env.CLAUDE_CODE_EXECUTABLE ?? ""}`);
      return {
        protocolVersion: mode === "wrong-protocol" ? 2 : 1,
        agentCapabilities: {
          loadSession: mode !== "no-restore",
          sessionCapabilities: {
            ...(mode === "load-only" || mode === "no-restore" ? {} : { resume: {} }),
            ...(mode === "no-close" ? {} : { close: {} }),
          },
        },
        authMethods: [{ id: "claude-login", name: "Interactive login" }],
      };
    })
    .onRequest(acp.methods.agent.authenticate, () => {
      log("authenticate");
      throw new Error("Interactive login must not run");
    })
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      log(`new:${ctx.params.cwd}:${ctx.params.mcpServers.length}`);
      if (mode === "auth-new") throw acp.RequestError.authRequired();
      if (mode === "new-timeout") await pending();
      return { sessionId, configOptions };
    })
    .onRequest(acp.methods.agent.session.resume, async (ctx) => {
      log(`resume:${ctx.params.sessionId}`);
      if (mode === "resume-fail") throw new Error("resume rejected");
      restoreOptions();
      return { configOptions };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      log(`load:${ctx.params.sessionId}`);
      restoreOptions();
      await update(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD HISTORY" } });
      await update(ctx, { sessionUpdate: "tool_call", toolCallId: "old-tool", title: "Old", content: [], status: "completed" });
      return { configOptions };
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
      const { configId, value } = ctx.params;
      log(`set:${configId}:${value}`);
      if (mode === "config-fail" || (mode === "mode-fail" && configId === "mode")) throw new Error("config rejected");
      if (mode === "config-timeout" || (mode === "effort-timeout" && configId === "effort")) await pending();
      const option = configOptions.find((entry) => entry.id === configId);
      if (mode !== "mode-ignored" || configId !== "mode") option.currentValue = value;
      if (configId === "model" && value === "fast") {
        const effort = configOptions.find((entry) => entry.id === "effort");
        if (effort) {
          effort.currentValue = "low";
          effort.options = [{ value: "low", name: "Low" }];
        }
      }
      if (statePath) writeFileSync(statePath, JSON.stringify(Object.fromEntries(configOptions.map((entry) => [entry.id, entry.currentValue]))));
      return { configOptions };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      log(`prompt:${ctx.params.sessionId}`);
      log(`prompt-text:${ctx.params.prompt[0]?.text}`);
      log(`effective:${JSON.stringify(Object.fromEntries(configOptions.map((entry) => [entry.id, entry.currentValue])))}`);
      await update(ctx, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Fake tool", status: "completed", content: [] });
      await update(ctx, { sessionUpdate: "usage_update", used: 42, size: 128, cost: { amount: 0.25, currency: "USD" } });
      await update(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OTHER SESSION" } }, "other-session");
      await update(ctx, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: mode === "large" ? "x".repeat(10000) : "fresh answer" } });
      if (mode.startsWith("permission")) {
        const options = [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          ...(mode === "permission-missing" ? [] : [{ optionId: "reject", name: "Reject", kind: "reject_once" }]),
        ];
        const response = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: "permission-1", title: "Run command", status: "pending", content: [] },
          options,
        });
        log(`permission:${JSON.stringify(response)}`);
        await pending();
      }
      if (mode === "auth-prompt") throw acp.RequestError.authRequired();
      if (mode === "partial-fail") throw new Error("failed after output");
      if (mode === "summary-large") {
        for (let index = 0; index < 200; index++) {
          await update(ctx, { sessionUpdate: "tool_call", toolCallId: `tool-${index}`, title: "x".repeat(1000), status: "completed", content: [] });
        }
      }
      if (mode === "descendant") {
        const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
        log(`descendant:${descendant.pid}`);
        descendant.unref();
      }
      if (mode === "hang" || mode === "descendant-hang") {
        if (mode === "descendant-hang") {
          const descendant = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
          log(`descendant:${descendant.pid}`);
          descendant.unref();
        }
        await pending();
      }
      return { stopReason: "end_turn" };
    })
    .onRequest(acp.methods.agent.session.close, async () => {
      log(`close:${sessionId}`);
      if (mode === "close-timeout") await pending();
      if (mode === "close-fail") throw new Error("close rejected");
      return {};
    })
    .onNotification(acp.methods.agent.session.cancel, () => {
      log(`cancel:${sessionId}`);
    })
    .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
}
