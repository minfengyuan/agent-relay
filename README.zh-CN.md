# agent-relay

[English](README.md) | [简体中文](README.zh-CN.md)

通过一个本地 MCP Server，让任何支持 stdio 的 MCP 客户端调用 **Grok**、**Cursor**、**OpenCode**、**DSH** 和 **Codex**。

`agent-relay` 将 MCP 工具调用桥接到本地 Coding Agent，使用 ACP 或 Codex 原生 app-server 协议。调用方负责统一编排和结果审查；relay 执行一轮非交互任务，返回有大小限制的输出和可继续使用的会话 ID。

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

Cursor 需要显式配置可执行文件路径。Grok、OpenCode、DSH 和 Codex 默认使用 PATH 中的 `grok`、`opencode`、`dsh` 和 `codex`。只需安装并认证实际要调用的 Agent。

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

该命令检测 **Codex、Cursor、OpenCode、Grok 和 DSH**，展示检测依据和规则目标，然后按编号交互多选。回车选择全部已检测客户端，输入 `q` 取消。检测依据为 PATH 中的命令和已有客户端配置目录，不启动客户端，也不验证认证或 MCP 注册状态。也可显式选择未检测到的客户端。

| 客户端 | 规则目标 | 作用范围 |
| --- | --- | --- |
| Codex | `$CODEX_HOME/AGENTS.md`，默认 `~/.codex/AGENTS.md`；非空 `AGENTS.override.md` 优先，存在时改为更新它 | 全局 |
| Cursor | `<project>/.cursor/rules/agent-relay.mdc`，包含 `alwaysApply: true` | 所选项目 |
| OpenCode | 设置 `$OPENCODE_CONFIG_DIR` 时使用其下的 `AGENTS.md`；否则为 `$XDG_CONFIG_HOME/opencode/AGENTS.md`，默认 `~/.config/opencode/AGENTS.md` | 全局 |
| Grok | `$GROK_HOME/AGENTS.md`，默认 `~/.grok/AGENTS.md` | 全局 |
| DSH | `$DSH_HOME/AGENTS.md`，默认 `~/.dsh/AGENTS.md` | 全局 |

Cursor 需要已有项目目录，未提供时会交互询问。其规则仅对该项目生效；全局 User Rules 仍通过 Cursor 设置界面管理。其他客户端使用各自的全局指令文件。环境变量覆盖必须与对应客户端启动时保持一致。

脚本或非交互终端可用逗号分隔的客户端 ID：

```bash
pnpm setup:instructions --clients codex,opencode,grok,dsh
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
```

每个工具都需要 `task` 和绝对路径 `cwd`。将返回的 `sessionId` 连同相同工作目录传给同一个工具，即可继续对应 Agent 的会话。各 provider 的可选参数可通过 MCP 工具发现获取；原有四个 ACP 工具保留契约，并新增 `codex_delegate`。

```text
调用方选择任务和 worktree
        ↓
agent-relay 执行一轮 Agent 任务
        ↓
Grok / Cursor / OpenCode / DSH / Codex 在本地工作
        ↓
调用方审查结果、diff 和测试
        ↓
调用方集成或继续跟进
```

并行处理独立任务时使用不同 worktree。同一个解析后的工作目录只允许一个活跃任务；重叠调用返回 `WORKSPACE_BUSY`。

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

## 配置

在 MCP 服务进程的环境中设置以下变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AGENT_RELAY_GROK_COMMAND` | `grok` | Grok 可执行文件 |
| `AGENT_RELAY_CURSOR_COMMAND` | 调用 Cursor 时必填 | Cursor 可执行文件 |
| `AGENT_RELAY_OPENCODE_COMMAND` | `opencode` | OpenCode 可执行文件 |
| `AGENT_RELAY_DSH_COMMAND` | `dsh` | DSH 可执行文件 |
| `AGENT_RELAY_CODEX_COMMAND` | `codex` | Codex 原生可执行文件 |
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
