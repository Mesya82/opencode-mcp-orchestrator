#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
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
  normalizeStepLimits,
  renderAgentStepLimit,
} from "../config/step-limits.mjs"

function parseArgs(argv) {
  const result = {
    payload: null,
    config: null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === "--payload") {
      result.payload = argv[++i]
      continue
    }

    if (arg === "--config") {
      result.config = argv[++i]
      continue
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage:
  install-opencode.mjs --payload PATH [--config PATH]
`)
      process.exit(0)
    }

    throw new Error(
      `unknown argument: ${arg}`,
    )
  }

  if (!result.payload) {
    throw new Error(
      "--payload is required",
    )
  }

  return result
}

function sha256File(path) {
  return createHash("sha256")
    .update(
      readFileSync(path),
    )
    .digest("hex")
}

function loadState(path) {
  if (!existsSync(path)) {
    return {
      formatVersion: 1,
      files: {},
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
  }
}

function installManagedFile({
  source,
  destination,
  state,
  content,
}) {
  const sourceHash =
    createHash("sha256")
      .update(content)
      .digest("hex")

  const previous =
    state.files[destination]

  if (existsSync(destination)) {
    const currentHash =
      sha256File(destination)

    /*
     * Already exactly what we want.
     */
    if (currentHash === sourceHash) {
      state.files[destination] = {
        sha256: sourceHash,
      }

      console.log(
        `UNCHANGED  ${destination}`,
      )

      return
    }

    /*
     * If we previously installed this file, only replace it when the
     * current file still matches the version we installed.
     *
     * A mismatch means the user or another program modified it.
     */
    if (
      previous &&
      previous.sha256 === currentHash
    ) {
      mkdirSync(
        dirname(destination),
        {
          recursive: true,
          mode: 0o755,
        },
      )

      writeFileSync(
        destination,
        content,
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
        "",
        "Move/remove that file manually, or preserve it and configure",
        "the integration separately.",
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

  writeFileSync(
    destination,
    content,
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

const payload =
  resolve(args.payload)

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

const appConfig =
  resolve(
    configHome,
    "opencode-mcp-orchestrator",
  )

const configPath =
  args.config ||
  process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG ||
  resolve(
    appConfig,
    "config.json",
  )

if (!existsSync(configPath)) {
  throw new Error(
    `configuration not found: ${configPath}`,
  )
}

const config =
  JSON.parse(
    readFileSync(
      configPath,
      "utf8",
    ),
  )

const stepLimits =
  normalizeStepLimits(
    config.stepLimits,
  )

const statePath =
  resolve(
    appConfig,
    "managed-files.json",
  )

const opencodeConfig =
  resolve(
    configHome,
    "opencode",
  )

const state =
  loadState(statePath)

const files = [
  {
    role: "scout",

    source:
      resolve(
        payload,
        "opencode/agents/opencode-orchestrator-scout.md",
      ),

    destination:
      resolve(
        opencodeConfig,
        "agents/opencode-orchestrator-scout.md",
      ),
  },

  {
    role: "worker",

    source:
      resolve(
        payload,
        "opencode/agents/opencode-orchestrator-worker.md",
      ),

    destination:
      resolve(
        opencodeConfig,
        "agents/opencode-orchestrator-worker.md",
      ),
  },

  {
    role: "runner",

    source:
      resolve(
        payload,
        "opencode/agents/opencode-orchestrator-runner.md",
      ),

    destination:
      resolve(
        opencodeConfig,
        "agents/opencode-orchestrator-runner.md",
      ),
  },

  {
    source:
      resolve(
        payload,
        "opencode/plugins/sandbox-tools/index.ts",
      ),

    destination:
      resolve(
        opencodeConfig,
        "plugins/opencode-mcp-orchestrator/index.ts",
      ),
  },
]

for (const file of files) {
  if (!existsSync(file.source)) {
    throw new Error(
      `release payload file missing: ${file.source}`,
    )
  }

  const source =
    readFileSync(
      file.source,
    )

  const content =
    file.role
      ? Buffer.from(
          renderAgentStepLimit(
            source.toString("utf8"),
            file.role,
            stepLimits.limits[file.role],
          ),
        )
      : source

  installManagedFile({
    ...file,
    state,
    content,
  })
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
console.log(
  "OpenCode backend integration installed.",
)

console.log(
  `Ownership state: ${statePath}`,
)

console.log(
  `Step-limit profile: ${stepLimits.profile}`,
)

console.log()
console.log(
  "OPENCODE_BACKEND_INSTALL_COMPLETE",
)
