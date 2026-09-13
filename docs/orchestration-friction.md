# Orchestration friction and runtime notes

Operational notes from remediation. Source changes alone do not update an
installed deployment; rebuild and reinstall (run the installer again) to gain
fixes. See `README.md` installation and update sections.

## Caller timeout vs bridge timeout

External MCP callers may time out a tool call after about 300 seconds. That is
a caller-side wait limit. The delegated OpenCode session can keep running after
the caller stops waiting and may still edit workspace files.

This is different from the bridge-level session timeout and cancellation in
current source. Standard and Extended timeout profiles select independent
Scout, Worker, and Runner deadlines;
`OPENCODE_MCP_ORCHESTRATOR_BRIDGE_TIMEOUT_MS` remains a global compatibility
override. The bridge timeout aborts the operation and attempts best-effort
session interrupt and removal. Caller timeouts cancel the session only when
the host sends the MCP cancellation notification; this works in the live SDK
probe but is not yet proven for the observed five-minute host boundary.

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
not a reliable live request deadline, so preflight cannot detect an
undocumented host-side ceiling such as the observed roughly five-minute wait.
Keep host-specific profiles below a separately proven host deadline.

### Writable cleanup quarantine

Worker and writable Runner calls now share a per-canonical-worktree lifecycle:

```text
free -> active -> cleaning -> free
                  |
                  +-> quarantined
```

The worktree becomes free only when `session.remove` resolves successfully
within the cleanup deadline. A removal exception or timeout quarantines the
worktree, makes the originating writable call report an actionable quarantine
error, and blocks later writable delegation. If timeout or cancellation wins
before session creation finishes, the original error retains its timeout or
cancellation detail and also reports quarantine; late creation remains
quarantined until the background reconciliation confirms removal. Scout and
read-only Runner calls do not consult writer state.

Quarantine is deliberately in-memory and has no force-clear API. Before
restarting the bridge to clear it, inspect Git status and the focused diff and
verify that no orphaned session is still changing the worktree. A removal that
finishes only after its cleanup deadline does not itself clear quarantine.

## Provider compatibility

Observed: a Console provider rejected a non-`auto` `tool_choice` request with
`invalid_request_error` (`only "auto" is supported for tool_choice`), surfaced
as a session failure.

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
default, so it may not see NVM or other user-installed Node installations.

`OPENCODE_SANDBOX_TOOLCHAIN_DIRS` is an explicit allowlist of exact absolute
toolchain `bin` directories. Entries are mounted read-only at the same absolute
path, appended to the sandbox `PATH`, and invalid entries fail closed. Example:

    OPENCODE_SANDBOX_TOOLCHAIN_DIRS="$HOME/.nvm/versions/node/<version>/bin"

The setting takes effect only after the updated plugin is deployed (reinstall
so the new sandbox plugin is installed); setting the variable without
redeploying does not change existing installations.

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
write the workspace, then report the resulting status delta.

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

## Upstream audit finding with no available fix

As of 2026-09-12, `npm audit` reports 11 moderate, 0 high, and
0 critical findings under GHSA-8988-4f7v-96qf, via
`@opencode/plugin` -> `@opencode/util` -> OpenTelemetry packages,
with `fixAvailable:false`. See `SECURITY.md` for the full status.

Operational follow-up is to monitor upstream `@opencode/plugin` and
rerun `npm audit`; do not apply forced overrides. Treat this as a
dependency availability risk, not a confirmed exploit in this
repository.
