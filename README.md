# agent-relay

[English](README.md) | [简体中文](README.zh-CN.md)

Run **Grok**, **Cursor**, **OpenCode**, **DSH**, **Codex**, and **Claude Code** through one local MCP server from any MCP client that supports stdio.

`agent-relay` bridges MCP tool calls to local coding agents through ACP, the native Codex app-server, or a provider's headless JSON transport. The calling client handles orchestration and review; the relay runs one non-interactive agent turn and returns bounded output together with a resumable session ID.

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
| Claude Code | `claude_delegate` | Coding tasks through the Claude Agent ACP bridge |

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

Cursor requires an explicit executable path. Grok, OpenCode, DSH, Codex, and Claude Code default to `grok`, `opencode`, `dsh`, `codex`, and `claude-agent-acp` on PATH. You only need to install and authenticate the agents you intend to call. Claude Code requires the separate ACP bridge described below.

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

The command detects **Codex, Cursor, OpenCode, Grok, DSH, and Claude Code**, shows the evidence and rule destinations, then lets you select multiple clients by number. Press Enter to select all detected clients, or `q` to cancel. Detection uses commands on PATH and existing client configuration directories; it does not launch clients or verify authentication or MCP registration. Undetected clients can also be selected explicitly.

| Client | Rule destination | Scope |
| --- | --- | --- |
| Codex | `$CODEX_HOME/AGENTS.md`, default `~/.codex/AGENTS.md`; a non-empty `AGENTS.override.md` takes precedence and is updated instead | Global |
| Cursor | `<project>/.cursor/rules/agent-relay.mdc`, with `alwaysApply: true` | Selected project |
| OpenCode | `$OPENCODE_CONFIG_DIR/AGENTS.md` when set; otherwise `$XDG_CONFIG_HOME/opencode/AGENTS.md`, default `~/.config/opencode/AGENTS.md` | Global |
| Grok | `$GROK_HOME/AGENTS.md`, default `~/.grok/AGENTS.md` | Global |
| DSH | `$DSH_HOME/AGENTS.md`, default `~/.dsh/AGENTS.md` | Global |
| Claude Code | `$CLAUDE_CONFIG_DIR/CLAUDE.md`, default `~/.claude/CLAUDE.md` | Global |

Cursor requires an existing project directory, requested interactively if omitted. Its rule applies only to that project; global User Rules remain managed through Cursor's settings. Other clients use their own global instruction files. Environment overrides must match those used to launch the corresponding client.

For scripts or non-interactive terminals, pass comma-separated client IDs:

```bash
pnpm setup:instructions --clients codex,opencode,grok,dsh
pnpm setup:instructions --clients claude
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

Delegate this implementation task to Claude Code in /path/to/worktree.
```

Each tool takes a `task` and an absolute `cwd`. Pass a returned `sessionId` to the same tool with the same working directory to continue that provider's session. Optional provider-specific inputs are exposed through MCP tool discovery.

```text
Calling client chooses a task and worktree
        ↓
agent-relay executes one provider turn
        ↓
Grok / Cursor / OpenCode / DSH / Codex / Claude Code works locally
        ↓
Calling client reviews the result, diff, and tests
        ↓
Calling client integrates or follows up
```

Use separate worktrees for independent parallel tasks. Only one task may be active per resolved working directory; overlapping calls to that directory return `WORKSPACE_BUSY`.

### Grok

Grok uses headless streaming JSON (`--output-format streaming-json`), with the CLI's existing authentication. Each headless run starts its own daemon even when leader mode is enabled in user configuration; the relay does not connect to a shared leader or pass the ACP-only `--no-leader` flag.

The relay keeps `--sandbox workspace`, disabled built-in web search/fetch, explicit `WebFetch`/`WebSearch` deny rules, and `--always-approve`. It also passes `--disallowed-tools ask_user_question` and `--no-wait-for-background` for unattended work. Grok state and temporary directories remain writable, and shell networking remains available. These settings do not isolate external MCP services.

Tasks are written verbatim to a private `0600` file and passed with `--prompt-file`; prompt text is not placed in argv. New sessions use a relay-generated UUID with `-s`, persisted after the first event. Resume passes only a relay-recorded UUID with `-r` and the same resolved `--cwd`, avoiding Grok's title matching. Existing ACP UUIDs remain usable through the root `sessions/` namespace. An unknown provider session returns `UNKNOWN_SESSION` without creating a replacement; a `Not signed in` error returns `AUTH_UNAVAILABLE`.

