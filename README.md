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
- Bubblewrap (`bwrap`)
- Git

For the corresponding parent integrations:

- Codex CLI, optional
- Claude Code, optional

npm is not required on machines installing a release. Runtime JavaScript
dependencies are bundled into the release artifacts.

## Installation

Once official GitHub releases are configured, installation will use:

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
2. installs the versioned core payload
3. installs the OpenCode agents and sandbox plugin
4. discovers models available through OpenCode
5. lets the user choose models using an interactive searchable selector
6. detects supported parent coding clients
7. lets the user select integrations
8. installs selected MCP and skill integrations
9. runs the installation doctor

## Model selection

Scout, Worker, and Runner may use the same model or different models.

The selector reads the user's actual OpenCode model catalog instead of
maintaining a project-specific list.

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
      "integrations": [
        "codex",
        "claude"
      ]
    }

## Installed layout

Core release payloads use an XDG data directory:

    ${XDG_DATA_HOME:-~/.local/share}/opencode-mcp-orchestrator/
    ├── versions/
    │   ├── 0.1.0/
    │   └── ...
    ├── current -> versions/<active-version>
    └── install-manifest.json

Parent integrations reference the stable `current` path. Upgrades therefore
install a new version and atomically repoint `current`.

User configuration lives separately under the XDG config directory and is
preserved across upgrades.

## OpenCode integration

The installer adds:

    ~/.config/opencode/agents/opencode-orchestrator-scout.md
    ~/.config/opencode/agents/opencode-orchestrator-worker.md
    ~/.config/opencode/agents/opencode-orchestrator-runner.md

    ~/.config/opencode/plugins/opencode-mcp-orchestrator/index.ts

Equivalent XDG paths are used when `XDG_CONFIG_HOME` is set.

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

Deployments and similarly high-risk operations are intentionally not delegated
by the orchestration policy.

## Sandbox properties

The delegated command environment has been designed and tested so that:

- Scout cannot write the workspace.
- Worker can edit ordinary workspace files.
- Git metadata is read-only for Worker and Runner tooling.
- delegated shell commands have no outbound network access
- orchestrator/provider credentials are not exposed to delegated commands
- secret files outside the sandbox are not readable
- Runner can persist and analyze large command logs without returning the full
  log to the parent model

See SECURITY.md for the threat model and limitations.

## Managed-file safety

The installer records hashes of files it owns.

During updates, a managed file is replaced only if it still matches the
previously installed version.

During uninstall, modified files are preserved rather than deleted.

This prevents an upgrade or uninstall from silently destroying local edits.

## Doctor

Installed releases contain:

    node ~/.local/share/opencode-mcp-orchestrator/current/libexec/doctor.mjs

The doctor checks:

- runtime prerequisites
- installed core files
- configured role models
- OpenCode agents/plugin
- selected Codex integration
- selected Claude Code integration

A healthy installation ends with:

    DOCTOR_HEALTHY

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
    npm run build

Create a local release:

    node scripts/package-release.mjs \
      --version 0.1.0 \
      --repository Mesya82/opencode-mcp-orchestrator

Generated assets:

    release/
    ├── install.sh
    ├── opencode-mcp-orchestrator-0.1.0.tar.gz
    └── SHA256SUMS

## Releases

Pushing a version tag such as:

    git tag v0.1.0
    git push origin v0.1.0

triggers the release workflow, which:

1. installs dependencies using `npm ci`
2. builds bundled runtime artifacts
3. validates entrypoints
4. constructs the release archive
5. verifies its checksum and contents
6. renders the GitHub-specific bootstrap installer
7. publishes the three release assets

## Project status

The current implementation has been exercised against:

- isolated OpenCode Scout sessions
- bounded Worker edits and verification
- large Runner logs
- Codex MCP integration
- Claude Code user-scoped MCP integration
- clean installation
- upgrade across two installed versions
- conservative uninstall behavior
- checksum-verified bootstrap installation

The project is still pre-1.0. Interfaces and installation details may evolve.
