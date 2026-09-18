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
hardcoded model. Their model-step limits and matching synthesis guidance are
rendered during installation from the selected settings profile.

### Step-limit settings

`config/step-limits.mjs`

Defines the Standard and Extended presets, validates Custom values, derives the
tool-activity cutoff that reserves synthesis capacity, and renders those values
into agent definitions. Older configuration files without step-limit settings
resolve to Standard.

### Sandbox plugin

`opencode/plugins/sandbox-tools/`

`config/sandbox-runtime.mjs` defines the shared, tool-agnostic trusted-root
schema used by bridge validation, Doctor, and the bundled plugin. The plugin
reloads the user configuration for each sandbox invocation, canonicalizes
system PATH aliases into the existing `/usr` mount, and adds only validated
read-only runtime roots, contained PATH entries, and contained path-valued
environment variables. Model-controlled tool input cannot change these
capabilities.

The installed plugin also registers a narrowly scoped session-context hook for
orchestrator-owned OpenCode Muse Spark sessions. It removes hidden reasoning
parts before a subsequent provider request so Console/Zen does not receive
encrypted reasoning issued to a different upstream caller. Text and tool
history remain available to the delegated agent; other agents and models are
unchanged. A provider HTTP-request hook also removes `tool_choice: "none"` only
from an OpenCode Muse request whose tool list is absent or empty. It does not
depend on unstable hook `kind`, `agent`, or model-ID metadata; the model is
validated from the request body. This lets Console use its
supported `auto` default for final synthesis without weakening the final-step
tool prohibition.

`config/existing-container-runtime.mjs` is the shared admission and immutable
binding boundary used by both the bridge and plugin. The bridge resolves a
parent-selected display name once, before session creation, and stores only a
validated capability v2 containing the display name, immutable container ID,
pinned runtime path, pinned environment, cwd mapping intent, and host worktree.
The plugin rejects older or unknown capability shapes, re-inspects the pinned
ID and repeats admission before each command, and executes only by ID.

Existing-container commands run beneath an authenticated Linux/Python 3
subreaper supervisor. Same-session calls serialize. Only an authenticated
completion after descendant reaping removes the activity marker; unsupported
backends, supervisor failure, and unconfirmed cleanup retain quarantine for
explicit operator recovery. The parent-selected container remains a trusted
capability boundary for its pre-existing mounts, devices, credentials,
services, and network.

Provides the structured sandbox tools required by Worker and Runner.

### Model and step-limit configurator

`scripts/configure-models.mjs`

Discovers the user's current OpenCode catalog, stores role selections, and lets
the user select Standard, Extended, or per-role Custom step limits.

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

`setup.mjs` composes those pieces. Configuration is completed before the
OpenCode backend is installed so agent definitions can be rendered with the
selected limits while retaining managed-file ownership checks. Updating the
managed plugin writes a durable activation marker before replacing the file.
Full setup restarts the
OpenCode service, clears that marker only after success, and then runs Doctor;
the lower-level backend installer leaves `OPENCODE_RESTART_REQUIRED` visible
for operators that invoke it directly.

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
