#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from "node:fs"

import {
  createHash,
} from "node:crypto"

import {
  dirname,
  resolve,
} from "node:path"

import {
  spawnSync,
} from "node:child_process"

import {
  assertSafeRecursiveTarget,
  commandExists,
  environmentPaths,
  isProbeTimeoutResult,
  probeTimeoutMessage,
  SUBPROCESS_PROBE_TIMEOUT_MS,
} from "./path-security.mjs"

import {
  loadManagedState,
} from "./managed-state.mjs"

function parseArgs(argv) {
  const result = {
    purgeConfig: false,
    forUpdate: false,
  }

  for (const arg of argv) {
    if (arg === "--purge-config") {
      result.purgeConfig = true
      continue
    }

    if (arg === "--for-update") {
      result.forUpdate = true
      continue
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage:
  uninstall.mjs [--purge-config]
  uninstall.mjs --for-update

--for-update removes the installed payload and project-owned integrations
while preserving user configuration for the replacement installation.
`)
      process.exit(0)
    }

    throw new Error(`unknown argument: ${arg}`)
  }

  if (
    result.purgeConfig &&
    result.forUpdate
  ) {
    throw new Error(
      "--purge-config cannot be combined with --for-update",
    )
  }

  return result
}

function sha256(path) {
  return createHash("sha256")
    .update(readFileSync(path))
    .digest("hex")
}

function removeEmptyUpward(path, stop) {
  let current = path

  while (
    current.startsWith(stop) &&
    current !== stop
  ) {
    if (!existsSync(current)) {
      current = dirname(current)
      continue
    }

    try {
      if (readdirSync(current).length !== 0) {
        return
      }

      rmdirSync(current)
    } catch {
      return
    }

    current = dirname(current)
  }
}

const args =
  parseArgs(
    process.argv.slice(2),
  )

const {
  home,
  configHome,
  dataHome,
  appConfig,
  appData,
} =
  environmentPaths()

const statePath =
  resolve(
    appConfig,
    "managed-files.json",
  )

const userConfig =
  resolve(
    appConfig,
    "config.json",
  )

let state = {
  formatVersion: 1,
  files: {},
  integrations: {},
}

if (existsSync(statePath)) {
  /*
   * Fail closed before any integration removal or filesystem mutation.
   * Malformed, out-of-scope, or tampered state never drives removals.
   */
  state =
    loadManagedState(
      statePath,
      {
        home,
        configHome,
      },
    )
}

console.log()
console.log(
  args.forUpdate
    ? "OpenCode MCP Orchestrator replacement cleanup"
    : "OpenCode MCP Orchestrator uninstall",
)
console.log()

console.log(
  "Removing owned MCP registrations...",
)

/*
 * Replacement cleanup must not discard ownership state if an MCP
 * registration cannot be removed.
 *
 * Preflight every client we know we own before making any changes.
 */
if (args.forUpdate) {
  const requiredClients = [
    ["codex", "Codex", "codex"],
    ["claude", "Claude Code", "claude"],
  ]

  for (
    const [
      integration,
      label,
      command,
    ]
    of requiredClients
  ) {
    if (
      state.integrations?.[integration]?.mcpName &&
      !commandExists(command)
    ) {
      throw new Error(
        `${label} CLI is required to remove the existing managed MCP registration before replacement`,
      )
    }
  }
}

/*
 * Only touch registrations recorded as owned by this installation.
 */
if (
  state.integrations?.codex?.mcpName &&
  commandExists("codex")
) {
  const name =
    state.integrations.codex.mcpName

  const result =
    spawnSync(
      "codex",
      [
        "mcp",
        "remove",
        name,
      ],
      {
        encoding: "utf8",
        env: process.env,
        timeout: SUBPROCESS_PROBE_TIMEOUT_MS,
      },
    )

  if (isProbeTimeoutResult(result)) {
    const message =
      probeTimeoutMessage("codex")

    if (args.forUpdate) {
      throw new Error(message)
    }

    console.log(
      `  WARNING  ${message}`,
    )
  } else if (
    result.status === 0 ||
    /not found|does not exist/i.test(
      `${result.stdout}\n${result.stderr}`,
    )
  ) {
    console.log(
      `  REMOVED  Codex MCP ${name}`,
    )
  } else {
    const message =
      `could not remove Codex MCP ${name}`

    if (args.forUpdate) {
      throw new Error(message)
    }

    console.log(
      `  WARNING  ${message}`,
    )
  }
}

if (
  state.integrations?.claude?.mcpName &&
  commandExists("claude")
) {
  const name =
    state.integrations.claude.mcpName

  const result =
    spawnSync(
      "claude",
      [
        "mcp",
        "remove",
        name,
        "--scope",
        state.integrations.claude.scope || "user",
      ],
      {
        cwd: home,
        encoding: "utf8",
        env: process.env,
        timeout: SUBPROCESS_PROBE_TIMEOUT_MS,
      },
    )

  if (isProbeTimeoutResult(result)) {
    const message =
      probeTimeoutMessage("claude")

    if (args.forUpdate) {
      throw new Error(message)
    }

    console.log(
      `  WARNING  ${message}`,
    )
  } else if (
    result.status === 0 ||
    /not found|does not exist/i.test(
      `${result.stdout}\n${result.stderr}`,
    )
  ) {
    console.log(
      `  REMOVED  Claude MCP ${name}`,
    )
  } else {
    const message =
      `could not remove Claude MCP ${name}`

    if (args.forUpdate) {
      throw new Error(message)
    }

    console.log(
      `  WARNING  ${message}`,
    )
  }
}

console.log()
console.log(
  "Removing managed integration files...",
)

let preserved = 0

for (
  const [path, record]
  of Object.entries(
    state.files ?? {},
  )
) {
  if (!existsSync(path)) {
    console.log(
      `  ABSENT   ${path}`,
    )
    continue
  }

  let currentHash

  try {
    currentHash =
      sha256(path)
  } catch {
    console.log(
      `  SKIP     ${path}`,
    )
    preserved++
    continue
  }

  if (
    currentHash !== record.sha256
  ) {
    console.log(
      `  PRESERVE modified file: ${path}`,
    )

    preserved++
    continue
  }

  unlinkSync(path)

  console.log(
    `  REMOVED  ${path}`,
  )

  /*
   * Clean only now-empty directories below known user trees.
   */
  if (
    path.startsWith(
      resolve(home, ".agents"),
    )
  ) {
    removeEmptyUpward(
      dirname(path),
      resolve(home, ".agents"),
    )
  }

  if (
    path.startsWith(
      resolve(home, ".claude"),
    )
  ) {
    removeEmptyUpward(
      dirname(path),
      resolve(home, ".claude"),
    )
  }

  if (
    path.startsWith(
      resolve(configHome, "opencode"),
    )
  ) {
    removeEmptyUpward(
      dirname(path),
      resolve(configHome, "opencode"),
    )
  }
}

console.log()
console.log(
  "Removing application payload...",
)

if (existsSync(appData)) {
  assertSafeRecursiveTarget(
    appData,
    {
      home,
      dataHome,
      appData,
    },
  )

  rmSync(
    appData,
    {
      recursive: true,
      force: true,
    },
  )

  console.log(
    `  REMOVED  ${appData}`,
  )
}

if (existsSync(statePath)) {
  rmSync(
    statePath,
    {
      force: true,
    },
  )
}

if (args.purgeConfig) {
  if (existsSync(userConfig)) {
    rmSync(
      userConfig,
      {
        force: true,
      },
    )

    console.log(
      `  REMOVED  ${userConfig}`,
    )
  }

  /*
   * Remove app config directory only when empty.
   */
  if (
    existsSync(appConfig) &&
    readdirSync(appConfig).length === 0
  ) {
    rmdirSync(appConfig)
  }
} else {
  if (existsSync(userConfig)) {
    console.log()
    console.log(
      `Configuration preserved: ${userConfig}`,
    )
  }
}

console.log()

if (preserved > 0) {
  console.log(
    `UNINSTALL_COMPLETE_WITH_PRESERVED_FILES count=${preserved}`,
  )
} else {
  console.log(
    "UNINSTALL_COMPLETE",
  )
}

if (args.forUpdate) {
  console.log(
    "UNINSTALL_FOR_UPDATE_COMPLETE",
  )
}
