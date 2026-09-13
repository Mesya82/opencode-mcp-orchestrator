#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"

import {
  dirname,
} from "node:path"

import {
  checkbox,
} from "@inquirer/prompts"

import {
  findExecutable,
} from "../installer/path-security.mjs"

function parseArgs(argv) {
  const result = {
    config: null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === "--config") {
      result.config = argv[++i]
      continue
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage:
  configure-integrations.mjs [--config PATH]

Interactively choose which installed coding clients should use
OpenCode MCP Orchestrator.
`)
      process.exit(0)
    }

    throw new Error(
      `unknown argument: ${arg}`,
    )
  }

  return result
}

function defaultConfigPath() {
  const configHome =
    process.env.XDG_CONFIG_HOME ||
    `${process.env.HOME}/.config`

  return `${configHome}/opencode-mcp-orchestrator/config.json`
}

function loadConfig(path) {
  if (!existsSync(path)) {
    return {
      version: 1,
      models: {},
      integrations: [],
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
    version: 1,
    ...parsed,

    models: {
      ...(parsed.models ?? {}),
    },

    integrations:
      Array.isArray(parsed.integrations)
        ? parsed.integrations
        : [],
  }
}

const SUPPORTED = [
  {
    id: "codex",
    name: "Codex",
    binary: "codex",
  },

  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
  },
]

const args =
  parseArgs(
    process.argv.slice(2),
  )

const configPath =
  args.config ||
  process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG ||
  defaultConfigPath()

const config =
  loadConfig(
    configPath,
  )

const detected =
  SUPPORTED.map((client) => ({
    ...client,
    executable:
      findExecutable(
        client.binary,
      ),
  }))

console.log()
console.log(
  "Detected coding clients:",
)
console.log()

for (const client of detected) {
  if (client.executable) {
    console.log(
      `  ✓ ${client.name}`
    )

    console.log(
      `    ${client.executable}`
    )
  } else {
    console.log(
      `  - ${client.name} (not installed)`
    )
  }
}

const available =
  detected.filter(
    (client) =>
      client.executable,
  )

if (available.length === 0) {
  throw new Error(
    [
      "No supported coding clients were detected.",
      "",
      "Currently supported:",
      "  Codex",
      "  Claude Code",
    ].join("\n"),
  )
}

const previouslySelected =
  new Set(
    config.integrations,
  )

console.log()

const selected =
  await checkbox({
    message:
      "Select integrations to install",

    required: true,

    pageSize: 10,

    choices:
      detected.map(
        (client) => ({
          name:
            client.executable
              ? client.name
              : `${client.name} (not installed)`,

          value:
            client.id,

          checked:
            client.executable &&
            (
              previouslySelected.has(
                client.id,
              ) ||
              config.integrations.length === 0
            ),

          disabled:
            client.executable
              ? false
              : "not installed",
        }),
      ),
  })

config.integrations =
  selected

mkdirSync(
  dirname(configPath),
  {
    recursive: true,
    mode: 0o700,
  },
)

writeFileSync(
  configPath,
  JSON.stringify(
    config,
    null,
    2,
  ) + "\n",
  {
    mode: 0o600,
  },
)

console.log()
console.log(
  "Integration configuration saved.",
)
console.log()

for (const id of selected) {
  const client =
    SUPPORTED.find(
      (candidate) =>
        candidate.id === id,
    )

  console.log(
    `  ✓ ${client.name}`,
  )
}

console.log()
console.log(
  `Config: ${configPath}`,
)
