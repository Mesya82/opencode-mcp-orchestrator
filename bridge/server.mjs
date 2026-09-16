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

import {
  assertOperationTimeoutFitsParent,
  assertRunnerTimeoutFits,
  normalizeConfigTimeoutLimits,
} from "../config/timeout-limits.mjs"

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
 * Compatibility override for every delegated MCP operation, independent of
 * the configured per-role timeout profile. When the environment variable is
 * absent, runAgent uses the selected role timeout. The legacy default remains
 * the fail-closed fallback for an invalid override.
 */
export const BRIDGE_TIMEOUT_ENV_VAR =
  "OPENCODE_MCP_ORCHESTRATOR_BRIDGE_TIMEOUT_MS"

export const DEFAULT_BRIDGE_TIMEOUT_MS = 1_200_000
export const MIN_BRIDGE_TIMEOUT_MS = 1_000
export const MAX_BRIDGE_TIMEOUT_MS = 3_600_000

/*
 * Diagnostic-only switch. When enabled, delegated OpenCode sessions are
 * interrupted after unsuccessful operations but are deliberately not removed,
 * so their messages and runtime metadata remain available for inspection.
 * This is intentionally an environment flag rather than user configuration.
 */
export const PRESERVE_SESSIONS_ENV_VAR =
  "OPENCODE_MCP_ORCHESTRATOR_PRESERVE_SESSIONS"

export function resolvePreserveSessions(env = process.env) {
  return String(env?.[PRESERVE_SESSIONS_ENV_VAR] ?? "").trim() === "1"
}

/*
 * OpenCode's generated client implements session.wait() as a single HTTP
 * request using the host Node fetch implementation. Node/Undici can close a
 * response-header wait at roughly 300 seconds before the bridge operation
 * deadline. Refresh the long poll comfortably before that transport boundary;
 * the OpenCode session itself continues running when only the wait request is
 * aborted.
 */
export const SESSION_WAIT_REFRESH_MS = 240_000

/*
 * Best-effort bound for the read-only session.get() progress sample taken
 * between bounded session.wait() refreshes. The sample never extends past
 * the absolute operation deadline and never controls the session.
 */
const SESSION_PROGRESS_READ_TIMEOUT_MS = 5_000

/*
 * Test-only override for the bounded session-wait refresh interval.
 * Production never sets this variable; the E2E probe uses it to exercise
 * the refresh path deterministically against the installed bundle.
 */
export const OPENCODE_MCP_ORCHESTRATOR_E2E_SESSION_WAIT_REFRESH_MS =
  "OPENCODE_MCP_ORCHESTRATOR_E2E_SESSION_WAIT_REFRESH_MS"

export function resolveSessionWaitRefreshMs(env = process.env) {
  const raw =
    env?.[OPENCODE_MCP_ORCHESTRATOR_E2E_SESSION_WAIT_REFRESH_MS]

  if (
    raw === undefined ||
    raw === null ||
    String(raw).trim() === ""
  ) {
    return SESSION_WAIT_REFRESH_MS
  }

  const parsed = Number(String(raw).trim())

  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > SESSION_WAIT_REFRESH_MS
  ) {
    return SESSION_WAIT_REFRESH_MS
  }

  return parsed
}

/*
 * Upper bound for best-effort session cleanup (interrupt/remove) so a
 * wedged service cannot hold a bridge operation open indefinitely.
 * Tests may narrow this bound with overrides.cleanupTimeoutMs so hanging
 * removal can be covered without waiting the full production deadline.
 */
const SESSION_CLEANUP_TIMEOUT_MS = 10_000

let clientPromise

/*
 * Per-canonical-directory writer state for worker and writable runner work:
 *   free (absent) -> active -> cleaning -> free
 *                                     \-> preserved
 *                                     \-> quarantined
 * `active` means a writable operation is executing, `cleaning` means
 * interrupt/removal has started, `preserved` means diagnostic preservation
 * intentionally kept the OpenCode session, and `quarantined` means normal
 * termination/removal could not be confirmed. New writable operations fail
 * closed for every non-free state. The map is in-memory only and clears on
 * process restart. Scout and read-only runner operations never consult it.
 */
const writerDirectoryStates = new Map()

function writerQuarantineMessage(directory) {
  return `writable operation directory is quarantined for ${directory} after unconfirmed session cleanup; inspect Git status and the focused diff, verify no orphaned session remains, then restart the bridge process and retry`
}

