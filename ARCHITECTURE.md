# Architecture

This document explains the durable component boundaries and runtime invariants of `agent-relay`. For day-to-day agent instructions, start with [`AGENTS.md`](AGENTS.md).

## System context

The relay sits between **MCP clients** and locally installed **coding-agent CLIs** using ACP, the native Codex app-server protocol, or a provider headless JSON transport:

```text
MCP client
  │ MCP over stdio
  ▼
src/cli.ts → src/cli-runtime.ts
  ▼
src/server.ts
  │ validated delegate request
  ▼
  ├─ AcpRunner ────────────────────── Cursor / OpenCode (ACP)
  │    └─ inline lifecycle + lease
  │
  ├─ HeadlessRunner ─┐
  │                 ├─ WorkerHost ── owned CLI process tree
  └─ CodexRunner ────┘                 ├─ Grok / DSH / Claude (NDJSON)
                                      └─ Codex (app-server JSONL RPC)

All runners ── lifecycle.ts (admission / shutdown)
            └─ SessionStore (session metadata / shared per-cwd locks)
```

The relay is an orchestration boundary, not a second autonomous planner. The calling client chooses what to delegate and reviews/integrates the result; the relay executes one non-interactive provider turn and returns a resumable session ID plus bounded output.

## Transport selection

Choose the transport from verified native capabilities before choosing a runner.

| Provider | Transport / runner | Reason |
| --- | --- | --- |
| Grok | streaming JSON / `HeadlessRunner` | Native unattended turns own their daemon, expose terminal events, and resume ACP-created UUIDs. |
| DSH | headless JSON / `HeadlessRunner` | Each invocation enforces workspace-write and never approvals, including resume; no ACP close requirement. |
| Claude Code | stream-json / `HeadlessRunner` | Native CLI credentials and result/permission-denial events remove the separate ACP bridge. |
| Codex | native app-server / `CodexRunner` | Persistent threads, bidirectional requests, approvals, and turn interrupts need a native RPC driver. |
| Cursor | ACP / `AcpRunner` | Print-stream equivalents for interactions/todos/subagents/images are unverified. Print approval/WebFetch behavior is unverified, and it cannot validate ask mode through advertised session modes. A separate spike is required before changing transport. |
| OpenCode | ACP / `AcpRunner` | Existing capability negotiation, session options, permission refusal, and summaries remain on the supported ACP interface. |

## Layer boundaries

### `src/cli.ts` and `src/cli-runtime.ts`: process boundary

Responsibilities:

- `src/cli.ts` loads environment-derived configuration and enters the runtime.
- The runtime starts the MCP server on stdio and owns the testable shutdown coordinator.
- `SIGINT`, `SIGTERM`, `SIGHUP`, and stdin EOF synchronously close the runner admission gate and share one shutdown operation.
- MCP transport close has a fixed five-second timeout and runs in parallel with mandatory runner cleanup. Cleanup has no global timeout.
- Exit waits for every snapshotted task's process and lease finalization. A clean close exits `0`; transport, cleanup, lease, or shutdown-reporting failures exit `1` with bounded stderr diagnostics.

Do not move provider behavior here.

### `src/server.ts`: MCP contract boundary

Responsibilities:

- Define Zod schemas for MCP tool inputs and structured outputs.
- Register `grok_delegate`, `cursor_delegate`, `opencode_delegate`, `dsh_delegate`, `codex_delegate`, and `claude_delegate`.
- Resolve and validate `cwd` before execution.
- Convert runner results and `RelayFailure`s into MCP tool results.
- Forward MCP cancellation and progress notifications into the runner.

A public tool-contract change normally begins here and must stay synchronized with `src/types.ts`, provider adapters, tests, and the READMEs.

### `src/runner/acp-runner.ts`: provider-neutral execution engine

`AcpRunner` owns the common ACP lifecycle:

1. Reject nested delegation when `AGENT_RELAY_DELEGATED=1`.
2. Validate provider input through the adapter hook.
3. Acquire the per-`cwd` workspace lock.
4. Load persisted session metadata when a `sessionId` is supplied.
5. Ask the adapter how to spawn the provider CLI and construct the child environment.
   The optional `prepareSpawn` hook creates private native configuration and extra arguments before marking the lease as spawning. Its disposer runs only after confirming no worker exists or the process tree has exited; unconfirmed workers retain their configuration.
