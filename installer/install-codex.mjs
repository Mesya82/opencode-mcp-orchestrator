#!/usr/bin/env node

import {
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
  install-codex.mjs --payload PATH
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

function findExecutable(name) {
  const result =
    spawnSync(
      "/usr/bin/env",
      ["bash", "-lc", `command -v ${name}`],
      {
        encoding: "utf8",
        env: process.env,
      },
    )

  if (result.status !== 0) {
    return null
  }

  const value =
    result.stdout.trim()

  return value || null
}

function run(command, args) {
  const result =
    spawnSync(
      command,
      args,
      {
        encoding: "utf8",
        env: process.env,
      },
    )

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
      readFileSync(path, "utf8"),
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
    ".agents/skills/orchestrate/SKILL.md",
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

const codex =
  findExecutable("codex")

if (!codex) {
  throw new Error(
    "Codex CLI was selected but 'codex' was not found in PATH",
  )
}

const node =
  process.execPath

/*
 * Use the stable current symlink, never a specific installed version.
 */
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

/*
 * First installation must not silently replace an existing registration.
 *
 * Once this project owns the registration, upgrades can safely recreate it.
 */
const alreadyOwned =
  state.integrations.codex?.mcpName === mcpName

if (!alreadyOwned) {
  const listing =
    run(
      codex,
      ["mcp", "list"],
    )

  const combined =
    `${listing.stdout}\n${listing.stderr}`

  const exists =
    combined
      .split(/\r?\n/)
      .some((line) =>
        line.trim().startsWith(mcpName)
      )

  if (exists) {
    throw new Error(
      [
        `Codex MCP registration already exists: ${mcpName}`,
        "",
        "Refusing to replace an unmanaged registration.",
      ].join("\n"),
    )
  }
} else {
  /*
   * Recreate our own registration so updates to the Node executable
   * or installation location are reflected safely.
   */
  spawnSync(
    codex,
    ["mcp", "remove", mcpName],
    {
      encoding: "utf8",
      env: process.env,
    },
  )
}

run(
  codex,
  [
    "mcp",
    "add",
    mcpName,
    "--",
    node,
    mcpServer,
  ],
)

state.integrations.codex = {
  mcpName,
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

console.log()
console.log("Codex integration installed.")
console.log(`Skill: ${skillDestination}`)
console.log(`MCP:   ${mcpName}`)
console.log()
console.log("CODEX_INTEGRATION_INSTALL_COMPLETE")
