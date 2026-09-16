# Orchestration friction and runtime notes

Operational notes from remediation. Source changes alone do not update an
installed deployment; rebuild and reinstall (run the installer again) to gain
fixes. See `README.md` installation and update sections.

## Codex timeout vs OpenCode session wait

The observed approximately 300-second failures were not Codex MCP tool
timeouts. A fresh Codex process loaded
`mcp_servers.opencode-agents.tool_timeout_sec = 2100` and a minimal MCP tool
returned successfully after 330 seconds.

The same fresh process reproduced the failure through the real orchestrator.
OpenCode logged HTTP 499 for `POST /api/session/<id>/wait` after about 300.7
seconds. Its generated client implements that wait as one bare
`globalThis.fetch` request and wraps the response-header timeout as
`ClientError("Transport")`.

The bridge now refreshes only the wait request every 240 seconds. An intentional
refresh does not cancel the delegated session and does not extend the
bridge-level deadline. Standard and Extended profiles still select independent
Scout, Worker, and Runner deadlines;
`OPENCODE_MCP_ORCHESTRATOR_BRIDGE_TIMEOUT_MS` remains a global compatibility
override. Caller and bridge cancellation still abort the operation and trigger
best-effort interrupt/removal.

### Read-only refresh progress telemetry

After each intentional wait refresh, the bridge takes one best-effort
read-only `session.get()` sample for the same session before issuing the next
`session.wait()`. The sample never prompts, steers, queues, restarts,
recreates, interrupts, or resends anything; it only observes. It uses the
outer operation signal (never the already-aborted refresh signal), is bounded
to at most 5 seconds and never past the absolute operation deadline, and runs
sequentially between waits so it cannot materially delay the next wait. A
failed or timed-out read logs `session_progress_unavailable` with the existing
error name/code/cause diagnostics and a stable reason code, and never fails
the operation; a genuine wait failure still propagates without a progress
read. Successful reads log a
`session_progress` event carrying only safe scalar fields (`updated_at`,
`idle_at` when present, `outcome` when present, token totals, and `cost`) plus
whether the snapshot changed since the prior successful read (first read uses
`changed: null`). No prompt text, message contents, titles, agents, models,
locations, or metadata are ever logged.

After any delegated infrastructure timeout, check Git status and diff before
assuming nothing changed. Do not assume timeout means no edits.

### Configured caller-budget preflight

The bridge now rejects an operation before writer-lock acquisition, client
initialization, or session creation when its actual operation timeout plus the
40-second cleanup/result reserve does not fit within the configured parent MCP
timeout. This includes the global bridge-timeout compatibility override.
Runner commands retain their separate inner check, so the required nesting is:

```text
command timeout + 60s <= operation timeout
operation timeout + 40s <= configured parent timeout
```

This check uses configured limits. The MCP SDK supplies an `AbortSignal`, but
not a reliable live request deadline, so callers still must configure their MCP
deadline to contain the operation and reserve. The former five-minute symptom
is handled separately by refreshing OpenCode's internal session wait.

### Writable cleanup quarantine

Worker and writable Runner calls now share a per-canonical-worktree lifecycle:

```text
free -> active -> cleaning -> free
                  |
                  +-> quarantined
                  +-> preserved
```

The worktree becomes free only when `session.remove` resolves successfully
within the cleanup deadline. A removal exception or timeout quarantines the
worktree, makes the originating writable call report an actionable quarantine
error, and blocks later writable delegation. If timeout or cancellation wins
before session creation finishes, the original error retains its timeout or
cancellation detail and also reports quarantine; late creation remains
quarantined until the background reconciliation confirms removal. Scout and
read-only Runner calls do not consult writer state.

Diagnostic preservation is a strict opt-in: only
`OPENCODE_MCP_ORCHESTRATOR_PRESERVE_SESSIONS=1` enables it. When enabled,
every delegated session (Scout, Worker, and Runner in either access mode)
is retained instead of removed: a `session_preserved` event records the
session ID and outcome. Successful sessions are retained without
interruption; the session is interrupted best-effort only after
unsuccessful work, never removed. Only Worker and writable Runner
transition the worktree to the terminal `preserved` state above, which
stays blocked for later writable delegation. Retained Scout and
read-only Runner sessions never consult or update writer state, so they
neither block nor poison subsequent writable delegation. A writable timeout
before `session.create()` resolves still blocks the directory; once creation
resolves late, reconciliation attaches the session ID, interrupts exactly
once, never
removes the session, and emits `session_preserved` with
`succeeded:false`. Recovery is to verify the preserved session is no
longer executing, inspect the workspace and inspect/export the preserved
session, then restart the bridge; preserved sessions are retained as
diagnostic evidence.

