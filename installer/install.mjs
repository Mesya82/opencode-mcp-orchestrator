#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"

import {
  dirname,
  relative,
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

const versionDir =
  resolve(
    paths.appData,
    "versions",
    args.version,
  )

const currentLink =
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
console.log(`Install: ${versionDir}`)
console.log(`Config:  ${paths.appConfig}`)
console.log()

if (args.dryRun) {
  console.log("DRY_RUN_OK")
  process.exit(0)
}

mkdirSync(
  resolve(
    paths.appData,
    "versions",
  ),
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

if (existsSync(versionDir)) {
  throw new Error(
    `version already installed: ${versionDir}`,
  )
}

copyTree(
  payload,
  versionDir,
)

/*
 * current is the stable path used by client integrations.
 *
 * Build the replacement beside current and then rename it over the
 * existing symlink. On Linux/POSIX this keeps the version switch atomic:
 * readers see either the old target or the new target, never a gap.
 */
const nextCurrentLink =
  `${currentLink}.next-${process.pid}`

rmSync(
  nextCurrentLink,
  {
    recursive: true,
    force: true,
  },
)

symlinkSync(
  relative(
    dirname(currentLink),
    versionDir,
  ),
  nextCurrentLink,
)

renameSync(
  nextCurrentLink,
  currentLink,
)

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
    currentLink,

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
console.log(`Current: ${currentLink}`)
console.log(`Config:  ${userConfig}`)
console.log()
console.log("CORE_INSTALL_COMPLETE")
