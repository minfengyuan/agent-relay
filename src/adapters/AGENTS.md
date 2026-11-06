# Adapter instructions

These instructions apply to `src/adapters/**`. Read the root [`AGENTS.md`](../../AGENTS.md) first. Consult [`ARCHITECTURE.md`](../../ARCHITECTURE.md) when the change affects lifecycle/session boundaries rather than only one provider.

## Scope

Adapters are the compatibility layer between a provider-neutral runner and one provider CLI. Keep provider quirks here instead of branching on provider names inside `AcpRunner` or `HeadlessRunner`.

The contracts are `ProviderAdapter<I, R>` for ACP and `HeadlessAdapter<I, R>` for headless NDJSON in `src/runner/types.ts`.

## What belongs in an adapter

An adapter may own:

- executable/argument construction;
- environment overlays needed by that provider;
- ACP authentication-method selection or headless credential behavior;
- advertised ACP client capabilities;
- a non-interactive task preamble;
- provider-specific input validation;
- session metadata and load-vs-resume policy;
- mode/config-option selection after session creation/loading;
- deterministic permission handling;
- headless stdin, event decoding, and terminal/exit interpretation;
- provider extension requests/notifications;
- bounded provider-specific summaries.

The adapter should not reimplement:

- child-process lifecycle or process-group cleanup;
- total/phase timeout orchestration;
- per-workspace locking;
- session-record I/O;
- common ACP initialize/new/load/resume/prompt flow;
- MCP tool registration/result conversion.

If a provider cannot fit the current hooks, first consider a narrow generic hook in `ProviderAdapter` rather than a provider-name conditional in `AcpRunner`.

## Adapter checklist

When changing an existing adapter, walk through the contract in this order:

1. **Input** — validate impossible option combinations before spawning the CLI.
2. **Command** — use `shell: false` assumptions; return executable + argument array, not a shell command string.
3. **Environment** — preserve the incoming environment and overlay only required keys.
4. **Authentication** — use only a non-interactive ACP method actually advertised at initialization, or a headless flow that does not reserve an interactive UI.
5. **Capabilities** — advertise only client features the relay really implements.
6. **Session policy** — decide new/load/resume behavior from advertised capabilities and user input.
7. **Stable session options** — reject conflicts with persisted metadata instead of silently changing session semantics.
8. **Configuration** — verify requested modes/config values exist before setting them; keep phase timeouts around ACP configuration calls.
9. **Permissions** — return a deterministic allow/reject/cancel response. Never block waiting for a UI.
10. **Headless terminal state** — decode the provider's terminal event and decide success only from that event plus the process exit code.
11. **Extensions** — parse provider extension payloads defensively before adding them to summaries.
12. **Summaries** — bound all accumulated provider data and set truncation when dropping or shortening information.
13. **Errors** — use a specific `RelayFailure` code and include partial state when useful.

## Current provider invariants

### Grok

- Default command comes from `RelayConfig.command` (`grok` by default) with relay-owned safety/noninteractive arguments.
- Keep `--sandbox workspace`, disabled web search/fetch and explicit web deny rules. Workspace permits Grok state/temp writes and child networking; emit the bounded policy warning without claiming complete network isolation.
- Authentication prefers `xai.api_key` only when `XAI_API_KEY` exists and the method is advertised; otherwise it uses advertised `cached_token`.
- A permission request is unexpected because the CLI is launched with always-approve semantics; fail rather than inventing an interactive flow.
- No provider-specific structured summary is currently returned beyond the common text/session result.

### Cursor

- `AGENT_RELAY_CURSOR_COMMAND` is required; do not silently guess an executable path.
- The CLI is launched with sandboxing enabled and an explicit workspace. A private CLI config snapshot forces allowlist approvals, user-config-only network rules, and a WebFetch deny; preserve unrelated config and normal credential/data discovery.
- Mode defaults to `agent`; `ask` and `model` are session-stable and persisted in the session record.
- Resuming with conflicting mode/model must fail with `SESSION_OPTION_CONFLICT`.
- Interactive question requests are skipped and plan approvals are rejected because delegated execution has no UI.
- Permission requests are rejected and surfaced as `PERMISSION_REQUIRED`, retaining a bounded interaction summary.
- Cursor extension notifications (todos/subagents/images) must remain bounded through `CursorSummaries`.