function writerPreservedMessage(directory, sessionID) {
  const sessionSuffix = sessionID
    ? `; preserved OpenCode session: ${sessionID}`
    : ""

  return `writable operation directory is preserved for diagnostics for ${directory}${sessionSuffix}; verify the preserved session is no longer executing, inspect the workspace and inspect/export the preserved session, then restart the bridge process before running another writable delegation in this directory`
}

function diagnosticEvent(event) {
  /*
   * stdout is reserved for MCP protocol traffic. Preservation is itself an
   * explicit diagnostics mode, so emit this identity record even when generic
   * debug logging is disabled.
   */
  console.error(
    `[opencode-mcp-orchestrator] ${JSON.stringify(event)}`
  )
}

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

async function configuredBridgeConfig() {
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

  return validateBridgeConfig(config, { configPath: path })
}

export async function configuredModel(role) {
  const config = await configuredBridgeConfig()

  if (!MODEL_ROLES.includes(role)) {
    throw new Error(
      `unsupported configuredModel role "${role}" at path "models.${role}": expected one of ${MODEL_ROLES.join(", ")}`,
    )
  }

  const model = parseModelReference(
    config.models[role],
    role,
  )
  const variant = config.modelVariants?.[role]

  return variant === undefined
    ? model
    : { ...model, variant }
}

