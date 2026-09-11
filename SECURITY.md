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
- ordinary workspace behavior follows the Runner sandbox policy
- `.git` metadata remains protected
- outbound command network access is disabled
- large command output is persisted and analyzed inside the delegated flow
  rather than copied wholesale into the parent context

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

The sandbox protects Git metadata from structured and shell-based writes.

The parent coding agent remains responsible for commits, rebases, resets,
branch operations, and similar repository-state changes.

## Network isolation

Network isolation applies to delegated commands.

The OpenCode process itself necessarily retains network access when using a
remote model provider.

Therefore:

    OpenCode/provider traffic      allowed
    delegated local shell traffic  blocked

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

Managed integration files are tracked by hash. Upgrades refuse to overwrite
unmanaged or locally modified files, and uninstall preserves modified files.

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

Future releases may add signed artifacts or provenance/attestation.

## Reporting a vulnerability

Please avoid publishing exploitable details in a public issue before a fix is
available.

Once the public repository is created, use GitHub private vulnerability
reporting if enabled. Otherwise contact the repository maintainer privately.