Results retain the common fields only: text is assembled from `text` events, and `stopReason` comes from `end`. Tool events provide progress but no tool or usage summaries. Success requires an `end` event, a stop reason other than `cancelled`, exit code `0`, and no error event. A defensive stderr `permission required:` diagnostic returns `UNEXPECTED_PERMISSION`, including when the CLI exits `0`.

Cancellation first sends SIGTERM and allows at least 12 seconds for Grok to exit before process-tree termination. Grok can emit `end{cancelled}` before its daemon exits, so the relay also waits for exit within that grace. Grok's tool shells run in separate process groups: only Grok's own graceful shutdown reaps those children; force-killing its original process group cannot guarantee cleanup of escaped groups. DSH detached tool groups have the same limitation. Wait for the call to finish before resuming.

### OpenCode

The relay starts `opencode acp` for both V1 and V2. It sets the child working directory and sends the absolute `cwd` in ACP session requests. It does not pass `--cwd`, which OpenCode V2 rejects. Use `AGENT_RELAY_OPENCODE_COMMAND` to select another executable. Sign in with `opencode auth login` before delegation; the relay uses existing provider credentials and does not open an interactive login.

Inputs are `task`, absolute `cwd`, and optional `sessionId`, `resume`, `model`, `effort`, and `agent`. Existing sessions prefer ACP resume, fall back to load only when resume is not advertised, and use load when `resume: false`. A failed restore never creates a replacement session. Pass the original working directory. Relay records keep their existing format; OpenCode owns migration and availability of its stored conversations.

Model, effort, and agent values must be advertised session options. The relay sets model, then effort, then agent (ACP `mode`), refreshing the available options after each change. Omitted fields preserve provider settings. Effort depends on the selected model; `default` is valid only when advertised.

For V1, the child environment preserves other `OPENCODE_PERMISSION` rules while forcing `question`, `external_directory`, `webfetch`, and `websearch` to `"deny"`. V2 uses native `permissions` rules; the relay does not translate the legacy environment object. The client advertises no terminal authentication or question forms, so V2 ACP cancels questions instead of waiting for an answer. Both versions refuse ordinary permission requests through `reject_once` when offered, otherwise cancel, and fail with `PERMISSION_REQUIRED`. This does not provide filesystem or network isolation.

For example, a V2 workspace can require approval for edits while denying shell commands:

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

Run `pnpm test:real:opencode` for authenticated V2 smoke tests. They call the configured model and use disposable workspaces and relay state, without changing global configuration. Coverage includes cross-process resume/load, edits, observed permission replies, advertised configuration, actual question-tool invocation, cancellation, timeout, and private-server cleanup. The effort test requires a configured default model with variants and reports failure if none are available. V1.18.35 and V2.0.12 protocol profiles are covered by hermetic tests; a V1 profile is not a real V1 execution or a guarantee of cross-version conversation migration.

On November 3, 2026, all six real smoke tests passed on macOS with OpenCode 2.0.12 and the configured `opencode/pulse-alpha-free` model under the previous `allow_once` policy. The question-tool probe returned `stopReason: "cancelled"` without user input. The new refusal policy has not been revalidated with a real provider. V1 and Windows real execution remain unverified.

### DSH

The relay runs `dsh --profile headless` and reads newline-delimited JSON events. Relay-owned `--patch` files follow `--profile headless` and precede application flags: a `0600` permissions patch, plus an optional `0600` model-route patch. The relay does not edit `$DSH_HOME/profiles/headless/cordis.patch.yml`. The task is written to stdin and is not exposed in argv.

The permissions patch keeps approval, permission, and `tool-web` policy, removes the profile's `sandbox-policy` overlay, and re-enables the bundled `credentials`, `authorization`, and `deepseek-account` services. Saved credentials are preferred. If they are unavailable, DSH falls back to the launch environment, then `<cwd>/.env`, then `$DSH_HOME/.env`. An empty `DEEPSEEK_API_KEY` is removed from the child environment so it cannot mask the `.env` fallback; the relay does not set or read a nonempty value. The parent environment is unchanged.

