# Subagent usage friction review

Date: 2026-09-13

This review records observed behavior from the repository remediation work and
turns it into design requirements. It distinguishes the currently installed
deployment from uncommitted source changes in this repository.

## Executive finding

Prompt breadth is not the primary reliability problem. The most important
problem is that several independent timeout layers do not share one deadline or
one cancellation contract.

Delegated calls repeatedly failed after approximately 300 seconds while the
source allowed much longer bridge operations. Later isolation proved that the
Codex MCP timeout was not the failing layer: a fresh Codex process loaded the
configured 2,100-second timeout and completed a minimal MCP call after 330
seconds. The failure was OpenCode's single long-running `session.wait()` HTTP
request, which the generated client issued through bare Node fetch and reported
as `Transport` when the request closed at the response-header boundary.

A live source-bridge probe established that when
an MCP client explicitly aborts a request, or when the MCP SDK's request timer
expires and sends `notifications/cancelled`, the bridge rejects in about three
seconds, remains responsive to `tools/list`, and leaves a read-only worktree
unchanged. The bridge now also refreshes OpenCode's wait request every 240
seconds without cancelling the session or extending its operation deadline.

During this remediation:

- seven worker invocations ended at the OpenCode wait-request boundary;
- at least four timed-out attempts left observable partial changes;
- even a checksum-test-only prompt reached the same boundary without producing
  a file;
- one provider rejected a non-`auto` `tool_choice` request after edits had
  already been made;
- most delegated verification could not initially find Node or npm;
- validation-only prompts usually completed more reliably than broad
  implementation prompts.

The current installed deployment uses the Extended step profile (Scout 32,
Worker 48, Runner 64) with `opencode/muse-spark-1.3-contributor-free` for all
roles. The source changes reviewed here have not yet been installed into that
deployment.

## Current timeout layers

| Layer | Current default or observed value | Enforcement point |
| --- | ---: | --- |
| OpenCode client `session.wait()` HTTP request | approximately 300 seconds before refresh fix | generated client bare Node fetch; server observes HTTP 499 |
| Codex CLI per-tool timeout | 300 seconds by default; `mcp_servers.<id>.tool_timeout_sec` is supported | Codex `config.toml` |
| Bridge operation | Standard: Scout 300s, Worker 600s, Runner 1,200s; Extended: 900s/1,500s/1,800s | timeout profile used by `bridge/server.mjs:runAgent()` |
| Failed-session cleanup | up to 10 seconds for interrupt and 10 seconds for removal | `bridge/server.mjs:cleanupSession()` |
| Runner command | 900 seconds, accepted range 1-3,600 seconds | delegated `sandbox_run` process timer |
| Worker verification command | 120 seconds by default, configurable 1-900 seconds | delegated `sandbox_shell` process timer |
| Code-mode wait interval | 120 seconds | orchestration skill waiting guidance |

An earlier active Codex registration inspected on 2026-09-13 omitted
`tool_timeout_sec`. The timeout-profile implementation now persists and
verifies the setting after `codex mcp add` recreates the owned registration. A
later fresh-process probe reported `tool_timeout_sec = 2100` and completed a
minimal 330-second MCP call, proving that the configured Codex layer was not
the source of the remaining 300-second failure.

The Standard 20-minute Runner operation deadline is internally consistent with
the 15-minute default Runner command. The Extended profile gives Muse 30
minutes and configures a 35-minute Codex parent deadline. OpenCode wait requests
are refreshed inside either profile before the HTTP transport boundary.

## Confirmed friction points

### 1. Cancellation propagation and bounded wait refresh

The bridge now accepts an MCP request signal and forwards an `AbortSignal` to
OpenCode session calls. The live cancellation probe passed twice against the
source bridge and installed OpenCode backend:

- explicit `AbortController` after 3,000 ms rejected after 3,005 ms;
- MCP SDK request timeout after 3,000 ms rejected after 3,005 ms.

The SDK request-timeout path sends `notifications/cancelled` before rejecting.
The server remained responsive and the worktree snapshot did not change in
both cases. The separate 300-second failures were OpenCode wait-request
transport failures, not evidence of an outer caller timeout. An intentional
240-second refresh aborts only that wait request and immediately reissues it;
caller or bridge cancellation is never treated as a refresh.

