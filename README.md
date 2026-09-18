# OpenCode MCP Orchestrator

OpenCode MCP Orchestrator adds sandboxed delegated coding agents to MCP-capable
coding assistants.

It uses OpenCode as the delegated-agent runtime and exposes three focused MCP
tools:

- `scout` - read-only repository investigation
- `worker` - bounded repository implementation
- `runner` - noisy command execution and output analysis

The parent coding agent remains responsible for architecture, integration,
high-risk operations, and final decisions.

## Why

Large coding agents are often capable of delegating work, but delegation can
become expensive when the parent model repeatedly reads repository files,
large build logs, test output, and implementation details.

This project moves suitable work into cheaper or otherwise independently
selected OpenCode models while returning concise results to the parent agent.

Typical uses include:

- locating code paths and tracing behavior
- implementing bounded changes
- running tests, builds, linters, and other noisy commands
- extracting relevant errors from large logs

## Architecture

    Codex / Claude Code / other MCP client
                     |
                     v
             MCP orchestrator
                     |
           +---------+---------+
           |         |         |
         scout     worker    runner
           |         |         |
           +---- OpenCode -----+
                     |
            user-selected models

Model selection is independent for each role.

The project does not hardcode Muse, OpenCode Go, or any other provider.
Available choices are discovered from the user's OpenCode installation.

## Current client integrations

- OpenAI Codex CLI
- Claude Code

The core MCP server is client-agnostic, so other MCP-capable coding clients can
be added without changing the delegated-agent architecture.

## Requirements

Linux is currently required.

Runtime requirements:

- Node.js 20 or newer
- OpenCode
- Bubblewrap at the exact production path `/usr/bin/bwrap` (version >=0.12.0; GHSA-pxhw-h44j-8pfx affects <0.12.0)
- Git at the exact launcher path `/usr/bin/git`
- Exact launcher paths `/usr/bin/bash` and `/usr/bin/python3` (production
  launches these absolute paths; a `PATH` substitute does not satisfy the
  check; each must exist, be executable, and not be a directory; inside the
  sandbox `/usr` is ro-bound with `usr/bin` mapped to `/bin`, so production
  `/bin/bash` uses host `/usr/bin/bash`)

For the corresponding parent integrations:

- Codex CLI, optional
- Claude Code, optional

npm is not required on machines installing a release. Runtime JavaScript
dependencies are bundled into the release artifacts.

## Installation

Install the latest GitHub release with:

    curl -fsSL https://github.com/Mesya82/opencode-mcp-orchestrator/releases/latest/download/install.sh | bash

The bootstrap installer:

1. downloads `SHA256SUMS`
2. downloads the release archive
3. verifies the SHA-256 checksum
4. validates archive paths
5. extracts the verified archive
6. launches the interactive installer

The interactive installer then:

1. checks prerequisites
2. detects and removes an existing project-owned installation, if present,
   while preserving user configuration
3. installs the requested release as a fresh core payload
4. discovers models and model-specific variants available through OpenCode
5. lets the user choose models, optional variants, and a step-limit profile
6. detects supported parent coding clients
7. lets the user select integrations
8. renders and installs the OpenCode agents plus sandbox plugin
9. installs MCP and skill integrations for the requested configuration
10. runs the installation doctor

## Model selection

Scout, Worker, and Runner may use the same model or different models. Each role
may also choose its own OpenCode model variant, even when multiple roles use the
same model.

The selector reads the user's actual OpenCode model catalog instead of
maintaining a project-specific list. When OpenCode exposes structured variant
metadata, the installer offers exactly those variants plus `Default`. Choosing
`Default`, or omitting a role from `modelVariants`, leaves variant/reasoning
selection to OpenCode. Existing configurations without `modelVariants` remain
valid and keep the historical default behavior.

Configuration is stored at:

    ${XDG_CONFIG_HOME:-~/.config}/opencode-mcp-orchestrator/config.json