6. Connect ACP over NDJSON on the child's stdin/stdout.
7. Initialize and, when required, authenticate.
8. Let the adapter validate initialized capabilities, then create, load, or resume a session.
9. For adapters that require recoverable configuration failures, persist a newly created session immediately.
10. Let the adapter apply provider-specific session configuration.
11. Persist any remaining newly created session before prompting.
12. Send one prompt and collect bounded text/provider summaries.
13. Run the adapter's optional session-finalization hook.
14. Touch resumed session metadata after successful completion.
15. On cancellation, timeout, permission failure, or other error, preserve useful partial output.
16. Terminate the worker process tree and release the workspace lock only after cleanup is confirmed.

Provider-name branches should not be added here when the `ProviderAdapter` contract can express the difference.

### Native Codex and shared lifecycle

`src/runner/codex-runner.ts` uses `codex app-server --listen stdio://` directly. Its JSONL client in `codex-client.ts` correlates requests and handles server-initiated requests without ACP translation. Frames and early-event buffers are limited to 8 MiB; early events are additionally limited to 1024 entries. Unknown requests fail deterministically; unknown notifications are ignored.

After `initialize`/`initialized`, Codex checks `account/read` without initiating login, creates or resumes a persistent thread, then runs one turn. The relay's `sessionId` stores `thread.id`, not `thread.sessionId`. Only relay-confirmed IDs are exposed, and Codex has its own session namespace while sharing all workspace locks. New records are persisted before starting the turn; recovery never substitutes a new thread. Explicit model/effort overrides apply to the live thread; omitted values preserve Codex's state.

Every turn explicitly applies workspace-write sandboxing with sandbox network access disabled, default temporary-directory access, on-request approvals routed to the user, and no automatic approval. Approval requests are declined and fail with `PERMISSION_REQUIRED`; questions/elicitation fail with `INTERACTION_REQUIRED`. Local Codex authentication and MCP configuration still apply. Text and tool summaries are bounded, agent-message completion is deduplicated against deltas, and native token usage retains `total`, `last`, and `modelContextWindow` rather than ACP usage semantics. Only `turn/completed` with status `completed` succeeds.

Codex and `HeadlessRunner` run on the protocol-independent `src/runner/worker-host.ts`, which owns admission checks, total timeout, caller cancellation, lease acquisition, spawning, process-tree binding, bounded stderr, cleanup ordering, and cleanup diagnostics. The protocol driver supplies `drive(ctx)` and an optional `gracefulCancel(ctx)`; Codex uses the latter to attempt `turn/interrupt` within bounded grace, and the headless driver uses it for a provider-selected signal such as SIGTERM. The host also exposes a bounded helper-subprocess entry for provider preflight commands. A helper runs under the same workspace lease; after confirmed cleanup it moves the held lease from `reaped` back to `spawning` without retiring it, then binds the main worker. A helper shares the task's admission, cancellation, and total timeout, and does not register a separate active task. Unconfirmed helper cleanup fails closed and retains the lease and private preparation state.

Both runners register with `src/runner/lifecycle.ts` before acquiring a lease. This module owns the synchronous admission gate, active-task registry, shutdown promise, and cleanup diagnostic aggregation. Existing runner exports remain compatible. Unconfirmed worker cleanup retains the lock and takes precedence over lease and task errors.

### Headless NDJSON execution

`src/runner/headless-runner.ts` adds a provider-neutral driver on `WorkerHost`. Its `HeadlessAdapter` contract in `types.ts` owns command/preparation, stdin policy, event decoding, terminal/exit interpretation, summaries, and graceful-stop signal/grace. Preparation uses a private native-config task directory, retained when process cleanup cannot be confirmed. DSH, Grok, and Claude use this layer; DSH also uses the host helper entry for `--dump-config` model-route preflight.

The driver lifecycle is:

1. The host checks admission/nesting, registers cancellation and total timeout, acquires the workspace lease, and reads any recorded session.
2. The adapter selects a preset ID when needed and prepares private files, optional helpers, arguments, environment, and stdin (`ignore`, `close`, or `{ write }`).
3. The host marks spawning, spawns without a shell in the resolved cwd, marks the child `AGENT_RELAY_DELEGATED=1`, binds its process tree, and collects bounded stderr.
4. The driver parses frames, validates session IDs, persists a new confirmed ID, collects bounded text/summaries, and sends rate-limited progress.
5. After stream close and process exit, the driver applies stderr/permission failures and calls `complete(state, exit)`. A terminal success event and a valid exit are both required.
6. On cancellation, the adapter's graceful root signal precedes host tree termination. The host marks terminating, confirms tree cleanup, marks reaped, then releases the lease and disposes private files. Unconfirmed cleanup marks orphaned and retains the lease/files. Error precedence is cleanup, lease, then task failure.