### OpenCode

- Command defaults to `opencode` and launches `acp` without `--cwd`, which V2 rejects. The child working directory and ACP new/load/resume requests carry the requested `cwd`; this also supports V1.
- Preserve any existing `OPENCODE_PERMISSION` object while forcing `question`, `external_directory`, `webfetch`, and `websearch` to `"deny"` for V1 compatibility. Do not translate it into V2 permission rules. This is a native permission policy, not OS isolation; V2's own permission configuration still applies.
- Do not advertise terminal authentication or question/elicitation capabilities. V2 ACP cancels questions that cannot be shown; keep real question-tool coverage separate from fake-agent assertions.
- `resume` without `sessionId` is invalid.
- Existing sessions prefer ACP resume when available, then load; `resume: false` explicitly requires load support.
- `model`, `effort`, and `agent` map to advertised session config options and must be validated against available values before setting.
- Reject ACP permission requests through `reject_once` when offered, otherwise cancel, and fail with `PERMISSION_REQUIRED`. Never select `allow_once` or `allow_always`.
- Usage/tool-call summaries must remain bounded through `OpenCodeSummaries` (`StandardSummaries` with provider `"opencode"`).

### DSH

- DSH uses `HeadlessAdapter`, not ACP. The command defaults to `dsh`; relay-owned arguments are `--profile headless --patch <permissions> [--patch <model>] --json --permission-mode workspace-write --approval-policy never [--session-id <id>] -`. Both patches must follow `--profile headless` before application flags. The task uses stdin `{ write: input.task }`, not argv.
- Write the permissions patch and optional model patch as `0600` files in the private task directory. Keep approval/permission/tool-web policy, omit `sandbox-policy`, and re-enable `credentials`, `authorization`, and `deepseek-account`. Do not edit user profiles. Set `DSH_PERMISSION_MODE` only in the child environment.
- Preserve the incoming environment except that an empty-string `DEEPSEEK_API_KEY` is removed from the child so it cannot mask DSH's `.env` fallback. Do not set or inspect a nonempty value.
- Resume a relay-confirmed ID with `--session-id` and repeat both policy flags. Keep the existing `sessions/dsh` namespace so bare ACP-era UUIDs remain recoverable in the same resolved cwd. Spawn in the store's realpath cwd.
- When model or reasoning effort is requested, first run `--profile headless --patch <permissions> --dump-config` through the host helper under the same lease/cwd/timeout, and read `agent-default-model.provider`. Unparsable output is `INVALID_CONFIG`; helper timeout is `CONFIG_TIMEOUT`. Write `{id: agent-default-model, config: {provider, model?, reasoningEffort?}}` as JSON/YAML at `0600`; omit empty effort. Do not validate model names locally.
- Map `session` to the session event, accumulate `text`, map `tool_call`/`tool_result` to bounded summaries (`completed`→completed, `error`→failed), ignore `status`, `thinking`, and unknown types, and take result text from `final.text`. Omit usage.
- Success requires exit `0` and `final.reason.kind === "completed"`. `MISSING_CREDENTIAL` maps to `AUTH_UNAVAILABLE`; other final errors retain the DSH code and message in `ACP_FAILURE`. A standalone `error` without `final` maps `does not exist` to `UNKNOWN_SESSION` and `was recorded in` to `CWD_MISMATCH`. No events plus nonzero exit includes the bounded stderr tail.
- `FS_SANDBOX_DENIED` and `AUTO_REVIEW_DENIED` tool errors become `permissionDenied`, so the turn ends with `PERMISSION_REQUIRED` even when `final` is completed. Other tool errors are ordinary failures. A completed tool result does not prove the underlying shell command succeeded, and shell-internal denials may not carry a recognized code.
- Cancel with SIGTERM and wait within `cancelGraceMs` before process-tree termination. Do not treat exit `0` without `completed` as success; a SIGTERM-shaped turn surfaces as `CANCELLED`.
- On Windows, resolve the executable in this adapter under `shell: false`: PATH/PATHEXT lookup, native `.exe`/`.com`, direct `.js`/`.mjs` via `process.execPath`, and conservative parsing of known npm/pnpm `.cmd` shims to `@deepseek-ai/dsh/lib/bin.js` after `bin.dsh` verification. Do not spawn `cmd.exe` or set `shell: true`.

