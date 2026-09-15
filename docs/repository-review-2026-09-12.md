# Repository review — 2026-09-12

## Purpose and scope

This document restores the repository-wide review performed on 2026-09-12.
It covers the bridge runtime, delegated execution sandbox, configuration and
installer lifecycle, release pipeline, and their tests. It is separate from
the later subagent friction review in
[`subagent-usage-friction-review.md`](subagent-usage-friction-review.md).

The review assessed the repository as it existed before the v0.1.5 hardening
work. The disposition notes below record what was subsequently implemented so
the original findings remain useful without presenting repaired issues as
current defects.

## Current status

Status was reconciled against base merge commit `6bc1dfb` and the changes on
this branch on 2026-09-15.

| Finding | Current status | Remediation lineage |
| --- | --- | --- |
| Bridge lifecycle bounds | Fixed | v0.1.5-v0.1.7 and PR #4 |
| Failed client initialization recovery | Fixed | v0.1.5 |
| Blocking sandbox subprocesses | Fixed | v0.1.5 |
| Advisory-only Runner read-only mode | Fixed | v0.1.5 |
| Workspace validation and writer concurrency | Fixed | v0.1.5-v0.1.6 |
| Configuration and managed-state validation | Fixed | v0.1.5 |
| Installer filesystem defenses | Fixed | v0.1.5 |
| Required static and dependency checks | Fixed | v0.1.5 |
| Delegated sandbox toolchain availability | Fixed | v0.1.5, v0.1.8, and this branch |

All nine original findings are resolved in source. Doctor now runs separate
networkless Worker and Runner probes in disposable workspaces by default;
both real Bubblewrap probes passed locally. Installed two-worktree validation
for the subsequent session-directory fix remains a separate follow-up.

## Strengths observed

The repository already had a strong security and delivery foundation:

- Bubblewrap isolated delegated commands and stripped host credentials.
- Git metadata was mounted read-only inside delegated execution.
- Workspace paths were validated before use.
- Runner output and retained logs were bounded.
- Installation used conservative, hash-tracked managed state and atomic file
  replacement.
- Release artifacts were checksum-validated.
- Delegated agents had bounded model-step budgets with synthesis reserves.
- End-to-end coverage exercised real Codex, Claude Code, and OpenCode
  installation paths.

## Findings and disposition

### 1. Bridge operations lacked complete lifecycle bounds — fixed

The bridge did not consistently bound long-running SDK calls, propagate caller
cancellation, or interrupt and remove OpenCode sessions after failure. A
timed-out caller could therefore leave work running and could leave partial
writes in the canonical worktree.

**Risk:** high for writable Worker calls; medium for read-only calls.

**Disposition:** fixed. The bridge now applies role-specific operation
timeouts, propagates caller cancellation, performs bounded best-effort
interrupt and removal, refreshes long `session.wait()` requests, and
quarantines a writable worktree until removal is confirmed. Caller-budget
preflight rejects impossible timeout combinations before acquiring a writer
lock or creating a session. PR #4 added deterministic installed-bundle E2E
coverage for bounded wait refreshes.

### 2. Failed client initialization could poison the process — fixed

A rejected cached OpenCode client-initialization promise could be reused by
later requests, preventing recovery from a transient initialization failure.

**Risk:** medium availability risk.

**Disposition:** fixed. Rejected initialization is cleared so a subsequent
operation can retry.

### 3. Sandbox subprocess probes could block indefinitely — fixed

Synchronous command and toolchain probes did not all have finite execution
bounds. A broken executable or filesystem interaction could stall setup or a
delegated operation.

**Risk:** medium availability risk.

**Disposition:** fixed. Sandbox subprocesses have finite timeouts,
configurable resource limits, and bounded log retention.

### 4. Runner read-only mode was advisory — fixed

The Runner prompt described read-only behavior, but the same writable sandbox
mechanism remained available. Prompt compliance was carrying a security
property that should have been enforced by the runtime.

**Risk:** high integrity risk if a Runner ignored or misunderstood its prompt.

**Disposition:** fixed. Read-only and writable Runner agents use separate
permission-scoped tools. `sandbox_run_ro` mounts the workspace read-only;
`sandbox_run` is available only to the explicitly writable Runner. Model input
cannot change the mount mode.

### 5. Workspace validation and writer concurrency were too weak — fixed

Canonical-path validation, dangerous-root rejection, and concurrent writable
operation handling were incomplete. Two writers could target the same
worktree, and invalid workspace input could reach later configuration work
before failing.

**Risk:** high for worktree integrity.

**Disposition:** fixed. The bridge validates and canonicalizes the working
directory before configuration or timeout processing, rejects dangerous
locations, serializes writable work per canonical worktree, and fails closed
while termination remains uncertain.

### 6. Configuration and managed-state validation were shallow — fixed

