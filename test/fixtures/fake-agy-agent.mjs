import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

const mode = process.env.FAKE_ACP_MODE ?? "normal";
const sessionId = process.env.FAKE_SESSION_ID ?? "fake-session-1";
const log = (line) => {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, `${line}\n`);
};

if (mode === "malformed") {
  process.stdout.write("{definitely-not-json}\n");
} else if (mode === "exit") {
  process.exit(19);
} else {
  let cancelled = false;
  let cancelPermissionDone = false;
  let configOptions = defaultConfigOptions(mode === "grouped");
  acp.agent({ name: "fake-agy" })
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      log(`initialize:${JSON.stringify(ctx.params.clientCapabilities)}`);
      log(`argv:${JSON.stringify(process.argv.slice(1))}`);
      log(`process-cwd:${process.cwd()}`);
      log(`delegated:${process.env.AGENT_RELAY_DELEGATED ?? ""}`);
      const resume = mode !== "no-resume";
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {
            ...(resume ? { resume: {} } : {}),
            close: {},
            load: {},
            list: {},
            additionalDirectories: {},
          },
        },
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.12" },
        authMethods: [
          { id: "oauth-personal", name: "Log in with Google" },
          { id: "oauth-business", name: "Log in with Gemini Enterprise" },
          { id: "gemini-api-key", name: "Gemini API key" },
          { id: "agent-platform", name: "Gemini Enterprise Agent Platform" },
        ],
      };
    })
    .onRequest(acp.methods.agent.authenticate, (ctx) => {
      log(`auth:${ctx.params.methodId}`);
      return {};
    })
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      log(`new:${ctx.params.cwd}:${process.cwd()}:${ctx.params.mcpServers.length}`);
      if (mode === "auth-required") throw acp.RequestError.authRequired();
      configOptions = defaultConfigOptions(mode === "grouped");
      return { sessionId, configOptions };
    })
    .onRequest(acp.methods.agent.session.resume, (ctx) => {
      log(`resume:${ctx.params.sessionId}:${ctx.params.cwd}:${ctx.params.mcpServers.length}`);
      if (mode === "auth-required") throw acp.RequestError.authRequired();
      if (mode === "resume-fail") throw new Error("Failed to read session");
      configOptions = defaultConfigOptions(mode === "grouped");
      return { configOptions };
    })
    .onRequest(acp.methods.agent.session.load, (ctx) => {
      log(`load:${ctx.params.sessionId}:${ctx.params.cwd}:${ctx.params.mcpServers.length}`);
      configOptions = defaultConfigOptions(mode === "grouped");
      return { configOptions };
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
      log(`set-config:${ctx.params.configId}:${ctx.params.value}`);
      if (mode === "config-timeout" || (mode === "config-hang-effort" && ctx.params.configId === "thought_level")) {
        while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 10));
        return { configOptions };
      }
      const option = configOptions.find((entry) => entry.id === ctx.params.configId);
      if (!option) throw new Error(`unknown config ${ctx.params.configId}`);
      if (!(mode === "ignore-mode" && ctx.params.configId === "mode")) {
        option.currentValue = ctx.params.value;
      }
      if (ctx.params.configId === "model" && ctx.params.value === "gemini-pro-orchestrator-neon") {
        configOptions = configOptions.filter((entry) => entry.id !== "thought_level");
      }
      if (ctx.params.configId === "model" && ctx.params.value === "gemini-4-neon"
        && mode !== "no-thought-level"
        && !configOptions.some((entry) => entry.id === "thought_level")) {
        configOptions.splice(1, 0, thoughtLevelOption());
      }
      if (mode === "mode-resets-effort" && ctx.params.configId === "mode") {
        const effort = configOptions.find((entry) => entry.id === "thought_level");
        if (effort) effort.currentValue = "low";
      }
      return { configOptions };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      log(`prompt:${ctx.params.sessionId}`);
      log(`prompt-text:${ctx.params.prompt[0]?.text ?? ""}`);
      if (mode === "descendant") {
        const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),30000)"], {
          stdio: "ignore",
        });
        log(`descendant:${descendant.pid}`);
        descendant.unref();
      }
      if (mode === "permission" || mode === "permission-no-reject" || mode === "permission-prompt-reject") {
        const outcome = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: {
            toolCallId: "t1",
            title: "Run command",
            status: "pending",
            content: [],
            rawInput: { command: "rm -rf /tmp/x" },
          },
          options: mode === "permission-no-reject"
            ? [{ optionId: "allow-once-actual", name: "Once", kind: "allow_once" }]
            : [
                { optionId: "always-actual", name: "Always", kind: "allow_always" },
                { optionId: "allow-once-actual", name: "Once", kind: "allow_once" },
                { optionId: "reject-actual", name: "Reject", kind: "reject_once" },
              ],
        });
        log(`permission-response:${JSON.stringify(outcome)}`);
        if (mode === "permission-prompt-reject") {
          throw new Error("Tool execution denied by user");
        }
      }
      if (mode === "permission-other-session") {
        const outcome = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: "other-session",
          toolCall: { toolCallId: "t-other", title: "Other", status: "pending", content: [] },
          options: [{ optionId: "allow-once-actual", name: "Once", kind: "allow_once" }],
        });
        log(`permission-other-response:${JSON.stringify(outcome)}`);
      }
      if (mode === "hang") {
        while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 10));
        return { stopReason: "cancelled" };
      }
      if (mode === "permission-after-cancel") {
        while (!cancelled || !cancelPermissionDone) await new Promise((resolve) => setTimeout(resolve, 10));
        return { stopReason: "cancelled" };
      }
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: "other-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OTHER SESSION" } },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: "other-session",
        update: { sessionUpdate: "tool_call", toolCallId: "other-tool", title: "Other tool", status: "completed", content: [] },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: "other-session",
        update: { sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 1, currency: "USD" } },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Fake tool", status: "in_progress", content: [] },
      });
      if (mode === "summary-large") {
        for (let i = 0; i < 200; i += 1) {
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `task-${i}`,
              title: "x".repeat(500),
              status: "completed",
              content: [],
            },
          });
        }
      }
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 11,
          size: 100,
          cost: { amount: 1.25, currency: "USD" },
        },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 42,
          size: 128,
          cost: { amount: 3.5, currency: "USD" },
        },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: mode === "large"
              ? "x".repeat(10000)
              : mode === "unicode"
                ? "界".repeat(60)
                : mode === "partial-fail"
                  ? "partial text"
                  : "fresh answer",
          },
        },
      });
      if (mode === "partial-fail") throw new Error("prompt failed after output");
      return { stopReason: "end_turn" };
    })
    .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
      log(`cancel:${ctx.params.sessionId}`);
      cancelled = true;
      if (mode === "permission-after-cancel") {
        try {
          const outcome = await ctx.client.request(acp.methods.client.session.requestPermission, {
            sessionId: ctx.params.sessionId,
            toolCall: { toolCallId: "late", title: "Late", status: "pending", content: [] },
            options: [
              { optionId: "always-actual", name: "Always", kind: "allow_always" },
              { optionId: "allow-once-actual", name: "Once", kind: "allow_once" },
              { optionId: "reject-actual", name: "Reject", kind: "reject_once" },
            ],
          });
          log(`permission-response:${JSON.stringify(outcome)}`);
        } finally {
          cancelPermissionDone = true;
        }
      }
    })
    .connect(acp.ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin),
    ));
}

function thoughtLevelOption() {
  return {
    id: "thought_level",
    name: "Thinking Level",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "Extra" },
    ],
  };
}

function defaultConfigOptions(grouped) {
  const models = [
    { value: "gemini-4-neon", name: "Gemini 4 Neon" },
    { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
    { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  ];
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gemini-4-neon",
      options: grouped ? [{ group: "gemini", name: "Gemini", options: models }] : models,
    },
    ...(mode === "no-thought-level" ? [] : [thoughtLevelOption()]),
    ...(mode === "no-mode" ? [] : [{
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "accept-edits", name: "Accept edits" },
        { value: "auto", name: "Auto" },
        { value: "plan", name: "Plan" },
      ],
    }]),
  ];
}
