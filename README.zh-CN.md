# agent-relay

[English](README.md) | [简体中文](README.zh-CN.md)

通过一个本地 MCP Server，让任何支持 stdio 的 MCP 客户端调用 **Grok**、**Cursor**、**OpenCode**、**DSH**、**Codex** 和 **Claude Code**。

`agent-relay` 将 MCP 工具调用桥接到本地 Coding Agent，使用 ACP、Codex 原生 app-server 或 provider 的 headless JSON 传输。调用方负责统一编排和结果审查；relay 执行一轮非交互任务，返回有大小限制的输出和可继续使用的会话 ID。

## 为什么使用它？

- **一个 MCP Server，对接多个 Coding Agent** —— 不同 MCP 客户端均可使用同一组工具。
- **会话可继续** —— 延续已有工作，无需每轮重新开始。
- **适配 worktree** —— 不同工作目录中的独立任务可以并行执行。
- **本地执行** —— 通过本地 CLI 运行 Agent，沿用已有认证和配置。
- **调用方负责总控** —— 由调用方选择任务、审查变更和决定最终集成。

## 支持的 Agent

| Agent | MCP 工具 | 典型用途 |
| --- | --- | --- |
| Grok | `grok_delegate` | 实现、调试和审查 |
| Cursor | `cursor_delegate` | Agent 模式或 ask 模式编码任务 |
| OpenCode | `opencode_delegate` | 支持可选 model、effort、agent 的编码任务 |
| DSH | `dsh_delegate` | 通过 DeepSeek Harness 执行编码任务 |
| Codex | `codex_delegate` | 通过 Codex 原生 app-server 执行编码任务 |
| Claude Code | `claude_delegate` | 通过 Claude Agent ACP 桥接执行编码任务 |

## 快速开始

### 1. 前置条件

- Node.js 22+
- pnpm 12+
- 至少一个已安装并完成认证的受支持 Agent CLI
- 能启动本地 stdio 服务的 MCP 客户端

### 2. 安装并构建

```bash
git clone https://github.com/minfengyuan/agent-relay.git
cd agent-relay
pnpm install
pnpm build
```

MCP 入口为 `dist/cli.js`，包提供的可执行命令名称为 `agent-relay`。

### 3. 接入 MCP 客户端

将客户端配置为启动以下命令：

```bash
node /ABSOLUTE/PATH/agent-relay/dist/cli.js
```

对于使用 `mcpServers` JSON 配置的客户端，可参考以下示例；配置文件位置及格式以所用客户端为准：

```json
{
  "mcpServers": {
    "agent-relay": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/agent-relay/dist/cli.js"],
      "env": {
        "AGENT_RELAY_CURSOR_COMMAND": "/ABSOLUTE/PATH/TO/cursor-agent"
      }
    }
  }
}
```

Cursor 需要显式配置可执行文件路径。Grok、OpenCode、DSH、Codex 和 Claude Code 默认使用 PATH 中的 `grok`、`opencode`、`dsh`、`codex` 和 `claude-agent-acp`。只需安装并认证实际要调用的 Agent。Claude Code 还需单独安装下文说明的 ACP 桥接程序。

relay 使用 stdio，stdout 专用于 MCP 消息。任务默认总超时为一小时；如果客户端支持设置工具调用超时，建议至少设为 3660 秒，并始终高于自定义的 relay 总超时。客户端超时和进度设置方式以各客户端为准。

如使用 Codex，可采用以下可选 TOML 配置：

```toml
[mcp_servers.agent_relay]
command = "node"
args = ["/ABSOLUTE/PATH/agent-relay/dist/cli.js"]
startup_timeout_sec = 10
tool_timeout_sec = 3660

[mcp_servers.agent_relay.env]
AGENT_RELAY_CURSOR_COMMAND = "/ABSOLUTE/PATH/TO/cursor-agent"
```

### 4. 可选：安装委派指令

