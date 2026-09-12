#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
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

const SUPPORTED = new Set([
  "codex",
  "claude",
])

function parseArgs(argv) {
  const result = {
    integration: null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === "--integration") {
      result.integration = argv[++i]
      continue
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage:
  remove-integration.mjs --integration codex|claude
`)
      process.exit(0)
    }

    throw new Error(
      `unknown argument: ${arg}`,
    )
  }

  if (
    !result.integration ||
    !SUPPORTED.has(result.integration)
  ) {
    throw new Error(
      "--integration must be codex or claude",
    )
  }

  return result
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
      [
        "bash",
        "-c",
        `command -v ${name}`,
      ],
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

function run(command, args, options = {}) {
  const result =
    spawnSync(
      command,
      args,
      {
        encoding: "utf8",
        env: process.env,
        ...options,
      },
    )

  return result
}

function successfulRemoval(result) {
  if (result.status === 0) {
    return true
  }

  const output =
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`

  return /not found|does not exist/i.test(output)
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
  resolve(
    home,
    ".config",
  )

const appConfig =
  resolve(
    configHome,
    "opencode-mcp-orchestrator",
  )

const statePath =
  resolve(
    appConfig,
    "managed-files.json",
  )

if (!existsSync(statePath)) {
  console.log(
    `Integration not managed: ${args.integration}`,
  )
  console.log(
    "INTEGRATION_REMOVE_NOT_MANAGED",
  )
  process.exit(0)
}

const state =
  JSON.parse(
    readFileSync(
      statePath,
      "utf8",
    ),
  )

state.files ??= {}
state.integrations ??= {}

const owned =
  state.integrations[args.integration]

if (!owned?.mcpName) {
  console.log(
    `Integration not managed: ${args.integration}`,
  )
  console.log(
    "INTEGRATION_REMOVE_NOT_MANAGED",
  )
  process.exit(0)
}

const specification =
  args.integration === "codex"
    ? {
        label: "Codex",
        command: "codex",

        skill:
          resolve(
            home,
            ".agents/skills/orchestrate/SKILL.md",
          ),

        skillRoot:
          resolve(
            home,
            ".agents",
          ),

        removeArgs: [
          "mcp",
          "remove",
          owned.mcpName,
        ],

        cwd:
          undefined,
      }
    : {
        label: "Claude Code",
        command: "claude",

        skill:
          resolve(
            home,
            ".claude/skills/orchestrate/SKILL.md",
          ),

        skillRoot:
          resolve(
            home,
            ".claude",
          ),

        removeArgs: [
          "mcp",
          "remove",
          owned.mcpName,
          "--scope",
          owned.scope || "user",
        ],

        cwd:
          home,
      }

if (!commandExists(specification.command)) {
  throw new Error(
    [
      `${specification.label} integration is managed`,
      "but its CLI is not available in PATH.",
      "",
      "Cannot safely reconcile the requested configuration.",
    ].join("\n"),
  )
}

console.log()
console.log(
  `Removing managed ${specification.label} integration...`,
)

const removal =
  run(
    specification.command,
    specification.removeArgs,
    specification.cwd
      ? {
          cwd:
            specification.cwd,
        }
      : {},
  )

if (!successfulRemoval(removal)) {
  throw new Error(
    [
      `failed to remove ${specification.label} MCP registration`,
      `  ${specification.command} ${specification.removeArgs.join(" ")}`,
      removal.stdout?.trim(),
      removal.stderr?.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  )
}

console.log(
  `  REMOVED  ${specification.label} MCP ${owned.mcpName}`,
)

const fileRecord =
  state.files[specification.skill]

if (fileRecord) {
  if (!existsSync(specification.skill)) {
    console.log(
      `  ABSENT   ${specification.skill}`,
    )

    delete state.files[specification.skill]
  } else {
    let currentHash = null

    try {
      currentHash =
        sha256(
          specification.skill,
        )
    } catch {
      // Preserve anything we cannot safely inspect.
    }

    if (
      currentHash &&
      currentHash === fileRecord.sha256
    ) {
      unlinkSync(
        specification.skill,
      )

      delete state.files[specification.skill]

      console.log(
        `  REMOVED  ${specification.skill}`,
      )

      removeEmptyUpward(
        dirname(
          specification.skill,
        ),
        specification.skillRoot,
      )
    } else {
      /*
       * The user changed the skill after installation.
       * Stop managing it, but never destroy their copy.
       */
      delete state.files[specification.skill]

      console.log(
        `  PRESERVE modified file: ${specification.skill}`,
      )
    }
  }
}

delete state.integrations[args.integration]

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
  `${specification.label} integration removed.`,
)

console.log(
  "INTEGRATION_REMOVE_COMPLETE",
)