`ndjson-lines.ts` reads stdout with an 8 MiB per-frame limit and rejects oversized or malformed JSON as `PROTOCOL_MISMATCH`. The runner ignores unknown event types, bounds text and summaries, persists new IDs on a session event (or the first event for a preset ID), and rejects inconsistent IDs. Only relay-recorded IDs appear in partial results or resume commands. Permission denials are reported after the worker finishes, preserving later output. Completion requires a successful terminal event plus adapter validation of the process exit; successful resumes touch their record. Cancellation signals the root and waits within the adapter's grace for a terminal event before the host terminates the process tree. DSH maps its headless transcript into this contract: `final.text` is authoritative, only exit `0` plus `final.reason.kind: "completed"` succeeds, credential, session, and cwd errors are normalized, usage is omitted, and recognized sandbox or auto-review denials become post-turn `PERMISSION_REQUIRED` failures. Claude persists at `system/init`, treats a result with `is_error: false` as successful, and converts result `permission_denials` into a post-turn `PERMISSION_REQUIRED` failure.

Grok creates a private daemon for each headless run, including when user configuration enables leader mode. Its adapter uses streaming JSON, a private `0600` prompt file, ignored stdin, and a preset UUID with `-s`; it persists the UUID on the first event and validates `end.sessionId`. Resume uses `-r` with a relay-recorded UUID and `--cwd`, preserving the root `sessions/` namespace for ACP-created UUIDs without title matching. Text chunks accumulate; tools provide progress only, and usage/thought/available-command events add no result fields. Success requires `end`, a non-cancelled stop reason, no error event, and exit `0`. Authentication and missing-session messages are normalized by the adapter.

Claude runs the native CLI with `-p --output-format stream-json --verbose`, `acceptEdits`, and `--permission-prompts none`; the task is written to stdin. New sessions receive a preset UUID through `--session-id`, and records are persisted when `system/init` arrives. Resume passes only a relay-recorded UUID through `--resume` in the `sessions/claude` namespace. Effort is validated locally before spawn, while model names are passed through because the gateway decides whether they are accepted. Result text is authoritative, tool use/results feed bounded summaries, and CLI token counters do not map to the relay usage shape, so usage is omitted. A SIGTERM exit `143` without a result is never success.

The optional `stderrFailure(tail)` hook classifies bounded stderr diagnostics without provider branches in the runner. Grok uses it for `permission required:` → `UNEXPECTED_PERMISSION`, even on exit `0`; Claude uses it defensively for `Unknown --effort value` → `INVALID_CONFIG`. The runner retains a detected failure as stderr advances and waits for stream close before completion. The optional `gracefulStop.waitForExit` makes Grok and Claude wait for actual exit after root SIGTERM, rather than stopping at an early terminal event or a missing result. Grok's tool shells can use separate process groups: only Grok's own graceful shutdown reaps those groups. Force-killing the original process group cannot guarantee cleanup of escaped tools; DSH detached tool groups have the same limitation.

### `src/runner/*`: shared execution primitives

- `types.ts` defines `ProviderAdapter`, `HeadlessAdapter`, summarizer, permission runtime, and session configuration extension points.
- `worker-host.ts` owns the shared non-ACP worker lifecycle used by native Codex and headless providers.
- `limits.ts` bounds output and supplies timeout helpers.
- `summaries.ts` converts high-volume provider updates into bounded structured summaries. Standard usage/tool-call summaries require an explicit provider; `OpenCodeSummaries(limit)` remains a thin `"opencode"` wrapper.
- `helpers.ts` centralizes ACP capability/auth/cancellation helpers.

These modules may know ACP concepts but should remain provider-neutral unless a type is explicitly a provider summary implementation.

### `src/adapters/*`: provider policy

An adapter decides provider-specific behavior such as:

- CLI executable and arguments.
- Authentication method selection.
- ACP client capabilities advertised by the relay.
- Prompt preamble for non-interactive execution.
- Session metadata and whether existing sessions are loaded or resumed.
- Session mode/config-option selection.
- Permission-request handling.
- Provider-specific ACP requests/notifications and summaries.