```bash
pnpm setup:instructions
```

该命令检测 **Codex、Cursor、OpenCode、Grok、DSH 和 Claude Code**，展示检测依据和规则目标，然后按编号交互多选。回车选择全部已检测客户端，输入 `q` 取消。检测依据为 PATH 中的命令和已有客户端配置目录，不启动客户端，也不验证认证或 MCP 注册状态。也可显式选择未检测到的客户端。

| 客户端 | 规则目标 | 作用范围 |
| --- | --- | --- |
| Codex | `$CODEX_HOME/AGENTS.md`，默认 `~/.codex/AGENTS.md`；非空 `AGENTS.override.md` 优先，存在时改为更新它 | 全局 |
| Cursor | `<project>/.cursor/rules/agent-relay.mdc`，包含 `alwaysApply: true` | 所选项目 |
| OpenCode | 设置 `$OPENCODE_CONFIG_DIR` 时使用其下的 `AGENTS.md`；否则为 `$XDG_CONFIG_HOME/opencode/AGENTS.md`，默认 `~/.config/opencode/AGENTS.md` | 全局 |
| Grok | `$GROK_HOME/AGENTS.md`，默认 `~/.grok/AGENTS.md` | 全局 |
| DSH | `$DSH_HOME/AGENTS.md`，默认 `~/.dsh/AGENTS.md` | 全局 |
| Claude Code | `$CLAUDE_CONFIG_DIR/CLAUDE.md`，默认 `~/.claude/CLAUDE.md` | 全局 |

Cursor 需要已有项目目录，未提供时会交互询问。其规则仅对该项目生效；全局 User Rules 仍通过 Cursor 设置界面管理。其他客户端使用各自的全局指令文件。环境变量覆盖必须与对应客户端启动时保持一致。

脚本或非交互终端可用逗号分隔的客户端 ID：

```bash
pnpm setup:instructions --clients codex,opencode,grok,dsh
pnpm setup:instructions --clients claude
pnpm setup:instructions --clients codex,cursor --project /absolute/project
pnpm setup:instructions --clients codex,cursor --project /absolute/project --dry-run
pnpm setup:instructions --help
```

`--clients` 跳过选择，也允许安装未检测到的客户端。非交互输入缺少 `--clients` 时会报错且不写入。`--dry-run` 使用相同的选择和校验规则，预览新增／更新／不变状态，不创建目录或写文件。

安装器将同一份指令正文嵌入所选客户端支持的文件，保留无关内容，重复运行时幂等更新受管理块。所选目标中的完整历史块会被替换。全部目标在写入前完成校验：标记损坏、存在多个受管理块、Cursor 项目无效，或已有同名 `agent-relay.mdc` 不含受管理块时，安装中止且不写入目标。实际写入失败会逐客户端报告，继续尝试其他所选客户端，并以非零退出码结束；已完成的写入不会回滚。

安装器会提示并保留 `~/.agents/AGENTS.md`（或 `$DSH_AGENTS_HOME/AGENTS.md`）中的历史指令，供手动检查；默认不再写入该共享路径。创建 OpenCode 全局 `AGENTS.md` 可能遮蔽其 `~/.claude/CLAUDE.md` 回退规则；回退文件存在且启用时会提示，请在选择 OpenCode 前检查其中的偏好。

安装后请开启新的客户端会话。指令仅允许委派给用户明确提及的 Agent；未指定 Agent 时，由调用方自行完成任务。**安装规则不会注册 relay MCP 服务**：仍需在每个调用方客户端中分别完成第 3 步。文件安装成功不代表已验证客户端运行时加载。

