import { realpath } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { stat } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { isAbsolute } from "node:path"
import { normalize } from "node:path"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { pathToFileURL } from "node:url"
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import * as z from "zod/v4"

import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

import {
  extractFinalText,
  messageType,
} from "./final-text.mjs"

import {
  MODEL_ROLES,
  validateBridgeConfig,
  validateModelReference,
} from "./config.mjs"

export const SERVER_VERSION_FALLBACK = "0.0.0-dev"

function injectedBuildVersion() {
  try {
    if (
      typeof __ORCHESTRATOR_VERSION__ !== "undefined" &&
      typeof __ORCHESTRATOR_VERSION__ === "string" &&
      __ORCHESTRATOR_VERSION__.trim() !== ""
    ) {
      return __ORCHESTRATOR_VERSION__
    }
  } catch {
    // Define was not injected; fall through to file lookup.
  }

  return undefined
}

function readJsonVersion(candidate) {
  let raw

  try {
    raw = readFileSync(candidate, "utf8")
  } catch {
    return undefined
  }

  try {
    const parsed = JSON.parse(raw)
    const version = parsed?.version

    if (
      typeof version === "string" &&
      version.trim() !== "" &&
      !/[\s\x00-\x1f\x7f]/.test(version)
    ) {
      return version
    }
  } catch {
    return undefined
  }

  return undefined
}

/*
 * Installed sibling manifest only (dist/manifest.json when bundled as
 * dist/libexec/mcp-server.mjs, payload/manifest.json after packaging).
 * package-release rewrites the manifest version after the bundle is
 * built, so the manifest stays authoritative at installed runtime while
 * the injected define carries the same buildVersion as a fallback.
 */
function readInstalledManifestVersion() {
  let directory

  try {
    directory = dirname(fileURLToPath(import.meta.url))
  } catch {
    return undefined
  }

  return readJsonVersion(resolve(directory, "../manifest.json"))
}

/*
 * Deterministic development fallback for source execution/tests:
 * package.json adjacent to the checkout root. From an installed payload
 * this sibling path does not exist, so installed runtime never reads
 * the repository checkout through this lookup.
 */
function readPackageJsonVersion() {
  let directory

  try {
    directory = dirname(fileURLToPath(import.meta.url))
  } catch {
    return undefined
  }

  return readJsonVersion(resolve(directory, "../package.json"))
}

export function resolveServerVersion() {
  return (
    readInstalledManifestVersion() ??
    injectedBuildVersion() ??
    readPackageJsonVersion() ??
    SERVER_VERSION_FALLBACK
  )
}

/*
 * Bridge-level timeout for every delegated MCP operation, independent of
 * any runner command timeout handed to the delegated model. Configurable
 * through OPENCODE_MCP_ORCHESTRATOR_BRIDGE_TIMEOUT_MS with a conservative
 * default and strict numeric bounds (see resolveBridgeTimeoutMs). The
 * default comfortably exceeds the runner tool's 900s delegated command
 * budget plus model analysis overhead, so long delegated runs are not
 * cut off unless an operator opts into a shorter bound.
 */
export const BRIDGE_TIMEOUT_ENV_VAR =
  "OPENCODE_MCP_ORCHESTRATOR_BRIDGE_TIMEOUT_MS"

export const DEFAULT_BRIDGE_TIMEOUT_MS = 1_200_000
export const MIN_BRIDGE_TIMEOUT_MS = 1_000
export const MAX_BRIDGE_TIMEOUT_MS = 3_600_000

/*
 * Upper bound for best-effort session cleanup (interrupt/remove) so a
 * wedged service cannot hold a bridge operation open indefinitely.
 */
const SESSION_CLEANUP_TIMEOUT_MS = 10_000

let clientPromise

/*
 * Canonical directories with a writer currently in flight (worker or
 * writable runner). The lock is keyed per worktree so unrelated
 * worktrees never block each other. Scout and read-only runner
 * operations never consult this set.
 */
const activeWriterDirectories = new Set()

export function configPath() {
  if (process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG) {
    return process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG
  }

  const home = process.env.HOME

  if (!home) {
    throw new Error(
      "HOME is not set and OPENCODE_MCP_ORCHESTRATOR_CONFIG was not provided"
    )
  }

  const configHome =
    process.env.XDG_CONFIG_HOME ||
    `${home}/.config`

  return `${configHome}/opencode-mcp-orchestrator/config.json`
}

export function parseModelReference(reference, role) {
  return validateModelReference(reference, role)
}

