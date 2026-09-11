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

- core version installation
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

## Upgrade design

Every installed release receives its own version directory.

A relative symlink:

    current -> versions/<version>

selects the active version.

A new version is copied completely before an atomic symlink replacement.

Previous versions are retained so rollback support can be added without
redownloading the old release.

## Integration ownership

Files managed outside the core data directory are recorded with SHA-256 hashes.

An update may replace a managed file only when its current hash still equals
the hash previously installed by this project.

This deliberately favors preserving user data over forcing an upgrade.