See [`src/adapters/AGENTS.md`](src/adapters/AGENTS.md) before changing this layer.

### `src/store.ts`: state and concurrency boundary

The store has two separate responsibilities.

**Session metadata**

- Session IDs are hashed for filenames, but the record stores the original ID.
- Records include the canonical `cwd`, creation/update timestamps, and optional provider metadata (`model`/`mode`).
- State directories/files are created with private permissions.
- A session may only be resumed from the same resolved `cwd`.
- Writes are atomic enough to avoid exposing partially written JSON.

**Workspace serialization**

- The real/resolved `cwd` is hashed into a private `<hash>.lock/` directory created with non-recursive `mkdir` as the atomic acquisition step.
- `owner.json` records a random owner token, hostname, relay PID, lifecycle phase, and the bound process-tree reference. Lease transitions validate the token, serialize updates, reject state regression, and release only from `reaped`.
- Release and stale recovery rename the lock directory to a permanent, nonempty `<hash>.retired.<old-token>/` tombstone. The old token in the target makes concurrent reclaimers fail safely instead of moving or deleting a newer generation.
- Existing records are read with a 16 KiB limit and strict schema validation. Symlinks, empty/corrupt records, unknown formats, mismatched hosts/platforms, and uncertain process probes fail closed.
- A live owner returns `WORKSPACE_BUSY`. A dead owner is reclaimed only for `reaped`, pre-spawn `locked`, or a POSIX worker whose process group is confirmed gone. Unsafe crash states return `WORKSPACE_ORPHANED`; legacy stale locks return `STALE_LOCK_UNVERIFIED`.
- Independent working directories can run concurrently.

Session records and workspace lease records are persistent state. Lease version 1 intentionally does not migrate legacy file locks automatically because those records cannot prove descendant cleanup. Do not mix relay versions against one state directory.

## Request and result flow

```text
MCP request
  │
  ├─ Zod validation / cwd resolution
  │
  ├─ acquire workspace lock
  │
  ├─ optional session-record lookup
  │
  ├─ spawn provider CLI (ACP, headless, or native)
  │
  ├─ ACP initialize/auth, or headless session event
  │
  ├─ new | load | resume session
  │
  ├─ provider-specific session configuration/preflight
  │
  ├─ session/prompt or headless task
  │    ├─ text chunks -> bounded text
  │    ├─ tool/usage/provider updates -> bounded summarizer
  │    └─ progress -> MCP notifications/progress (rate limited)
  │
  ├─ result or RelayFailure + partial result
  │
  └─ mark terminating → child cleanup → mark reaped → retire lease
       ▼
structured MCP result
```

## Session semantics

The relay persists only the metadata needed to safely reconnect an MCP client to a provider-owned session/thread. The provider remains the source of truth for conversation state.

Important consequences:

- A returned `sessionId` is provider-specific and must be sent back to the same MCP tool/provider.
- Results and partial errors expose a `sessionId` only after its relay record has been read or written successfully, so any returned ID is eligible for relay resume from its bound `cwd`.
- A session is tied to the resolved working directory to prevent accidental continuation in another checkout/worktree.
- Provider options that must remain stable across a session belong in persisted metadata when necessary. Cursor currently persists model/mode semantics; Grok, OpenCode, DSH, and Claude currently do not persist extra adapter metadata.
- ACP capability negotiation decides whether an existing session can be resumed or loaded; headless adapters pass only relay-recorded IDs to native resume flags.
- DSH persists its new relay record when the headless session event arrives, before prompting. Claude persists its preset UUID when `system/init` arrives, before the model call. Both retain their existing session namespaces for ACP-era compatibility.

## Provider behavior matrix

