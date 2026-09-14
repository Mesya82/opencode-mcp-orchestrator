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
  isProbeTimeoutResult,
  probeTimeoutMessage,
  resolveCatalogCwd,
  resolveDiscoveryCandidate,
  SUBPROCESS_PROBE_TIMEOUT_MS,
} from "../installer/path-security.mjs"

import {
  MAX_STEP_LIMIT,
  MIN_STEP_LIMIT,
  normalizeStepLimits,
  STEP_LIMIT_PROFILES,
  STEP_LIMIT_ROLES,
  stepLimitConfig,
} from "../config/step-limits.mjs"

import {
  MAX_PARENT_TIMEOUT_SECONDS,
  MAX_ROLE_TIMEOUT_SECONDS,
  MIN_PARENT_RESERVE_SECONDS,
  MIN_PARENT_TIMEOUT_SECONDS,
  MIN_ROLE_TIMEOUT_SECONDS,
  normalizeConfigTimeoutLimits,
  normalizeTimeoutLimits,
  TIMEOUT_LIMIT_PROFILES,
  TIMEOUT_LIMIT_ROLES,
  timeoutLimitConfig,
} from "../config/timeout-limits.mjs"

const MODEL_ROLES = [
  "scout",
  "worker",
  "runner",
]

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

Interactively select the OpenCode model and optional advertised variant used for:

  scout
  worker
  runner

Available choices are discovered from the user's current OpenCode
installation. No provider, model, or variant list is maintained by this project.

The configurator also selects Standard, Extended, or Custom model-step
and wall-clock timeout limits for the delegated roles.
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

