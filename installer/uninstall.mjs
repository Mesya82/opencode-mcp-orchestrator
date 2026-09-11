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

function parseArgs(argv) {
  return {
    purgeConfig:
      argv.includes("--purge-config"),
  }
}

function sha256(path) {
  return createHash("sha256")
    .update(readFileSync(path))
    .digest("hex")
}

function commandExists(name) {
  const result =
    spawnSync(
      "/usr/bin/env",
      ["bash", "-lc", `command -v ${name}`],
      {
        encoding: "utf8",
        env: process.env,
      },
    )

  return (
    result.status === 0 &&
    result.stdout.trim() !== ""
  )
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

const home =
  process.env.HOME

if (!home) {
  throw new Error("HOME is not set")
}

const configHome =
  process.env.XDG_CONFIG_HOME ||
  resolve(home, ".config")

const dataHome =
  process.env.XDG_DATA_HOME ||
  resolve(home, ".local/share")

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

const userConfig =
  resolve(
    appConfig,
    "config.json",
  )

let state = {
  files: {},
  integrations: {},
}

if (existsSync(statePath)) {
  state =
    JSON.parse(
      readFileSync(
        statePath,
        "utf8",
      ),
    )
}

console.log()
console.log(
  "OpenCode MCP Orchestrator uninstall",
)
console.log()

console.log(
  "Removing owned MCP registrations...",
)

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
      },
    )

  if (
    result.status === 0 ||
    /not found|does not exist/i.test(
      `${result.stdout}\n${result.stderr}`,
    )
  ) {
    console.log(
      `  REMOVED  Codex MCP ${name}`,
    )
  } else {
    console.log(
      `  WARNING  could not remove Codex MCP ${name}`,
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
      },
    )

  if (
    result.status === 0 ||
    /not found|does not exist/i.test(
      `${result.stdout}\n${result.stderr}`,
    )
  ) {
    console.log(
      `  REMOVED  Claude MCP ${name}`,
    )
  } else {
    console.log(
      `  WARNING  could not remove Claude MCP ${name}`,
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