| Concern | Grok | Cursor | OpenCode | DSH | Claude |
| --- | --- | --- | --- | --- | --- |
| CLI default | `grok --output-format streaming-json` | explicit `AGENT_RELAY_CURSOR_COMMAND` required | `opencode` | `dsh --profile headless` | `claude -p --output-format stream-json` |
| Authentication | existing CLI credentials; no interactive login | `cursor_login` | `opencode-login` when advertised; no auth request when none advertised | restored bundled credential services, then launch env and `.env` fallback | existing Claude Code CLI login; auth failures map to `AUTH_UNAVAILABLE` |
| Existing session | recorded UUID via `-r` and `--cwd`; root namespace retained | common load behavior with persisted mode/model checks | prefers ACP resume, falls back to load; `resume: false` forces load | relay-confirmed ID passed as `--session-id`; never load or create a replacement | recorded UUID via `--resume`; `sessions/claude` retained; never create a replacement |
| Successful completion | non-cancelled `end`, no error event, exit `0`, confirmed cleanup | process cleanup | process cleanup | exit `0` and `final.reason.kind: "completed"` | exit `0` and terminal `result.is_error: false` |
| Interactive questions | not supported | question requests are skipped; plan approval rejected | V1 question permission denied in child env; V2 ACP cancels questions without client form support | noninteractive; no question channel | noninteractive; approval-requiring tools are denied automatically |
| Permission request | stderr `permission required:` → UNEXPECTED_PERMISSION | reject once when possible and fail with structured summary | reject once when possible, otherwise cancel; fail with PERMISSION_REQUIRED; never auto-allow | never approvals; recognized denial codes fail after the turn with PERMISSION_REQUIRED | `--permission-prompts none`; `permission_denials` fail after the turn with PERMISSION_REQUIRED |
| Native file policy | workspace sandbox, including Grok state/temp writes | enabled workspace sandbox with explicit cwd | V1 external-directory permissions denied; no OS sandbox or V2 permission translation | workspace-write patch on every new and resumed turn | `acceptEdits` plus native allow rules; no OS isolation |
| Native web policy | web search/fetch disabled; child networking allowed | WebFetch denied, user-config-only network rules; custom allowlists apply | V1 webfetch/websearch denied; V2 configuration still applies; shell networking remains possible | web tools disabled; shell networking remains possible | native rules apply; shell networking and external MCP services remain available |
| Provider summaries | plain text result | tool calls, todos, subagents, interactions, images | usage and tool-call summaries | tool-call summaries; usage omitted | tool-call summaries; usage omitted |

This table describes current implementation, not a requirement that every future provider behave identically.

## Headless compatibility baselines and spike evidence

The pinned transcript baselines are **Grok 1.0.77**, **DSH 0.2.2-rc.1**, and **Claude Code 2.1.318**. Sanitized raw events, stderr, timing, and exit status live in [`test/fixtures/transcripts/`](test/fixtures/transcripts/). These are tested observations at those versions, not guarantees about future CLI releases.

| Spike | Observed conclusion and evidence | Limit / assumption |
| --- | --- | --- |
| S1 Grok | `new-session-success.json`: preset UUID matches `end.sessionId`; `resume-acp-session.json`: ACP context resumes through `-r`; `resume-unknown.json` and `not-signed-in.json`: structured error messages. `sigterm-during-tool.json`: early cancelled end, then exit 143. | Leader-enabled headless runs owned a private daemon in the process-tree probe (not captured in NDJSON). Tool shells can escape the original group; graceful shutdown is necessary. |
| S2 DSH | `credential-restore-run.json`: restored credential services work; shell networking and `/tmp` writes remain possible. `sandbox-deny.json`: `FS_SANDBOX_DENIED` can precede completed final. `shell-sandbox-deny.json`: a shell-internal denial is a completed `tool_result` with no code, marked only by `[sandbox: file access denied under …]` text. `bad-model.json`: generic `INVALID_REQUEST`. `sigterm-tool.json`: exit 0 and error only, no final. | Both bare ACP UUIDs and headless IDs resume in the same literal cwd (`resume-acp-session.json`, `resume-headless-session.json`); those turns then fail for missing credentials. Process-tree probes found separate tool groups. |
| S3 Claude | `new-session-success.json`: init confirms the preset UUID. `permission-denied-continues.json`: denied tools do not stop later edits. `resume-unknown.json`: unknown ID is an error result. `unknown-model-accepted.json` and `unknown-effort-ignored.json`: gateway-dependent model acceptance and silently ignored effort. Both `sigterm-*.json` traces exit 143 without result. | ACP-created session compatibility is assumed, not measured: keep `sessions/claude`, return `UNKNOWN_SESSION` if unavailable, and never create a replacement. Unauthenticated/keychain behavior was not probed against a real account. |

Opt-in headless smoke tests check exact CLI versions and compare observed event types with the union in the corresponding baseline directory. Required session/text/terminal types must appear for the scenario; optional hook/tool/rate-limit types need not all appear on every run. New types fail the smoke check for review, while production still ignores unknown types. Hermetic tests exercise these checks without installed CLIs.

