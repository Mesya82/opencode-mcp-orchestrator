# Orchestration friction and runtime notes

Operational notes from remediation. Source changes alone do not update an
installed deployment; rebuild and reinstall (run the installer again) to gain
fixes. See `README.md` installation and update sections.

## Caller timeout vs bridge timeout

External MCP callers may time out a tool call after about 300 seconds. That is
a caller-side wait limit. The delegated OpenCode session can keep running after
the caller stops waiting and may still edit workspace files.

This is different from the bridge-level session timeout and cancellation in
current source (`OPENCODE_MCP_ORCHESTRATOR_BRIDGE_TIMEOUT_MS`, default
20 minutes). The bridge timeout aborts the operation and attempts best-effort
session interrupt and removal. Caller timeouts do not.

After any delegated infrastructure timeout, check Git status and diff before
assuming nothing changed. Do not assume timeout means no edits.

## Provider compatibility

Observed: a Console provider rejected a non-`auto` `tool_choice` request with
`invalid_request_error` (`only "auto" is supported for tool_choice`), surfaced
as a session failure.

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
2. Treat an empty diff as possibly correct only after checking the requested
   resulting state.
3. Report the concrete timeout, what was checked, and any continued-session
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
