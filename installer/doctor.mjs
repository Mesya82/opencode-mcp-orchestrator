#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
} from "node:fs"

import {
  resolve,
} from "node:path"

import {
  spawnSync,
} from "node:child_process"

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
  doctor.mjs [--config PATH]
`)
      process.exit(0)
    }

    throw new Error(`unknown argument: ${arg}`)
  }

  return result
}

const args =
  parseArgs(
    process.argv.slice(2),
  )

let failures = 0

function ok(message) {
  console.log(`  ✓ ${message}`)
}

function fail(message) {
  console.log(`  ✗ ${message}`)
  failures++
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

  return result.status === 0
}

function run(command, args, cwd) {
  return spawnSync(
    command,
    args,
    {
      cwd,
      encoding: "utf8",
      env: process.env,
    },
  )
}

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

const current =
  resolve(
    appData,
    "current",
  )

const configPath =
  args.config ||
  process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG ||
  resolve(
    appConfig,
    "config.json",
  )

console.log()
console.log("OpenCode MCP Orchestrator Doctor")
console.log()

console.log("Platform")

if (process.platform === "linux") {
  ok("Linux")
} else {
  fail(`Linux required; detected ${process.platform}`)
}

if (commandExists("bwrap")) {
  ok("bubblewrap")
} else {
  fail("bubblewrap not found")
}

if (commandExists("git")) {
  ok("Git")
} else {
  fail("Git not found")
}

if (
  process.env.OPENCODE_BIN ||
  commandExists("opencode") ||
  commandExists("opencode2")
) {
  ok("OpenCode CLI")
} else {
  fail("OpenCode CLI not found")
}

console.log()
console.log("Core")

for (const relative of [
  "libexec/mcp-server.mjs",
  "libexec/configure-models.mjs",
  "libexec/configure-integrations.mjs",
  "opencode/plugins/sandbox-tools/index.ts",
  "skills/orchestrate/SKILL.md",
]) {
  const path =
    resolve(
      current,
      relative,
    )

  if (existsSync(path)) {
    ok(relative)
  } else {
    fail(`${relative} missing`)
  }
}

let config = null

console.log()
console.log("Configuration")

if (existsSync(configPath)) {
  try {
    config =
      JSON.parse(
        readFileSync(
          configPath,
          "utf8",
        ),
      )

    ok(configPath)
  } catch (error) {
    fail(
      `invalid config: ${error.message}`,
    )
  }
} else {
  fail(`config missing: ${configPath}`)
}

if (config) {
  for (const role of [
    "scout",
    "worker",
    "runner",
  ]) {
    const model =
      config.models?.[role]

    if (
      typeof model === "string" &&
      model.includes("/")
    ) {
      ok(`${role}: ${model}`)
    } else {
      fail(`${role} model not configured`)
    }
  }
}

console.log()
console.log("OpenCode backend")

for (const relative of [
  "agents/opencode-orchestrator-scout.md",
  "agents/opencode-orchestrator-worker.md",
  "agents/opencode-orchestrator-runner.md",
  "plugins/opencode-mcp-orchestrator/index.ts",
]) {
  const path =
    resolve(
      configHome,
      "opencode",
      relative,
    )

  if (existsSync(path)) {
    ok(relative)
  } else {
    fail(`${relative} missing`)
  }
}

console.log()
console.log("Parent integrations")

for (
  const integration
  of config?.integrations ?? []
) {
  if (integration === "codex") {
    const skill =
      resolve(
        home,
        ".agents/skills/orchestrate/SKILL.md",
      )

    if (existsSync(skill)) {
      ok("Codex skill")
    } else {
      fail("Codex skill missing")
    }

    if (!commandExists("codex")) {
      fail("Codex CLI not found")
    } else {
      const result =
        run(
          "codex",
          ["mcp", "list"],
          home,
        )

      const text =
        `${result.stdout}\n${result.stderr}`

      if (
        result.status === 0 &&
        text.includes("opencode-agents")
      ) {
        ok("Codex MCP registration")
      } else {
        fail("Codex MCP registration missing")
      }
    }
  }

  if (integration === "claude") {
    const skill =
      resolve(
        home,
        ".claude/skills/orchestrate/SKILL.md",
      )

    if (existsSync(skill)) {
      ok("Claude Code skill")
    } else {
      fail("Claude Code skill missing")
    }

    if (!commandExists("claude")) {
      fail("Claude Code CLI not found")
    } else {
      const result =
        run(
          "claude",
          [
            "mcp",
            "get",
            "opencode-agents",
          ],
          home,
        )

      if (result.status === 0) {
        ok("Claude Code MCP registration")
      } else {
        fail("Claude Code MCP registration missing")
      }
    }
  }
}

console.log()

if (failures === 0) {
  console.log("DOCTOR_HEALTHY")
  process.exit(0)
}

console.log(
  `DOCTOR_UNHEALTHY failures=${failures}`,
)

process.exit(1)