function runCatalogCommand(
  binary,
  cwd,
  args,
) {
  /*
   * Current OpenCode V2 beta can behave differently when CLI stdout is
   * captured through a pipe. Capture to ordinary files instead. This is
   * also friendlier to CLI programs that change behaviour based on their
   * output descriptor.
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
      args,
      {
        cwd,
        env: process.env,
        timeout: SUBPROCESS_PROBE_TIMEOUT_MS,
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

function parseStructuredCatalog(stdout) {
  let parsed

  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }

  if (!Array.isArray(parsed?.data)) {
    return null
  }

  const entries = []
  const seen = new Set()

  for (const raw of parsed.data) {
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    ) {
      continue
    }

    const providerID = raw.providerID
    const modelID = raw.modelID ?? raw.id

    if (
      typeof providerID !== "string" ||
      providerID === "" ||
      typeof modelID !== "string" ||
      modelID === "" ||
      /\s/.test(providerID) ||
      /\s/.test(modelID)
    ) {
      continue
    }

    const reference = `${providerID}/${modelID}`

    if (seen.has(reference)) {
      continue
    }

    seen.add(reference)

    const variants = []
    const seenVariants = new Set()

    if (Array.isArray(raw.variants)) {
      for (const candidate of raw.variants) {
        const id = candidate?.id

        if (
          typeof id !== "string" ||
          id === "" ||
          /\s/.test(id) ||
          seenVariants.has(id)
        ) {
          continue
        }

        seenVariants.add(id)
        variants.push(id)
      }
    }

    entries.push({
      reference,
      variants,
    })
  }

  if (entries.length === 0) {
    return null
  }

  entries.sort((a, b) => {
    const providerA =
      a.reference.slice(
        0,
        a.reference.indexOf("/"),
      )
    const providerB =
      b.reference.slice(
        0,
        b.reference.indexOf("/"),
      )

    return (
      providerA.localeCompare(providerB) ||
      a.reference.localeCompare(b.reference)
    )
  })

  return entries
}

function parsePlainModelCatalog(stdout) {
  const models = []

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

  return [...new Set(models)].sort(
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
        providerA.localeCompare(providerB) ||
        a.localeCompare(b)
      )
    },
  )
}

function discoverModels(catalogCwd) {
  const rawCandidates = [
    process.env.OPENCODE_BIN,
    "opencode",
    "opencode2",
  ].filter(Boolean)

  /*
   * Validate OPENCODE_BIN with the same safe executable-name/path rules
   * as normal discovery. Unsafe names and relative paths never reach
   * spawnSync; absolute paths must be a real executable non-directory.
   * No shell is ever used.
   */
  const resolvedCandidates = []

  for (const raw of [...new Set(rawCandidates)]) {
    const resolved =
      resolveDiscoveryCandidate(raw)

    if (
      resolved &&
      !resolvedCandidates.includes(resolved)
    ) {
      resolvedCandidates.push(resolved)
    }
  }

  let binary = null
  let timedOutCandidate = null

  for (const candidate of resolvedCandidates) {
    const probe = spawnSync(
      candidate,
      ["--version"],
      {
        encoding: "utf8",
        env: process.env,
        timeout: SUBPROCESS_PROBE_TIMEOUT_MS,
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      },
    )

    if (isProbeTimeoutResult(probe)) {
      timedOutCandidate =
        timedOutCandidate ?? candidate

      continue
    }

    if (
      !probe.error &&
      probe.status === 0
    ) {
      binary = candidate
      break
    }
  }

  if (!binary) {
    if (timedOutCandidate) {
      throw new Error(
        probeTimeoutMessage(timedOutCandidate),
      )
    }

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
   *
   * An explicitly configured catalog cwd must be an absolute, existing,
   * real directory (not a symlink or file).
   */
  const rawConfiguredCwd =
    catalogCwd ??
    process.env.OPENCODE_MCP_ORCHESTRATOR_CATALOG_CWD ??
    null

  const cwd =
    typeof rawConfiguredCwd === "string" &&
    rawConfiguredCwd.trim() !== ""
      ? resolveCatalogCwd(rawConfiguredCwd)
      : process.env.HOME ||
        process.cwd()

  /*
   * Prefer OpenCode's structured catalog because it includes model-specific
   * variant metadata. Older/supported clients may not expose this command; in
   * that case retain the historical `models` discovery path and simply offer
   * the OpenCode default variant.
   */
  const structured =
    runCatalogCommand(
      binary,
      cwd,
      ["api", "GET", "/api/model"],
    )

  if (
    !isProbeTimeoutResult(structured.result) &&
    !structured.result.error &&
    structured.result.status === 0 &&
    structured.stdout.trim() !== ""
  ) {
    const entries =
      parseStructuredCatalog(
        structured.stdout,
      )

    if (entries) {
      return {
        models: entries.map((entry) => entry.reference),
        variantsByModel: Object.fromEntries(
          entries.map((entry) => [entry.reference, entry.variants]),
        ),
        structured: true,
      }
    }
  }

  let last

  for (
    let attempt = 1;
    attempt <= 3;
    attempt++
  ) {
    last =
      runCatalogCommand(
        binary,
        cwd,
        ["models"],
      )

    if (isProbeTimeoutResult(last.result)) {
      throw new Error(
        probeTimeoutMessage(binary),
      )
    }

    if (last.result.error) {
      throw new Error(
        `failed to execute "${binary} models": ${last.result.error.message}`,
      )
    }

    if (last.result.status !== 0) {
      if (attempt < 3) {
        sleepSync(
          attempt * 500,
        )

        continue
      }

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

  const models =
    parsePlainModelCatalog(stdout)

  if (models.length === 0) {
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

  return {
    models,
    variantsByModel: {},
    structured: false,
  }
}

function loadConfig(path) {
  if (!existsSync(path)) {
    return {
      version: 1,
      models: {},
      modelVariants: {},
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
      modelVariants: {
        ...(parsed.modelVariants ?? {}),
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

async function chooseVariant({
  model,
  role,
  variants,
  current,
}) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return undefined
  }

  const currentIsValid =
    typeof current === "string" &&
    variants.includes(current)

  const chosen = await select({
    message: `Select variant for ${role} (${model})`,
    default: currentIsValid ? current : "__default__",
    choices: [
      {
        name: "Default — use OpenCode model default",
        value: "__default__",
      },
      ...variants.map((variant) => ({
        name: variant,
        value: variant,
      })),
    ],
  })

  return chosen === "__default__"
    ? undefined
    : chosen
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

const catalog =
  discoverModels(
    args.catalogCwd,
  )

const models = catalog.models

console.log(
  `Found ${models.length} selectable model${models.length === 1 ? "" : "s"}.`,
)

if (!catalog.structured) {
  console.log(
    "Variant metadata is unavailable from this OpenCode installation; model variants will use OpenCode defaults.",
  )
}

const config =
  loadConfig(
    configPath,
  )

const previousModels = {
  ...config.models,
}
const previousVariants = {
  ...config.modelVariants,
}

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

config.modelVariants = {}

for (const role of MODEL_ROLES) {
  const model = config.models[role]
  const variants = catalog.variantsByModel[model] ?? []
  const compatiblePrevious =
    previousModels[role] === model
      ? previousVariants[role]
      : undefined

  const selected =
    await chooseVariant({
      model,
      role,
      variants,
      current: compatiblePrevious,
    })

  if (selected !== undefined) {
    config.modelVariants[role] = selected
  }
}

if (Object.keys(config.modelVariants).length === 0) {
  delete config.modelVariants
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

const currentTimeoutLimits =
  normalizeConfigTimeoutLimits(config)

const timeoutProfile =
  await select({
    message: "Select delegated-agent timeout profile",
    default:
      config.timeoutLimits === undefined &&
      Object.hasOwn(TIMEOUT_LIMIT_PROFILES, stepProfile)
        ? stepProfile
        : currentTimeoutLimits.profile,
    choices: [
      {
        name:
          `Standard — Scout ${TIMEOUT_LIMIT_PROFILES.standard.scout}s, Worker ${TIMEOUT_LIMIT_PROFILES.standard.worker}s, Runner ${TIMEOUT_LIMIT_PROFILES.standard.runner}s, parent ${TIMEOUT_LIMIT_PROFILES.standard.parent}s`,
        value: "standard",
        description:
          "Wall-clock budgets for typical focused delegation.",
      },
      {
        name:
          `Extended — Scout ${TIMEOUT_LIMIT_PROFILES.extended.scout}s, Worker ${TIMEOUT_LIMIT_PROFILES.extended.worker}s, Runner ${TIMEOUT_LIMIT_PROFILES.extended.runner}s, parent ${TIMEOUT_LIMIT_PROFILES.extended.parent}s`,
        value: "extended",
        description:
          "Longer budgets for Muse and tool-heavy delegated work.",
      },
      {
        name: "Custom — configure each role and parent",
        value: "custom",
        description:
          "Set independent wall-clock budgets with a validated parent reserve.",
      },
    ],
  })

let customTimeouts

if (timeoutProfile === "custom") {
  customTimeouts = {}

  for (const role of TIMEOUT_LIMIT_ROLES) {
    const fallback =
      currentTimeoutLimits.limits[role] ??
      TIMEOUT_LIMIT_PROFILES.standard[role]

    const answer =
      await input({
        message: `Wall-clock timeout in seconds for ${role}`,
        default: String(fallback),
        validate: (value) => {
          const parsed = Number(value)

          return (
            Number.isInteger(parsed) &&
            parsed >= MIN_ROLE_TIMEOUT_SECONDS &&
            parsed <= MAX_ROLE_TIMEOUT_SECONDS
          )
            ? true
            : `Enter an integer from ${MIN_ROLE_TIMEOUT_SECONDS} to ${MAX_ROLE_TIMEOUT_SECONDS}`
        },
      })

    customTimeouts[role] = Number(answer)
  }

  const parentAnswer =
    await input({
      message: "Parent MCP timeout in seconds",
      default: String(currentTimeoutLimits.parentTimeoutSeconds),
      validate: (value) => {
        const parsed = Number(value)
        const longest = Math.max(
          ...TIMEOUT_LIMIT_ROLES.map((role) => customTimeouts[role]),
        )

        return (
          Number.isInteger(parsed) &&
          parsed >= MIN_PARENT_TIMEOUT_SECONDS &&
          parsed <= MAX_PARENT_TIMEOUT_SECONDS &&
          parsed >= longest + MIN_PARENT_RESERVE_SECONDS
        )
          ? true
          : `Enter an integer from ${Math.max(MIN_PARENT_TIMEOUT_SECONDS, longest + MIN_PARENT_RESERVE_SECONDS)} to ${MAX_PARENT_TIMEOUT_SECONDS}`
      },
    })

  customTimeouts.parent = Number(parentAnswer)
}

config.timeoutLimits =
  timeoutLimitConfig(
    timeoutProfile,
    customTimeouts,
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

for (const role of MODEL_ROLES) {
  const label = role[0].toUpperCase() + role.slice(1)
  const variant = config.modelVariants?.[role] ?? "default"

  console.log(
    `${label.padEnd(7)} ${config.models[role]} (variant: ${variant})`,
  )
}

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

const savedTimeoutLimits =
  normalizeTimeoutLimits(
    config.timeoutLimits,
  )

console.log()
console.log(
  `Timeout profile: ${savedTimeoutLimits.profile}`,
)

for (const role of TIMEOUT_LIMIT_ROLES) {
  console.log(
    `  ${role.padEnd(7)} ${savedTimeoutLimits.limits[role]}s`,
  )
}

console.log(
  `  ${"parent".padEnd(7)} ${savedTimeoutLimits.parentTimeoutSeconds}s`,
)

console.log()
console.log(
  `Config: ${configPath}`,
)
