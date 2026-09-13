# Subagent usage friction review

Date: 2026-09-13

This review records observed behavior from the repository remediation work and
turns it into design requirements. It distinguishes the currently installed
deployment from uncommitted source changes in this repository.

## Executive finding

Prompt breadth is not the primary reliability problem. The most important
problem is that several independent timeout layers do not share one deadline or
one cancellation contract.

The orchestration tool host stopped waiting after approximately 300 seconds,
while the current source defaults the bridge operation timeout to 20 minutes.
Some delegated sessions continued editing after the caller had already
received a timeout. This makes that host timeout an ambiguous state transition
rather than a completed cancellation.

A live source-bridge probe now establishes the narrower positive result: when
an MCP client explicitly aborts a request, or when the MCP SDK's request timer
expires and sends `notifications/cancelled`, the bridge rejects in about three
seconds, remains responsive to `tools/list`, and leaves a read-only worktree
unchanged. It does not yet establish that the orchestration tool host's
observed 300-second boundary sends the same cancellation notification.

During this remediation:

- seven worker invocations ended at the external 300-second boundary;
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
| Orchestration tool host `tools/call` | approximately 300 seconds | host outside this repository; configuration surface not yet identified |
| Codex CLI per-tool timeout | 60 seconds by default; `mcp_servers.<id>.tool_timeout_sec` is supported | Codex `config.toml` |
| Bridge operation | 1,200 seconds | `bridge/server.mjs:runAgent()` |
| Failed-session cleanup | up to 10 seconds for interrupt and 10 seconds for removal | `bridge/server.mjs:cleanupSession()` |
| Runner command | 900 seconds, accepted range 1-3,600 seconds | delegated `sandbox_run` process timer |
| Worker verification command | 120 seconds by default, configurable 1-900 seconds | delegated `sandbox_shell` process timer |
| Code-mode wait interval | 120 seconds | orchestration skill waiting guidance |

The active Codex registration inspected on 2026-09-13 omitted
`tool_timeout_sec`. The official Codex configuration reference documents a
60-second default and a per-server override. Older local configuration backups
contained `tool_timeout_sec = 900`, but the current installer registers the
server with `codex mcp add` and does not persist a timeout override.

The 20-minute bridge default is internally consistent with a 15-minute Runner
command, but incompatible with an effective five-minute synchronous host. Both
cannot be supported by one synchronous request unless the effective outer
deadline can be increased.

## Confirmed friction points

### 1. Cancellation propagation works, but only when the caller sends it

The bridge now accepts an MCP request signal and forwards an `AbortSignal` to
OpenCode session calls. The live cancellation probe passed twice against the
source bridge and installed OpenCode backend:

- explicit `AbortController` after 3,000 ms rejected after 3,005 ms;
- MCP SDK request timeout after 3,000 ms rejected after 3,005 ms.

The SDK request-timeout path sends `notifications/cancelled` before rejecting.
The server remained responsive and the worktree snapshot did not change in
both cases. However, the earlier observed 300-second host timeout did not
terminate the underlying delegated work. It is not yet proven that this host
sends an MCP cancellation notification when its own deadline expires, and the
currently running integration was loaded from the older installed deployment.

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

### 5. Verification toolchains are not ready by default

The sandbox deliberately clears the environment and restricts `PATH`. On this
host, Node is installed below an FNM-managed version directory and was invisible
to most delegated verification commands. This caused workers to return static
inspection instead of executable verification and moved noisy testing back to
the parent.

`OPENCODE_SANDBOX_TOOLCHAIN_DIRS` provides an explicit read-only allowlist in
current source, but requires deployment, configuration, and a positive doctor
check before it can be trusted operationally.

### 6. Timeout errors lack recovery identity

An outer timeout reports that `tools/call` expired but does not reliably provide
the OpenCode session ID, current phase, cleanup state, worktree state, or a
recovery operation. The parent must infer continued activity from later file
changes.

### 7. Narrow prompts reduce work but do not bound latency

Small validation-only packets were usually successful. Narrow implementation
packets still occasionally reached 300 seconds. Prompt narrowing is useful
routing discipline, but it is not a substitute for cancellation, isolation,
or an asynchronous execution protocol.

## Timeout design options

### Option A: short synchronous operations

Define an explicit caller budget in orchestrator configuration and make every
inner deadline fit inside it. For a confirmed 300-second outer limit, a possible
budget is:

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

The repository's installer does not currently preserve this setting when it
recreates an owned MCP registration, and the observed orchestration host may
have a separate five-minute cap. It also leaves poor recovery behavior when
transports disappear.

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

## Toolchain improvements

The installer should detect the resolved Node/npm executable directories and
offer only those exact directories as read-only sandbox toolchain mounts. It
must not mount all of NVM, FNM, or the user's home directory.

Doctor should then perform a networkless sandbox probe such as `node --version`
and report Worker and Runner toolchain readiness separately from host readiness.

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
2. Add an installer-safe way to preserve/configure Codex
   `tool_timeout_sec`, then test a call longer than five minutes through the
   freshly restarted Codex integration.
3. Verify actual Codex app/tool-host and Claude outer deadlines and
   cancellation behavior.
4. Introduce configured caller budget and reject impossible synchronous
   timeout combinations.
5. Add writer quarantine until termination is confirmed.
6. Add sandbox toolchain auto-detection and doctor probe.
7. Add provider capability doctor probe.
8. Implement asynchronous operation status/cancel for long work.
9. Isolate writable jobs and integrate patches only after acceptance.

Signed release provenance is intentionally deferred. The unsigned SPDX SBOM and
SHA-256 integrity checks remain in scope; neither is represented as an
authenticity signature.