If the caller disappears without cancellation, cleanup does not begin until
the much later bridge timeout. Repository writes can continue during that
window.

### 2. Cleanup is best effort, not confirmed termination

On error, cancellation, or timeout the bridge attempts `session.interrupt` and
then `session.remove`, bounding each attempt. Errors are deliberately swallowed
to preserve the original failure.

If either cleanup call hangs or fails, the bridge eventually releases its
per-worktree writer lock even though the remote session or delegated process may
still be active. A later writer can then race an orphaned writer.

### 3. Partial writes are an expected failure state

Workers edit the selected worktree directly. Provider failure, process failure,
or caller timeout can leave a syntactically valid but semantically incomplete
diff. `git status` and `git diff` make this visible but cannot establish task
completion.

### 4. Step limits and wall-clock limits solve different problems

The configured `steps` value limits model iterations, not elapsed time or tool
calls. Increasing from Standard to Extended helps step exhaustion but can make
a fixed wall-clock deadline more likely to expire before synthesis.

The configured provider has also rejected OpenCode's forced text-only final
step (`tool_choice: "none"`) when a model exhausted its tool-bearing steps.
The bridge now surfaces that provider error, but configuration-time model
discovery still does not prove tool-choice compatibility.

### 5. Verification toolchain visibility

The sandbox deliberately clears the environment and restricts `PATH`. On this
host, Node is installed below an FNM-managed version directory and was invisible
to most delegated verification commands. This caused workers to return static
inspection instead of executable verification and moved noisy testing back to
the parent.

Current source canonicalizes inherited PATH aliases that resolve beneath the
already mounted `/usr` tree. Other installations use runtime-reloaded,
tool-agnostic `sandboxRuntime` declarations with separate read-only roots,
relative PATH entries, and contained path-valued environment variables.
`OPENCODE_SANDBOX_TOOLCHAIN_DIRS` remains compatible. A positive live sandbox
probe is still required before operational readiness can be claimed.

### 6. Transport errors lack recovery identity

A failed wait request reports only `Transport` and does not reliably provide the
OpenCode session ID, current phase, cleanup state, worktree state, or a recovery
operation. The parent must infer continued activity from later file changes.

### 7. Narrow prompts reduce work but do not bound latency

Small validation-only packets were usually successful. Narrow implementation
packets still occasionally reached the wait-request boundary. Prompt narrowing is useful
routing discipline, but it is not a substitute for cancellation, isolation,
or an asynchronous execution protocol.

## Timeout design options

### Option A: short synchronous operations

Before the OpenCode wait boundary was isolated, one conservative option was to
fit synchronous work inside an assumed 300-second outer limit:

```text
delegated model/session work: 240-260 seconds
interrupt and removal reserve: 20-30 seconds
structured result reserve:    10 seconds
outer tools/call deadline:     300 seconds
```

This is suitable for Scout and narrowly scoped Worker tasks. It cannot honestly
support a Runner command with a 900-second default or 3,600-second maximum.

The bridge should reject an impossible timeout combination before creating a
session. It should not silently truncate a requested Runner timeout.

### Option B: increase the outer caller deadline

Codex CLI supports a per-server setting:

```toml
[mcp_servers.opencode-agents]
tool_timeout_sec = 1800
```

