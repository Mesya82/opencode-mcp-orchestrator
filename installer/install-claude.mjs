#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
} from "node:fs"

import {
  dirname,
  resolve,
} from "node:path"

import {
  createHash,
} from "node:crypto"

import {
  spawnSync,
} from "node:child_process"

import {
  findExecutable,
  isProbeTimeoutResult,
  probeTimeoutMessage,
  SUBPROCESS_PROBE_TIMEOUT_MS,
} from "./path-security.mjs"

function parseArgs(argv) {
  const result = {
    payload: null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === "--payload") {
      result.payload = argv[++i]
      continue
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage:
  install-claude.mjs --payload PATH
`)
      process.exit(0)
    }

    throw new Error(`unknown argument: ${arg}`)
  }

  if (!result.payload) {
    throw new Error("--payload is required")
  }

  return result
}

function sha256(path) {
  return createHash("sha256")
    .update(readFileSync(path))
    .digest("hex")
}

function run(command, args, cwd) {
  const result =
    spawnSync(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        env: process.env,
        timeout: SUBPROCESS_PROBE_TIMEOUT_MS,
      },
    )

  return result
}

function requireSuccess(
  result,
  command,
  args,
) {
  if (isProbeTimeoutResult(result)) {
    throw new Error(
      probeTimeoutMessage(command),
    )
  }

  if (result.status !== 0) {
    throw new Error(
      [
        `command failed (${result.status}):`,
        `  ${command} ${args.join(" ")}`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  return result
}

function loadState(path) {
  if (!existsSync(path)) {
    return {
      formatVersion: 1,
      files: {},
      integrations: {},
    }
  }

  const parsed =
    JSON.parse(
      readFileSync(
        path,
        "utf8",
      ),
    )

  return {
    formatVersion: 1,
    ...parsed,

    files: {
      ...(parsed.files ?? {}),
    },

    integrations: {
      ...(parsed.integrations ?? {}),
    },
  }
}

function installManagedFile({
  source,
  destination,
  state,
}) {
  const sourceHash =
    sha256(source)

  const previous =
    state.files[destination]

  if (existsSync(destination)) {
    const currentHash =
      sha256(destination)

    if (currentHash === sourceHash) {
      chmodSync(
        destination,
        0o644,
      )

      state.files[destination] = {
        sha256: sourceHash,
      }

      console.log(
        `UNCHANGED  ${destination}`,
      )

      return
    }

    if (
      previous &&
      previous.sha256 === currentHash
    ) {
      copyFileSync(
        source,
        destination,
      )

      chmodSync(
        destination,
        0o644,
      )

      state.files[destination] = {
        sha256: sourceHash,
      }

      console.log(
        `UPDATED    ${destination}`,
      )

      return
    }

    throw new Error(
      [
        "Refusing to overwrite an unmanaged or modified file:",
        `  ${destination}`,
      ].join("\n"),
    )
  }

  mkdirSync(
    dirname(destination),
    {
      recursive: true,
      mode: 0o755,
    },
  )

  copyFileSync(
    source,
    destination,
  )

  chmodSync(
    destination,
    0o644,
  )

  state.files[destination] = {
    sha256: sourceHash,
  }

  console.log(
    `INSTALLED  ${destination}`,
  )
}

const args =
  parseArgs(
    process.argv.slice(2),
  )

const home =
  process.env.HOME

if (!home) {
  throw new Error(
    "HOME is not set",
  )
}

const configHome =
  process.env.XDG_CONFIG_HOME ||
  resolve(
    home,
    ".config",
  )

const dataHome =
  process.env.XDG_DATA_HOME ||
  resolve(
    home,
    ".local/share",
  )

const appConfig =
  resolve(
    configHome,
    "opencode-mcp-orchestrator",
  )

const appData =
  resolve(
    dataHome,
    "opencode-mcp-orchestrator",
  )

const statePath =
  resolve(
    appConfig,
    "managed-files.json",
  )

const state =
  loadState(statePath)

const payload =
  resolve(args.payload)

const skillSource =
  resolve(
    payload,
    "skills/orchestrate/SKILL.md",
  )

const skillDestination =
  resolve(
    home,
    ".claude/skills/orchestrate/SKILL.md",
  )

if (!existsSync(skillSource)) {
  throw new Error(
    `skill missing from payload: ${skillSource}`,
  )
}

installManagedFile({
  source: skillSource,
  destination: skillDestination,
  state,
})

const claude =
  findExecutable("claude")

if (!claude) {
  throw new Error(
    "Claude Code was selected but 'claude' was not found in PATH",
  )
}

const node =
  process.execPath

const mcpServer =
  resolve(
    appData,
    "current/libexec/mcp-server.mjs",
  )

if (!existsSync(mcpServer)) {
  throw new Error(
    `installed MCP server not found: ${mcpServer}`,
  )
}

const mcpName =
  "opencode-agents"

const alreadyOwned =
  state.integrations.claude?.mcpName === mcpName

/*
 * Run Claude MCP administration from HOME so project-local .mcp.json
 * registrations cannot interfere with the user-scoped integration.
 */
if (!alreadyOwned) {
  const existing =
    run(
      claude,
      [
        "mcp",
        "get",
        mcpName,
      ],
      home,
    )

  if (isProbeTimeoutResult(existing)) {
    throw new Error(
      probeTimeoutMessage(claude),
    )
  }

  if (existing.status === 0) {
    throw new Error(
      [
        `Claude MCP registration already exists: ${mcpName}`,
        "",
        "Refusing to replace an unmanaged registration.",
      ].join("\n"),
    )
  }
} else {
  /*
   * Only remove a registration that this installer already owns.
   *
   * Nonzero removal is intentionally ignored here; a timeout is not
   * and must surface instead of silently looking like absence.
   */
  const ownedRemoval =
    run(
      claude,
      [
        "mcp",
        "remove",
        mcpName,
        "--scope",
        "user",
      ],
      home,
    )

  if (isProbeTimeoutResult(ownedRemoval)) {
    throw new Error(
      probeTimeoutMessage(claude),
    )
  }
}

const addArgs = [
  "mcp",
  "add",
  mcpName,
  "--scope",
  "user",
  "--",
  node,
  mcpServer,
]

requireSuccess(
  run(
    claude,
    addArgs,
    home,
  ),
  claude,
  addArgs,
)

state.integrations.claude = {
  mcpName,
  scope: "user",
  node,
  server: mcpServer,
}

mkdirSync(
  appConfig,
  {
    recursive: true,
    mode: 0o700,
  },
)

writeFileSync(
  statePath,
  JSON.stringify(
    state,
    null,
    2,
  ) + "\n",
  {
    mode: 0o600,
  },
)

chmodSync(
  statePath,
  0o600,
)

console.log()
console.log(
  "Claude Code integration installed.",
)

console.log(
  `Skill: ${skillDestination}`,
)

console.log(
  `MCP:   ${mcpName} (user scope)`,
)

console.log()
console.log(
  "CLAUDE_INTEGRATION_INSTALL_COMPLETE",
)