export async function configuredModel(role) {
  const path = configPath()

  let raw

  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `configuration not found: ${path}. Run the model configurator first.`
      )
    }

    throw error
  }

  let config

  try {
    config = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `failed to parse configuration ${path}: ${error.message}`
    )
  }

  validateBridgeConfig(config, { configPath: path })

  if (!MODEL_ROLES.includes(role)) {
    throw new Error(
      `unsupported configuredModel role "${role}" at path "models.${role}": expected one of ${MODEL_ROLES.join(", ")}`,
    )
  }

  return parseModelReference(
    config.models[role],
    role,
  )
}

function debug(message) {
  if (
    process.env.OPENCODE_MCP_ORCHESTRATOR_DEBUG === "1"
  ) {
    /*
     * stdout is reserved for MCP protocol traffic.
     */
    console.error(
      `[opencode-mcp-orchestrator] ${message}`
    )
  }
}

export function resolveBridgeTimeoutMs(env = process.env) {
  const raw = env?.[BRIDGE_TIMEOUT_ENV_VAR]

  if (
    raw === undefined ||
    raw === null ||
    String(raw).trim() === ""
  ) {
    return DEFAULT_BRIDGE_TIMEOUT_MS
  }

  const parsed = Number(String(raw).trim())

  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_BRIDGE_TIMEOUT_MS ||
    parsed > MAX_BRIDGE_TIMEOUT_MS
  ) {
    return DEFAULT_BRIDGE_TIMEOUT_MS
  }

  return parsed
}

function safeHomedir() {
  try {
    return homedir()
  } catch {
    return undefined
  }
}

function candidateHomeDirectories(overrideHome) {
  const candidates = []

  for (const value of [
    overrideHome,
    process.env.HOME,
    safeHomedir(),
  ]) {
    if (
      typeof value === "string" &&
      value.trim() !== ""
    ) {
      candidates.push(normalize(value.trim()))
    }
  }

  return candidates
}

function isDangerousCwd(candidate, overrideHome) {
  const roots = new Set(
    [
      "/",
      "/home",
      "/tmp",
      "/usr",
      "/etc",
      "/proc",
      "/dev",
    ].map((root) => normalize(root)),
  )

  for (const home of candidateHomeDirectories(overrideHome)) {
    roots.add(home)
  }

  return roots.has(candidate)
}

export async function resolveCanonicalCwd(directoryArg, overrides = {}) {
  const candidate =
    typeof directoryArg === "string"
      ? directoryArg.trim()
      : ""

  if (candidate === "") {
    throw new Error("cwd must be a non-empty string")
  }

  if (!isAbsolute(candidate)) {
    throw new Error(
      `cwd must be an absolute path: ${candidate}`
    )
  }

  const normalized = normalize(candidate)

  if (isDangerousCwd(normalized, overrides.homeDir)) {
    throw new Error(
      `cwd must not be a system or home root: ${normalized}`
    )
  }

  const doRealpath = overrides.realpath ?? realpath

  let canonical

  try {
    canonical = await doRealpath(normalized)
  } catch {
    throw new Error(
      `cwd does not exist or cannot be resolved: ${normalized}`
    )
  }

  const normalizedCanonical = normalize(canonical)

  if (isDangerousCwd(normalizedCanonical, overrides.homeDir)) {
    throw new Error(
      `cwd must not be a system or home root: ${normalizedCanonical}`
    )
  }

  const doStat = overrides.stat ?? stat

  let info

  try {
    info = await doStat(normalizedCanonical)
  } catch {
    throw new Error(
      `cwd does not exist or cannot be accessed: ${normalizedCanonical}`
    )
  }

  if (!info.isDirectory()) {
    throw new Error(
      `cwd must be an existing directory: ${normalizedCanonical}`
    )
  }

  return normalizedCanonical
}

export async function getClient(overrides = {}) {
  if (!clientPromise) {
    const ensureService = overrides.ensureService ?? Service.ensure
    const makeClient = overrides.makeClient ?? OpenCode.make

    const attempt = (async () => {
      const endpoint = await ensureService()

      return makeClient({
        baseUrl: endpoint.url,
        headers: Service.headers(endpoint),
      })
    })()

    clientPromise = attempt

    /*
     * A transient initialization failure must not permanently poison
     * later calls: drop the cached promise so the next call retries.
     * Attaching this handler marks the rejection as handled; callers
     * awaiting the original promise still observe the failure.
     */
    attempt.then(
      () => {},
      () => {
        if (clientPromise === attempt) {
          clientPromise = undefined
        }
      },
    )
  }

  return clientPromise
}

function acquireWriterLock(directory) {
  if (activeWriterDirectories.has(directory)) {
    throw new Error(
      `worker is already running for ${directory}; wait for it to finish and retry`
    )
  }

  activeWriterDirectories.add(directory)
}