Example:

    {
      "version": 1,
      "models": {
        "scout": "provider/model-a",
        "worker": "provider/model-b",
        "runner": "provider/model-c"
      },
      "modelVariants": {
        "scout": "low",
        "worker": "low",
        "runner": "minimal"
      },
      "stepLimits": {
        "profile": "standard"
      },
      "timeoutLimits": {
        "profile": "standard"
      },
      "integrations": [
        "codex",
        "claude"
      ]
    }

Variant IDs are model-specific and discovered from OpenCode. The example names
above are illustrative, not a project-maintained compatibility list. See
`docs/model-variants.md` for discovery, fallback, and backward-compatibility
details.

## Step-limit profiles

The installer configures the maximum number of model steps available to each
delegated role. A model step is one agent iteration and may contain several
parallel tool calls.

Three profiles are available:

| Profile | Scout | Worker | Runner | Intended use |
| --- | ---: | ---: | ---: | --- |
| Standard | 16 | 32 | 40 | Raised defaults for normal focused delegation |
| Extended | 32 | 48 | 64 | Broad investigations and tool-heavy models such as Muse |
| Custom | User-selected | User-selected | User-selected | Explicit per-role control from 4 through 256 steps |

Each generated agent prompt states its actual limit and reserves the final 20%
of the budget, with a minimum of two steps, for synthesis. OpenCode's final
configured step is text-only, so the reserve reduces the chance that a model
reaches provider-incompatible forced termination without returning a report.

Configurations created by older releases do not need manual migration. If
`stepLimits` is absent, setup uses the new Standard profile. Running the
installer again lets interactive users select another profile and regenerates
the managed OpenCode agent definitions from that setting.

A non-interactive custom configuration uses:

    {
      "stepLimits": {
        "profile": "custom",
        "scout": 24,
        "worker": 40,
        "runner": 48
      }
    }

## Timeout profiles

Wall-clock timeouts are independent from model-step limits. The installer
selects both profiles together by default, while allowing either to be changed
independently.

| Profile | Scout | Worker | Runner | Codex parent | Intended use |
| --- | ---: | ---: | ---: | ---: | --- |
| Standard | 300s | 600s | 1,200s | 1,500s | Focused delegation |
| Extended | 900s | 1,500s | 1,800s | 2,100s | Muse and tool-heavy work |
| Custom | User-selected | User-selected | User-selected | User-selected | Explicit per-role and parent control |

The parent timeout must be at least 60 seconds longer than every role timeout.
Runner command timeouts must leave at least 60 seconds inside the Runner
operation deadline for analysis, synthesis, and cleanup. Impossible
combinations fail before an OpenCode session is created.

The bridge also enforces a configured caller-budget preflight on every
operation: the actual operation timeout (including
`OPENCODE_MCP_ORCHESTRATOR_BRIDGE_TIMEOUT_MS` or a test `timeoutMs`
override) plus a 40-second cleanup and result reserve (30 seconds cleanup,
10 seconds result) must fit within the configured parent timeout. The
check runs before writer-lock acquisition and before any session or client
work, and its error names the concrete operation, caller budget, and
reserve without echoing prompts or config secrets. It enforces only the
configured parent budget; the SDK context exposes an MCP request
`AbortSignal` but no reliable live host deadline.

The OpenCode client implements `session.wait()` as a response-header long
poll. The bridge refreshes only that HTTP wait request every 240 seconds so
Node/Undici's approximately 300-second response-header boundary cannot mask a
still-running session as `Transport`. Refreshes do not interrupt the OpenCode
session or reset the operation deadline. A failure before the refresh timer, or
after caller/operation cancellation, remains a real error and is not retried.