Inputs are `task`, absolute `cwd`, and optional `sessionId`, `model`, and `reasoningEffort`. When model or effort is requested, the relay first runs `dsh --profile headless --patch <permissions> --dump-config` under the same workspace lease and timeout, and reads `agent-default-model.provider`. Unparsable output returns `INVALID_CONFIG`; a preflight timeout returns `CONFIG_TIMEOUT`. The relay does not validate model names locally. DSH reports an unknown model as its generic `INVALID_REQUEST`, which the relay returns as `ACP_FAILURE` with the DSH code and message. On resume, an omitted `reasoningEffort` keeps a saved explicit effort only when the provider/model route is unchanged.

Every new and resumed turn explicitly uses `--permission-mode workspace-write --approval-policy never`. Built-in web search and fetch are disabled. Shell networking and external MCP services remain available, so this is not network isolation. Recognized `FS_SANDBOX_DENIED` and `AUTO_REVIEW_DENIED` tool results fail the turn with `PERMISSION_REQUIRED` after it finishes, preserving later text. Other tool errors are not treated as permission failures. A denial raised inside a shell command may not include a recognized code, so it can be reported only as an ordinary tool failure. A completed `tool_result` means the tool returned; it does not prove that a shell command exited successfully.

Only exit code `0` with `final.reason.kind: "completed"` succeeds. Result text comes from the bounded `final.text`; DSH tool calls are summarized and usage is omitted. A missing credential maps to `AUTH_UNAVAILABLE`. Unknown-session and cwd-mismatch messages map to `UNKNOWN_SESSION` and `CWD_MISMATCH`; other turn or startup failures use `ACP_FAILURE`. SIGTERM cancellation waits for the configured grace, then terminates the remaining process tree. Wait for the call to finish before resuming because the workspace lease is released only after cleanup is confirmed.

Sessions use the existing `sessions/dsh` namespace. Bare UUIDs from the previous ACP integration can resume under the same resolved working directory. The relay passes only confirmed IDs as `--session-id` and repeats the permission and approval flags on every resumed turn.

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

### Claude Code

Install the ACP bridge separately; `@agentclientprotocol/claude-agent-acp@0.100.0` is the integration baseline:

```bash
npm install -g @agentclientprotocol/claude-agent-acp@0.100.0
claude-agent-acp --cli auth login
```

The bridge uses the Claude Agent SDK and its bundled native Claude executable. Existing compatible local authentication or provider environment credentials can be used. To use another native executable, set the upstream `CLAUDE_CODE_EXECUTABLE` to its absolute path. `AGENT_RELAY_CLAUDE_COMMAND` selects the **bridge**, not the native `claude` command. The relay does not install software or start interactive login during delegation.

`claude_delegate` accepts `task`, absolute `cwd`, and optional `sessionId`, `model`, and `effort`. Model/effort values must be advertised `configOptions`; the relay sets model before effort and refreshes options after each change. Omitted options preserve provider state. Invalid or unavailable options return `INVALID_CONFIG` or `CONFIG_UNSUPPORTED`.

Every new or restored session is explicitly set to `acceptEdits` before prompting. Edits can run directly, while additional ACP approval requests are rejected with `PERMISSION_REQUIRED` and available partial output. The relay advertises no terminal authentication, file/terminal services, or elicitation UI; the baseline bridge disables `AskUserQuestion` without form support. Native allow rules, hooks, shell networking and external MCP services still apply. This is not filesystem or network isolation.

Sessions use a separate `claude` namespace and the same cross-provider workspace locks. Only relay-confirmed IDs can be restored from the original `cwd`. Resume is preferred; load is used only when resume is not advertised. A failed restore never creates a replacement session. New IDs are persisted before configuration so configuration errors can return a resumable ID. ACP authentication-required errors return `AUTH_UNAVAILABLE`; sign in outside the relay and retry the confirmed session when available.

The bridge must advertise `session/close`. The relay closes the session, confirms process-tree cleanup, and only then releases the workspace lock. Results include `provider: "claude"` and the common result fields, with optional bounded tool-call and ACP usage summaries.

On Windows, supported npm/pnpm `.cmd` shims are resolved to a verified package `bin.claude-agent-acp` entry and run with Node, without a shell. Native `.exe`/`.com` and explicit `.js`/`.mjs` launchers are also supported. Arbitrary batch scripts are rejected.

Run the opt-in authenticated smoke with `pnpm test:real:claude` (or `RUN_CLAUDE_REAL_TESTS=1 pnpm exec vitest run test/claude-real-smoke.test.ts`). Optional `CLAUDE_TEST_MODEL` and `CLAUDE_TEST_EFFORT` exercise explicit configuration. The smoke uses a disposable workspace, edits files, restores the conversation across processes, and checks lock release. It requires authentication and may consume model allowance; default tests use a fake bridge.

