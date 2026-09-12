#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"

import {
  resolve,
} from "node:path"

function parseArgs(argv) {
  const result = {
    payload: null,
    version: null,
    dryRun: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === "--payload") {
      result.payload = argv[++i]
      continue
    }

    if (arg === "--version") {
      result.version = argv[++i]
      continue
    }

    if (arg === "--dry-run") {
      result.dryRun = true
      continue
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage:
  install.mjs --payload PATH --version VERSION [--dry-run]
`)
      process.exit(0)
    }

    throw new Error(`unknown argument: ${arg}`)
  }

  if (!result.payload) {
    throw new Error("--payload is required")
  }

  if (!result.version) {
    throw new Error("--version is required")
  }

  return result
}

function environmentPaths() {
  const home = process.env.HOME

  if (!home) {
    throw new Error("HOME is not set")
  }

  const dataHome =
    process.env.XDG_DATA_HOME ||
    resolve(home, ".local/share")

  const configHome =
    process.env.XDG_CONFIG_HOME ||
    resolve(home, ".config")

  return {
    home,
    dataHome,
    configHome,

    appData:
      resolve(
        dataHome,
        "opencode-mcp-orchestrator",
      ),

    appConfig:
      resolve(
        configHome,
        "opencode-mcp-orchestrator",
      ),
  }
}

function copyTree(source, destination) {
  cpSync(
    source,
    destination,
    {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    },
  )
}

const args =
  parseArgs(
    process.argv.slice(2),
  )

const payload =
  realpathSync(
    resolve(args.payload),
  )

const sourceManifest =
  JSON.parse(
    readFileSync(
      resolve(
        payload,
        "manifest.json",
      ),
      "utf8",
    ),
  )

const paths =
  environmentPaths()

/*
 * Only one release payload is installed locally.
 *
 * "current" remains the stable path used by parent integrations, but it is
 * now a real directory rather than a symlink into versions/<version>.
 */
const installDir =
  resolve(
    paths.appData,
    "current",
  )

const installManifestPath =
  resolve(
    paths.appData,
    "install-manifest.json",
  )

console.log("OpenCode MCP Orchestrator")
console.log()
console.log(`Version: ${args.version}`)
console.log(`Payload: ${payload}`)
console.log(`Install: ${installDir}`)
console.log(`Config:  ${paths.appConfig}`)
console.log()

if (args.dryRun) {
  console.log("DRY_RUN_OK")
  process.exit(0)
}

mkdirSync(
  paths.appData,
  {
    recursive: true,
    mode: 0o755,
  },
)

mkdirSync(
  paths.appConfig,
  {
    recursive: true,
    mode: 0o700,
  },
)

/*
 * The higher-level setup flow is responsible for removing an existing
 * installation before invoking the core installer.
 *
 * Refuse to overwrite one here so a direct low-level invocation can never
 * silently mix two releases.
 */
if (existsSync(installDir)) {
  throw new Error(
    `installation already exists: ${installDir}`,
  )
}

/*
 * Copy into a temporary sibling first. A failed copy therefore never leaves
 * a partially populated stable "current" directory.
 */
const nextInstallDir =
  resolve(
    paths.appData,
    `.current.next-${process.pid}`,
  )

rmSync(
  nextInstallDir,
  {
    recursive: true,
    force: true,
  },
)

try {
  copyTree(
    payload,
    nextInstallDir,
  )

  renameSync(
    nextInstallDir,
    installDir,
  )
} finally {
  rmSync(
    nextInstallDir,
    {
      recursive: true,
      force: true,
    },
  )
}

/*
 * Do not overwrite an existing user model configuration.
 */
const userConfig =
  resolve(
    paths.appConfig,
    "config.json",
  )

if (!existsSync(userConfig)) {
  writeFileSync(
    userConfig,
    JSON.stringify(
      {
        version: 1,
        models: {},
      },
      null,
      2,
    ) + "\n",
    {
      mode: 0o600,
    },
  )
}

const installedManifest = {
  formatVersion: 1,

  product:
    "opencode-mcp-orchestrator",

  version:
    args.version,

  current:
    installDir,

  config:
    userConfig,

  installedAt:
    new Date().toISOString(),

  payloadManifest:
    sourceManifest,
}

writeFileSync(
  installManifestPath,
  JSON.stringify(
    installedManifest,
    null,
    2,
  ) + "\n",
)

console.log("Core payload installed.")
console.log()
console.log(`Current: ${installDir}`)
console.log(`Config:  ${userConfig}`)
console.log()
console.log("CORE_INSTALL_COMPLETE")
