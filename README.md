# agent-relay

[English](README.md) | [简体中文](README.zh-CN.md)

Run **Grok**, **Cursor**, **OpenCode**, **DSH**, and **Codex** through one local MCP server from any MCP client that supports stdio.

`agent-relay` bridges MCP tool calls to local coding agents through ACP or the native Codex app-server. The calling client handles orchestration and review; the relay runs one non-interactive agent turn and returns bounded output together with a resumable session ID.

## Why use it?

- **One MCP server, multiple coding agents** — use the same tools from different MCP clients.
- **Resumable sessions** — continue work instead of starting from scratch every turn.
- **Worktree-friendly execution** — run independent tasks in different working directories in parallel.
- **Local execution** — agents run through their local CLIs and use their existing authentication and configuration.
- **Caller-controlled orchestration** — the calling client decides what to run, reviews changes, and chooses what to integrate.

## Supported agents

| Agent | MCP tool | Typical use |
| --- | --- | --- |
| Grok | `grok_delegate` | General implementation, debugging, and review |
| Cursor | `cursor_delegate` | Agent or ask-mode coding tasks |
| OpenCode | `opencode_delegate` | Coding tasks with optional model/effort/agent selection |
| DSH | `dsh_delegate` | Coding tasks through DeepSeek Harness |
| Codex | `codex_delegate` | Coding tasks through the native Codex app-server |

## Quick start

### 1. Prerequisites

- Node.js 22+
- pnpm 12+
- At least one supported agent CLI installed and authenticated
- An MCP client that can launch a local stdio server

### 2. Install and build

```bash
git clone https://github.com/minfengyuan/agent-relay.git
cd agent-relay
pnpm install
pnpm build
```

The MCP entry point is `dist/cli.js`; the package's executable is named `agent-relay`.

### 3. Connect an MCP client

Configure your client to launch:

```bash
node /ABSOLUTE/PATH/agent-relay/dist/cli.js
```

For clients using an `mcpServers` JSON configuration, the following is an example. Adapt the configuration location and format to your client:

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

Cursor requires an explicit executable path. Grok, OpenCode, DSH, and Codex default to `grok`, `opencode`, `dsh`, and `codex` on PATH. You only need to install and authenticate the agents you intend to call.

The relay uses stdio, with stdout reserved for MCP messages. Tasks default to a one-hour total timeout. Set the client's tool-call timeout to at least 3660 seconds when available, and keep it above any custom relay total timeout. Client timeout and progress settings are client-specific.

For Codex, an optional TOML configuration is:

```toml
[mcp_servers.agent_relay]
command = "node"
args = ["/ABSOLUTE/PATH/agent-relay/dist/cli.js"]
startup_timeout_sec = 10
tool_timeout_sec = 3660

[mcp_servers.agent_relay.env]
AGENT_RELAY_CURSOR_COMMAND = "/ABSOLUTE/PATH/TO/cursor-agent"
```

### 4. Optional: install delegation guidance

```bash
pnpm setup:instructions
```

The command detects **Codex, Cursor, OpenCode, Grok, and DSH**, shows the evidence and rule destinations, then lets you select multiple clients by number. Press Enter to select all detected clients, or `q` to cancel. Detection uses commands on PATH and existing client configuration directories; it does not launch clients or verify authentication or MCP registration. Undetected clients can also be selected explicitly.

| Client | Rule destination | Scope |
| --- | --- | --- |
| Codex | `$CODEX_HOME/AGENTS.md`, default `~/.codex/AGENTS.md`; a non-empty `AGENTS.override.md` takes precedence and is updated instead | Global |
| Cursor | `<project>/.cursor/rules/agent-relay.mdc`, with `alwaysApply: true` | Selected project |
| OpenCode | `$OPENCODE_CONFIG_DIR/AGENTS.md` when set; otherwise `$XDG_CONFIG_HOME/opencode/AGENTS.md`, default `~/.config/opencode/AGENTS.md` | Global |
| Grok | `$GROK_HOME/AGENTS.md`, default `~/.grok/AGENTS.md` | Global |
| DSH | `$DSH_HOME/AGENTS.md`, default `~/.dsh/AGENTS.md` | Global |

Cursor requires an existing project directory, requested interactively if omitted. Its rule applies only to that project; global User Rules remain managed through Cursor's settings. Other clients use their own global instruction files. Environment overrides must match those used to launch the corresponding client.

For scripts or non-interactive terminals, pass comma-separated client IDs:

```bash
pnpm setup:instructions --clients codex,opencode,grok,dsh
pnpm setup:instructions --clients codex,cursor --project /absolute/project
pnpm setup:instructions --clients codex,cursor --project /absolute/project --dry-run
pnpm setup:instructions --help
```

`--clients` skips selection and allows installation for undetected clients. Non-interactive input without `--clients` fails without writing. `--dry-run` uses the same selection and validation rules and previews create/update/unchanged results without creating directories or writing files.

The installer embeds one shared guidance body into each selected client's supported file, preserves unrelated content, and updates its managed block idempotently. Complete historical blocks in the selected target are replaced. Every selected target is validated before any writes: malformed or multiple managed blocks, an invalid Cursor project, or an existing unmanaged `agent-relay.mdc` abort the installation without writing targets. Write failures are reported per client, other selected clients are still attempted, and the command exits nonzero; already completed writes are not rolled back.

Historical guidance in `~/.agents/AGENTS.md` (or `$DSH_AGENTS_HOME/AGENTS.md`) is reported and preserved for manual review; the installer no longer writes that shared path by default. Creating OpenCode's global `AGENTS.md` can shadow its `~/.claude/CLAUDE.md` fallback; the installer warns when that fallback is present and enabled. Review those preferences before selecting OpenCode.

Start a new client session after installation. The guidance permits delegation only to an agent explicitly named by the user; otherwise, the calling agent performs the task itself. **Rules installation does not register the relay MCP server**: complete step 3 separately in each calling client. File installation success is not a runtime client-loading check.

Rule locations follow the clients' documentation: [Codex](https://developers.openai.com/codex/guides/agents-md), [Cursor](https://cursor.com/docs/rules), [OpenCode](https://opencode.ai/docs/rules/) ([XDG configuration](https://github.com/anomalyco/opencode/issues/6669), [custom directory precedence](https://github.com/anomalyco/opencode/issues/28658)), [Grok](https://docs.x.ai/build/features/project-rules), and [DSH](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/context/agent-instructions).

## Usage

Ask your configured client to run a named agent, for example:

```text
Use Grok to review the current changes in /path/to/worktree and run the relevant tests.

Ask Cursor to inspect the authentication flow without editing files.

Delegate this implementation task to OpenCode in /path/to/worktree.

Delegate this implementation task to DSH in /path/to/worktree.

Delegate this implementation task to Codex in /path/to/worktree.
```

Each tool takes a `task` and an absolute `cwd`. Pass a returned `sessionId` to the same tool with the same working directory to continue that provider's session. Optional provider-specific inputs are exposed through MCP tool discovery; the four existing ACP tools retain their contracts alongside the new `codex_delegate` tool.

```text
Calling client chooses a task and worktree
        ↓
agent-relay executes one provider turn
        ↓
Grok / Cursor / OpenCode / DSH / Codex works locally
        ↓
Calling client reviews the result, diff, and tests
        ↓
Calling client integrates or follows up
```

Use separate worktrees for independent parallel tasks. Only one task may be active per resolved working directory; overlapping calls to that directory return `WORKSPACE_BUSY`.

### Codex

Install and authenticate the Codex CLI before calling `codex_delegate`; no ACP bridge package is needed. The relay launches `codex app-server --listen stdio://` directly and uses the CLI's existing authentication. It does not initiate login. Protocol compatibility is based on Codex CLI 0.163.0; older versions are unverified. On Windows, point `AGENT_RELAY_CODEX_COMMAND` at a native `codex.exe`; `.cmd`/`.bat` launchers are unsupported.

Inputs are `task`, absolute `cwd`, and optional `sessionId`, `model`, and `reasoningEffort`. The returned `sessionId` is the Codex `thread.id`; only relay-recorded IDs may be resumed in their original directory. Restoring a missing thread fails rather than creating a replacement. Explicit model/effort values update the live thread; omitted values preserve restored/default settings. Invalid options are reported by Codex as `CODEX_FAILURE`.

```json
{
  "task": "Implement the requested change and run the relevant checks.",
  "cwd": "/absolute/path/to/worktree",
  "reasoningEffort": "high"
}
```

New and resumed turns use workspace-write sandboxing, disabled sandbox network access, default temporary-directory access, and user-routed approvals. Extra approvals are declined with `PERMISSION_REQUIRED`; questions/elicitation fail with `INTERACTION_REQUIRED`. Local Codex/MCP configuration still applies; this is not isolation of external MCP services or model API traffic. Keep this relay out of the worker's MCP configuration.