Writable work is fail-closed per canonical worktree with states
`active`, `cleaning`, `quarantined`, and `preserved`. A second worker or writable
runner cannot start while any of those states is present. The state moves
through `cleaning` on success, error, timeout, or cancellation, and is
cleared only after `session.remove` is confirmed within the cleanup
deadline. A throw or timeout during removal quarantines the directory with
an actionable restart-and-verify error on the originating writable call. A
timeout or cancellation before
session creation also quarantines until late-session reconciliation
confirms removal, at which point it may clear. Quarantine is in-memory
and clears on process restart; there is no force-clear API in this batch.
Scout and read-only runner paths never consult writer state.

Diagnostic preservation is a strict opt-in: only
`OPENCODE_MCP_ORCHESTRATOR_PRESERVE_SESSIONS=1` enables it. When enabled,
every delegated session (Scout, Worker, and Runner in either access mode)
is retained instead of removed, and a `session_preserved` event records the
session ID and outcome. Successful sessions are retained without
interruption; unsuccessful sessions are interrupted best-effort before
retention. Only Worker and writable Runner transition the worktree to the
`preserved` state: the directory stays blocked for subsequent writable
delegation. Retained Scout and read-only Runner sessions never touch
writer state, so they neither block nor poison later writable work.
A writable timeout before
`session.create()` resolves still blocks the directory; once creation
resolves late, reconciliation attaches the session ID, interrupts exactly
once, never removes the session, and emits `session_preserved` with
`succeeded:false`. Recovery is to verify the preserved session is no
longer executing, inspect the workspace and inspect/export the preserved
session, then restart the bridge; preserved sessions are retained as
diagnostic evidence.

When Codex integration is selected, installation writes the profile's parent
deadline to `mcp_servers.opencode-agents.tool_timeout_sec` in Codex
`config.toml`. An existing Extended step profile without `timeoutLimits`
automatically receives the Extended timeout defaults; other older
configurations receive Standard defaults.

A non-interactive custom timeout configuration uses:

    {
      "timeoutLimits": {
        "profile": "custom",
        "scout": 600,
        "worker": 1200,
        "runner": 1800,
        "parent": 2100
      }
    }

`OPENCODE_MCP_ORCHESTRATOR_BRIDGE_TIMEOUT_MS` remains available as a
deployment-wide compatibility override. When set, it replaces the configured
per-role operation deadline and is validated against the existing 1-second to
1-hour bounds.

## Installed layout

The installed release uses an XDG data directory:

    ${XDG_DATA_HOME:-~/.local/share}/opencode-mcp-orchestrator/
    ├── current/
    │   ├── libexec/
    │   ├── opencode/
    │   ├── skills/
    │   └── manifest.json
    └── install-manifest.json

`current/` is a real directory containing the single installed release payload.
Parent integrations reference this stable path.

Installing another release replaces the existing project-owned installation
rather than retaining multiple local versions.

User configuration lives separately under the XDG config directory and is
preserved across replacement installs.

## Updating or installing another version

Run the normal installer again to install the latest release:

    curl -fsSL https://github.com/Mesya82/opencode-mcp-orchestrator/releases/latest/download/install.sh | bash

The requested release is downloaded, checksum-verified, validated, and
extracted before the existing installation is changed.

If an installation already exists, its project-owned payload and integrations
are removed while user configuration is preserved. The requested release is
then installed fresh.

The same mechanism can install an older release. For example:

    curl -fsSL https://github.com/Mesya82/opencode-mcp-orchestrator/releases/download/v0.1.2/install.sh | bash

There is no local version archive or version manager. GitHub Releases provide
the version archive, and running a release's installer makes that release the
single locally installed version.

## OpenCode integration

The installer adds:

    ~/.config/opencode/agents/opencode-orchestrator-scout.md
    ~/.config/opencode/agents/opencode-orchestrator-worker.md
    ~/.config/opencode/agents/opencode-orchestrator-worker-container.md
    ~/.config/opencode/agents/opencode-orchestrator-worker-container-readonly.md
    ~/.config/opencode/agents/opencode-orchestrator-runner.md
    ~/.config/opencode/agents/opencode-orchestrator-runner-writable.md
    ~/.config/opencode/agents/opencode-orchestrator-runner-network.md
    ~/.config/opencode/agents/opencode-orchestrator-runner-writable-network.md

    ~/.config/opencode/plugins/opencode-mcp-orchestrator/index.ts