规则入口依据客户端文档：[Codex](https://developers.openai.com/codex/guides/agents-md)、[Cursor](https://cursor.com/docs/rules)、[OpenCode](https://opencode.ai/docs/rules/)（[XDG 配置](https://github.com/anomalyco/opencode/issues/6669)、[自定义目录优先级](https://github.com/anomalyco/opencode/issues/28658)）、[Grok](https://docs.x.ai/build/features/project-rules) 和 [DSH](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/context/agent-instructions)。

## 使用方式

配置完成后，可向调用方提出以下任务：

```text
使用 Grok 审查 /path/to/worktree 中的当前改动，并运行相关测试。

让 Cursor 只读检查认证流程，不修改文件。

将 /path/to/worktree 中的这个实现任务交给 OpenCode。

将 /path/to/worktree 中的这个实现任务交给 DSH。

将 /path/to/worktree 中的这个实现任务交给 Codex。

将 /path/to/worktree 中的这个实现任务交给 Claude Code。
```

每个工具都需要 `task` 和绝对路径 `cwd`。将返回的 `sessionId` 连同相同工作目录传给同一个工具，即可继续对应 Agent 的会话。各 provider 的可选参数可通过 MCP 工具发现获取。

```text
调用方选择任务和 worktree
        ↓
agent-relay 执行一轮 Agent 任务
        ↓
Grok / Cursor / OpenCode / DSH / Codex / Claude Code 在本地工作
        ↓
调用方审查结果、diff 和测试
        ↓
调用方集成或继续跟进
```

并行处理独立任务时使用不同 worktree。同一个解析后的工作目录只允许一个活跃任务；重叠调用返回 `WORKSPACE_BUSY`。

### Grok

Grok 使用 headless 流式 JSON（`--output-format streaming-json`），沿用 CLI 已有认证。即使用户配置启用了 leader mode，每次 headless 运行仍启动自己的 daemon；Relay 不连接共享 leader，也不再传 ACP 专用的 `--no-leader`。

Relay 保留 `--sandbox workspace`、禁用内置 Web search/fetch、显式拒绝 `WebFetch`/`WebSearch`，以及 `--always-approve`；另传 `--disallowed-tools ask_user_question` 和 `--no-wait-for-background`，支持无人值守执行。Grok 状态目录和临时目录仍可写，shell 网络仍可用；这些设置不隔离外部 MCP 服务。

任务原样写入私有 `0600` 文件，通过 `--prompt-file` 传入，任务文本不放入 argv。新会话由 Relay 生成 UUID，以 `-s` 传入，首个事件到达后持久化。恢复只传 Relay 已记录的 UUID，以 `-r` 和相同解析后的 `--cwd` 启动，避免按标题匹配。旧 ACP UUID 沿用根 `sessions/` 命名空间。Provider 中不存在的会话返回 `UNKNOWN_SESSION`，不创建替代会话；`Not signed in` 错误映射为 `AUTH_UNAVAILABLE`。

结果只保留公共字段：文本由 `text` 事件拼接，`stopReason` 来自 `end`。工具事件只提供进度，不返回工具或 usage 摘要。成功必须同时满足：存在 `end`，停止原因不是 `cancelled`，退出码为 `0`，且没有 error 事件。作为防御，stderr 出现 `permission required:` 时返回 `UNEXPECTED_PERMISSION`，即使 CLI 退出码为 `0`。

取消时先发送 SIGTERM，给 Grok 至少 12 秒退出宽限，再终止进程树。Grok 可能在 daemon 退出前就发出 `end{cancelled}`，所以 Relay 在宽限内继续等待进程退出。Grok 工具 shell 使用独立进程组，只有 Grok 自身的优雅关闭会回收这些子进程；强杀原进程组无法保证回收已脱离的组。DSH 的 detached 工具进程组也有相同限制。恢复会话前必须等调用结束。

### OpenCode

Relay 对 V1、V2 均使用 `opencode acp`，通过子进程工作目录和 ACP 会话请求传递绝对路径 `cwd`，不传递 V2 已拒绝的 `--cwd` 参数。可用 `AGENT_RELAY_OPENCODE_COMMAND` 指定其他可执行文件。委派前先执行 `opencode auth login`；Relay 使用已有认证，不启动交互登录。

输入为 `task`、绝对路径 `cwd`，以及可选的 `sessionId`、`resume`、`model`、`effort`、`agent`。已有会话优先使用 ACP resume，仅在未声明 resume 能力时回退 load；`resume: false` 强制 load。恢复失败不会创建替代会话，且必须使用原工作目录。Relay 会话记录格式保持不变；OpenCode 自身历史对话的迁移和可用性由 OpenCode 负责。

model、effort、agent 必须是会话声明的可用选项。Relay 依次设置 model、effort、agent（ACP `mode`），每次设置后刷新可用选项。省略字段保留 provider 当前设置。effort 取决于所选模型，只有明确声明 `default` 时才能使用该值。

V1 子进程保留 `OPENCODE_PERMISSION` 中的其他规则，同时强制 `question`、`external_directory`、`webfetch`、`websearch` 为 `"deny"`。V2 使用原生 `permissions` 规则，Relay 不转换旧环境变量对象。客户端不声明终端认证或问题表单能力，V2 ACP 会取消问题，避免等待用户回答。两个版本均拒绝普通权限请求：有 `reject_once` 就选择拒绝，否则取消，并返回 `PERMISSION_REQUIRED`。这不构成文件系统或网络隔离。

例如，V2 工作目录可要求编辑审批，同时禁止 shell 命令：

```json
{
  "agents": {
    "build": {
      "permissions": [
        { "action": "edit", "resource": "*", "effect": "ask" },
        { "action": "shell", "resource": "*", "effect": "deny" }
      ]
    }
  }
}
```

运行 `pnpm test:real:opencode` 执行已认证的 V2 真实测试。测试会调用已配置模型，使用临时工作目录和 Relay 状态，不修改全局配置。覆盖跨进程 resume/load、编辑、实际权限应答、会话配置、真实问题工具调用、取消、超时及私有服务清理。effort 测试要求默认模型具备 variants，否则明确失败。隔离测试覆盖 V1.18.35 和 V2.0.12 协议配置；V1 模拟覆盖不等于真实 V1 验证，也不保证跨版本历史对话迁移成功。

2026 年 11 月 3 日，在 macOS、OpenCode 2.0.12 和已配置的 `opencode/pulse-alpha-free` 模型上，六项真实测试在此前 `allow_once` 策略下全部通过。问题工具探针在没有用户输入时返回 `stopReason: "cancelled"`。新的拒绝策略尚未重新进行真实 provider 验证；V1 和 Windows 的真实运行仍未验证。

### DSH

Relay 运行 `dsh --profile headless`，逐行读取 JSON 事件。Relay 自有的 `--patch` 文件紧跟在 `--profile headless` 之后、应用参数之前：一个 `0600` 权限 patch，以及可选的 `0600` 模型路由 patch。Relay 不修改 `$DSH_HOME/profiles/headless/cordis.patch.yml`。任务通过 stdin 写入，不放入 argv。

权限 patch 保留 approval、permission、`tool-web` 策略，删除 profile 自带的 `sandbox-policy` overlay，并重新启用随包提供的 `credentials`、`authorization`、`deepseek-account` 服务。已保存凭据优先；不可用时，DSH 依次回退到启动环境、`<cwd>/.env`、`$DSH_HOME/.env`。空字符串 `DEEPSEEK_API_KEY` 只从子进程环境删除，避免遮蔽 `.env` 后备；Relay 不设置也不读取非空值，父进程环境保持不变。

输入为 `task`、绝对路径 `cwd`，以及可选的 `sessionId`、`model`、`reasoningEffort`。请求 model 或 effort 时，Relay 先在同一工作目录 lease 和超时约束下运行 `dsh --profile headless --patch <permissions> --dump-config`，读取 `agent-default-model.provider`。输出无法解析返回 `INVALID_CONFIG`；预检超时返回 `CONFIG_TIMEOUT`。Relay 不在本地校验模型名；DSH 对未知模型返回通用 `INVALID_REQUEST`，Relay 以带 DSH 错误码和消息的 `ACP_FAILURE` 返回。恢复时省略 `reasoningEffort`，只有 provider/model 路由相同时才保留已保存的显式强度。

新建和恢复的每一轮都显式使用 `--permission-mode workspace-write --approval-policy never`。内置 Web search/fetch 被禁用；shell 网络和外部 MCP 服务仍可用，因此不构成网络隔离。可识别的 `FS_SANDBOX_DENIED`、`AUTO_REVIEW_DENIED` 工具结果会在轮次结束后返回 `PERMISSION_REQUIRED`，并保留后续文本。其他工具错误不算权限拒绝。shell 命令内部的拒绝可能不带可识别错误码，此时只能作为普通工具失败报告。`tool_result.completed` 只表示工具已返回，不代表 shell 命令成功退出。

只有退出码 `0` 且 `final.reason.kind: "completed"` 才算成功。结果文本取自限长后的 `final.text`；DSH 工具调用生成摘要，usage 省略。凭据缺失映射为 `AUTH_UNAVAILABLE`；未知会话和 cwd 不匹配分别映射为 `UNKNOWN_SESSION`、`CWD_MISMATCH`，其他轮次或启动失败使用 `ACP_FAILURE`。取消时先发送 SIGTERM，等待配置的宽限时间，再终止剩余进程树。必须等调用结束再恢复会话，因为只有确认进程清理后才释放工作目录 lease。

会话沿用 `sessions/dsh` 命名空间。旧 ACP 集成留下的裸 UUID 可在相同解析后工作目录中恢复。Relay 只把已确认 ID 作为 `--session-id` 传入，并在每次恢复时重复权限与审批参数。

### Codex

调用 `codex_delegate` 前先安装 Codex CLI 并完成认证，无需安装 ACP 桥接包。relay 直接启动 `codex app-server --listen stdio://`，沿用 CLI 已有认证，不发起登录。协议兼容基线为 Codex CLI 0.163.0，旧版未经验证。Windows 请将 `AGENT_RELAY_CODEX_COMMAND` 指向原生 `codex.exe`，不支持 `.cmd`/`.bat` 启动器。

输入包括 `task`、绝对路径 `cwd`，以及可选的 `sessionId`、`model`、`reasoningEffort`。返回的 `sessionId` 是 Codex 的 `thread.id`；只能在原目录恢复 relay 已记录的 ID。线程恢复失败时不会创建替代线程。显式 model/effort 修改当前线程配置，省略则保留恢复值或默认值；无效配置由 Codex 校验，返回 `CODEX_FAILURE`。

```json
{
  "task": "实现指定改动并运行相关检查。",
  "cwd": "/absolute/path/to/worktree",
  "reasoningEffort": "high"
}
```

新建与恢复后的每一轮均采用 workspace-write 沙箱，禁用沙箱内网络访问，保留默认临时目录权限，并将审批路由给客户端。额外审批会被拒绝并返回 `PERMISSION_REQUIRED`；提问或 elicitation 返回 `INTERACTION_REQUIRED`。本机 Codex/MCP 配置仍然生效；这不隔离外部 MCP 服务或模型 API 流量。请勿在工作 Agent 的 MCP 配置中加载本 relay。

结果包含 `provider: "codex"`、`sessionId`、`stopReason`、`text`、`truncated`，以及可选的有界 `toolCalls`、`summariesTruncated` 和原生 token `usage`（`total`、`last`、`modelContextWindow`）。只有轮次完成才算成功。失败保留已确认的会话 ID 和部分输出；取消或超时会中断轮次并清理进程树。协议不兼容返回 `PROTOCOL_MISMATCH`，其他原生失败使用 `CODEX_FAILURE`。

真实 smoke 需显式运行 `pnpm test:real:codex`，或 `RUN_CODEX_REAL_TESTS=1 pnpm exec vitest run test/codex-real-smoke.test.ts`。测试使用临时状态和工作目录，但会使用真实 Codex 账户和服务。

### Claude Code

单独安装 ACP 桥接程序；本次接入以 `@agentclientprotocol/claude-agent-acp@0.100.0` 为兼容基线：

```bash
npm install -g @agentclientprotocol/claude-agent-acp@0.100.0
claude-agent-acp --cli auth login
```

桥接程序使用 Claude Agent SDK 及其附带的原生 Claude 可执行文件，可沿用兼容的本地认证或 provider 环境凭据。需要其他原生可执行文件时，设置上游 `CLAUDE_CODE_EXECUTABLE` 为其绝对路径。`AGENT_RELAY_CLAUDE_COMMAND` 选择的是**桥接程序**，不是原生 `claude` 命令。relay 不在委派时安装软件或启动交互登录。

`claude_delegate` 接收 `task`、绝对路径 `cwd`，以及可选的 `sessionId`、`model` 和 `effort`。模型和推理强度必须是桥接端公布的 `configOptions` 值；relay 先设置模型再设置 effort，每次更新后刷新选项。省略的选项保持 provider 状态。值无效或选项不可用时，返回 `INVALID_CONFIG` 或 `CONFIG_UNSUPPORTED`。

新建和恢复会话后，均在发送任务前显式设置 `acceptEdits`。文件编辑可以直接执行；额外 ACP 审批请求被拒绝，返回 `PERMISSION_REQUIRED` 及可用的部分输出。relay 不声明终端认证、文件/终端服务或问询 UI；基线桥接程序在没有表单支持时禁用 `AskUserQuestion`。原生允许规则、hooks、shell 网络和外部 MCP 服务仍生效；这不构成文件系统或网络隔离。

会话记录使用独立 `claude` 命名空间，与其他 provider 共用工作目录锁。只能在原 `cwd` 恢复 relay 已确认的 ID。优先 resume；仅在未公布 resume 能力时使用 load。恢复失败不新建替代会话。新 ID 在配置前持久化，使配置错误也能返回可恢复 ID。ACP 认证缺失映射为 `AUTH_UNAVAILABLE`；应先在 relay 外完成登录，再使用可用的已确认会话重试。

桥接端必须公布 `session/close`。relay 关闭会话、确认进程树清理后才释放工作目录锁。结果包含 `provider: "claude"` 和公共结果字段，以及可选的有界工具调用和 ACP usage 摘要。

Windows 下，受支持的 npm/pnpm `.cmd` 启动脚本会解析为通过包信息与 `bin.claude-agent-acp` 校验的入口，再由 Node 执行，不经过 shell。也支持原生 `.exe`/`.com` 和显式 `.js`/`.mjs`；任意 batch 脚本会被拒绝。

真实 smoke 需显式运行 `pnpm test:real:claude`，或 `RUN_CLAUDE_REAL_TESTS=1 pnpm exec vitest run test/claude-real-smoke.test.ts`。可选 `CLAUDE_TEST_MODEL` 和 `CLAUDE_TEST_EFFORT` 验证显式配置。测试在临时工作目录中编辑文件、跨进程恢复会话，并检查锁释放；需要认证且可能消耗模型额度。默认测试使用 fake bridge。

### 原生权限策略

relay 使用各 provider 的原生权限控制，各 provider 的能力不同。额外 ACP/native 审批请求均拒绝；Grok 的意外权限请求直接失败，不会打开交互审批流程。

| Agent | Relay 配置 | 剩余限制 |
| --- | --- | --- |
| Codex | `workspace-write`，禁用沙箱网络与内置 Web Search；新建、恢复线程和每轮执行均重新设置 | 默认临时目录仍可写；模型 API 流量和外部 MCP 服务不在此边界内 |
| Grok | `--sandbox workspace`、`--disable-web-search`、`WebFetch`/`WebSearch` 拒绝规则；沙箱内保留 `--always-approve` | Grok 状态目录和临时目录可写；workspace profile 允许子进程联网；自定义网络限制仅在 Linux 生效，macOS 不等价 |
| Cursor | `--sandbox enabled --workspace <cwd>`、`approvalMode: allowlist`、`sandbox.networkAccess: user_config_only`，拒绝 `WebFetch(*)` | 自定义沙箱网络白名单及本地/团队策略仍生效；不等于全面禁网 |
| OpenCode | 强制 V1 `OPENCODE_PERMISSION` 中的 `question`、`external_directory`、`webfetch`、`websearch` 为 `deny`；两个版本均拒绝额外 ACP 审批 | 不转换为 V2 权限规则，V2 自身配置仍生效；没有 OS 沙箱，shell、插件和外部 MCP 工具仍可能越界写入或联网；V1 外部目录拒绝也限制受支持工具的外部读取 |
| DSH | headless `--patch` 在新建和恢复轮次中强制 `workspace-write`、`--approval-policy never`，关闭 `web_search`/`web_fetch`，并恢复凭据存储服务 | 文件沙箱不限制 shell 网络；shell 内部拒绝可能没有可识别错误码；Windows ACL 和较旧 Linux Landlock 后端可能仅提供部分文件隔离 |
| Claude Code | 新建和恢复会话均设置 `acceptEdits`，拒绝额外 ACP 审批 | 不构成文件系统或网络隔离；原生允许规则、hooks、shell 网络与外部 MCP 服务仍生效 |

**OpenCode 行为变化：** 不再通过 `allow_once` 自动授予权限。有 `reject_once` 就选择拒绝，否则取消，并返回带可用部分结果的 `PERMISSION_REQUIRED`。

Cursor 使用 relay 状态目录下的私有 CLI 配置快照。原有 CLI 设置、认证相关配置、环境凭据及正常的 OS 凭据发现保留；只覆盖上表中的权限/沙箱设置并补齐缺失的配置结构默认值。不修改原 CLI 配置或项目文件。通过 `CURSOR_CONFIG_DIR` 或 `XDG_CONFIG_HOME` 定位原配置；正常数据目录和模型/API 连接保持不变。

DSH 接收包含 relay 随包权限 patch 和可选模型 patch 的私有文件，它们紧跟 `--profile headless`，位于应用参数之前。不修改用户 profile；`DSH_PERMISSION_MODE` 仅在子进程环境中设置。原生配置文件在确认进程清理后删除，包括启动失败、取消和超时；无法确认清理时保留文件。配置准备失败会返回结构化错误，不会无约束重试。进程崩溃可能遗留私有目录，只有确认没有工作进程使用时才能删除。

Cursor、OpenCode、DSH 和 Claude Code 每次执行向 stderr 输出一次有长度限制的策略诊断。诊断不包含凭据或任务文本。上述设置不隔离外部 MCP 服务。自定义可执行文件/包装器必须遵守原生参数与配置；替换可执行文件不代表限制已经生效。

策略通过各 provider 自身支持的后端面向 macOS、Linux 和 Windows；relay 能启动 CLI 不代表该平台具备可用沙箱。隔离测试验证配置和拒绝行为，不证明真实 CLI 隔离能力。真实 CLI 验收仍需显式启用：在临时工作区检查内部/外部写入、shell 联网、Web 工具与恢复会话，记录 OS、CLI 版本及实际结果。未执行的平台与能力均标记为未验证。

## 配置

在 MCP 服务进程的环境中设置以下变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AGENT_RELAY_GROK_COMMAND` | `grok` | Grok 可执行文件 |
| `AGENT_RELAY_CURSOR_COMMAND` | 调用 Cursor 时必填 | Cursor 可执行文件 |
| `AGENT_RELAY_OPENCODE_COMMAND` | `opencode` | OpenCode 可执行文件 |
| `AGENT_RELAY_DSH_COMMAND` | `dsh` | DSH 可执行文件 |
| `AGENT_RELAY_CODEX_COMMAND` | `codex` | Codex 原生可执行文件 |
| `AGENT_RELAY_CLAUDE_COMMAND` | `claude-agent-acp` | Claude ACP 桥接可执行文件 |
| `AGENT_RELAY_STATE_DIR` | `~/.local/agent-relay` | 会话元数据及工作目录锁 |
| `AGENT_RELAY_PHASE_TIMEOUT_MS` | `30000` | 协议阶段超时 |
| `AGENT_RELAY_TOTAL_TIMEOUT_MS` | `3600000` | 任务总超时 |
| `AGENT_RELAY_CANCEL_GRACE_MS` | `5000` | 取消宽限时间 |
| `AGENT_RELAY_TERM_GRACE_MS` | `2000` | 强制终止前的宽限时间 |
| `AGENT_RELAY_KILL_CONFIRM_MS` | `2000` | 强制终止确认超时 |
| `AGENT_RELAY_TEXT_LIMIT_BYTES` | `262144` | 保留的文本上限 |
| `AGENT_RELAY_STDERR_LIMIT_BYTES` | `65536` | 保留的 stderr 上限 |
| `AGENT_RELAY_PROGRESS_INTERVAL_MS` | `1000` | 进度通知最小间隔 |

数值设置要求为正安全整数；无效值回退到默认值。`AGENT_RELAY_DELEGATED=1` 是用于拒绝递归委派的内部子进程标记，请勿在顶层服务中设置。

## 从 codex-agent-relay 迁移

本次更名不提供旧命令或旧环境变量别名：

1. 切换前停止所有旧 relay 实例，等待其任务和子进程结束。迁移期间不要让新旧实例同时操作相同工作区。
2. 将使用到的可执行命令名称改为 `agent-relay`，将所有 `CODEX_AGENT_RELAY_*` 配置改为 `AGENT_RELAY_*`，并按需更新客户端注册项和绝对路径。四个 MCP 工具名保持不变。
3. 默认状态目录由 `~/.local/codex-agent-relay` 改为 `~/.local/agent-relay`。如需保留会话，在停止服务后迁移**完整**状态目录，包括会话和锁，并保留权限。目标目录应未被使用，不要合并两套已有状态目录。也可通过 `AGENT_RELAY_STATE_DIR` 显式指向原目录。会话和锁格式未变；仍有未确认清理的孤儿锁时，应先调查原因，迁移不意味着可以安全删除它。
4. 将 `pnpm setup:codex-instructions` 改为 `pnpm setup:instructions`。安装器现在按客户端检测并写入其支持的位置；Codex 重新读取 `CODEX_HOME`。所选目标中的已有受管理块会更新。旧的 `~/.agents/AGENTS.md` 共享指令会保留并提示手动检查；具体位置见上方客户端表格。

relay 不会自动迁移状态或修改客户端配置。

## 注意事项

- 调用前先完成各 Agent CLI 的认证，不要把凭据放入任务参数。
- relay 不创建 worktree，也不自动接受 Agent 的修改。
- 文件系统、网络和权限行为取决于所选 Agent 及其本地配置。
- 工作进程按进程树清理；无法确认清理完成时，relay 会保留工作目录锁。
- 集成结果前，请检查实际 diff 并运行相关验证。
- 不要将本 relay 配置到下游 Agent 的 MCP 中，以免递归委派。

## 开发

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

默认测试使用假 ACP Agent。真实 Agent 冒烟测试需主动启用，参见 [`test/AGENTS.md`](test/AGENTS.md)。