Runtime configuration, release manifests, and installer-managed state accepted
some malformed or structurally incomplete values. Upgrade and uninstall paths
could then operate on state that had not been validated as strictly as fresh
installation input.

**Risk:** medium integrity and upgrade-reliability risk.

**Disposition:** fixed. Configuration and timeout profiles use strict
validation. Release manifests and managed state are validated before mutation,
including upgrade and uninstall compatibility for Codex timeout settings.

### 7. Installer paths needed stronger filesystem defenses — fixed

Installer and uninstaller targets needed consistent rejection of dangerous
roots, path escapes, intermediate symlinks, final symlinks, and unsafe
shell-interpolated executable discovery.

**Risk:** high when installation runs with access to user configuration.

**Disposition:** fixed. Path handling validates ownership, modes, roots,
containment, and symlink chains; executable discovery avoids shell
interpolation; installed file modes are deterministic.

### 8. Static and dependency checks were incomplete in CI — fixed

The TypeScript sandbox plugin was not covered by a required no-emit typecheck,
and the release pipeline did not enforce a high-severity dependency audit.

**Risk:** medium regression and supply-chain visibility risk.

**Disposition:** fixed. CI and release workflows run `tsc --noEmit` and
`npm audit --audit-level=high`. Release packaging generates and validates an
unsigned SPDX SBOM and publishes checksums.

### 9. Delegated sandboxes could lack the required toolchain — fixed

The security boundary intentionally exposed only a small runtime surface, but
that could leave Node, npm, or other required executables unavailable to a
Worker or Runner. The resulting infrastructure limitation could be mistaken
for a test failure.

**Risk:** medium operability risk.

**Disposition:** fixed. Trusted toolchain roots are explicit,
validated, runtime-reloaded, and exposed without mounting entire home or
version-manager directories. Canonical `/usr` discovery is supported.
Doctor now performs bounded, networkless execution probes with validated
trusted runtime mounts and separate Worker/Runner results. Fixed commands prove
writable Worker and read-only Runner workspaces without mounting the real
repository or host HOME. `--no-sandbox-probes` visibly leaves readiness
unverified. Real Bubblewrap execution and focused/full local tests passed.

## Verification of the hardening work

The remediation was accepted through:

- the build and unit/integration test suite;
- a no-emit TypeScript check for sandbox tools;
- clean-container end-to-end installation tests for Codex, Claude Code, and
  OpenCode;
- installation Doctor checks and MCP tool discovery;
- upgrade, legacy migration, and uninstall coverage;
- GitHub CI and E2E workflows.

The principal v0.1.5 hardening commits were `19c3e72` and `b93a99c`. Later
releases extended lifecycle quarantine, long-wait refresh, trusted runtime
exposure, and installed-bundle regression coverage.

## Remaining work from this review lineage

The nine original findings have source fixes. PR #5's Doctor readiness review
gate is resolved by the shared-builder work and passing clean-container
verification recorded below. Remaining work consists of ongoing regression
coverage and explicitly deferred scope:

- PR #5 review follow-up (2026-09-15): the Docker clean-container job failed
  at the required networkless Bubblewrap preflight, and Doctor independently
  reconstructed production sandbox arguments. A disposable GitHub-hosted-only
  user-namespace-policy wrapper is implemented locally with passing mocked
  success/failure/restoration tests and is wired into E2E and release workflows.
  The production/Doctor shared-builder refactor is now complete locally after
  splitting the failed Worker task into small, explicitly authorized packets.
  Both callers share mount/environment construction, runtime/toolchain checks
  and Runner output binding. Concrete argv equivalence tests cover empty and
  configured runtime/toolchain cases. Git-write checks fail immediately on a
  forbidden write through either alias; Runner output is unique and always
  cleaned up. Full build/unit/integration tests, typecheck and both real host
  probes pass. [Docker E2E on source commit `3b944e1`](https://github.com/Mesya82/opencode-mcp-orchestrator/actions/runs/34942391248)
  and [CI](https://github.com/Mesya82/opencode-mcp-orchestrator/actions/runs/34942391174)
  pass. The E2E log confirms required networkless preflight, installed Worker
  and Runner probes, `DOCTOR_HEALTHY`, and restoration of the runner's exact
  original AppArmor user-namespace setting (`1`). Both review concerns are
  resolved; installed two-worktree live testing remains a separate follow-up.

1. Continue live cancellation and installed-bundle regression coverage as the
   bridge lifecycle evolves.
2. Monitor the documented transitive OpenTelemetry advisories until an upstream
   fix is available; do not weaken the high-severity audit gate.
3. Signed provenance or artifact attestation remains intentionally deferred.
   SHA-256 checksums prove integrity after download but are not signatures.

These follow-ups should not be confused with the broader asynchronous-operation
and isolated-patch roadmap recorded in the subagent friction review.