function releaseWriterLock(directory) {
  activeWriterDirectories.delete(directory)
}

/*
 * Test hook: clears cached client state and writer locks. Production
 * code never calls this.
 */
export function resetBridgeStateForTests() {
  clientPromise = undefined
  activeWriterDirectories.clear()
}

function settleWithin(promise, ms) {
  return (async () => {
    let timer

    try {
      await Promise.race([
        Promise.resolve(promise).catch(() => {}),
        new Promise((innerResolve) => {
          timer = setTimeout(innerResolve, ms)

          if (typeof timer.unref === "function") {
            timer.unref()
          }
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  })()
}

async function cleanupSession(client, sessionID, succeeded) {
  /*
   * Only interrupt/abort and remove/delete calls supported by the
   * installed @opencode/client are used here: session.interrupt stops
   * in-flight model work after failures, and session.remove deletes the
   * session on every path (including success). Cleanup never receives
   * the operation AbortSignal and never throws.
   */
  if (!succeeded) {
    await settleWithin(
      (async () => {
        try {
          await client.session.interrupt({ sessionID })
        } catch {
          // Best effort only.
        }
      })(),
      SESSION_CLEANUP_TIMEOUT_MS,
    )
  }

  await settleWithin(
    (async () => {
      try {
        await client.session.remove({ sessionID })
      } catch {
        // Best effort only.
      }
    })(),
    SESSION_CLEANUP_TIMEOUT_MS,
  )
}

export async function runAgent(directoryArg, task, agent, role, overrides = {}) {
  const timeoutMs =
    overrides.timeoutMs ??
    resolveBridgeTimeoutMs(overrides.env ?? process.env)

  /*
   * Canonicalize and validate before any OpenCode session exists, so
   * invalid cwd values fail without creating (or leaking) sessions.
   * Error messages below never interpolate prompt contents.
   */
  const directory = await resolveCanonicalCwd(directoryArg, overrides)

  const takesWriterLock =
    role === "worker" ||
    (role === "runner" &&
      (overrides.workspaceAccess === "writable" ||
        (overrides.workspaceAccess === undefined &&
          agent === "opencode-orchestrator-runner-writable")))

  if (takesWriterLock) {
    acquireWriterLock(directory)
  }

  /*
   * Combine caller cancellation (when the MCP SDK exposes one) with the
   * bridge-level timeout. Every OpenCode call below receives the
   * combined signal through RequestOptions.
   */
  const runController = new AbortController()
  const externalSignal = overrides.signal ?? undefined

  let onExternalAbort = null

  const cancelledError = () =>
    new Error(`OpenCode ${agent} operation was cancelled`)

  const cancelPromise = new Promise((_, reject) => {
    if (!externalSignal) {
      return
    }

    if (externalSignal.aborted) {
      runController.abort()
      reject(cancelledError())
      return
    }

    if (typeof externalSignal.addEventListener === "function") {
      onExternalAbort = () => {
        runController.abort()
        reject(cancelledError())
      }

      externalSignal.addEventListener(
        "abort",
        onExternalAbort,
        { once: true },
      )
    }
  })

  let onTimeout = () => {}

  const timeoutPromise = new Promise((_, reject) => {
    onTimeout = () => {
      runController.abort()
      reject(
        new Error(
          `OpenCode ${agent} operation timed out after ${timeoutMs}ms`
        ),
      )
    }
  })

  const timer = setTimeout(onTimeout, timeoutMs)

  if (typeof timer.unref === "function") {
    timer.unref()
  }

  let sessionID
  let succeeded = false
  let sessionClient = overrides.client ?? null
  let cleanupAttempted = false
  let work

  /*
   * Exactly-once best-effort session cleanup. The outer finally runs it
   * promptly when the timeout or cancellation wins the race; the
   * background hook below guarantees it when the operation itself
   * settles later (including a session created after the timeout
   * already fired). Cleanup never receives the operation AbortSignal
   * and never throws.
   */
  const cleanupOnce = async () => {
    if (cleanupAttempted) {
      return
    }

    if (!sessionID || !sessionClient) {
      return
    }

    cleanupAttempted = true

    await cleanupSession(
      sessionClient,
      sessionID,
      succeeded,
    )
  }

  try {
    work = (async () => {
      const client = sessionClient ?? await getClient(overrides)

      sessionClient = client

      const model = overrides.model ?? await configuredModel(role)

      debug(
        `${role}: agent=${agent} model=${model.reference} cwd=${directory}`
      )

      const requestOptions = { signal: runController.signal }

      const session = await client.session.create(
        {
          location: { directory },
        },
        requestOptions,
      )

      sessionID = session?.id

      if (!sessionID) {
        throw new Error(
          `OpenCode ${agent} session creation returned no session id`
        )
      }

      await client.session.switchAgent(
        {
          sessionID,
          agent,
        },
        requestOptions,
      )

      await client.session.switchModel(
        {
          sessionID,
          model: {
            providerID: model.providerID,
            id: model.id,
          },
        },
        requestOptions,
      )

      await client.session.prompt(
        {
          sessionID,
          text: task,
        },
        requestOptions,
      )

      await client.session.wait(
        {
          sessionID,
        },
        requestOptions,
      )

      const raw = await client.session.context(
        {
          sessionID,
        },
        requestOptions,
      )

      const messages =
        Array.isArray(raw) ? raw :
        Array.isArray(raw?.messages) ? raw.messages :
        Array.isArray(raw?.data) ? raw.data :
        []

      const assistants = messages.filter(
        (message) => messageType(message) === "assistant"
      )

      const last = assistants.at(-1)

      return extractFinalText(last, {
        agent,
        sessionID,
      })
    })()

    const result = await Promise.race([
      work,
      timeoutPromise,
      cancelPromise,
    ])

    succeeded = true

    return result
  } catch (error) {
    /*
     * Delegated failures must never echo the prompt back to MCP
     * clients: redact it before the error leaves the bridge.
     */
    throw redactPromptFromError(error, task)
  } finally {
    clearTimeout(timer)

    if (
      onExternalAbort &&
      externalSignal &&
      typeof externalSignal.removeEventListener === "function"
    ) {
      externalSignal.removeEventListener(
        "abort",
        onExternalAbort,
      )
    }

    await cleanupOnce()

    /*
     * Guarantee eventual cleanup for a session created after the race
     * already settled (for example, session creation itself outlived
     * the timeout): when the background operation settles, cleanupOnce
     * removes the session unless the prompt attempt above already did.
     * Handlers are attached, so a late background failure stays
     * handled, and cleanupOnce never throws.
     */
    if (work) {
      work.then(
        () => cleanupOnce(),
        () => cleanupOnce(),
      )
    }

    if (takesWriterLock) {
      releaseWriterLock(directory)
    }
  }
}

/*
 * Redact the delegated prompt from an error before it leaves the
 * bridge. Upstream OpenCode failures may echo request text; MCP error
 * results must never carry prompt contents back to clients.
 */
function redactPromptFromError(error, task) {
  if (
    typeof task !== "string" ||
    task === ""
  ) {
    return error
  }

  const scrub = (value) =>
    typeof value === "string" && value.includes(task)
      ? value.split(task).join("[redacted]")
      : value

  if (error instanceof Error) {
    error.message = scrub(error.message)

    if (error.cause instanceof Error) {
      error.cause.message = scrub(error.cause.message)
    }

    return error
  }

  if (typeof error === "string") {
    return new Error(scrub(error))
  }

  return error
}

function errorResult(name, error) {
  const message =
    error instanceof Error
      ? error.message
      : String(error)

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `OpenCode ${name} failed: ${message}`,
      },
    ],
  }
}

/*
 * Cancellation signal for the MCP request being handled, when the
 * installed MCP SDK exposes one (v2 surfaces it at ctx.mcpReq.signal).
 * Returns undefined when the transport or SDK version provides none; the
 * bridge-level timeout still bounds every operation in that case.
 */
export function mcpRequestSignal(ctx) {
  return (
    ctx?.mcpReq?.signal ??
    ctx?.signal ??
    undefined
  )
}

export function createToolHandlers(run = runAgent) {
  return {
    scout: async (args, ctx) => {
      try {
        const text = await run(
          args.cwd,
          args.task,
          "opencode-orchestrator-scout",
          "scout",
          { signal: mcpRequestSignal(ctx) },
        )

        return { content: [{ type: "text", text }] }
      } catch (error) {
        return errorResult("scout", error)
      }
    },

    worker: async (args, ctx) => {
      try {
        const text = await run(
          args.cwd,
          args.task,
          "opencode-orchestrator-worker",
          "worker",
          { signal: mcpRequestSignal(ctx) },
        )

        return { content: [{ type: "text", text }] }
      } catch (error) {
        return errorResult("worker", error)
      }
    },

    runner: async (args, ctx) => {
      try {
        const timeout = args.timeout_seconds ?? 900
        const workspaceAccess = args.workspace_access ?? "read_only"

        if (
          workspaceAccess !== "read_only" &&
          workspaceAccess !== "writable"
        ) {
          throw new Error(
            `invalid workspace_access: expected "read_only" or "writable"`
          )
        }

        const agent =
          workspaceAccess === "writable"
            ? "opencode-orchestrator-runner-writable"
            : "opencode-orchestrator-runner"

        const workspaceRules =
          workspaceAccess === "writable"
            ? [
                "Writes to the workspace are permitted only when required by the parent-requested command.",
                "Do not make unrelated edits or attempt repairs.",
              ]
            : [
                "Do not modify workspace files or attempt repairs.",
              ]

        const task = [
          "Execute and analyze one local command.",
          "",
          `Workspace access mode: ${workspaceAccess}.`,
          "Enforcement comes from the selected permission-scoped agent; this line is informational only.",
          "",
          "Command:",
          args.command,
          "",
          "Objective:",
          args.objective,
          "",
          "Expected condition:",
          args.expected ?? "None specified.",
          "",
          `Maximum runtime: ${timeout} seconds.`,
          "",
          "Run the command exactly once with sandbox_run.",
          "Pass the requested maximum runtime to sandbox_run.",
          "If the initial result is insufficient, inspect the persisted output with sandbox_log.",
          ...workspaceRules,
          "Do not run replacement or follow-up substantive commands.",
          "Return a concise result containing the actual exit code, whether the objective/expected condition was met, and only the smallest useful diagnostic evidence.",
        ].join("\n")

        const text = await run(
          args.cwd,
          task,
          agent,
          "runner",
          {
            signal: mcpRequestSignal(ctx),
            workspaceAccess,
          },
        )

        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        }
      } catch (error) {
        return errorResult(
          "runner",
          error,
        )
      }
    },
  }
}

export function createServer() {
  const server = new McpServer({
    name: "opencode-agents",
    version: resolveServerVersion(),
  })

  const handlers = createToolHandlers()

  server.registerTool(
    "scout",
    {
      title: "OpenCode Orchestrator Scout",
      description:
        "Run read-only repository reconnaissance in a fresh OpenCode session using the configured OpenCode model. " +
        "Use for code discovery, tracing, locating symbols, callers, state changes, tests, " +
        "configuration, and exact implementation facts.",
      inputSchema: z.object({
        cwd: z.string().min(1).describe(
          "Absolute path to the repository or worktree to inspect"
        ),
        task: z.string().min(1).describe(
          "Complete self-contained reconnaissance task"
        ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    handlers.scout,
  )

  server.registerTool(
    "worker",
    {
      title: "OpenCode Orchestrator Worker",
      description:
        "Run a bounded repository implementation task in a fresh OpenCode session using the configured OpenCode model. " +
        "The worker may edit ordinary workspace files and use its isolated sandbox_shell for " +
        "focused verification. Git metadata is protected and model-controlled shell networking " +
        "is blocked.",
      inputSchema: z.object({
        cwd: z.string().min(1).describe(
          "Absolute path to the repository or worktree to modify"
        ),
        task: z.string().min(1).describe(
          "Complete self-contained bounded implementation task including acceptance criteria and verification"
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    handlers.worker,
  )

  server.registerTool(
    "runner",
    {
      title: "OpenCode Orchestrator Runner",
      description:
        "Run a potentially noisy local build, test, diagnostic, lint, typecheck, or log-producing command and return only a concise delegated-model analysis. " +
        "The command runs in an isolated networkless sandbox with Git metadata protected. " +
        "Use this instead of running large-output commands directly in the root model.",
      inputSchema: z.object({
        cwd: z.string().min(1).describe(
          "Absolute path to the repository or worktree in which to run the command"
        ),
        command: z.string().min(1).describe(
          "Exact local command to execute"
        ),
        objective: z.string().min(1).describe(
          "What the runner should determine from the command result and output"
        ),
        expected: z.string().optional().describe(
          "Optional expected result or condition to check"
        ),
        timeout_seconds: z.number().int().min(1).max(3600).optional().describe(
          "Maximum command runtime in seconds"
        ),
        workspace_access: z.enum(["read_only", "writable"]).default("read_only").describe(
          "Workspace access mode: read_only delegates to the read-only runner agent, writable delegates to the writable runner agent"
        ),
      }),
      annotations: {
        // Static and conservative: annotations cannot vary per call,
        // so keep the writable (least permissive) hints for both modes.
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    handlers.runner,
  )

  return server
}

function invokedAsMain() {
  try {
    if (!process.argv[1]) {
      return false
    }

    return (
      pathToFileURL(resolve(process.argv[1])).href ===
        import.meta.url
    )
  } catch {
    return false
  }
}

if (invokedAsMain()) {
  serveStdio(createServer)
}