export async function configuredRoleTimeoutSeconds(role) {
  if (!MODEL_ROLES.includes(role)) {
    throw new Error(
      `unsupported timeout role "${role}": expected one of ${MODEL_ROLES.join(", ")}`,
    )
  }

  const config = await configuredBridgeConfig()
  const timeouts =
    config.timeoutLimits?.limits
      ? config.timeoutLimits
      : normalizeConfigTimeoutLimits(config)

  return timeouts.limits[role]
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

async function resolveOperationTimeoutMs(role, overrides) {
  if (overrides.timeoutMs !== undefined) {
    return overrides.timeoutMs
  }

  const env = overrides.env ?? process.env
  const raw = env?.[BRIDGE_TIMEOUT_ENV_VAR]

  if (
    raw !== undefined &&
    raw !== null &&
    String(raw).trim() !== ""
  ) {
    return resolveBridgeTimeoutMs(env)
  }

  return (
    await configuredRoleTimeoutSeconds(role)
  ) * 1000
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
  const existing = writerDirectoryStates.get(directory)

  if (existing) {
    if (existing.status === "preserved") {
      throw new Error(
        writerPreservedMessage(directory, existing.sessionID)
      )
    }

    if (existing.status === "quarantined") {
      throw new Error(writerQuarantineMessage(directory))
    }

    if (existing.status === "cleaning") {
      throw new Error(
        `writable operation cleanup is still in progress for ${directory}; wait for confirmed session removal and retry`
      )
    }

    throw new Error(
      `writable operation is already running for ${directory}; wait for it to finish and retry`
    )
  }

  writerDirectoryStates.set(directory, { status: "active" })
}

function markWriterCleaning(directory) {
  const existing = writerDirectoryStates.get(directory)

  if (existing && existing.status === "active") {
    existing.status = "cleaning"
  }
}

function clearWriterState(directory) {
  writerDirectoryStates.delete(directory)
}

function preserveWriter(directory, sessionID) {
  writerDirectoryStates.set(
    directory,
    sessionID
      ? { status: "preserved", sessionID }
      : { status: "preserved" },
  )
}

function quarantineWriter(directory, sessionID) {
  writerDirectoryStates.set(
    directory,
    sessionID
      ? { status: "quarantined", sessionID }
      : { status: "quarantined" },
  )
}

/*
 * Test hook: clears cached client state and writer locks. Production
 * code never calls this.
 */
export function resetBridgeStateForTests() {
  clientPromise = undefined
  writerDirectoryStates.clear()
}

/*
 * Normalize the read-only session.get() result. The generated client
 * resolves SessionInfo directly; tolerate an optional { data: SessionInfo }
 * wrapper. Returns null when no object shape is present.
 */
function normalizeSessionProgressInfo(raw) {
  const info =
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    raw.data !== null &&
    typeof raw.data === "object" &&
    !Array.isArray(raw.data)
      ? raw.data
      : raw

  if (
    info === null ||
    typeof info !== "object" ||
    Array.isArray(info)
  ) {
    return null
  }

  return info
}

/*
 * Extract only safe scalar telemetry from SessionInfo. Never includes
 * prompt text, message contents, titles, agents, models, locations, or
 * metadata. Missing optional fields are omitted.
 */
function extractProgressSnapshot(info) {
  const snapshot = {}

  const updated = info?.time?.updated

  if (
    typeof updated === "number" &&
    Number.isFinite(updated)
  ) {
    snapshot.updated_at = updated
  }

  const idle = info?.time?.idle

  if (
    typeof idle === "number" &&
    Number.isFinite(idle)
  ) {
    snapshot.idle_at = idle
  }

  if (
    typeof info?.outcome === "string" &&
    info.outcome !== ""
  ) {
    snapshot.outcome = info.outcome
  }

  const tokens = info?.tokens

  if (
    tokens !== null &&
    typeof tokens === "object" &&
    !Array.isArray(tokens)
  ) {
    if (
      typeof tokens.input === "number" &&
      Number.isFinite(tokens.input)
    ) {
      snapshot.tokens_input = tokens.input
    }

    if (
      typeof tokens.output === "number" &&
      Number.isFinite(tokens.output)
    ) {
      snapshot.tokens_output = tokens.output
    }

    if (
      typeof tokens.reasoning === "number" &&
      Number.isFinite(tokens.reasoning)
    ) {
      snapshot.tokens_reasoning = tokens.reasoning
    }

    const cache = tokens.cache

    if (
      cache !== null &&
      typeof cache === "object" &&
      !Array.isArray(cache)
    ) {
      if (
        typeof cache.read === "number" &&
        Number.isFinite(cache.read)
      ) {
        snapshot.tokens_cache_read = cache.read
      }

      if (
        typeof cache.write === "number" &&
        Number.isFinite(cache.write)
      ) {
        snapshot.tokens_cache_write = cache.write
      }
    }
  }

  if (
    typeof info?.cost === "number" &&
    Number.isFinite(info.cost)
  ) {
    snapshot.cost = info.cost
  }

  return snapshot
}

function progressSnapshotsEqual(previous, current) {
  const keys = new Set([
    ...Object.keys(previous),
    ...Object.keys(current),
  ])

  for (const key of keys) {
    if (previous[key] !== current[key]) {
      return false
    }
  }

  return true
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

async function resolveConfiguredParentTimeoutSeconds(overrides = {}) {
  if (overrides.parentTimeoutSeconds !== undefined) {
    return overrides.parentTimeoutSeconds
  }

  const config = await configuredBridgeConfig()
  const timeouts =
    config.timeoutLimits?.limits
      ? config.timeoutLimits
      : normalizeConfigTimeoutLimits(config)

  return timeouts.parentTimeoutSeconds
}

async function cleanupSession(client, sessionID, succeeded, options = {}) {
  /*
   * session.interrupt stops in-flight model work after unsuccessful operations.
   * Normal mode then removes the session and confirms deletion. Diagnostic
   * preservation mode deliberately skips removal so postmortem session state
   * survives. Cleanup never receives the operation AbortSignal and never
   * throws.
   */
  const cleanupTimeoutMs =
    options.cleanupTimeoutMs ?? SESSION_CLEANUP_TIMEOUT_MS

  if (!succeeded) {
    await settleWithin(
      (async () => {
        try {
          await client.session.interrupt({ sessionID })
        } catch {
          // Best effort only.
        }
      })(),
      cleanupTimeoutMs,
    )
  }

  if (options.preserveSession === true) {
    const log = options.log ?? diagnosticEvent

    log({
      event: "session_preserved",
      session_id: sessionID,
      succeeded,
      ...options.metadata,
    })

    return {
      removeConfirmed: false,
      preserved: true,
    }
  }

  let removeConfirmed = false
  let timer

  try {
    const removeOutcome = (async () => {
      try {
        await client.session.remove({ sessionID })
        return "removed"
      } catch {
        return "failed"
      }
    })()

    const timeoutOutcome = new Promise((innerResolve) => {
      timer = setTimeout(() => innerResolve("timeout"), cleanupTimeoutMs)

      if (typeof timer.unref === "function") {
        timer.unref()
      }
    })

    const outcome = await Promise.race([
      removeOutcome,
      timeoutOutcome,
    ])

    removeConfirmed = outcome === "removed"
  } finally {
    clearTimeout(timer)
  }

  return {
    removeConfirmed,
    preserved: false,
  }
}

export async function waitForSessionCompletion(
  client,
  sessionID,
  operationSignal,
  options = {},
) {
  const refreshMs =
    options.refreshMs ?? SESSION_WAIT_REFRESH_MS
  const operationStartedAt =
    options.operationStartedAt ?? Date.now()
  const operationDeadlineAt =
    options.operationDeadlineAt ?? Number.POSITIVE_INFINITY
  const log = options.log ?? debug

  if (!Number.isInteger(refreshMs) || refreshMs < 1) {
    throw new Error(
      "session wait refresh must be a positive integer number of milliseconds"
    )
  }

  const errorDetails = (error) => {
    const causeChain = []
    let cause = error?.cause

    while (cause !== undefined && causeChain.length < 4) {
      causeChain.push({
        name: cause?.name ?? typeof cause,
        ...(cause?.code !== undefined
          ? { code: String(cause.code) }
          : {}),
      })
      cause = cause?.cause
    }

    const details = {
      error_name: error?.name ?? typeof error,
    }

    if (error?.code !== undefined) {
      details.error_code = String(error.code)
    }

    if (causeChain.length > 0) {
      details.error_cause_chain = causeChain
    }

    return details
  }

  let attempt = 0
  let previousProgressSnapshot = null

  const readSessionProgress = async (waitAttempt) => {
    /*
     * Read-only telemetry between bounded waits. Never prompts, steers,
     * queues, restarts, recreates, interrupts, or resends anything. Uses
     * the outer operation signal (never the already-aborted refresh
     * signal) combined with a short timeout so the read cannot delay the
     * next wait or pass the absolute operation deadline. Failures are
     * logged diagnostically and never fail the operation.
     */
    if (operationSignal?.aborted) {
      return
    }

    if (
      !client?.session ||
      typeof client.session.get !== "function"
    ) {
      log(JSON.stringify({
        event: "session_progress_unavailable",
        session_id: sessionID,
        wait_attempt: waitAttempt,
        elapsed_operation_ms: Date.now() - operationStartedAt,
        remaining_operation_ms: Math.max(
          0,
          operationDeadlineAt - Date.now(),
        ),
        reason: "session_get_unavailable",
        ...errorDetails(
          new Error("session progress read is unavailable"),
        ),
      }))

      return
    }

    const remainingMs = operationDeadlineAt - Date.now()

    if (remainingMs <= 0) {
      return
    }

    const budgetMs = Math.min(
      SESSION_PROGRESS_READ_TIMEOUT_MS,
      remainingMs,
    )
    const progressController = new AbortController()
    let progressTimer

    const timeoutOutcome = new Promise((innerResolve) => {
      progressTimer = setTimeout(() => {
        progressController.abort()

        innerResolve({
          status: "timeout",
        })
      }, budgetMs)

      if (typeof progressTimer?.unref === "function") {
        progressTimer.unref()
      }
    })

    try {
      const progressSignal = operationSignal
        ? AbortSignal.any([
            operationSignal,
            progressController.signal,
          ])
        : progressController.signal

      const readOutcome = (async () => {
        try {
          const raw = await client.session.get(
            { sessionID },
            { signal: progressSignal },
          )

          return { status: "ready", raw }
        } catch (error) {
          return { status: "failed", error }
        }
      })()

      const outcome = await Promise.race([
        readOutcome,
        timeoutOutcome,
      ])

      if (outcome.status === "ready") {
        const info = normalizeSessionProgressInfo(outcome.raw)

        if (info === null) {
          log(JSON.stringify({
            event: "session_progress_unavailable",
            session_id: sessionID,
            wait_attempt: waitAttempt,
            elapsed_operation_ms: Date.now() - operationStartedAt,
            remaining_operation_ms: Math.max(
              0,
              operationDeadlineAt - Date.now(),
            ),
            reason: "empty_progress_snapshot",
            ...errorDetails(
              new Error("session progress snapshot was empty"),
            ),
          }))
        } else {
          const snapshot = extractProgressSnapshot(info)
          const changed = previousProgressSnapshot === null
            ? null
            : !progressSnapshotsEqual(
                previousProgressSnapshot,
                snapshot,
              )

          previousProgressSnapshot = snapshot

          log(JSON.stringify({
            event: "session_progress",
            session_id: sessionID,
            wait_attempt: waitAttempt,
            elapsed_operation_ms: Date.now() - operationStartedAt,
            remaining_operation_ms: Math.max(
              0,
              operationDeadlineAt - Date.now(),
            ),
            changed,
            ...snapshot,
          }))
        }
      } else if (outcome.status === "failed") {
        log(JSON.stringify({
          event: "session_progress_unavailable",
          session_id: sessionID,
          wait_attempt: waitAttempt,
          elapsed_operation_ms: Date.now() - operationStartedAt,
          remaining_operation_ms: Math.max(
            0,
            operationDeadlineAt - Date.now(),
          ),
          reason: "session_get_failed",
          ...errorDetails(outcome.error),
        }))
      } else {
        log(JSON.stringify({
          event: "session_progress_unavailable",
          session_id: sessionID,
          wait_attempt: waitAttempt,
          elapsed_operation_ms: Date.now() - operationStartedAt,
          remaining_operation_ms: Math.max(
            0,
            operationDeadlineAt - Date.now(),
          ),
          reason: "progress_read_timeout",
          ...errorDetails(
            new Error("session progress read timed out"),
          ),
        }))
      }
    } finally {
      if (progressTimer !== undefined) {
        clearTimeout(progressTimer)
      }
    }
  }

  while (true) {
    if (operationSignal?.aborted) {
      throw (
        operationSignal.reason instanceof Error
          ? operationSignal.reason
          : new Error("OpenCode session wait was aborted")
      )
    }

    const attemptStartedAt = Date.now()
    const remainingMs = operationDeadlineAt - attemptStartedAt

    if (remainingMs <= 0) {
      throw new Error(
        `OpenCode session ${sessionID} exceeded its overall operation deadline`
      )
    }

    attempt += 1

    const refreshController = new AbortController()
    const shouldRefresh = remainingMs > refreshMs
    const signal = operationSignal && shouldRefresh
      ? AbortSignal.any([
          operationSignal,
          refreshController.signal,
        ])
      : operationSignal ?? refreshController.signal

    const refreshTimer = shouldRefresh
      ? setTimeout(
          () => refreshController.abort(),
          refreshMs,
        )
      : undefined

    if (typeof refreshTimer?.unref === "function") {
      refreshTimer.unref()
    }

    try {
      await client.session.wait(
        { sessionID },
        { signal },
      )

      return
    } catch (error) {
      if (
        operationSignal?.aborted ||
        !shouldRefresh ||
        !refreshController.signal.aborted
      ) {
        log(JSON.stringify({
          event: "session_wait_failure",
          session_id: sessionID,
          wait_attempt: attempt,
          elapsed_operation_ms: Date.now() - operationStartedAt,
          remaining_operation_ms: Math.max(
            0,
            operationDeadlineAt - Date.now(),
          ),
          reason: operationSignal?.aborted
            ? "overall_operation_aborted"
            : "wait_rejected_before_refresh_boundary",
          ...errorDetails(error),
        }))

        throw error
      }

      log(JSON.stringify({
        event: "session_wait_refresh",
        session_id: sessionID,
        wait_attempt: attempt,
        elapsed_operation_ms: Date.now() - operationStartedAt,
        remaining_operation_ms: Math.max(
          0,
          operationDeadlineAt - Date.now(),
        ),
        reason: "bounded_wait_refresh_elapsed",
        refresh_ms: refreshMs,
        ...errorDetails(error),
      }))

      await readSessionProgress(attempt)
    } finally {
      if (refreshTimer !== undefined) {
        clearTimeout(refreshTimer)
      }
    }
  }
}

export async function runAgent(directoryArg, task, agent, role, overrides = {}) {
  /*
   * Canonicalize and validate before any OpenCode session exists, so
   * invalid cwd values fail without reading runtime configuration or creating
   * (or leaking) sessions. Error messages below never interpolate prompt
   * contents.
   */
  const directory = await resolveCanonicalCwd(directoryArg, overrides)

  const timeoutMs =
    await resolveOperationTimeoutMs(role, overrides)
  const preserveSession =
    overrides.preserveSession ??
    resolvePreserveSessions(overrides.env ?? process.env)

  if (
    role === "runner" &&
    overrides.commandTimeoutSeconds !== undefined
  ) {
    assertRunnerTimeoutFits(
      overrides.commandTimeoutSeconds,
      Math.floor(timeoutMs / 1000),
    )
  }

  /*
   * Configured caller-budget preflight: the actual operation timeout
   * (including OPENCODE_MCP_ORCHESTRATOR_BRIDGE_TIMEOUT_MS and test
   * overrides) plus cleanup/result reserve must fit within the configured
   * parent timeout. This runs before writer-lock acquisition and before
   * any session/client work. It enforces only the configured parent
   * budget; the SDK context exposes no reliable live host deadline.
   */
  const operationTimeoutSeconds = Math.ceil(timeoutMs / 1000)
  const parentTimeoutSeconds =
    await resolveConfiguredParentTimeoutSeconds(overrides)

  assertOperationTimeoutFitsParent(
    operationTimeoutSeconds,
    parentTimeoutSeconds,
    `${role} (${agent})`,
    "configured parent",
  )

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
  const operationStartedAt = Date.now()
  const operationDeadlineAt = operationStartedAt + timeoutMs

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

  const timer = setTimeout(
    onTimeout,
    Math.max(0, operationDeadlineAt - Date.now()),
  )

  if (typeof timer.unref === "function") {
    timer.unref()
  }

  let sessionID
  let succeeded = false
  let sessionClient = overrides.client ?? null
  let cleanupAttempted = false
  let cleanupResult = null
  let work
  let result
  let operationError
  let quarantineError

  /*
   * Exactly-once session cleanup/preservation. The outer finally runs it
   * promptly when timeout or cancellation wins the race; the background hook
   * below guarantees it when the operation itself settles later (including a
   * session created after the timeout already fired). Normal mode removes the
   * session. Diagnostic mode interrupts unsuccessful work but preserves the
   * session for postmortem inspection.
   */
  const cleanupOnce = async () => {
    if (cleanupAttempted) {
      return cleanupResult
    }

    if (!sessionID || !sessionClient) {
      return null
    }

    cleanupAttempted = true

    cleanupResult = await cleanupSession(
      sessionClient,
      sessionID,
      succeeded,
      {
        cleanupTimeoutMs: overrides.cleanupTimeoutMs,
        preserveSession,
        log: overrides.diagnosticLog,
        metadata: {
          role,
          agent,
          cwd: directory,
        },
      },
    )

    return cleanupResult
  }

  const reconcileLateWriter = async () => {
    const result = await cleanupOnce()

    if (result?.preserved === true) {
      preserveWriter(directory, sessionID)
      return
    }

    if (result?.removeConfirmed === true) {
      const current = writerDirectoryStates.get(directory)

      if (
        current &&
        (current.status === "quarantined" ||
          current.status === "cleaning")
      ) {
        clearWriterState(directory)
      }
    }
  }

  try {
    work = (async () => {
      const client = sessionClient ?? await getClient(overrides)

      sessionClient = client

      const model = overrides.model ?? await configuredModel(role)

      debug(
        `${role}: agent=${agent} model=${model.reference}${model.variant ? `#${model.variant}` : ""} cwd=${directory}`
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
            ...(model.variant !== undefined
              ? { variant: model.variant }
              : {}),
          },
        },
        requestOptions,
      )

      const budgetedTask = [
        task,
        "",
        `Operation wall-clock budget: ${Math.floor(timeoutMs / 1000)} seconds.`,
        "Finish tool activity and return the final response before this deadline.",
      ].join("\n")

      await client.session.prompt(
        {
          sessionID,
          text: budgetedTask,
        },
        requestOptions,
      )

      await waitForSessionCompletion(
        client,
        sessionID,
        requestOptions.signal,
        {
          refreshMs:
            overrides.sessionWaitRefreshMs ??
            resolveSessionWaitRefreshMs(overrides.env ?? process.env),
          operationStartedAt,
          operationDeadlineAt,
        },
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

    result = await Promise.race([
      work,
      timeoutPromise,
      cancelPromise,
    ])

    succeeded = true
  } catch (error) {
    /*
     * Delegated failures must never echo the prompt back to MCP
     * clients: redact it before the error leaves the bridge.
     */
    operationError = redactPromptFromError(error, task)
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

    if (takesWriterLock) {
      markWriterCleaning(directory)
    }

    await cleanupOnce()

    /*
     * Guarantee eventual cleanup/preservation for a session created after the
     * race already settled. Handlers are attached so a late background failure
     * stays handled, and cleanupOnce never throws.
     */
    if (work) {
      if (takesWriterLock) {
        work.then(
          () => reconcileLateWriter(),
          () => reconcileLateWriter(),
        )
      } else {
        work.then(
          () => cleanupOnce(),
          () => cleanupOnce(),
        )
      }
    }

    if (takesWriterLock) {
      const confirmed = cleanupResult?.removeConfirmed === true
      const preserved = cleanupResult?.preserved === true

      if (confirmed) {
        clearWriterState(directory)
      } else if (preserved) {
        preserveWriter(directory, sessionID)
      } else if (sessionID) {
        quarantineWriter(directory, sessionID)
        quarantineError = new Error(writerQuarantineMessage(directory))
      } else if (runController.signal.aborted) {
        /*
         * Timeout or cancellation won before session creation completed. In
         * preservation mode retain the writer lock without manufacturing a
         * cleanup failure; late reconciliation will attach the eventual
         * session id. Normal mode keeps the existing quarantine behavior.
         */
        if (preserveSession) {
          preserveWriter(directory)
        } else {
          quarantineWriter(directory)
          quarantineError = new Error(writerQuarantineMessage(directory))
        }
      } else {
        clearWriterState(directory)
      }
    }
  }

  if (operationError) {
    if (quarantineError) {
      operationError.message =
        `${operationError.message}; ${quarantineError.message}`
    }

    throw operationError
  }

  if (quarantineError) {
    throw quarantineError
  }

  return result
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

export const RUNNER_WORKSPACE_ACCESS_VALUES = ["read_only", "writable"]
export const RUNNER_NETWORK_ACCESS_VALUES = ["disabled", "host"]

export function resolveRunnerSelection(workspaceAccess = "read_only", networkAccess = "disabled") {
  if (
    workspaceAccess !== "read_only" &&
    workspaceAccess !== "writable"
  ) {
    throw new Error(
      `invalid workspace_access: expected "read_only" or "writable"`,
    )
  }

  if (
    networkAccess !== "disabled" &&
    networkAccess !== "host"
  ) {
    throw new Error(
      `invalid network_access: expected "disabled" or "host"`,
    )
  }

  if (workspaceAccess === "writable" && networkAccess === "host") {
    return {
      agent: "opencode-orchestrator-runner-writable-network",
      executionTool: "sandbox_run_network",
    }
  }

  if (workspaceAccess === "writable") {
    return {
      agent: "opencode-orchestrator-runner-writable",
      executionTool: "sandbox_run",
    }
  }

  if (networkAccess === "host") {
    return {
      agent: "opencode-orchestrator-runner-network",
      executionTool: "sandbox_run_network_ro",
    }
  }

  return {
    agent: "opencode-orchestrator-runner",
    executionTool: "sandbox_run_ro",
  }
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
        const networkAccess = args.network_access ?? "disabled"

        const { agent, executionTool } = resolveRunnerSelection(
          workspaceAccess,
          networkAccess,
        )

        const workspaceRules =
          workspaceAccess === "writable"
            ? [
                "Writes to the workspace are permitted only when required by the parent-requested command.",
                "Do not make unrelated edits or attempt repairs.",
              ]
            : [
                "Do not modify workspace files or attempt repairs.",
              ]

        const networkRules =
          networkAccess === "host"
            ? [
                "Network access mode: host. The parent explicitly granted host network access; use it only for the requested command and do not fetch unrelated resources or perform additional investigation.",
              ]
            : [
                "Network access mode: disabled. Network is unavailable in this sandbox; do not attempt external network access.",
              ]

        const task = [
          "Execute and analyze one local command.",
          "",
          `Workspace access mode: ${workspaceAccess}.`,
          `Network access mode: ${networkAccess}.`,
          `Use exactly ${executionTool} for the requested command; no other execution tool is permitted.`,
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
          `Run the command exactly once with ${executionTool}.`,
          `Pass the requested maximum runtime to ${executionTool}.`,
          "If the initial result is insufficient, inspect the persisted output with sandbox_log.",
          ...networkRules,
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
            commandTimeoutSeconds: timeout,
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
        "The command runs networkless by default in an isolated sandbox with Git metadata protected; host-network access is available only when the parent explicitly grants it. " +
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
        network_access: z.enum(["disabled", "host"]).default("disabled").describe(
          "Network access mode: disabled runs networkless, host grants parent-controlled host-network access"
        ),
      }),
      annotations: {
        // Static and conservative: annotations cannot vary per call,
        // so keep the writable (least permissive) hints for both modes.
        // openWorldHint is true because host-network access is reachable
        // through explicit parent grant even though the default is closed.
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
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
