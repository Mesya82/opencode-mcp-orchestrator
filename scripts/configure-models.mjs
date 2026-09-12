#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"

import {
  dirname,
  join,
} from "node:path"

import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"

import {
  confirm,
  input,
  search,
  select,
} from "@inquirer/prompts"

import {
  MAX_STEP_LIMIT,
  MIN_STEP_LIMIT,
  normalizeStepLimits,
  STEP_LIMIT_PROFILES,
  STEP_LIMIT_ROLES,
  stepLimitConfig,
} from "../config/step-limits.mjs"

function parseArgs(argv) {
  const result = {
    config: null,
    catalogCwd: null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === "--config") {
      result.config = argv[++i]
      continue
    }

    if (arg === "--catalog-cwd") {
      result.catalogCwd = argv[++i]
      continue
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage:
  configure-models.mjs [--config PATH] [--catalog-cwd PATH]

Interactively select the OpenCode model used for:

  scout
  worker
  runner

Available choices are discovered from the user's current OpenCode
installation. No provider or model list is maintained by this project.

The configurator also selects Standard, Extended, or Custom model-step
limits for the delegated roles.
`)
      process.exit(0)
    }

    throw new Error(`unknown argument: ${arg}`)
  }

  return result
}

function defaultConfigPath() {
  const configHome =
    process.env.XDG_CONFIG_HOME ||
    `${process.env.HOME}/.config`

  return `${configHome}/opencode-mcp-orchestrator/config.json`
}

function stripAnsi(value) {
  return value.replace(
    /\u001b\[[0-?]*[ -/]*[@-~]/g,
    "",
  )
}

function sleepSync(milliseconds) {
  Atomics.wait(
    new Int32Array(
      new SharedArrayBuffer(4),
    ),
    0,
    0,
    milliseconds,
  )
}

function runModelCatalogCommand(
  binary,
  cwd,
) {
  /*
   * Current OpenCode V2 beta can behave differently when CLI stdout is
   * captured through a pipe.
   *
   * Capture to ordinary files instead. This is also friendlier to CLI
   * programs that change behaviour based on their output descriptor.
   */
  const temporaryDirectory =
    mkdtempSync(
      join(
        tmpdir(),
        "opencode-orchestrator-models-",
      ),
    )

  const stdoutPath =
    join(
      temporaryDirectory,
      "stdout",
    )

  const stderrPath =
    join(
      temporaryDirectory,
      "stderr",
    )

  const stdoutFd =
    openSync(
      stdoutPath,
      "w",
      0o600,
    )

  const stderrFd =
    openSync(
      stderrPath,
      "w",
      0o600,
    )

  let result

  try {
    result = spawnSync(
      binary,
      ["models"],
      {
        cwd,
        env: process.env,

        /*
         * The command itself requires no input.
         *
         * Crucially, stdout/stderr are regular files rather than pipes.
         */
        stdio: [
          "ignore",
          stdoutFd,
          stderrFd,
        ],
      },
    )
  } finally {
    closeSync(stdoutFd)
    closeSync(stderrFd)
  }

  const stdout =
    readFileSync(
      stdoutPath,
      "utf8",
    )

  const stderr =
    readFileSync(
      stderrPath,
      "utf8",
    )

  rmSync(
    temporaryDirectory,
    {
      recursive: true,
      force: true,
    },
  )

  return {
    result,
    stdout,
    stderr,
  }
}

function discoverModels(catalogCwd) {
  const candidates = [
    process.env.OPENCODE_BIN,
    "opencode",
    "opencode2",
  ].filter(Boolean)

  let binary = null

  for (const candidate of [...new Set(candidates)]) {
    const probe = spawnSync(
      candidate,
      ["--version"],
      {
        encoding: "utf8",
        env: process.env,
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      },
    )

    if (
      !probe.error &&
      probe.status === 0
    ) {
      binary = candidate
      break
    }
  }

  if (!binary) {
    throw new Error(
      [
        "OpenCode CLI was not found.",
        "",
        "Tried:",
        "  $OPENCODE_BIN",
        "  opencode",
        "  opencode2",
      ].join("\n"),
    )
  }

  /*
   * Global configuration deliberately queries from HOME rather than from
   * whichever repository happens to be current.
   *
   * OpenCode catalogs are location-scoped. We want the user's general
   * available model inventory when configuring this installation.
   */
  const cwd =
    catalogCwd ||
    process.env.OPENCODE_MCP_ORCHESTRATOR_CATALOG_CWD ||
    process.env.HOME ||
    process.cwd()

  let last

  for (
    let attempt = 1;
    attempt <= 3;
    attempt++
  ) {
    last =
      runModelCatalogCommand(
        binary,
        cwd,
      )

    if (last.result.error) {
      throw new Error(
        `failed to execute "${binary} models": ${last.result.error.message}`,
      )
    }

    if (last.result.status !== 0) {
      throw new Error(
        [
          `${binary} models exited with status ${last.result.status}`,
          last.stderr.trim(),
        ]
          .filter(Boolean)
          .join("\n"),
      )
    }

    if (last.stdout.trim()) {
      break
    }

    if (attempt < 3) {
      sleepSync(
        attempt * 500,
      )
    }
  }

  const stdout =
    last?.stdout ?? ""

  const stderr =
    last?.stderr ?? ""

  const models = []

  /*
   * OpenCode currently outputs one canonical reference per line:
   *
   *   provider/model
   *
   * Keep parsing intentionally strict and boring. OpenCode owns the
   * catalog; this project does not maintain its own model list.
   */
  for (
    const rawLine
    of stdout.split(/\r?\n/)
  ) {
    const line =
      stripAnsi(rawLine).trim()

    if (!line) continue
    if (!line.includes("/")) continue
    if (/\s/.test(line)) continue

    const slash =
      line.indexOf("/")

    if (
      slash <= 0 ||
      slash === line.length - 1
    ) {
      continue
    }

    models.push(line)
  }

  const sorted =
    [...new Set(models)].sort(
      (a, b) => {
        const providerA =
          a.slice(
            0,
            a.indexOf("/"),
          )

        const providerB =
          b.slice(
            0,
            b.indexOf("/"),
          )

        return (
          providerA.localeCompare(
            providerB,
          ) ||
          a.localeCompare(b)
        )
      },
    )

  if (sorted.length === 0) {
    throw new Error(
      [
        "OpenCode returned no selectable models.",
        "",
        `Catalog cwd: ${cwd}`,
        `stdout bytes: ${Buffer.byteLength(stdout)}`,
        `stderr bytes: ${Buffer.byteLength(stderr)}`,
        "",
        stderr.trim()
          ? `stderr:\n${stderr.trim()}`
          : "No diagnostic output was produced.",
      ].join("\n"),
    )
  }

  return sorted
}

function loadConfig(path) {
  if (!existsSync(path)) {
    return {
      version: 1,
      models: {},
    }
  }

  try {
    const parsed =
      JSON.parse(
        readFileSync(path, "utf8"),
      )

    return {
      version: 1,
      ...parsed,
      models: {
        ...(parsed.models ?? {}),
      },
    }
  } catch (error) {
    throw new Error(
      `failed to parse existing config ${path}: ${error.message}`,
    )
  }
}

function modelChoices(models, input) {
  const query =
    (input ?? "")
      .trim()
      .toLowerCase()

  let matches = models

  if (query) {
    const words =
      query
        .split(/\s+/)
        .filter(Boolean)

    matches =
      models.filter((model) => {
        const haystack =
          model.toLowerCase()

        return words.every(
          (word) =>
            haystack.includes(word),
        )
      })
  }

  return matches.map((model) => ({
    name: model,
    value: model,
  }))
}

async function chooseModel({
  models,
  role,
  current,
}) {
  return search({
    message:
      current
        ? `Select model for ${role} (current: ${current})`
        : `Select model for ${role}`,

    pageSize: 15,

    source: async (input) =>
      modelChoices(
        models,
        input,
      ),

    validate: (value) =>
      models.includes(value)
        ? true
        : "Select one of the models reported by OpenCode",
  })
}

const args =
  parseArgs(
    process.argv.slice(2),
  )

const configPath =
  args.config ||
  process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG ||
  defaultConfigPath()

console.log()
console.log("Discovering models from OpenCode...")

const models =
  discoverModels(
    args.catalogCwd,
  )

console.log(
  `Found ${models.length} selectable model${models.length === 1 ? "" : "s"}.`,
)

const config =
  loadConfig(
    configPath,
  )

const useOne =
  await confirm({
    message:
      "Use the same model for Scout, Worker and Runner?",
    default: true,
  })

if (useOne) {
  const current =
    (
      config.models.scout &&
      config.models.scout === config.models.worker &&
      config.models.worker === config.models.runner
    )
      ? config.models.scout
      : undefined

  const selected =
    await chooseModel({
      models,
      role: "all roles",
      current,
    })

  config.models = {
    scout: selected,
    worker: selected,
    runner: selected,
  }
} else {
  config.models.scout =
    await chooseModel({
      models,
      role: "Scout",
      current:
        config.models.scout,
    })

  config.models.worker =
    await chooseModel({
      models,
      role: "Worker",
      current:
        config.models.worker,
    })

  config.models.runner =
    await chooseModel({
      models,
      role: "Runner",
      current:
        config.models.runner,
    })
}

const currentStepLimits =
  normalizeStepLimits(
    config.stepLimits,
  )

const stepProfile =
  await select({
    message: "Select delegated-agent step-limit profile",
    default: currentStepLimits.profile,
    choices: [
      {
        name:
          `Standard — Scout ${STEP_LIMIT_PROFILES.standard.scout}, Worker ${STEP_LIMIT_PROFILES.standard.worker}, Runner ${STEP_LIMIT_PROFILES.standard.runner}`,
        value: "standard",
        description:
          "Raised defaults for typical focused delegation.",
      },
      {
        name:
          `Extended — Scout ${STEP_LIMIT_PROFILES.extended.scout}, Worker ${STEP_LIMIT_PROFILES.extended.worker}, Runner ${STEP_LIMIT_PROFILES.extended.runner}`,
        value: "extended",
        description:
          "More room for tool-heavy models and broad investigations.",
      },
      {
        name: "Custom — configure each role",
        value: "custom",
        description:
          "Set an explicit model-step limit for Scout, Worker, and Runner.",
      },
    ],
  })

let customLimits

if (stepProfile === "custom") {
  customLimits = {}

  for (const role of STEP_LIMIT_ROLES) {
    const fallback =
      currentStepLimits.limits[role] ??
      STEP_LIMIT_PROFILES.standard[role]

    const answer =
      await input({
        message: `Model-step limit for ${role}`,
        default: String(fallback),
        validate: (value) => {
          const parsed = Number(value)

          return (
            Number.isInteger(parsed) &&
            parsed >= MIN_STEP_LIMIT &&
            parsed <= MAX_STEP_LIMIT
          )
            ? true
            : `Enter an integer from ${MIN_STEP_LIMIT} to ${MAX_STEP_LIMIT}`
        },
      })

    customLimits[role] = Number(answer)
  }
}

config.stepLimits =
  stepLimitConfig(
    stepProfile,
    customLimits,
  )

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
console.log("Configuration saved.")
console.log()

console.log(
  `Scout   ${config.models.scout}`,
)

console.log(
  `Worker  ${config.models.worker}`,
)

console.log(
  `Runner  ${config.models.runner}`,
)

const savedStepLimits =
  normalizeStepLimits(
    config.stepLimits,
  )

console.log()
console.log(
  `Step-limit profile: ${savedStepLimits.profile}`,
)

for (const role of STEP_LIMIT_ROLES) {
  console.log(
    `  ${role.padEnd(7)} ${savedStepLimits.limits[role]}`,
  )
}

console.log()
console.log(
  `Config: ${configPath}`,
)