### Claude Code

- Use the external `claude-agent-acp` executable (baseline `@agentclientprotocol/claude-agent-acp@0.100.0`), with ACP v1 and no interactive `authenticate`. Preserve local credentials and `CLAUDE_CODE_EXECUTABLE`.
- Existing relay-confirmed sessions prefer resume; use load only when resume is not advertised. Never create a replacement after restore failure. Persist new records before configuration.
- Set model then effort from advertised config options, refresh after each response, then set and verify `mode: acceptEdits` before every prompt, including restored sessions.
- Do not advertise terminal authentication, file/terminal services, or elicitation UI. Refuse permission requests via `reject_once` or cancel and return `PERMISSION_REQUIRED`. Native allow rules, hooks and networking still apply; this is not OS isolation.
- Require and await `session/close`; reuse the common lifecycle and cleanup path. Map only structured ACP `authRequired` errors to `AUTH_UNAVAILABLE` through `mapError`, without message matching.
- Windows launchers use `windows-command.ts` with the official package name, bin name and entry path. Keep the DSH resolver wrapper compatible.
- Summaries use `StandardSummaries` with provider `"claude"` and ACP usage semantics.

## Adding a provider

Adding a provider is intentionally more than creating one adapter file. At minimum inspect/update these layers:

1. `src/types.ts` — provider-specific input/result types if the common shape is insufficient.
2. `src/runner/types.ts` — extend the `Provider` union and only add adapter hooks when they are generally useful.
3. `src/adapters/<provider>.ts` — implement policy using `AcpRunner` or `HeadlessRunner`, matching the provider's transport.
4. `src/runner.ts` — export the new runner if this remains the public runner barrel.
5. `src/config.ts` — add command/runtime configuration when needed.
6. `src/server.ts` — add MCP input/output schema, runner instance, tool registration, and error-result mapping.
7. `src/store.ts` — decide whether the provider needs a separate session namespace or new persisted metadata. Treat record-format changes as compatibility work.
8. `test/fixtures/` — add/extend a deterministic fake ACP agent or replay committed headless transcripts when provider behavior differs.
9. `test/<provider>-runner.test.ts` and `test/server.test.ts` — cover adapter semantics and MCP wiring.
10. `README.md` and `README.zh-CN.md` — document the supported provider, tool name, setup, and examples.
11. `scripts/append-agent-relay-instructions.mjs` and its tests — update only if the recommended delegation guidance must mention the provider.

Prefer an isolated `SessionStore` namespace for a new provider unless compatibility with an existing namespace is intentional.

## Tests required for adapter work

Use hermetic fake-agent tests for the behavior contract. Cover the cases relevant to the change, especially:

- command construction / missing executable;
- authentication availability;
- new and existing session behavior;
- option conflicts and unsupported config values;
- permission outcomes;
- provider extension parsing/summarization;
- truncation;
- cancellation/timeout if the adapter changes lifecycle interaction;
- structured partial output on failure.

Run the provider test first, then the full default suite:

```bash
pnpm exec vitest run test/<provider>-runner.test.ts
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run a real-agent smoke test only when the local CLI and authentication are available and the change depends on real provider behavior.
