# agent-relay

[English](README.md) | [简体中文](README.zh-CN.md)

通过一个本地 MCP Server，让任何支持 stdio 的 MCP 客户端调用 **Grok**、**Cursor**、**OpenCode** 和 **DSH**。

`agent-relay` 将 MCP 工具调用桥接到本地支持 ACP 的 Coding Agent。调用方负责统一编排和结果审查；relay 执行一轮非交互任务，返回有大小限制的输出和可继续使用的会话 ID。

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

## 快速开始

### 1. 前置条件

- Node.js 22+
- pnpm 12+
- 至少一个已安装并完成认证的受支持 Agent CLI
- 能启动本地 stdio 服务的 MCP 客户端

### 2. 安装并构建

```bash
git clone https://github.com/minfengyuan/codex-agent-relay.git agent-relay
cd agent-relay
pnpm install
pnpm build
```

源码仓库仍使用原有地址。MCP 入口为 `dist/cli.js`，包提供的可执行命令名称为 `agent-relay`。

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

Cursor 需要显式配置可执行文件路径。Grok、OpenCode 和 DSH 默认使用 PATH 中的 `grok`、`opencode` 和 `dsh`。只需安装并认证实际要调用的 Agent。

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

该命令将通用委派指令写入 `~/.agents/AGENTS.md`，保留无关内容，重复运行时更新受管理的指令块。目标文件中完整的历史指令块会被替换；标记损坏或存在多个指令块时，命令会报错且不修改文件。

请配置客户端加载该文件，或将指令复制到客户端支持的位置。并非所有 MCP 客户端都会自动读取 `~/.agents/AGENTS.md`。指令仅允许委派给用户明确提及的 Agent；未指定 Agent 时，由调用方自行完成任务。安装脚本不会配置 MCP 客户端。

## 使用方式

配置完成后，可向调用方提出以下任务：

```text
使用 Grok 审查 /path/to/worktree 中的当前改动，并运行相关测试。

让 Cursor 只读检查认证流程，不修改文件。

将 /path/to/worktree 中的这个实现任务交给 OpenCode。

将 /path/to/worktree 中的这个实现任务交给 DSH。
```

每个工具都需要 `task` 和绝对路径 `cwd`。将返回的 `sessionId` 连同相同工作目录传给同一个工具，即可继续对应 Agent 的会话。各 provider 的可选参数可通过 MCP 工具发现获取；本次更名保留四个工具的名称和输入输出契约。

```text
调用方选择任务和 worktree
        ↓
agent-relay 执行一轮 Agent 任务
        ↓
Grok / Cursor / OpenCode / DSH 在本地工作
        ↓
调用方审查结果、diff 和测试
        ↓
调用方集成或继续跟进
```

并行处理独立任务时使用不同 worktree。同一个解析后的工作目录只允许一个活跃任务；重叠调用返回 `WORKSPACE_BUSY`。

## 配置

在 MCP 服务进程的环境中设置以下变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AGENT_RELAY_GROK_COMMAND` | `grok` | Grok 可执行文件 |
| `AGENT_RELAY_CURSOR_COMMAND` | 调用 Cursor 时必填 | Cursor 可执行文件 |
| `AGENT_RELAY_OPENCODE_COMMAND` | `opencode` | OpenCode 可执行文件 |
| `AGENT_RELAY_DSH_COMMAND` | `dsh` | DSH 可执行文件 |
| `AGENT_RELAY_STATE_DIR` | `~/.local/agent-relay` | 会话元数据及工作目录锁 |
| `AGENT_RELAY_PHASE_TIMEOUT_MS` | `30000` | ACP 阶段超时 |
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
4. 将 `pnpm setup:codex-instructions` 改为 `pnpm setup:instructions`。安装目标改为 `~/.agents/AGENTS.md`，不再读取 `CODEX_HOME`。脚本不会移除以前写入 `~/.codex/AGENTS.md` 的指令；如果客户端仍会加载它，请手动审查旧内容。

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