Results include `provider: "codex"`, `sessionId`, `stopReason`, `text`, and `truncated`, plus optional bounded `toolCalls`, `summariesTruncated`, and native token `usage` (`total`, `last`, `modelContextWindow`). Only a completed turn succeeds. Failure retains confirmed session IDs and partial output; cancellation/timeout interrupts the turn and cleans up its process tree. Protocol incompatibility returns `PROTOCOL_MISMATCH`; other native failures use `CODEX_FAILURE`.

Run the opt-in authenticated smoke with `pnpm test:real:codex` (or `RUN_CODEX_REAL_TESTS=1 pnpm exec vitest run test/codex-real-smoke.test.ts`). It uses disposable state/workspaces but the real Codex account and service.

## Configuration

Set these environment variables on the MCP server process:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_RELAY_GROK_COMMAND` | `grok` | Grok executable |
| `AGENT_RELAY_CURSOR_COMMAND` | Required for Cursor | Cursor executable |
| `AGENT_RELAY_OPENCODE_COMMAND` | `opencode` | OpenCode executable |
| `AGENT_RELAY_DSH_COMMAND` | `dsh` | DSH executable |
| `AGENT_RELAY_CODEX_COMMAND` | `codex` | Native Codex executable |
| `AGENT_RELAY_STATE_DIR` | `~/.local/agent-relay` | Session metadata and workspace locks |
| `AGENT_RELAY_PHASE_TIMEOUT_MS` | `30000` | Protocol phase timeout |
| `AGENT_RELAY_TOTAL_TIMEOUT_MS` | `3600000` | Total task timeout |
| `AGENT_RELAY_CANCEL_GRACE_MS` | `5000` | Cancellation grace period |
| `AGENT_RELAY_TERM_GRACE_MS` | `2000` | Grace period before forced termination |
| `AGENT_RELAY_KILL_CONFIRM_MS` | `2000` | Forced-termination confirmation timeout |
| `AGENT_RELAY_TEXT_LIMIT_BYTES` | `262144` | Retained text limit |
| `AGENT_RELAY_STDERR_LIMIT_BYTES` | `65536` | Retained stderr limit |
| `AGENT_RELAY_PROGRESS_INTERVAL_MS` | `1000` | Minimum progress notification interval |

Numeric settings require positive safe integers; invalid values use their defaults. `AGENT_RELAY_DELEGATED=1` is an internal child-process marker used to reject nested relay delegation; do not set it on the top-level server.

## Migrating from codex-agent-relay

This rename intentionally removes old command and environment-variable aliases:

1. Stop all old relay instances and wait for their tasks and child processes to finish before switching. Do not run old and new instances against the same workspaces during migration.
2. Change the executable name to `agent-relay` where used, and replace every `CODEX_AGENT_RELAY_*` setting with `AGENT_RELAY_*`. Update the registered server entry and absolute paths if necessary. The four MCP tool names remain unchanged.
3. The default state directory changes from `~/.local/codex-agent-relay` to `~/.local/agent-relay`. To retain sessions, move the **complete** state directory, including sessions and locks, while preserving permissions. Use an unused destination; do not merge two existing state directories. Alternatively, set `AGENT_RELAY_STATE_DIR` to the existing directory. Session and lock formats have not changed. An unresolved orphaned lock still needs investigation; migration does not make it safe to delete.
4. Replace `pnpm setup:codex-instructions` with `pnpm setup:instructions`. The installer now detects clients and installs guidance into their supported locations; Codex honors `CODEX_HOME` again. Existing managed blocks in selected targets are updated. Older shared guidance in `~/.agents/AGENTS.md` is preserved and reported for manual review; see the client table above.

The relay does not automatically migrate state or modify client configuration.

## Important notes

- Authenticate each agent CLI before calling it. Do not place credentials in task arguments.
- The relay does not create worktrees or automatically accept an agent's changes.
- Filesystem, network, and permission behavior depends on the selected agent and its local configuration.
- Workers are cleaned up as process trees. If cleanup cannot be confirmed, the relay keeps the workspace locked.
- Inspect the actual diff and run the relevant checks before integrating a result.
- Keep this relay out of downstream agents' MCP configuration to avoid recursive delegation.

## Development

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The default suite uses fake ACP agents and a fake Codex app-server. Real-agent smoke tests are opt-in; see [`test/AGENTS.md`](test/AGENTS.md).
