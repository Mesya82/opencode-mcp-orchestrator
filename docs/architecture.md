# Architecture

## Core principle

The parent coding agent is the persistent orchestrator.

Delegated OpenCode agents are disposable bounded workers.

## Components

### MCP server

`bridge/server.mjs`

Exports:

- `scout`
- `worker`
- `runner`

Each invocation creates an isolated OpenCode session and selects the role's
model from user configuration.

### OpenCode agents

`opencode/agents/`

Agent definitions contain behavior and tool policy, but deliberately contain no
hardcoded model.

### Sandbox plugin

`opencode/plugins/sandbox-tools/`

Provides the structured sandbox tools required by Worker and Runner.

### Model configurator

`scripts/configure-models.mjs`

Discovers the user's current OpenCode catalog and stores role selections.

### Integration configurator

`scripts/configure-integrations.mjs`

Detects supported parent clients and lets the user choose integrations.

### Installer

`installer/`

Installation is split into small components:

- core payload installation
- OpenCode backend
- Codex adapter
- Claude Code adapter
- doctor
- uninstall

`setup.mjs` composes those pieces.

## Release design

npm dependencies are development/build-time dependencies.

esbuild creates bundled runtime entrypoints so release installation does not
require npm or `node_modules`.

The GitHub release consists of:

- bootstrap `install.sh`
- versioned `.tar.gz`
- `SHA256SUMS`

## Replacement-install design

Only one release payload is installed locally at a time:

    ${XDG_DATA_HOME:-~/.local/share}/opencode-mcp-orchestrator/current/

`current/` is a real directory and remains the stable path referenced by parent
client integrations.

The bootstrap downloads, checksum-verifies, validates, and extracts the
requested release before the existing installation is changed.

When an installation already exists, setup removes the project-owned payload
and integrations while preserving user configuration. It then installs the
requested release fresh into `current/` and reconstructs the configured
integrations.

The same mechanism is used for upgrades, same-release reinstalls, and
installing an older release. Previous release payloads are not retained
locally.

## Integration ownership

Files managed outside the core data directory are recorded with SHA-256 hashes.

During replacement cleanup or uninstall, an owned file is removed only when
its current hash still equals the hash recorded by this project.

Locally modified files are preserved rather than deleted. A subsequent fresh
installation does not silently overwrite preserved unmanaged or modified files.

This deliberately favors preserving user data over forcing a replacement.

Integration selection describes the desired integrations for the newly
installed release. During a replacement install, currently owned integrations
are removed as part of replacement cleanup and the selected integrations are
then installed fresh from the requested release.

The low-level core installer refuses to overwrite an existing `current/`
payload. The higher-level setup flow is responsible for replacement cleanup
before invoking the core installer.
