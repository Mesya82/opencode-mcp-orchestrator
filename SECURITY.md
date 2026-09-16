# Security

OpenCode MCP Orchestrator deliberately executes AI-selected local commands.
Its sandbox exists to reduce the consequences of a delegated agent making an
incorrect or unsafe tool decision.

It is not a general-purpose hostile-code sandbox.

## Trust model

The parent coding client is trusted.

The OpenCode runtime and the configured model/provider are trusted to
participate in the requested coding task, but delegated command execution is
treated as potentially unsafe.

Repository contents are also treated as potentially adversarial because source
files can contain prompt-injection-like instructions.

## Sandbox boundaries

The project currently uses Bubblewrap on Linux.

The intended delegated-command properties are:

### Scout

- repository is readable
- repository is not writable
- external secret locations are inaccessible
- outbound command network access is disabled

### Worker

- ordinary workspace files are writable
- `.git` metadata is read-only
- external secret locations are inaccessible
- outbound command network access is disabled

### Runner

- may execute local commands required to inspect/test/build the workspace
- `read_only` (default) uses a read-only workspace: commands cannot create
  build, cache, coverage, or other workspace files
- `writable` must be explicitly selected and uses a separate
  permission-scoped agent
- `.git` metadata remains protected
- outbound command network access is disabled by default
  (`network_access: "disabled"`); `"host"` must be explicitly selected,
  only when the exact command and repository code are trusted, and uses a
  separate permission-scoped agent plus execution tool
  (`sandbox_run_ro`, `sandbox_run`, `sandbox_run_network_ro`,
  `sandbox_run_network`)
- `workspace_access` and `network_access` are independent, giving four
  combinations (`read_only`/`writable` × `disabled`/`host`)
- host networking shares the host network namespace: broader than Internet
  access, it may reach Internet, LAN, link-local, and loopback addresses
  plus applicable namespace-scoped abstract Unix sockets, and can
  exfiltrate sandbox-visible data; read-only mode prevents writes, not
  exfiltration
- host mode adds only enumerated read-only `/etc/resolv.conf`,
  `/etc/hosts`, and CA trust source mounts; host HOME/credentials stay
  inaccessible, `--clearenv` remains in effect, and proxy variables are not
  inherited
- large command output is persisted and analyzed inside the delegated flow
  rather than copied wholesale into the parent context
- persisted Runner logs may contain command output; see
  docs/orchestration-friction.md for retention and access modes

## Provider credentials

Provider credentials required by OpenCode itself are intentionally kept outside
the delegated command sandbox.

They should never be placed:

- in task prompts
- in repository files
- in command arguments
- in environment variables deliberately exposed to delegated commands

## Git protection

Worker and Runner are not intended to perform Git-mutating operations.

Prevention: the sandbox mounts Git metadata read-only and structured tool
permissions deny Git paths, while delegated shells have no outbound network
and no host credential or home-directory access.

Detection only: Runner and worker flows also report a Git status delta
before/after execution. That report observes workspace changes; it does not
prevent writable-mode workspace edits. A caller-side timeout may leave the
delegated session running, so check Git status after any delegated
infrastructure timeout rather than assuming no edits occurred.

The bridge also blocks a second Worker or writable Runner for the same
canonical worktree until session removal is confirmed. Unconfirmed removal
quarantines that worktree in memory and makes the originating writable call
fail with an actionable quarantine error; it does not undo, merge, or approve
any partial edits. Before restarting the bridge to clear quarantine, inspect
Git status and the focused diff and verify that no orphaned session remains.

The parent coding agent remains responsible for commits, rebases, resets,
branch operations, and similar repository-state changes.

## Network isolation

Network isolation applies to delegated commands; the default is networkless.

The OpenCode process itself necessarily retains network access when using a
remote model provider.

Therefore:

    OpenCode/provider traffic      allowed
    delegated local shell traffic  blocked by default

Runner host networking (`network_access: "host"`) is an explicit
capability escalation: it shares the host network namespace and is broader
than Internet access (Internet, LAN, link-local, loopback, and applicable
namespace-scoped abstract Unix sockets), with exfiltration risk for
sandbox-visible data. Filesystem protections otherwise remain; only the
enumerated resolver/hosts/CA trust source mounts are added, with no host
HOME/credentials and no inherited proxy variables. `sandbox_shell` and the
Doctor probes remain networkless. There are no hostname allowlists or
selective egress controls.

## High-risk operations

The orchestration policy intentionally keeps operations such as deployment in
the parent agent rather than Runner.

The sandbox should not be considered authorization to delegate:

- production deployment
- destructive infrastructure changes
- credential rotation
- privilege management
- irreversible external actions

## Installer safety

Release installation uses SHA-256 verification before archive extraction.

The bootstrap also rejects:

- absolute archive paths
- `..` parent traversal
- archives with unexpected multiple top-level roots

Managed integration files are tracked by hash. Replacement cleanup and
uninstall preserve locally modified files, and a fresh installation does not
silently overwrite preserved unmanaged files.

Replacement cleanup is ownership-aware. It removes only MCP registrations
recorded as owned by this project. After cleanup, the integrations selected in
the preserved or newly configured settings are installed fresh. Unrelated MCP
registrations are left untouched.

## Limitations

This project does not claim protection against:

- vulnerabilities in the Linux kernel
- vulnerabilities in Bubblewrap
- vulnerabilities in OpenCode or the parent coding client
- malicious code exploiting allowed local binaries to escape their intended
  behavior
- a compromised model/provider runtime
- a compromised release-signing or GitHub account

Checksum verification protects against accidental corruption and mismatched
release assets. It is not equivalent to cryptographic publisher signing.

The release SPDX SBOM (`opencode-mcp-orchestrator-${VERSION}.spdx.json`) is
unsigned and is published without provenance or attestation. `SHA256SUMS`
provides SHA-256 integrity checking for the release archive; it is not
signing or provenance.

Future releases may add signed artifacts or provenance/attestation.

## Dependency audit status

As of 2026-09-12, `npm audit` reports 11 moderate, 0 high, and
0 critical findings.

- Advisory: GHSA-8988-4f7v-96qf, OpenTelemetry Core unbounded memory
  allocation in W3C Baggage propagation, affecting
  `@opentelemetry/core` <2.8.0.
- Dependency path: `@opencode/plugin` -> `@opencode/util` ->
  OpenTelemetry packages.
- `npm audit` reports `fixAvailable:false` for this dependency graph,
  so there is no available fix without changing the upstream
  dependency range.

This is recorded as a dependency availability risk, not a confirmed
exploit in this repository. No claim is made that the affected
Baggage propagation behavior is reachable or exploitable through this
repository's use of `@opencode/plugin`.

Policy for this finding:

- Do not apply forced overrides or `npm audit fix --force` to work
  around the upstream range.
- Monitor upstream `@opencode/plugin` for a release that moves past
  the affected OpenTelemetry range, then rerun `npm audit`.
- Release/CI handling: fail on high/critical findings and report
  moderate advisories where the workflow already provides an audit
  step. No workflow was changed in this task to add or enforce such a
  step; current workflows do not include an `npm audit` gate.

## Reporting a vulnerability

Please avoid publishing exploitable details in a public issue before a fix is
available.

Once the public repository is created, use GitHub private vulnerability
reporting if enabled. Otherwise contact the repository maintainer privately.