Claude runs through the native Claude Code CLI headless stream rather than a separate ACP bridge. It preserves the user's CLI login, hooks, skills, plugins, native allow rules, and MCP configuration. The `sessions/claude` namespace and workspace locks remain unchanged. Effort is validated locally before spawn because the CLI silently ignores unknown values; model names are passed through because acceptance depends on the configured gateway. Result `permission_denials` are reported after the turn, so the model may continue after a denial.

DSH, Grok, and Claude no longer use ACP close; their headless process trees are the cleanup boundary. They use SIGTERM as the graceful signal, and the adapter supplies the grace duration. Windows has no graceful signal, so cancellation skips it there and `taskkill /T /F` runs while the root is alive. Headless workers and preparation helpers declare `exitsOnCompletion`: on Windows their root's own exit counts as confirmed cleanup, because descendants of an exited root cannot be found. ACP and Codex workers keep the strict rule below. Windows npm/pnpm launchers still share a conservative parser, parameterized by package name, bin name and entry path. Claude's resolver targets the official `@anthropic-ai/claude-code` `bin.claude` entry. DSH's resolver export remains compatible; arbitrary batch scripts never execute.

## Non-interactive permission model

Delegated execution must not stall waiting for a human UI. Each provider adapter translates its available permission model into deterministic relay behavior.

The generic runner treats permission state as part of task failure handling so that cancellation, partial output, and cleanup use the same path as other execution failures. Do not add an unbounded user-question wait loop to the runner.

Cursor prepares a private CLI config snapshot; DSH writes a bundled permissions patch and optional model patch into a private task directory and passes them immediately after `--profile headless`. The generic runner owns disposal after confirmed process cleanup and reports disposal failures through cleanup diagnostics. Preparation failure never falls back to unrestricted execution. User configuration, provider session logs, and the session-record format are unchanged. Each ACP adapter emits a bounded static stderr policy warning. These settings express native policy, not uniform OS/network isolation; external MCP services remain outside the boundary. DSH shell networking remains available, and recognised permission signals are limited to the `FS_SANDBOX_DENIED` and `AUTO_REVIEW_DENIED` codes plus the shell sandbox result marker.

Native Codex also disables built-in web search in thread start/resume configuration. Its per-turn sandbox network denial remains separate from model/API traffic.

## Limits and backpressure

The relay bounds the data it accumulates:

- Agent text is capped by `textLimitBytes`.
- stderr keeps only a bounded tail controlled by `stderrLimitBytes`.
- Provider summary structures have their own bounded accounting.
- Progress notifications are rate-limited by `progressIntervalMs`.
- Individual ACP phases use `phaseTimeoutMs`; the whole delegated turn is bounded by `totalTimeoutMs`.

When adding new provider notifications, route them through a bounded summarizer rather than storing raw event streams.

## Cancellation and process lifetime

There are three cancellation sources:

- MCP request cancellation.
- Total task timeout.
- Relay shutdown.

The ACP runner tracks a session as active only after `session/new`, `session/resume`, or `session/load` returns a valid result. Cancellation, timeout, and permission failure then run ACP `session/cancel`, the optional adapter finalization hook, and process-tree termination in that order. No current ACP adapter defines that finalization hook. Configuration, prompting, persistence, and other failures skip cancel but still attempt finalization before termination. No finalization is attempted when session activation failed or timed out. Cancel notification, finalization, and termination are independently single-flight so caller cancellation, task failure, and relay shutdown cannot duplicate protocol requests or signals.

Headless DSH, Grok, and Claude use SIGTERM as their graceful signal; their adapter-selected grace precedes process-tree termination. DSH waits for a terminal event within `cancelGraceMs`. Grok waits at least 12 seconds for its early cancelled `end` and actual daemon exit. Claude emits no `result` line after SIGTERM, so its adapter waits up to at least 5 seconds for the actual process to exit; exit `143` without a result is never success. Caller cancellation and timeout retain their trigger reason, while process-tree confirmation remains authoritative for releasing the lease.