Quarantine is deliberately in-memory and has no force-clear API. Before
restarting the bridge to clear it, inspect Git status and the focused diff and
verify that no orphaned session is still changing the worktree. A removal that
finishes only after its cleanup deadline does not itself clear quarantine.

## Provider compatibility

OpenCode's v2 runner removes tools on the final configured agent step and sends
`tool_choice: "none"` to force a text-only response. Console rejects that field
with `invalid_request_error` (`only "auto" is supported for tool_choice`), so a
delegated agent that exhausted its model steps could finish its edits but fail
before returning the final report.

The installed plugin now intercepts only primary provider requests for
`opencode-orchestrator-*` agents using `opencode/muse-spark-*`. When the wire
body requests `none` and its tools are absent or empty, the plugin removes the
unsupported field. Console then uses its `auto` default, but no tool can be
called because OpenCode already removed the tool definitions. Requests with
remaining tools or an unfamiliar shape are left untouched and fail closed.
The hard step limit and provider/session failure propagation remain intact.

On 2026-09-13, Muse Spark through OpenCode Console/Zen also rejected continued
tool-using sessions with `reasoning encrypted_content was not issued to this
caller` ([upstream issue #48741](https://github.com/anomalyco/opencode/issues/48741)).
The upstream failure occurs when encrypted reasoning returned by one
Console caller is replayed to a different upstream caller. The installed
orchestrator plugin now removes reasoning parts only from subsequent context
requests for `opencode-orchestrator-*` agents using `opencode/muse-spark-*`.
Visible assistant text, tool calls, and tool results remain intact. Other
agents, providers, and models are not modified, and there is no automatic model
or paid-provider fallback.

After installing the rebuilt plugin with the active Extended configuration, a
live Worker probe completed separate file reads, an isolated shell command, and
final synthesis with `LIVE_WORKER_ENCRYPTED_REASONING_FIX_PASS`.

### Tracked upstream issue: Muse encrypted reasoning replay

- Issue: [anomalyco/opencode#48741](https://github.com/anomalyco/opencode/issues/48741),
  `Opencode Zen critical errors on Muse Spark family when model recieves a
  image/does a tool call`.
- Status checked: open on 2026-09-13.
- Affected orchestrator path: multi-step `opencode/muse-spark-*` Scout, Worker,
  or Runner sessions after a reasoning response is followed by tool use.
- Observed local error: `invalid_request_error` with
  `reasoning encrypted_content was not issued to this caller`.
- Local mitigation: strip hidden reasoning parts only from subsequent
  orchestrator-owned Muse context requests; retain visible text and tool
  history; never fall back to another model or paid API.
- Tracking action: recheck the issue and run the live Worker probe when
  upgrading OpenCode or changing the Muse model route.
- Removal criteria: upstream confirms a fix, the installed OpenCode version
  contains it, and the live multi-tool Worker regression passes with the hook
  disabled. Do not remove the workaround based only on an issue closure.

Verify that the selected provider and OpenCode version are compatible. Do not
silently fall back to another model or retry the same broad prompt without
narrowing it.

## Sandbox toolchains

The delegated sandbox exposes only the workspace and safe system paths by
default. Inherited PATH entries are canonicalized on every sandbox invocation;
only entries resolving beneath the already mounted `/usr` tree are retained
automatically. This makes trusted version-manager aliases into `/usr` visible
without exposing `/run` or arbitrary home directories.

Other installations are declared through the tool-agnostic `sandboxRuntime`
configuration. A declaration separates the read-only installation `root` from
its relative `pathEntries` and optional path-valued `environment`. The plugin
reloads configuration for every invocation and verifies that canonical PATH
and environment targets remain contained within their root. Broad system
roots, pseudo-filesystems, Git metadata, the home root, and common credential
directories fail closed. No model-controlled input can add a mount or an
environment variable.

`OPENCODE_SANDBOX_TOOLCHAIN_DIRS` remains an additive compatibility input. It
does not replace file-backed runtime configuration.

## Worker verification shell limit

`sandbox_shell` worker commands default to a 120-second limit, configurable with `OPENCODE_SANDBOX_SHELL_TIMEOUT_MS` from 1000 to 900000 ms. A command that
exceeds it is killed and reported with `timed_out=true`.

Split long verification into smaller commands, or use Runner with an explicit
per-command timeout for noisy or long-running checks.

## Runner access modes

Runner `workspace_access` defaults to `read_only`. Select `"writable"` explicitly
only when the command must write the workspace. Each mode delegates to a
separate permission-scoped agent, so enforcement comes from the selected agent,
not from the task text.

Read-only Runner commands cannot create build, cache, coverage, or other
workspace files; only the host output directory and sandbox `/tmp` stay
writable. Use writable mode when the requested command legitimately needs to
write the workspace, then report the resulting status delta. Network access
is likewise explicit: `network_access` defaults to `disabled` and is
independent of `workspace_access`, giving four agent/tool combinations;
request `"host"` only as explicit escalation for a trusted command.

## Runner log retention

Runner command output is persisted on the host outside model context for
follow-up inspection with `sandbox_log`:

- combined-log cap: 128 MB per run (additional output is marked truncated)
- retention: up to 20 most-recent runs from the last 24 hours
- storage root is created mode `0700`
- persisted logs may contain command output, including whatever the command
  printed; do not assume logs are free of repository or diagnostic content

## After a timeout

1. Check `git status` and the focused diff for the delegated worktree.
2. If writable delegation reports quarantine, verify that no orphaned session
   remains before restarting the bridge; restart is the recovery boundary.
3. Treat an empty diff as possibly correct only after checking the requested
   resulting state.
4. Report the concrete timeout, what was checked, and any continued-session
   edits found.

## Delegated-agent incidents observed 2026-09-15

Current status on 2026-09-15: incident 1 is diagnosed but its activation
lifecycle is not fixed. Incidents 2 and 3 are fixed in source and covered by
focused and full local tests; installed two-worktree validation remains
pending. Doctor probes pass focused/full local tests and real Bubblewrap
execution. The broad container E2E was stopped after an external OpenCode
download stalled; it did not reach the installed Doctor checks.
The first GitHub Docker E2E then failed closed because Docker's default
namespace/security profile denied nested Bubblewrap. Disposable-container
probes showed `--cap-add SYS_ADMIN` makes bwrap fail with `Unexpected
capabilities but not setuid`, while no capability with default masked system
paths fails on the proc mount. The Podman launcher passes with
`--security-opt seccomp=unconfined --security-opt systempaths=unconfined
--security-opt label=disable` and no capability or privileged flag; the
Docker launcher drops `--cap-add SYS_ADMIN`, retains unconfined
seccomp/AppArmor, and adds `systempaths=unconfined`, pending CI. Runtime
probes still use `--unshare-net` and are never skipped.
Incidents 2 and 3 shared the same plugin-init worktree-capture defect but have
distinct effects and regression assertions.

### 1. Stale OpenCode service bypassed the Muse final-step hook

Confirmed fact: worker session `ses_f5ebd0ffdffeyzhQFrnTVyZh12` failed on
2026-09-14T19:08:29Z with Console `invalid_request_error`: only `"auto"` is
supported for `tool_choice`. It left partial edits; a materially narrower
retry later succeeded.

Confirmed fact: the repository hook `omitUnsupportedMuseFinalToolChoice` in
`opencode/plugins/sandbox-tools/index.ts` strips literal `tool_choice:"none"`
only for primary `opencode-orchestrator-*` sessions using providerID
`opencode` and model id prefix `muse-spark-`, with tools absent or `[]`. The
current installed plugin contains the hook, and the current worker model is
`opencode/muse-spark-1.3-contributor-free` (variant low, Extended 48 steps).

Confirmed fact: the installed plugin hash equals the current installed bundle
hash and contains the hook. The OpenCode service run `e57c2ef2` started
2026-09-11T13:36:22Z; the compatibility hook was installed/reinstalled later
(installed plugin mtime 2026-09-14T16:49:05Z). The incident occurred under the
same long-lived run `e57c2ef2`. `opencode.log` contains zero
`opencode_orchestrator_muse_final_tool_choice_omitted` events.

Diagnosis: confirmed operational stale-process/load issue — the long-lived
OpenCode service did not reload the installed compatibility hook. This is not
current source drift or a model-predicate mismatch. No open design question
on cause.

Why a successful update did not prevent it: `install-opencode.mjs` atomically
replaces managed plugin files, and `setup.mjs` subsequently runs Doctor, but
neither component reloads or restarts the already-running OpenCode background
service. Doctor checks that the plugin exists on disk; it does not prove that
the running service loaded that generation. The installed OpenCode CLI exposes
`opencode2 service restart`, but the orchestrator update path never invokes it
or emits a mandatory restart result. The update therefore succeeded on disk
while the September 11 service continued running its older in-memory plugin.

Impact: a delegated agent that exhausted its model steps could complete edits
but fail before returning its final report.

Immediate recovery: restart/reload the OpenCode service after install/update
so the installed hook is loaded; then retry with a narrowed task if needed.

Required correction: installer/setup must explicitly require activation after
updating the OpenCode plugin. Because an automatic restart can interrupt active
sessions and leave writable work quarantined, the safe default is an explicit
`OPENCODE_RESTART_REQUIRED` result with the supported
`opencode2 service restart` command; interactive setup may offer that restart
only after confirmation. Doctor must detect/report stale loaded state rather
than treating file presence as runtime readiness. Keep the current hook until
upstream issue #48741 is fixed and a disabled-hook live regression passes.

Regression coverage: test install/update followed by service reload and a
live exhaustion/final-synthesis probe; assert the omit event and successful
final text. Never log request bodies or auth.

Removal/recheck criteria: same as the tracked upstream issue — upstream
confirms a fix, the installed OpenCode version contains it, and the live
multi-tool Worker regression passes with the hook disabled.

### 2. Worker verification mounted the wrong worktree — source fixed

Confirmed fact: the requested cwd was
`/home/Messier82/opencode-mcp-orchestrator-diagnostics/model-variants-worktree`.
Structured Worker edits landed there. `sandbox_shell` saw `/workspace` from
the OpenCode server's startup project/main copy and could not see the edited
files.

Diagnosis (from scout): `bridge/server.mjs` correctly passes
`session.create({location:{directory}})`, so native structured editing follows
the session location. `opencode/plugins/sandbox-tools/index.ts` `setup(ctx)`
computes `configuredRoot` from `ctx.location` and captures
`const worktree=realpathSync(configuredRoot)` once per plugin-process
initialization. `sandbox_shell` later calls
`baseSandboxArgs(capturedWorktree,"/workspace")`, so it ignores the delegated
session directory.

Impact: a Worker may falsely report tests were run against its changes, or
truthfully report files missing; writable commands can target the wrong
checkout.

Resolved implementation path (verified repository/dependency API, not yet
landed): `@opencode/plugin` and `@opencode/client` are
`0.0.0-beta-19425`. The tool execute signature is
`execute(input, context)`, where `context.sessionID` is defined by
`node_modules/@opencode/schema/dist/tool.d.ts` and the
`@opencode/plugin` `ToolContext`. Setup `ctx` exposes
`ctx.session.get({ sessionID })`, and `SessionInfo.location.directory`
is the per-session directory. `ToolEditor` has no dynamic
workspace/root callback, and the current
`sandbox_shell`/`sandbox_run`/`sandbox_run_ro` execute callbacks ignore
their second argument. The resolved per-call path is therefore:
require non-empty `context.sessionID` in `execute(input, context)`;
`await ctx.session.get({ sessionID })`; require
`location.directory`; canonicalize it and require a directory; then
pass that canonical root to `baseSandboxArgs`. Never fall back to the
setup-time root.

Implementation status: the plugin now resolves the canonical worktree per
executing session/tool call via the path above instead of capturing the
startup worktree. The resulting root is passed to `baseSandboxArgs`, and the
reported `sandbox_root` reflects that root. It fails closed: missing
session identity/location, session lookup failure, or an
invalid/non-directory path must abort before `bwrap`/Git and emit a
bounded message without exposing absolute host paths. Do not cache the
directory because `session.move` can change the session location.

Immediate recovery: verify edits and run checks in the requested checkout via
host-side commands until the plugin fix lands; do not trust `sandbox_shell`
file visibility as proof of the requested worktree state.

Regression coverage: unit tests resolve distinct A/B sessions, accept bare and
wrapped session responses, fail closed without path leakage, re-resolve a
moved session without caching, and invoke the registered `sandbox_shell` tool
twice to assert that each call mounts its own session worktree. The full local
build, unit/integration suite, and TypeScript check pass. An installed
two-worktree live regression must still confirm
`ctx.session.get` sees the calling session's updated location and
determine whether `SessionInfo.subpath` affects sandbox cwd; this is a
narrow remaining check and does not make the root cause uncertain.

Removal/recheck criteria: remove this note only after the per-session fix
lands and the two-worktree `sandbox_shell` sentinel regression passes.

### 3. Runner verification and Git status used the wrong worktree — source fixed

Confirmed fact: a Runner given the same alternate cwd ran
`node --test tests/unit/sandbox-probes.test.mjs` and failed
`Could not find...` though the file existed there. The Runner reported
repository status unchanged.

Diagnosis: the same captured startup worktree feeds `executeSandboxRun`,
`resolveSandboxCwd`, `buildSandboxRunArgv`, and both `gitStatus` calls.
Therefore `/workspace`, the command cwd, before/after status, and the status
delta all refer to the stale checkout.

Impact: tests execute against the wrong source and
`worktree_status_changed`/delta can be false.

Resolved implementation path: the same per-call resolver as incident 2
feeds `executeSandboxRun`, so `resolveSandboxCwd`,
`buildSandboxRunArgv`, and both `gitStatus` calls all use the
per-session root derived from `context.sessionID` via
`ctx.session.get({ sessionID })` and canonicalized
`location.directory`.

Implementation status: the per-session canonical worktree is now threaded into
`sandbox_run`/`sandbox_run_ro` and Git status collection via that resolver.
Missing session identity/location, session
lookup failure, or an invalid/non-directory path must abort before
`bwrap`/Git and emit a bounded message without exposing absolute host
paths. Do not cache the directory because `session.move` can change the
session location.

Immediate recovery: run the requested tests and `git status`/diff in the
requested checkout via host-side commands until the plugin fix lands; do not
trust Runner cwd or status-delta output for worktree selection.

Regression coverage: the registered read-only and writable Runner tools are
invoked with different session IDs. Tests assert read-only versus writable
mounts for the correct session root and assert that a change made only in the
second worktree appears in that Runner's Git status delta. The full local
build, unit/integration suite, and TypeScript check pass. An installed
two-worktree live test must still confirm the updated session location and
`SessionInfo.subpath` behavior; this is narrow remaining validation and does
not make the source diagnosis or fix uncertain.

Removal/recheck criteria: remove this note only after the per-session fix
lands and the two-worktree sandbox-run/Git-status regression passes.

## 2026-09-15 — PR #5 review fixes: partial Worker handoff

The review identified two separate issues: Docker E2E fails before installed
Doctor probes execute (`loopback: Failed RTM_NEWADDR: Operation not permitted`),
and Doctor's independently constructed sandbox can drift from production.

Docker diagnosis: Ubuntu's host AppArmor user-namespace policy is a plausible
remaining restriction despite the container's `apparmor=unconfined` setting.
See the analogous [sandbox-runtime report](https://github.com/anthropics/sandbox-runtime/issues/74).
This explanation remains to be confirmed by a new GitHub run. A Worker created
`tests/e2e/github-userns.sh` and mocked regression tests in an isolated scratch
directory. Root integrated them and tightened explicit missing-key detection
and signal restoration. The wrapper refuses outside disposable GitHub-hosted
runners, temporarily adjusts only the user-namespace sysctl for the entire E2E
command, and restores/verifies the exact prior value. Local wrapper tests and
shell syntax pass. No local host policy was changed. Networkless preflight and
Doctor probes remain mandatory; no capabilities, privileged container or skip
was added. The new Docker run has not occurred and these changes are unpushed.

Shared-builder Worker failures:

- First session `ses_f5c567bb6ffehSXSDSTwbCpMty` created the shared `.mjs`
  builder/declarations and partial production/Doctor wiring, then failed with
  provider Console `invalid_request_error`: only `auto` is supported for
  `tool_choice`; `none`, `required`, and named choices are unsupported.
- One materially narrower retry, `ses_f5c4c5767ffeaiQeN714FFaAzp`, completed
  more probe wiring but failed with the same final-step error. No further
  retry or silent direct implementation was performed.
- Runner's verification-boundary check could not see the new shared module;
  its `/workspace` result was not accepted as evidence for this worktree.

Root checked the preserved partial patch in the requested worktree:
`npm run typecheck`, `git diff --check`, wrapper tests and wrapper syntax pass.
`npm test` fails at `tests/unit/sandbox-probes.test.mjs`; direct focused execution
reports 6 passing and 5 failing cases. Failures include missing Git-protection
overlays in old fixtures, changed command-tail layout and safe PATH expectations,
and probe invariant rejection before the mocked spawn/failure path. Required
production/Doctor equivalence tests have not been added. The draft Git-write
checks using `write && exit 1 || true` can swallow a successful forbidden write
and must be corrected, not merely accommodated by changed test expectations.

Handoff: shared-builder changes remain uncommitted and unpushed. Complete the
refactor and equivalence tests, exercise real Worker/Runner probes with Git and
both workspace aliases protected, then push and require green CI/Docker E2E.
Provider/profile recovery or explicit root takeover is needed before resuming
implementation after the failed narrower retry.

### Recovery with smaller prompts

The user explicitly requested another prompt after the narrower retry failed.
Four small Worker packets subsequently returned successfully without changing
model or configured limits: (1) fixed Git-write checks plus focused regressions,
(2) real existence checks and old test expectation migration, (3) unique Runner
output lifecycle and exact output-bind validation, and (4) tests-only concrete
production/Doctor argument equivalence. Verification shells still used another
checkout, so their unavailable test results were not accepted. Root executed
acceptance checks in the requested worktree: full build/unit/integration suite,
typecheck, focused equivalence/Git/output tests and real provider-free Worker
and Runner host probes all pass. Root also removed an unused draft helper.

The prior partial-patch handoff above is historical, not the current source
status. [Docker clean-container E2E on `3b944e1`](https://github.com/Mesya82/opencode-mcp-orchestrator/actions/runs/34942391248)
and [CI](https://github.com/Mesya82/opencode-mcp-orchestrator/actions/runs/34942391174)
pass. The required networkless preflight and installed Worker/Runner probes
all execute successfully with `DOCTOR_HEALTHY`. The log shows the disposable
runner's AppArmor user-namespace setting changed from `1` to `0` for E2E and
restored/verified as `1` afterwards. This confirms the CI-only policy remedy;
the Docker launcher and production network isolation were not weakened.
The review gate is resolved. Installed two-worktree live testing remains a
separate follow-up, not evidence supplied by this provider-free E2E.

## Runner host networking (resolved design)

`network_access` defaults to `disabled` and is independent of
`workspace_access` (four permission-scoped agent/tool combinations).
Doctor probes and `sandbox_shell` stay networkless; host mode only removes
the network namespace while keeping `--clearenv`, filesystem protections,
and enumerated read-only resolver/hosts/CA trust mounts. Treat `"host"`
as explicit capability escalation with egress/exfiltration scope, never as
an automatic retry for networkless failures.

## Upstream audit finding with no available fix

As of 2026-09-12, `npm audit` reports 11 moderate, 0 high, and
0 critical findings under GHSA-8988-4f7v-96qf, via
`@opencode/plugin` -> `@opencode/util` -> OpenTelemetry packages,
with `fixAvailable:false`. See `SECURITY.md` for the full status.

Operational follow-up is to monitor upstream `@opencode/plugin` and
rerun `npm audit`; do not apply forced overrides. Treat this as a
dependency availability risk, not a confirmed exploit in this
repository.