Equivalent XDG paths are used when `XDG_CONFIG_HOME` is set.

For orchestrator-owned sessions using OpenCode Console/Zen Muse Spark models,
the plugin omits hidden reasoning parts from subsequent provider requests. This
avoids replaying caller-bound encrypted reasoning state that Console may reject
after tool use. On the final configured agent step, after OpenCode has removed
all tools, the plugin also omits the unsupported `tool_choice: "none"` field so
Console can use its `auto` default and return the text-only final report. The
absence of tools preserves the hard step boundary. Visible text and tool
history are retained. Both workarounds are scoped to `opencode-orchestrator-*`
agents with `opencode/muse-spark-*`; they do not alter ordinary OpenCode
sessions or silently select another provider.
The upstream defect is tracked as
[anomalyco/opencode#48741](https://github.com/anomalyco/opencode/issues/48741);
see `docs/orchestration-friction.md` for status, validation, and workaround
removal criteria.

## Codex integration

The installer:

- registers the MCP server as `opencode-agents`
- installs the `orchestrate` skill under the user's agent skills directory

The MCP registration points at the stable `current/libexec/mcp-server.mjs`
path.

## Claude Code integration

The installer:

- registers `opencode-agents` as a user-scoped stdio MCP server
- installs the `orchestrate` skill as a personal Claude Code skill

The registration is therefore available across Claude projects.

## Integration desired state

The selected integration set describes the desired resulting state.

On a later setup run:

- selected integrations are installed or refreshed
- already-selected integrations are safe to reinstall
- integrations previously managed by this project but now deselected are announced
  before removal
- only MCP registrations and skills owned by this project are removed
- locally modified managed skill files are preserved rather than deleted

For example, changing from Codex + Claude Code to Claude Code only removes this
project's Codex MCP registration and managed Codex skill. It does not uninstall
Codex itself or touch unrelated Codex configuration.

Running setup again for the currently active release reuses that release's core
payload and reconciles the requested integrations instead of failing because the
version directory already exists.

## Delegated roles

### Scout

Scout is intended for broad but read-only repository investigation.

It is useful for questions such as:

- where is a behavior implemented?
- which functions participate in this flow?
- where is a value parsed or transformed?
- what exact code path leads to this operation?

It cannot modify the repository.

### Worker

Worker performs bounded implementation tasks.

Its sandbox permits normal workspace edits but protects Git metadata and blocks
access to files outside the allowed workspace.

The worker must not perform Git-mutating operations.

Worker also supports an optional parent-selected existing-container execution
mode for projects whose build/test toolchain already lives in a running
development container. No named profile is required:

    worker({
      cwd: "/home/me/project",
      task: "Implement and verify ...",
      execution: {
        kind: "existing_container",
        container: "dev-box"
      }
    })

The default remains the existing isolated sandbox. For
`kind: "existing_container"`, `workspace_access` defaults to `"writable"`,
`container_cwd` defaults to `"auto"`, and `network_access` is accurately
reported as `"inherit"`. The bridge binds the selected container to the
OpenCode session before prompting the Worker. The model-visible
`container_run` tool accepts only an argv array, optional absolute workdir, and
timeout; it has no container/runtime/network selector and does not expose
Podman/Docker binaries or sockets as general-purpose tools.

Full command output is persisted in the same bounded run-log store used by
Runner and can be inspected with `sandbox_log`. Existing containers are not
sandboxes created by this project: they retain whatever mounts, devices,
credentials, services, and network access they already have. Generic admission
checks reject clearly unsafe cases such as privileged containers, host-PID
containers, writable host-root mounts, and mounted container-runtime sockets.
The parent remains responsible for selecting an appropriate existing
development container. `workspace_access` describes intended project mutation
semantics; it cannot remove unrelated capabilities from a pre-existing
container.

### Runner

Runner executes noisy local commands and analyzes their output.

Examples:

- test suites
- builds
- linters
- type checking
- local application commands
- log inspection

The parent receives a concise analysis rather than the entire command output.

Runner `workspace_access` defaults to `read_only`; request `"writable"`
explicitly when the command must write the workspace. Runner
`network_access` defaults to `disabled`; request `"host"` explicitly only
when the exact command and repository code are trusted to use host
networking. The two modes are independent, giving four combinations
(`read_only`/`writable` × `disabled`/`host`), each enforced by a separate
permission-scoped agent and execution tool (`sandbox_run_ro`,
`sandbox_run`, `sandbox_run_network_ro`, `sandbox_run_network`).

Host networking shares the host network namespace, which is broader than
Internet access: it may reach the Internet, LAN, link-local, and loopback
addresses, plus applicable namespace-scoped abstract Unix sockets, and can
exfiltrate sandbox-visible data. Read-only mode prevents workspace writes
but does not prevent exfiltration. Host mode adds only enumerated
read-only mounts for `/etc/resolv.conf`, `/etc/hosts`, and a CA trust
source; it does not expose host HOME, host credential files, or inherited
credential environment variables, `--clearenv` remains in effect, and proxy
variables are not inherited. Reachable host-network endpoints may themselves
expose sensitive data or credentials depending on host configuration.
Host-mode construction
fails closed unless both a validated resolver configuration and a CA trust
source are available. `sandbox_shell` and the Doctor probes remain
networkless. The Runner tool schema is
`cwd`, `command`, `objective`, plus existing optional `expected`,
`timeout_seconds`, `workspace_access`, and `network_access`. Details and log
retention are in docs/orchestration-friction.md.

Deployments and similarly high-risk operations are intentionally not delegated
by the orchestration policy.

## Sandbox properties

The delegated command environment has been designed and tested so that:

- Scout cannot write the workspace.
- Worker can edit ordinary workspace files.
- Git metadata is read-only for Worker and Runner tooling.
- delegated shell commands have no outbound network access by default;
  Runner `network_access` defaults to `disabled` and host networking
  requires an explicit `"host"` grant
- orchestrator/provider credential files and inherited credential environment
  variables are not exposed to delegated commands; host-enabled Runner commands
  may reach endpoints that independently expose sensitive data or credentials
- secret files outside the sandbox are not readable
- Runner can persist and analyze large command logs without returning the full
  log to the parent model

### Sandbox toolchains

`sandbox_shell` and `sandbox_run` expose only the workspace and safe system
paths by default. Inherited `PATH` entries that canonicalize beneath `/usr`
are retained automatically, so version-manager aliases into the existing
read-only system tree remain usable without restarting OpenCode.

Additional installations use the optional, tool-agnostic `sandboxRuntime`
configuration. Each trusted root is mounted read-only. `pathEntries` and
path-valued environment variables are resolved relative to that root and must
remain inside it:

    {
      "sandboxRuntime": {
        "trustedRoots": [
          {
            "root": "/opt/example-runtime",
            "pathEntries": ["bin"],
            "environment": {
              "EXAMPLE_HOME": "."
            }
          }
        ]
      }
    }

The plugin reloads this file for every sandbox invocation, so changing trusted
roots does not require reinstalling the orchestrator or restarting the shared
OpenCode service. Broad system roots, the home root, Git metadata, runtime
pseudo-filesystems, and common credential directories are rejected. Core
sandbox variables such as `HOME` and `PATH` cannot be overridden.

`OPENCODE_SANDBOX_TOOLCHAIN_DIRS` remains supported for backward compatibility
as an additive list of read-only directories that are also appended to PATH.

### Sandbox resource limits

Sandbox timeouts and caps have safe defaults and hard bounds. Each value is a
strict integer; unset variables preserve the default. Invalid, non-integer, or
out-of-range values fail closed.

| Variable | Default | Allowed range |
| --- | ---: | ---: |
| `OPENCODE_SANDBOX_SHELL_TIMEOUT_MS` | `120000` | `1000`..`900000` |
| `OPENCODE_SANDBOX_SHELL_MAX_OUTPUT_BYTES` | `30000` | `4096`..`1048576` |
| `OPENCODE_SANDBOX_RUNNER_LOG_LIMIT_BYTES` | `134217728` | `1048576`..`536870912` |
| `OPENCODE_SANDBOX_RUN_RETENTION_HOURS` | `24` | `1`..`168` |
| `OPENCODE_SANDBOX_RUN_RETENTION_COUNT` | `20` | `1`..`200` |

See SECURITY.md for the threat model and limitations.

See docs/orchestration-friction.md for observed caller-vs-bridge timeouts,
provider compatibility, sandbox toolchains, Runner access modes, and log
retention.

## Troubleshooting

For observed runtime friction, see docs/orchestration-friction.md: caller-side
versus bridge-level timeouts, provider compatibility, sandbox toolchains,
Runner access modes, and log retention.

For the detailed subagent reliability review and proposed synchronous versus
asynchronous timeout architecture, see
docs/subagent-usage-friction-review.md.

## Managed-file safety

The installer records hashes of files it owns.

During replacement cleanup, a managed file is removed only if it still matches
the hash recorded by the existing installation.

Locally modified files are preserved rather than deleted. A subsequent fresh
installation will not silently overwrite such preserved files.

The same conservative behavior applies to normal uninstall.

This prevents replacement installation or uninstall from silently destroying
local edits.

## Doctor

Installed releases contain:

    node ~/.local/share/opencode-mcp-orchestrator/current/libexec/doctor.mjs

The doctor checks:

- runtime prerequisites, including the exact launcher paths `/usr/bin/bash`,
  `/usr/bin/python3`, `/usr/bin/git`, and production Bubblewrap `/usr/bin/bwrap` >=0.12.0 (GHSA-pxhw-h44j-8pfx affects <0.12.0; each must
  exist, be executable, and not be a directory; checked even with
  `--no-sandbox-probes`, so Doctor never reports `DOCTOR_HEALTHY` when a
  launcher dependency is missing)
- installed core files
- configured role models and optional per-role variants
- the step-limit profile and per-role values
- the timeout profile, per-role values, and parent MCP deadline
- the installed Codex MCP timeout matches the orchestrator configuration
- installed agent definitions match the configured limits
- OpenCode agents/plugin
- selected Codex integration
- selected Claude Code integration
- separate networkless Worker and Runner sandbox execution probes

Sandbox probes use fixed commands in disposable workspaces, with validated
trusted runtime roots. The Worker workspace must be writable; the Runner
workspace must be read-only while sandbox-private temporary storage is writable.
Probe failures make Doctor unhealthy. To inspect only the other installation
checks, pass `--no-sandbox-probes`; Doctor explicitly reports sandbox readiness
as unverified when probes are skipped.

A healthy installation ends with:

    DOCTOR_HEALTHY

With `--no-sandbox-probes` and all other checks passing, Doctor exits 0 and ends with `DOCTOR_READINESS_UNVERIFIED` instead (never `DOCTOR_HEALTHY` for skipped probes).

## Uninstall

The bundled uninstaller is:

    node ~/.local/share/opencode-mcp-orchestrator/current/libexec/uninstall.mjs

By default, model/integration configuration is preserved for future
reinstallation.

To remove configuration as well:

    node ~/.local/share/opencode-mcp-orchestrator/current/libexec/uninstall.mjs --purge-config

Files modified by the user are preserved.

## Building from source

Development requires Node.js and npm.

    npm ci
    npm test

`npm test` builds the release payload and runs the unit and installer
integration suites. The CI workflow uses this as its focused test gate.

Create a local release:

    node scripts/package-release.mjs \
      --version 0.1.0 \
      --repository Mesya82/opencode-mcp-orchestrator

Generated assets:

    release/
    ├── install.sh
    ├── opencode-mcp-orchestrator-0.1.0.tar.gz
    └── SHA256SUMS

## End-to-end testing

Run the clean-container E2E suite with:

    npm run test:e2e

The suite first runs the same focused tests as CI, builds a release artifact,
starts a clean Linux container, installs
the latest Codex CLI, Claude Code, and OpenCode, and exercises the real
curl-based bootstrap installer.

It verifies:

- Codex-only installation
- clean replacement from Codex to Claude Code
- transition from Claude Code to both integrations
- same-release clean replacement reinstall
- real Codex and Claude Code MCP registrations
- MCP `initialize` and `tools/list`
- the `scout`, `worker`, and `runner` tool contract
- configured step limits are rendered into installed agent definitions
- installation doctor health
- uninstall cleanup
- preservation of user configuration

Docker or Podman may be used locally. The GitHub E2E workflow also runs daily so
changes in the latest supported client CLIs can surface even when this repository
has not changed.

The scheduled E2E workflow and release publication both run this entrypoint, so
the focused and clean-container suites are mandatory in all pipelines.

To exercise the built MCP server against the currently configured live Scout
model and existing OpenCode authentication, run:

    npm run build
    npm run test:live:scout

This sends a real provider request and may incur provider usage. Install the
same configuration first so the managed agent definition and its configured
step limit match the values read by the live test.

To probe live MCP cancellation through the current source bridge, run:

    npm run build
    npm run test:live:cancel

This starts a read-only `runner` task (`sleep 60`), aborts it after a short
delay (`ABORT_DELAY_MS` argument or `OPENCODE_MCP_CANCEL_PROBE_ABORT_MS`,
default `3000ms`), and passes only when the call rejects promptly as a
cancellation (under `30000ms`), `tools/list` still works, and
`git status --porcelain` is unchanged. Success prints
`LIVE_MCP_CANCELLATION_PASS` with elapsed time; server stderr is printed only
on failure. This is not part of normal CI because it uses a live provider.

This probes the current source bridge against the currently installed
OpenCode backend/agent/plugin unless an isolated deployment is explicitly
supplied (isolated configuration, home directory, and executable path).

## Releases

Pushing a version tag such as:

    git tag v0.1.0
    git push origin v0.1.0

triggers the release workflow, which:

1. installs dependencies using `npm ci`
2. builds bundled runtime artifacts
3. validates entrypoints
4. constructs the release archive
5. generates and validates the unsigned SPDX SBOM
6. verifies its checksum and contents
7. renders the GitHub-specific bootstrap installer
8. publishes the four release assets

Release assets are:

- `install.sh`
- `opencode-mcp-orchestrator-${VERSION}.tar.gz`
- `SHA256SUMS`
- `opencode-mcp-orchestrator-${VERSION}.spdx.json`

The SPDX SBOM is unsigned and is published without provenance or
attestation. `SHA256SUMS` provides SHA-256 integrity checking for the
release archive; it is not signing or provenance. The bootstrap
`SHA256SUMS` lookup is unchanged: it selects the single release archive
entry.

## Project status

The current implementation has been exercised against:

- isolated OpenCode Scout sessions
- bounded Worker edits and verification
- large Runner logs
- Codex MCP integration
- Claude Code user-scoped MCP integration
- clean installation
- migration from the public v0.1.2 versioned layout to the single-install layout
- conservative uninstall behavior
- checksum-verified bootstrap installation
- clean-container E2E with real latest Codex CLI, Claude Code, and OpenCode
- integration selection changes across clean replacement installs

The project is still pre-1.0. Interfaces and installation details may evolve.