On POSIX systems the provider is spawned in its own process group. Before sending signals, cleanup retries an unknown initial group probe within `killConfirmMs`: on macOS an exiting worker can briefly produce `EPERM` before its group disappears. If the probe remains unknown, cleanup fails closed without sending signals. Once the group is known to be alive, cleanup sends group-level `SIGTERM`, escalates to `SIGKILL`, and confirms both group disappearance and direct-child exit; processes that escape the original group are outside this guarantee. After those signals, confirmation retries transient unknown process-group probes (`EPERM` and other non-`ESRCH` errors) only inside the existing TERM/KILL confirmation deadlines, then fails closed if the last probe is still unknown. `EPERM` and direct-child exit alone never count as group disappearance. Windows invokes the absolute `%SystemRoot%\System32\taskkill.exe` path with `/T /F`, without a shell, and confirms both a successful helper exit and direct-child exit. This is confirmation of the `taskkill` operation, not Job Object or crash-proof containment. A Windows root that exits before tree termination is conservatively unconfirmed because the relay can no longer establish descendant cleanup, unless the worker declares `exitsOnCompletion` (headless CLIs and preparation helpers).

If process-tree cleanup is unconfirmed, the runner returns `PROCESS_CLEANUP_FAILED`, preserves partial task output, and attempts to mark the lease `orphaned` without releasing it. Metadata failures never skip actual process cleanup. Once cleanup is confirmed, the runner must persist `reaped` before it can retire the lease. Error precedence is cleanup failure, then lease ownership/I/O failure, then the original task failure.

Crash recovery is deliberately conservative. Automatic recovery requires the same hostname and a compatible process-tree kind; records without a worker reference assume that the same hostname is also the same OS and PID namespace. The protocol does not provide Job Object containment, durable-write guarantees across power loss, or safe recovery from copied/manually edited state. Retired tombstones are not removed during normal startup and may be cleaned only offline.

`cleanupAllChildren()` snapshots the currently registered tasks, requests all cancellations in parallel, waits for their process-tree and lease-finalization reports, and throws a bounded `CleanupAggregateError` when any final cleanup is unconfirmed. Ordinary task failures and transient cancellation errors do not make shutdown fail when final cleanup succeeds. The reusable function does not close admission.

`beginRunnerShutdown()` is the CLI boundary: it synchronously closes the process-wide admission gate, immediately snapshots active tasks through `cleanupAllChildren()`, and caches that exact result for every later caller. A request that was still resolving its `cwd` before shutdown is rejected by the runner before lock acquisition or spawn. The gate remains closed for the process lifetime.

The CLI starts transport close and runner shutdown together. Transport exceptions and timeouts cannot skip worker cleanup, and repeated signals or EOF reuse the same coordinator promise. SDK errors reported during shutdown count as close failures even if `close()` resolves. Shutdown diagnostics remain on stderr and are bounded to 8 KiB; stdout remains reserved for MCP traffic. There is deliberately no global cleanup deadline, so an indefinitely blocked filesystem operation can keep the process alive rather than exit before lease state is safe.

## Error model

Expected operational failures use `RelayFailure(code, message, partial?)`.

Guidelines:

- Codes are part of the machine-readable behavior; prefer a specific stable code over parsing messages.
- Attach partial output/session metadata when the caller can still use it diagnostically.
- Convert unknown exceptions at layer boundaries rather than leaking arbitrary throw shapes through MCP.
- Do not hide cleanup/lock-release failures; they can indicate state corruption or leaked serialization.

## Configuration

`src/config.ts` maps environment variables to one immutable `RelayConfig` loaded at process startup. Defaults include:

- 30s phase timeout.
- 1h total delegation timeout.
- 5s ACP cancellation grace.
- 2s process termination grace.
- 2s forced-termination confirmation (`AGENT_RELAY_KILL_CONFIRM_MS`).
- 256 KiB text limit.
- 64 KiB stderr tail.
- 1s progress interval.

New runtime settings should be environment-driven only when they represent deployment/runtime policy rather than provider session choices. Provider session choices belong in the MCP tool contract and adapter configuration hooks.

## Where to put a change

| Change | Primary layer |
| --- | --- |
| New MCP field/result property | `src/server.ts` + `src/types.ts` |
| ACP lifecycle behavior shared by all providers | `src/runner/` |
| Provider CLI/auth/permission/session option | `src/adapters/<provider>.ts` |
| Persistent session compatibility | `src/store.ts` |
| Environment/runtime default | `src/config.ts` |
| Shutdown/stdio process behavior | `src/cli.ts` |
| New provider | adapter first, then wire types/config/server/store/tests/docs; follow `src/adapters/AGENTS.md` |

Favor extending the existing adapter contract over adding cross-layer special cases. That boundary is what keeps additional ACP agents cheap to integrate without duplicating the process/session engine.