### Native permission policy

The relay applies provider-specific native permission controls. These controls are not equivalent across providers. Extra ACP/native approval requests are refused; Grok's unexpected requests fail instead of opening an interactive approval flow.

| Agent | Relay configuration | Remaining limits |
| --- | --- | --- |
| Codex | `workspace-write`, sandbox network disabled, built-in web search disabled; reapplied to new/resumed threads and every turn | Default temporary directories remain writable. Model API traffic and external MCP services are outside this boundary |
| Grok | `--sandbox workspace`, `--disable-web-search`, `WebFetch`/`WebSearch` deny rules; retains `--always-approve` inside the sandbox | Grok state directories and temp remain writable; the workspace profile permits child network access. Custom network restrictions are Linux-only, not equivalent on macOS |
| Cursor | `--sandbox enabled --workspace <cwd>`, `approvalMode: allowlist`, `sandbox.networkAccess: user_config_only`, `WebFetch(*)` denied | Custom sandbox network allowlists and local/team policy still apply; this is not a blanket network block |
| OpenCode | Forces V1 `OPENCODE_PERMISSION` entries `question`, `external_directory`, `webfetch`, and `websearch` to `deny`; refuses extra ACP approvals in both versions | No V2 permission translation; V2's own configuration still applies. No OS sandbox: shell, plugins and external MCP tools can write outside the workspace or use the network. V1 external-directory denial also restricts supported external reads |
| DSH | Headless `--patch` enforces `workspace-write`, `--approval-policy never`, and disabled `web_search`/`web_fetch` on new and resumed turns; credential-store services are restored | The file sandbox does not restrict shell networking. Shell-internal denials may lack a recognized error code. Windows ACL and older Linux Landlock backends may provide partial file enforcement |
| Claude Code | Sets `acceptEdits` on new/restored sessions and rejects extra ACP approvals | No filesystem or network isolation; native allow rules, hooks, shell networking and external MCP services still apply |

**OpenCode behavior change:** permission requests are no longer automatically granted with `allow_once`. The relay selects `reject_once` when offered, otherwise cancels, and returns `PERMISSION_REQUIRED` with available partial output.

Cursor uses a private snapshot of its CLI configuration under the relay state directory. Existing CLI settings, authentication-related configuration, environment credentials and normal OS credential discovery are retained. Only the permission/sandbox settings above are overridden, with missing schema defaults supplied. The source CLI configuration and project files are not edited. `CURSOR_CONFIG_DIR` or `XDG_CONFIG_HOME` locates the source CLI configuration; the normal data directory and model/API connection remain unchanged.

DSH receives private files containing the relay's bundled native and optional model patches. They are passed immediately after `--profile headless`, before application flags. User profiles are not edited; `DSH_PERMISSION_MODE` is set only in the child environment. Native configuration files are removed after confirmed process cleanup, including startup failure, cancellation and timeout; they are retained if cleanup cannot be confirmed. Preparation errors fail structurally without an unrestricted retry. A process crash may leave private directories behind; remove them only after confirming no worker still uses them.

Cursor, OpenCode, DSH and Claude Code emit one bounded stderr diagnostic per execution describing policy limits. Diagnostics contain no credentials or task text. External MCP services are not isolated by these settings. Custom executables/wrappers must honor native arguments and configuration; overriding the executable is not proof of enforcement.

The policy targets macOS, Linux and Windows through each provider's supported backends; launcher support does not prove sandbox availability. Hermetic tests verify configuration and refusal behavior, not real CLI isolation. Real CLI checks remain opt-in: use a disposable workspace to check internal/external writes, shell networking, web tools and resumed sessions, recording the OS, CLI version and observed result. Unrun platforms and capabilities remain unverified.

## Configuration

Set these environment variables on the MCP server process:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_RELAY_GROK_COMMAND` | `grok` | Grok executable |
| `AGENT_RELAY_CURSOR_COMMAND` | Required for Cursor | Cursor executable |
| `AGENT_RELAY_OPENCODE_COMMAND` | `opencode` | OpenCode executable |
| `AGENT_RELAY_DSH_COMMAND` | `dsh` | DSH executable |
| `AGENT_RELAY_CODEX_COMMAND` | `codex` | Native Codex executable |
| `AGENT_RELAY_CLAUDE_COMMAND` | `claude-agent-acp` | Claude ACP bridge executable |
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