The exact value must exceed the bridge deadline plus cleanup/result reserve.
For example, a 30-minute Codex deadline can contain the current 20-minute
bridge deadline and 15-minute default Runner command. This is a supported
near-term path for the CLI, according to the
[official Codex configuration reference](https://developers.openai.com/codex/config-reference).

The installer now persists and doctor-checks this setting when it recreates an
owned Codex MCP registration. A fresh Codex process has proven this configured
path with a minimal 330-second MCP call. A longer deadline still leaves poor
recovery behavior when transports disappear.

This option must be proven independently for Codex CLI, the Codex app/tool
host, and Claude rather than assumed from one client's configuration.

### Option C: asynchronous operation protocol

Long Worker and Runner jobs should not depend on one synchronous MCP response.
An asynchronous protocol would provide operations such as:

```text
operation_start -> operation_id
operation_status(operation_id)
operation_log(operation_id, query)
operation_cancel(operation_id)
```

The operation record should contain role, canonical worktree, selected access
mode, OpenCode session ID, timestamps, state, last phase, cleanup status, and
worktree status delta. Records should be stored under a mode-0700 runtime root
without prompt contents or credentials.

This preserves long Runner timeouts and gives cancellation/recovery explicit
semantics. It is the preferred long-term design.

### Option D: isolated writable worktrees

Writable workers should operate in a temporary Git worktree or copy-on-write
workspace. The parent should integrate the resulting patch only after a
successful final response and acceptance checks.

This does not replace cancellation, but it converts orphaned writes from a
shared-worktree integrity problem into disposable task state. It is the
preferred complement to asynchronous operations.

## Recommended design

Use two execution classes rather than forcing all roles into one timeout model:

1. **Synchronous Scout and narrow Worker**
   - configured deadline below the proven caller limit;
   - cancellation signal plus explicit interrupt/removal;
   - result returned before the outer deadline;
   - writer remains locked or quarantined until termination is confirmed.
2. **Asynchronous long Worker and Runner**
   - immediate operation ID;
   - explicit status, log, and cancellation tools;
   - isolated writable worktree for mutation-capable operations;
   - durable, non-secret operation state and cleanup reconciliation.

Until asynchronous execution exists, Runner must reject command timeouts that
cannot fit within the configured outer and bridge budgets.

## Writer-lock state model

A boolean active-writer set is insufficient when cleanup is uncertain. Use an
explicit per-worktree state:

```text
free -> active -> cleaning -> free
                  |
                  +-> quarantined
```

- `active`: a writable operation is executing;
- `cleaning`: interrupt/removal has started;
- `quarantined`: termination could not be confirmed;
- `free`: no writer or orphan is known.

New writers must fail closed for `active`, `cleaning`, and `quarantined`.
Quarantine should be cleared only by confirmed session termination, explicit
operator reconciliation, or process restart with a documented stale-state
check.

## Provider compatibility improvements

Add an opt-in live doctor check for each configured model that:

1. creates a disposable OpenCode session;
2. performs a harmless tool call;
3. reaches ordinary final synthesis before step exhaustion;
4. interrupts/removes the session;
5. reports unsupported `tool_choice` separately from authentication, quota,
   networking, and empty-text failures.

Unknown compatibility should fail closed for writable delegation. Do not
silently switch models or providers.

## Toolchain follow-up

The generic trusted-runtime-root model avoids per-tool discovery rules and does
not mount all of a version manager or the user's home directory. Doctor still
needs configurable, networkless execution probes and should report Worker and
Runner readiness separately from host readiness.

## Observability requirements

Every delegated operation should have a stable operation or session identifier
available before long-running work begins. Debug and persisted operation state
should record:

- start, prompt submitted, wait, context extraction, cleanup, and completion
  timestamps;
- role, canonical worktree, and read-only/writable mode;
- caller cancellation observed or absent;
- interrupt/remove attempted, timed out, failed, or confirmed;
- final worktree status delta;
- provider error category without prompt or credential contents.

Progress notifications may improve user visibility, but must not be treated as
proof that a hard outer deadline has been extended.

## Prompt and routing guidance

Worker packets should continue to specify one behavior, a small edit set, one
focused verification command, and an explicit stop condition. Agent guidance
should also require:

- one quick required-runtime check, then immediate reporting if unavailable;
- no repeated filesystem search for a missing toolchain;
- synthesis based on remaining wall time as well as remaining model steps;
- early finalization before the transport deadline;
- no claim of test success when only static inspection ran.

Use a faster execution-oriented model for Worker/Runner when available. Raising
step limits should be reserved for demonstrated step exhaustion, not used as a
response to a wall-clock timeout.

## Acceptance tests for timeout work

Before changing production defaults, add live and unit coverage for:

1. caller cancellation reaches the bridge and aborts every pending SDK call;
2. a never-resolving model operation returns before the outer deadline;
3. interrupt and removal each hang and respect their cleanup bounds;
4. late session creation is reconciled after the main request has timed out;
5. a worktree remains quarantined while termination is uncertain;
6. a second writer cannot race an orphaned first writer;
7. invalid Runner/bridge/caller timeout combinations fail before session
   creation;
8. long asynchronous operations survive caller disconnect and can be queried or
   cancelled by operation ID;
9. partial writes remain isolated and are never automatically merged;
10. real Codex and Claude callers are tested because their cancellation and
    deadline behavior may differ.

## Implementation order

1. Instrument operation/session lifecycle and create a live cancellation test.
2. [Implemented 2026-09-13] Test configured Codex `tool_timeout_sec` with a
   minimal 330-second MCP call in a fresh process; it passed with 2,100 seconds
   loaded.
3. [Implemented 2026-09-13] Isolate the real 300-second failure to OpenCode's
   `session.wait()` HTTP request and refresh that wait every 240 seconds.
4. [Implemented 2026-09-13] Introduce configured parent/caller-budget
   preflight and reject impossible synchronous timeout combinations. This
   enforces configured limits only because the MCP context has no live
   deadline field.
5. [Implemented 2026-09-13] Add in-memory writer quarantine until session
   removal is confirmed. Restart recovery requires a Git status/diff and
   orphan-session check.
6. [Partially implemented] Add generic runtime-reloaded trusted roots and
   canonical `/usr` PATH discovery. Add configurable live Doctor probes.
7. Add provider capability doctor probe.
8. Implement asynchronous operation status/cancel for long work.
9. Isolate writable jobs and integrate patches only after acceptance.

Signed release provenance is intentionally deferred. The unsigned SPDX SBOM and
SHA-256 integrity checks remain in scope; neither is represented as an
authenticity signature.

## 2026-09-13 batch implementation notes

Actual orchestration friction observed while implementing caller-budget
preflight and writable quarantine:

- The reconnaissance Scout completed successfully and returned exact runtime,
  test, and documentation insertion points.
- The first Worker ran for several minutes and left a focused partial diff, but
  its final response failed at the provider boundary with
  `invalid_request_error`: reasoning `encrypted_content` was not issued to this
  caller. The failure therefore did not prove that its edits or tests were
  complete.
- The orchestrator inspected Git status and the focused diff before recovery.
  A single materially narrower Worker retry failed immediately with the same
  provider error, after which direct completion required explicit user
  authorization.
- The partial unit suite was already green, but integration review found two
  issues not exposed by that first run: production parent-timeout loading used
  a catch-all fallback that could mask invalid configuration, and the async
  test polling helper did not await asynchronous predicates. Direct takeover
  removed the fallback, isolated runtime tests from developer-local config,
  and corrected asynchronous polling.

No Scout step-budget or wall-clock failure occurred in this batch. The repeated
Worker failure was a provider/session-state compatibility fault during response
generation, not demonstrated model-step exhaustion.

Follow-up root-cause work confirmed the same Muse Spark/Console failure in the
OpenCode service log and in the active upstream issue. The local mitigation is
a narrowly scoped OpenCode session-context hook: for orchestrator-owned Muse
Spark sessions only, hidden reasoning parts are omitted from the next provider
request so caller-bound encrypted state is not replayed. Visible text and tool
history are preserved, and no model fallback is introduced. A focused unit test
covers the exact filtering boundary; live validation requires reinstalling the
built plugin and restarting the OpenCode service that loaded the prior plugin.

The first deployment command mistakenly used the repository-local config,
which temporarily rendered Standard agent limits. The mismatch was detected
from installer output and corrected immediately by reinstalling with the active
user config; the final installed profile is Extended. The OpenCode watcher
loaded the updated plugin, and an isolated live Worker probe then completed two
separate reads, a sandbox-shell action, and final synthesis with
`LIVE_WORKER_ENCRYPTED_REASONING_FIX_PASS`. This confirms the exact previously
failing multi-turn tool path without changing the project worktree.
