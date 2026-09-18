import { Plugin } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
  writeSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs"
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { spawn, spawnSync } from "node:child_process"

import {
  normalizeSandboxRuntime,
  type SandboxRuntimeConfig,
} from "../../../config/sandbox-runtime.mjs"

import {
  WORKER_CONTAINER_CAPABILITY_ROOT,
  workerContainerActivityPath,
  workerContainerCapabilityPath,
} from "../../../config/worker-container-capability.mjs"

import {
  hasNetworklessIsolation,
  normalizeSandboxNetworkAccess,
} from "../../../config/sandbox-isolation.mjs"

import {
  SANDBOX_TOOLCHAIN_DIRS_ENV as SHARED_SANDBOX_TOOLCHAIN_DIRS_ENV,
  addAbsoluteWorktreeBind as sharedAddAbsoluteWorktreeBind,
  addSandboxRuntimeBinds as sharedAddSandboxRuntimeBinds,
  addSandboxToolchainBinds as sharedAddSandboxToolchainBinds,
  buildBaseSandboxArgv,
  parseSandboxToolchainEntries as sharedParseSandboxToolchainEntries,
  resolveSandboxRuntimeCapabilities as sharedResolveSandboxRuntimeCapabilities,
  resolveSandboxToolchainDirs as sharedResolveSandboxToolchainDirs,
  runnerOutputBindArgs as sharedRunnerOutputBindArgs,
  safeSystemPath as sharedSafeSystemPath,
  sandboxPathWithToolchains as sharedSandboxPathWithToolchains,
} from "../../../config/sandbox-bubblewrap.mjs"

export const RUNNER_ROOT = "/tmp/opencode-runner-runs"
export const RUNNER_LOG_LIMIT_BYTES =
  128 * 1024 * 1024

export const SANDBOX_SHELL_TIMEOUT_MS_ENV =
  "OPENCODE_SANDBOX_SHELL_TIMEOUT_MS"
export const SANDBOX_SHELL_TIMEOUT_MS_DEFAULT = 120000
export const SANDBOX_SHELL_TIMEOUT_MS_MIN = 1000
export const SANDBOX_SHELL_TIMEOUT_MS_MAX = 900000

export const SANDBOX_SHELL_MAX_OUTPUT_BYTES_ENV =
  "OPENCODE_SANDBOX_SHELL_MAX_OUTPUT_BYTES"
export const SANDBOX_SHELL_MAX_OUTPUT_BYTES_DEFAULT = 30000
export const SANDBOX_SHELL_MAX_OUTPUT_BYTES_MIN = 4096
export const SANDBOX_SHELL_MAX_OUTPUT_BYTES_MAX = 1048576

export const SANDBOX_RUNNER_LOG_LIMIT_BYTES_ENV =
  "OPENCODE_SANDBOX_RUNNER_LOG_LIMIT_BYTES"
export const SANDBOX_RUNNER_LOG_LIMIT_BYTES_DEFAULT =
  128 * 1024 * 1024
export const SANDBOX_RUNNER_LOG_LIMIT_BYTES_MIN = 1048576
export const SANDBOX_RUNNER_LOG_LIMIT_BYTES_MAX = 536870912

export const SANDBOX_RUN_RETENTION_HOURS_ENV =
  "OPENCODE_SANDBOX_RUN_RETENTION_HOURS"
export const SANDBOX_RUN_RETENTION_HOURS_DEFAULT = 24
export const SANDBOX_RUN_RETENTION_HOURS_MIN = 1
export const SANDBOX_RUN_RETENTION_HOURS_MAX = 168

export const SANDBOX_RUN_RETENTION_COUNT_ENV =
  "OPENCODE_SANDBOX_RUN_RETENTION_COUNT"
export const SANDBOX_RUN_RETENTION_COUNT_DEFAULT = 20
export const SANDBOX_RUN_RETENTION_COUNT_MIN = 1
export const SANDBOX_RUN_RETENTION_COUNT_MAX = 200

const SHELL_MAX_OUTPUT = 30000

export const ORCHESTRATOR_AGENT_PREFIX =
  "opencode-orchestrator-"

export const MUSE_SPARK_MODEL_PREFIX =
  "muse-spark-"

type MuseFinalHttpRequest = {
  readonly sessionID?: unknown
  readonly agent?: unknown
  readonly kind?: unknown
  readonly model?: {
    readonly providerID?: unknown
    readonly id?: unknown
  }
  request: Request
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  )
}

/*
 * OpenCode's v2 runner removes every tool on an agent's final configured step
 * and also sends tool_choice="none". Muse Spark through OpenCode Console only
 * accepts the default/"auto" choice, so that otherwise safe text-only request
 * fails before the model can return its final report.
 *
 * Omit only that unsupported wire field, and only after proving this is a
 * primary request for one of our Muse agents with no tools. With no advertised
 * tools, the provider's default "auto" mode cannot execute a tool, so the hard
 * OpenCode step boundary remains intact. Any unfamiliar shape is left alone.
 */
export async function omitUnsupportedMuseFinalToolChoice(
  input: MuseFinalHttpRequest,
): Promise<boolean> {
  if (
    input.kind !== "primary" ||
    typeof input.agent !== "string" ||
    !input.agent.startsWith(ORCHESTRATOR_AGENT_PREFIX) ||
    input.model?.providerID !== "opencode" ||
    typeof input.model?.id !== "string" ||
    !input.model.id.startsWith(MUSE_SPARK_MODEL_PREFIX) ||
    input.request.method !== "POST" ||
    !input.request.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json")
  ) {
    return false
  }

  let body: unknown

  try {
    body = await input.request.clone().json()
  } catch {
    return false
  }

  if (
    !isRecord(body) ||
    body.tool_choice !== "none" ||
    !(
      body.tools === undefined ||
      (Array.isArray(body.tools) && body.tools.length === 0)
    )
  ) {
    return false
  }

  const rewritten = { ...body }
  delete rewritten.tool_choice

  const headers = new Headers(input.request.headers)
  headers.delete("content-length")

  input.request = new Request(input.request, {
    body: JSON.stringify(rewritten),
    headers,
  })

  return true
}

/*
 * OpenCode Console/Zen may route consecutive Muse Spark requests through
 * different upstream callers. Replaying the previous response's encrypted
 * reasoning state then fails with `encrypted_content was not issued to this
 * caller`. Delegated sessions do not need hidden reasoning history to preserve
 * their visible text and tool transcript, so remove only reasoning parts from
 * orchestrator-owned Muse requests before OpenCode lowers the next provider
 * request. Other agents, providers, and models remain untouched.
 */
export function stripUnreplayableMuseReasoning(input: {
  agent?: unknown
  model?: {
    providerID?: unknown
    id?: unknown
  }
  messages?: Array<{
    readonly role?: unknown
    readonly content?: ReadonlyArray<{ readonly type?: unknown }>
  }>
}): number {
  if (
    typeof input.agent !== "string" ||
    !input.agent.startsWith(ORCHESTRATOR_AGENT_PREFIX) ||
    input.model?.providerID !== "opencode" ||
    typeof input.model?.id !== "string" ||
    !input.model.id.startsWith(MUSE_SPARK_MODEL_PREFIX) ||
    !Array.isArray(input.messages)
  ) {
    return 0
  }

  let removed = 0

  for (const [index, message] of input.messages.entries()) {
    if (
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    ) {
      continue
    }

    let messageRemoved = 0

    const retained = message.content.filter((part) => {
      if (part?.type !== "reasoning") {
        return true
      }

      removed += 1
      messageRemoved += 1
      return false
    })

    if (messageRemoved > 0) {
      input.messages[index] = {
        ...message,
        content: retained,
      }
    }
  }

  return removed
}

export function resolveSandboxIntEnv(
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name]

  if (raw === undefined) return defaultValue

  const trimmed = raw.trim()

  if (
    trimmed === "" ||
    !/^-?\d+$/.test(trimmed)
  ) {
    throw new Error(`invalid ${name}`)
  }

  const value = Number(trimmed)

  if (!Number.isSafeInteger(value)) {
    throw new Error(`invalid ${name}`)
  }

  if (value < min || value > max) {
    throw new Error(`invalid ${name}`)
  }

  return value
}

export function resolveSandboxShellTimeoutMs(): number {
  return resolveSandboxIntEnv(
    SANDBOX_SHELL_TIMEOUT_MS_ENV,
    SANDBOX_SHELL_TIMEOUT_MS_DEFAULT,
    SANDBOX_SHELL_TIMEOUT_MS_MIN,
    SANDBOX_SHELL_TIMEOUT_MS_MAX,
  )
}

export function resolveSandboxShellMaxOutputBytes(): number {
  return resolveSandboxIntEnv(
    SANDBOX_SHELL_MAX_OUTPUT_BYTES_ENV,
    SANDBOX_SHELL_MAX_OUTPUT_BYTES_DEFAULT,
    SANDBOX_SHELL_MAX_OUTPUT_BYTES_MIN,
    SANDBOX_SHELL_MAX_OUTPUT_BYTES_MAX,
  )
}

export function resolveRunnerLogLimitBytes(): number {
  return resolveSandboxIntEnv(
    SANDBOX_RUNNER_LOG_LIMIT_BYTES_ENV,
    SANDBOX_RUNNER_LOG_LIMIT_BYTES_DEFAULT,
    SANDBOX_RUNNER_LOG_LIMIT_BYTES_MIN,
    SANDBOX_RUNNER_LOG_LIMIT_BYTES_MAX,
  )
}

export function resolveRunnerRetentionHours(): number {
  return resolveSandboxIntEnv(
    SANDBOX_RUN_RETENTION_HOURS_ENV,
    SANDBOX_RUN_RETENTION_HOURS_DEFAULT,
    SANDBOX_RUN_RETENTION_HOURS_MIN,
    SANDBOX_RUN_RETENTION_HOURS_MAX,
  )
}

export function resolveRunnerRetentionCount(): number {
  return resolveSandboxIntEnv(
    SANDBOX_RUN_RETENTION_COUNT_ENV,
    SANDBOX_RUN_RETENTION_COUNT_DEFAULT,
    SANDBOX_RUN_RETENTION_COUNT_MIN,
    SANDBOX_RUN_RETENTION_COUNT_MAX,
  )
}

export function resolveRunnerRetentionMs(): number {
  return (
    resolveRunnerRetentionHours() *
    60 *
    60 *
    1000
  )
}

export interface SandboxLimits {
  shellTimeoutMs: number
  shellMaxOutputBytes: number
  runnerLogLimitBytes: number
  runnerRetentionHours: number
  runnerRetentionCount: number
  runnerRetentionMs: number
}

export function resolveSandboxLimits(): SandboxLimits {
  const shellTimeoutMs =
    resolveSandboxShellTimeoutMs()
  const shellMaxOutputBytes =
    resolveSandboxShellMaxOutputBytes()
  const runnerLogLimitBytes =
    resolveRunnerLogLimitBytes()
  const runnerRetentionHours =
    resolveRunnerRetentionHours()
  const runnerRetentionCount =
    resolveRunnerRetentionCount()

  return {
    shellTimeoutMs,
    shellMaxOutputBytes,
    runnerLogLimitBytes,
    runnerRetentionHours,
    runnerRetentionCount,
    runnerRetentionMs:
      runnerRetentionHours * 60 * 60 * 1000,
  }
}

export const GIT_STATUS_TIMEOUT_MS = 15000
export const SANDBOX_LOG_TIMEOUT_MS = 15000

export function isSpawnTimeout(
  result: { error?: unknown } | null | undefined,
): boolean {
  const error = result?.error as
    | { code?: unknown; message?: unknown }
    | undefined

  if (!error) return false
  if (error.code === "ETIMEDOUT") return true

  return (
    typeof error.message === "string" &&
    /timed out/i.test(error.message)
  )
}

export function gitStatusSpawnOptions(): {
  encoding: "utf8"
  maxBuffer: number
  timeout: number
} {
  return {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: GIT_STATUS_TIMEOUT_MS,
  }
}

export function sandboxLogSpawnOptions(): {
  encoding: "utf8"
  maxBuffer: number
  timeout: number
} {
  return {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: SANDBOX_LOG_TIMEOUT_MS,
  }
}

export function assertRunnerRootStat(
  entry: {
    isSymbolicLink(): boolean
    isDirectory(): boolean
    uid?: unknown
  },
  currentUid: unknown,
  root: string,
): void {
  if (entry.isSymbolicLink()) {
    throw new Error(
      `refusing symlink runner root: ${root}`,
    )
  }

  if (!entry.isDirectory()) {
    throw new Error(
      `runner root is not a directory: ${root}`,
    )
  }

  if (
    typeof entry.uid === "number" &&
    typeof currentUid === "number" &&
    entry.uid !== currentUid
  ) {
    throw new Error(
      `runner root not owned by current user: ${root}`,
    )
  }
}

export function ensureRunnerRoot(
  root: string = RUNNER_ROOT,
): string {
  const currentUid =
    typeof process.getuid === "function"
      ? process.getuid()
      : undefined

  try {
    assertRunnerRootStat(
      lstatSync(root),
      currentUid,
      root,
    )
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)?.code !==
      "ENOENT"
    ) {
      throw error
    }
  }

  mkdirSync(root, {
    recursive: true,
    mode: 0o700,
  })

  assertRunnerRootStat(
    lstatSync(root),
    currentUid,
    root,
  )

  chmodSync(root, 0o700)

  return root
}

const RUNNER_DEFAULT_TIMEOUT_SECONDS = 900
const RUNNER_MAX_TIMEOUT_SECONDS = 3600

function truncate(value: string, max = SHELL_MAX_OUTPUT): string {
  if (value.length <= max) return value
  return value.slice(0, max) + "\n...[output truncated]..."
}

export function addAbsoluteWorktreeBind(
  argv: string[],
  worktree: string,
  options?: {
    readonlyWorkspace?: boolean
  },
): void {
  sharedAddAbsoluteWorktreeBind(
    argv,
    worktree,
    options,
  )
}

export const SANDBOX_TOOLCHAIN_DIRS_ENV =
  SHARED_SANDBOX_TOOLCHAIN_DIRS_ENV

export const SANDBOX_RUNTIME_CONFIG_ENV =
  "OPENCODE_MCP_ORCHESTRATOR_CONFIG"

export type SandboxRuntimeCapabilities =
  import("../../../config/sandbox-bubblewrap.mjs").SandboxBubblewrapRuntime

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)

  return (
    rel === "" ||
    (
      rel !== ".." &&
      !rel.startsWith(".." + sep) &&
      !isAbsolute(rel)
    )
  )
}

export function sandboxRuntimeConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = env[SANDBOX_RUNTIME_CONFIG_ENV]

  if (override) return override

  const configHome = env.XDG_CONFIG_HOME

  if (configHome) {
    return join(
      configHome,
      "opencode-mcp-orchestrator/config.json",
    )
  }

  if (!env.HOME) return undefined

  return join(
    env.HOME,
    ".config/opencode-mcp-orchestrator/config.json",
  )
}

export function loadSandboxRuntimeConfig(options?: {
  env?: NodeJS.ProcessEnv
  worktree?: string
  readFileSync?: (path: string, encoding: "utf8") => string
}): SandboxRuntimeConfig {
  const env = options?.env ?? process.env
  const path = sandboxRuntimeConfigPath(env)

  if (!path || !existsSync(path)) {
    return { trustedRoots: [] }
  }

  try {
    if (options?.worktree) {
      const lexicalConfig = resolve(path)
      const lexicalWorktree = resolve(options.worktree)

      if (isWithin(lexicalWorktree, lexicalConfig)) {
        throw new Error("sandbox runtime configuration is inside worktree")
      }

      const canonicalConfig = realpathSync(path)
      const canonicalWorktree = realpathSync(options.worktree)

      if (isWithin(canonicalWorktree, canonicalConfig)) {
        throw new Error("sandbox runtime configuration resolves inside worktree")
      }
    }

    const read = options?.readFileSync ?? readFileSync
    const parsed = JSON.parse(read(path, "utf8"))

    return parsed?.sandboxRuntime === undefined
      ? { trustedRoots: [] }
      : normalizeSandboxRuntime(parsed.sandboxRuntime)
  } catch {
    throw new Error(
      "invalid sandbox runtime configuration",
    )
  }
}

export function networklessIsolationApplied(argv: unknown) {
  return hasNetworklessIsolation(argv)
}

export function resolveSandboxRuntimeCapabilities(options?: {
  config?: SandboxRuntimeConfig
  env?: NodeJS.ProcessEnv
  worktree?: string
  realpathSync?: (path: string) => string
  statSync?: (path: string) => { isDirectory(): boolean }
}): SandboxRuntimeCapabilities {
  const env = options?.env ?? process.env
  const config = options?.config ?? loadSandboxRuntimeConfig({
    env,
    worktree: options?.worktree,
  })
  return sharedResolveSandboxRuntimeCapabilities({
    config,
    env,
    realpathSync: options?.realpathSync,
    statSync: options?.statSync,
  })
}

export function safeSystemPath(options?: {
  path?: string
  realpathSync?: (path: string) => string
  statSync?: (path: string) => { isDirectory(): boolean }
}): string {
  return sharedSafeSystemPath(options)
}

export function parseSandboxToolchainEntries(
  raw: string | undefined | null,
  delim: string = delimiter,
): string[] {
  return sharedParseSandboxToolchainEntries(raw, delim)
}

export function resolveSandboxToolchainDirs(
  raw?: string,
  options?: {
    delimiter?: string
    home?: string | undefined
    realpathSync?: (path: string) => string
    statSync?: (path: string) => {
      isDirectory(): boolean
    }
  },
): string[] {
  return sharedResolveSandboxToolchainDirs(raw, options)
}

export function sandboxPathWithToolchains(
  basePath: string,
  toolchainDirs: string[],
): string {
  return sharedSandboxPathWithToolchains(basePath, toolchainDirs)
}

export function addSandboxToolchainBinds(
  argv: string[],
  dirs: string[],
): void {
  sharedAddSandboxToolchainBinds(argv, dirs)
}

export function addSandboxRuntimeBinds(
  argv: string[],
  roots: string[],
): void {
  sharedAddSandboxRuntimeBinds(argv, roots)
}

export function resolveSandboxCwd(
  worktree: string,
  requested?: string,
): string {
  if (!requested || requested === ".") {
    return "/workspace"
  }

  const display = requested

  const lexicalTarget = resolve(worktree, requested)
  const lexicalBase = resolve(worktree)
  const lexicalRel = relative(lexicalBase, lexicalTarget)

  if (
    lexicalRel === ".." ||
    lexicalRel.startsWith(".." + sep) ||
    isAbsolute(lexicalRel)
  ) {
    throw new Error(
      `cwd escapes worktree: ${display}`,
    )
  }

  let target: string

  try {
    target = realpathSync(
      resolve(worktree, requested),
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)
      ?.code

    if (code === "ENOENT") {
      throw new Error(
        `cwd does not exist: ${display}`,
      )
    }

    if (
      code === "EACCES" ||
      code === "EPERM"
    ) {
      throw new Error(
        `cwd is not accessible: ${display}`,
      )
    }

    if (code === "ENOTDIR") {
      throw new Error(
        `cwd is not a directory: ${display}`,
      )
    }

    throw new Error(`invalid cwd: ${display}`)
  }

  let stat: {
    isDirectory(): boolean
  }

  try {
    stat = statSync(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)
      ?.code

    if (code === "ENOENT") {
      throw new Error(
        `cwd does not exist: ${display}`,
      )
    }

    if (
      code === "EACCES" ||
      code === "EPERM"
    ) {
      throw new Error(
        `cwd is not accessible: ${display}`,
      )
    }

    throw new Error(`invalid cwd: ${display}`)
  }

  if (!stat.isDirectory()) {
    throw new Error(
      `cwd is not a directory: ${display}`,
    )
  }

  let canonicalWorktree: string

  try {
    canonicalWorktree = realpathSync(worktree)
  } catch {
    throw new Error(`invalid cwd: ${display}`)
  }

  const rel = relative(canonicalWorktree, target)

  if (
    rel === ".." ||
    rel.startsWith(".." + sep) ||
    isAbsolute(rel)
  ) {
    throw new Error(
      `cwd escapes worktree: ${display}`,
    )
  }

  return rel === ""
    ? "/workspace"
    : "/workspace/" + rel.split(sep).join("/")
}

export type SandboxNetworkAccess =
  "disabled" | "host"

export function baseSandboxArgs(
  worktree: string,
  sandboxCwd: string,
  options?: {
    readonlyWorkspace?: boolean
    networkAccess?: SandboxNetworkAccess
  },
): string[] {
  const toolchainDirs =
    resolveSandboxToolchainDirs()
  const runtime =
    resolveSandboxRuntimeCapabilities({ worktree })

  return buildBaseSandboxArgv(
    worktree,
    sandboxCwd,
    {
      readonlyWorkspace:
        options?.readonlyWorkspace,
      networkAccess: normalizeSandboxNetworkAccess(
        options?.networkAccess,
      ),
      toolchainDirs,
      runtime,
    },
  )
}

export type SessionWorktreeContext = {
  readonly sessionID?: unknown
}

export type SessionWorktreeGet = (args: {
  sessionID: string
}) => Promise<unknown>

function sessionInfoFromResponse(
  response: unknown,
): Record<string, unknown> | null {
  if (!isRecord(response)) return null

  const nested = (response as { data?: unknown })
    .data

  if (isRecord(nested)) return nested

  return response as Record<string, unknown>
}

export async function resolveSessionWorktree(
  context: SessionWorktreeContext | null | undefined,
  sessionGet: SessionWorktreeGet,
  fns?: {
    realpathSync?: (path: string) => string
    statSync?: (path: string) => {
      isDirectory(): boolean
    }
  },
): Promise<string> {
  const sessionID = context?.sessionID

  if (
    typeof sessionID !== "string" ||
    sessionID.trim() === ""
  ) {
    throw new Error(
      "sandbox session is unavailable",
    )
  }

  let response: unknown

  try {
    response = await sessionGet({
      sessionID,
    })
  } catch {
    throw new Error(
      "sandbox session lookup failed",
    )
  }

  const info = sessionInfoFromResponse(response)
  const location = info?.location

  const directory =
    isRecord(location) &&
    typeof location.directory === "string"
      ? location.directory
      : undefined

  if (!directory || directory.trim() === "") {
    throw new Error(
      "sandbox session has no directory",
    )
  }

  const realpathFn = fns?.realpathSync ?? realpathSync
  const statFn = fns?.statSync ?? statSync

  let canonical: string

  try {
    canonical = realpathFn(directory)
  } catch {
    throw new Error(
      "sandbox worktree is unavailable",
    )
  }

  let stat: { isDirectory(): boolean }

  try {
    stat = statFn(canonical)
  } catch {
    throw new Error(
      "sandbox worktree is unavailable",
    )
  }

  if (!stat.isDirectory()) {
    throw new Error(
      "sandbox worktree is not a directory",
    )
  }

  return canonical
}

function readTail(path: string, maxBytes = 7000): string {
  if (!existsSync(path)) return ""

  const size = statSync(path).size
  const start = Math.max(0, size - maxBytes)
  const length = size - start

  const fd = openSync(path, "r")

  try {
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, start)
    return buffer.toString("utf8")
  } finally {
    closeSync(fd)
  }
}

export function pruneRunnerRuns(overrides?: {
  retentionMs?: number
  maxRuns?: number
  root?: string
}) {
  const root =
    overrides?.root ?? RUNNER_ROOT
  const retentionMs =
    overrides?.retentionMs ??
    resolveRunnerRetentionMs()
  const maxRuns =
    overrides?.maxRuns ??
    resolveRunnerRetentionCount()
  ensureRunnerRoot(root)

  const now = Date.now()

  const entries = readdirSync(root)
    .map((name) => {
      const path = join(root, name)

      try {
        return {
          name,
          path,
          mtime: lstatSync(path).mtimeMs,
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.mtime - a.mtime)

  entries.forEach((entry: any, index) => {
    if (
      now - entry.mtime > retentionMs ||
      index >= maxRuns
    ) {
      try {
        rmSync(entry.path, {
          recursive: true,
          force: true,
        })
      } catch {
        // Best-effort cleanup only.
      }
    }
  })
}

export function resolveGitStatusOutput(result: {
  error?: unknown
  status?: number | null
  signal?: unknown
  stdout?: unknown
}): string {
  if (isSpawnTimeout(result)) {
    throw new Error(
      `git status timed out after ${GIT_STATUS_TIMEOUT_MS}ms`,
    )
  }

  if (result?.error) {
    throw new Error(
      "git status failed to start",
    )
  }

  if (
    typeof result?.signal === "string" &&
    result.signal !== ""
  ) {
    throw new Error(
      `git status terminated by signal: ${result.signal}`,
    )
  } else if (
    result?.signal !== null &&
    result?.signal !== undefined
  ) {
    throw new Error(
      "git status terminated by signal",
    )
  }

  if (result?.status !== 0) {
    throw new Error(
      `git status failed (exit ${String(result?.status)})`,
    )
  }

  if (typeof result?.stdout !== "string") {
    throw new Error(
      "git status produced unusable output",
    )
  }

  return result.stdout
}

export function gitStatus(
  worktree: string,
  deps?: {
    lstatSync?: (path: string) => unknown
    spawnSync?: (
      command: string,
      args: string[],
      options: {
        encoding: "utf8"
        maxBuffer: number
        timeout: number
      },
    ) => {
      error?: unknown
      status?: number | null
      signal?: unknown
      stdout?: unknown
    }
  },
): string {
  const lstat = deps?.lstatSync ?? lstatSync

  // Intentional non-Git workspaces stay supported; any present (even
  // inaccessible, dangling, or malformed) Git metadata must fail closed
  // below. Only ENOENT means ".git is absent". lstat (not existsSync, and
  // not stat) is used so dangling symlinks and permission errors are not
  // misreported as absent: existsSync swallows EACCES as false and stat
  // follows symlinks, while lstat succeeds on a dangling link and lets
  // git itself fail closed on it.
  try {
    lstat(join(worktree, ".git"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return ""

    throw new Error(
      "git status failed: unable to inspect git metadata",
    )
  }

  const spawn = deps?.spawnSync ?? spawnSync

  let result: {
    error?: unknown
    status?: number | null
    signal?: unknown
    stdout?: unknown
  }

  try {
    result = spawn(
      "/usr/bin/git",
      [
        "-C",
        worktree,
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ],
      gitStatusSpawnOptions(),
    )
  } catch {
    throw new Error(
      "git status failed to start",
    )
  }

  return resolveGitStatusOutput(result)
}

function statusDelta(before: string, after: string): string[] {
  const a = new Set(
    before.split("\n").filter(Boolean),
  )
  const b = new Set(
    after.split("\n").filter(Boolean),
  )

  const delta: string[] = []

  for (const line of b) {
    if (!a.has(line)) delta.push("+ " + line)
  }

  for (const line of a) {
    if (!b.has(line)) delta.push("- " + line)
  }

  return delta
}

export function validateRunID(
  runID: string,
  root: string = RUNNER_ROOT,
): string {
  if (!/^run-[A-Za-z0-9._-]+$/.test(runID)) {
    throw new Error("invalid run_id")
  }

  ensureRunnerRoot(root)

  const dir = join(root, runID)

  let entry: {
    isSymbolicLink(): boolean
    isDirectory(): boolean
  }

  try {
    entry = lstatSync(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)
      ?.code

    if (
      code === "ENOENT" ||
      code === "ENOTDIR"
    ) {
      throw new Error(`unknown run_id: ${runID}`)
    }

    if (
      code === "EACCES" ||
      code === "EPERM"
    ) {
      throw new Error(
        `run_id is not accessible: ${runID}`,
      )
    }

    throw new Error(`invalid run_id: ${runID}`)
  }

  if (entry.isSymbolicLink()) {
    throw new Error(
      "run_id escapes runner storage",
    )
  }

  if (!entry.isDirectory()) {
    throw new Error(`invalid run_id: ${runID}`)
  }

  let realRoot: string

  try {
    realRoot = realpathSync(root)
  } catch {
    throw new Error(`invalid run_id: ${runID}`)
  }

  let realDir: string

  try {
    realDir = realpathSync(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)
      ?.code

    if (
      code === "ENOENT" ||
      code === "ENOTDIR"
    ) {
      throw new Error(`unknown run_id: ${runID}`)
    }

    if (
      code === "EACCES" ||
      code === "EPERM"
    ) {
      throw new Error(
        `run_id is not accessible: ${runID}`,
      )
    }

    throw new Error(`invalid run_id: ${runID}`)
  }

  const rel = relative(realRoot, realDir)

  if (
    rel === ".." ||
    rel.startsWith(".." + sep) ||
    isAbsolute(rel)
  ) {
    throw new Error(
      "run_id escapes runner storage",
    )
  }

  return realDir
}

const CAPTURE_SCRIPT = String.raw`
import subprocess
import sys

command = sys.argv[1]
limit = int(sys.argv[2])

process = subprocess.Popen(
    ["/bin/bash", "--noprofile", "--norc", "-c", command],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)

written = 0
truncated = False

with open("/runner-output/combined.log", "wb", buffering=0) as log:
    while True:
        chunk = process.stdout.read(65536)
        if not chunk:
            break

        if written < limit:
            keep = chunk[: max(0, limit - written)]
            if keep:
                log.write(keep)
                written += len(keep)

            if len(keep) != len(chunk):
                truncated = True
        else:
            truncated = True

return_code = process.wait()

if return_code < 0:
    normalized = 128 + (-return_code)
else:
    normalized = return_code

with open("/runner-output/exit_code", "w", encoding="utf-8") as f:
    f.write(str(normalized))

if truncated:
    with open("/runner-output/truncated", "w", encoding="utf-8") as f:
        f.write("1")

sys.exit(normalized if 0 <= normalized <= 255 else 1)
`

/*
 * Model-controlled tool input keys for both sandbox_run variants.
 * Mount selection is server-controlled (tool identity) and never read from
 * these inputs.
 */
export const SANDBOX_RUN_INPUT_PROPERTY_NAMES = [
  "command",
  "cwd",
  "timeout_seconds",
] as const

export function sandboxRunInputSchema(): {
  type: "object"
  properties: {
    command: {
      type: "string"
      minLength: number
      description: string
    }
    cwd: {
      type: "string"
      description: string
    }
    timeout_seconds: {
      type: "integer"
      minimum: number
      maximum: number
      description: string
    }
  }
  required: string[]
  additionalProperties: false
} {
  return {
    type: "object",
    properties: {
      command: {
        type: "string",
        minLength: 1,
        description: "Exact command to execute",
      },

      cwd: {
        type: "string",
        description:
          "Optional working directory relative to the repository root",
      },

      timeout_seconds: {
        type: "integer",
        minimum: 1,
        maximum: RUNNER_MAX_TIMEOUT_SECONDS,
        description:
          "Maximum runtime in seconds",
      },
    },

    required: ["command"],
    additionalProperties: false,
  }
}

/*
 * /runner-output is always a writable bind in both sandbox_run variants.
 */
export function runnerOutputBindArgs(
  runDir: string,
): string[] {
  return sharedRunnerOutputBindArgs(runDir)
}

export function buildSandboxRunArgv(
  worktree: string,
  sandboxCwd: string,
  runDir: string,
  command: string,
  options?: {
    readonlyWorkspace?: boolean
    networkAccess?: SandboxNetworkAccess
    logLimitBytes?: number
  },
): string[] {
  const argv = baseSandboxArgs(
    worktree,
    sandboxCwd,
    options,
  )

  const logLimit =
    options?.logLimitBytes ??
    resolveRunnerLogLimitBytes()

  argv.push(
    ...runnerOutputBindArgs(runDir),

    "/usr/bin/python3",
    "-c",
    CAPTURE_SCRIPT,
    command,
    String(logLimit),
  )

  return argv
}

export interface SandboxRunInput {
  command: string
  cwd?: string
  timeout_seconds?: number
}

async function executeSandboxRun(
  worktree: string,
  input: SandboxRunInput,
  options: {
    readonlyWorkspace: boolean
    networkAccess?: SandboxNetworkAccess
  },
): Promise<{ content: string }> {
  const limits = resolveSandboxLimits()

  pruneRunnerRuns({
    retentionMs: limits.runnerRetentionMs,
    maxRuns: limits.runnerRetentionCount,
  })

  const {
    command,
    cwd,
    timeout_seconds,
  } = input

  const timeoutSeconds = Math.max(
    1,
    Math.min(
      timeout_seconds ??
        RUNNER_DEFAULT_TIMEOUT_SECONDS,
      RUNNER_MAX_TIMEOUT_SECONDS,
    ),
  )

  const sandboxCwd =
    resolveSandboxCwd(worktree, cwd)

  ensureRunnerRoot()

  const runDir = mkdtempSync(
    join(RUNNER_ROOT, "run-"),
  )

  const runID = basename(runDir)
  const combinedLog =
    join(runDir, "combined.log")

  const beforeStatus =
    gitStatus(worktree)

  const argv = buildSandboxRunArgv(
    worktree,
    sandboxCwd,
    runDir,
    command,
    {
      readonlyWorkspace:
        options.readonlyWorkspace,
      networkAccess: normalizeSandboxNetworkAccess(
        options.networkAccess,
      ),
      logLimitBytes:
        limits.runnerLogLimitBytes,
    },
  )

  const started = Date.now()

  const proc = Bun.spawn(argv, {
    stdout: "ignore",
    stderr: "pipe",
    env: {
      PATH: "/usr/bin:/bin",
    },
  })

  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true

    try {
      proc.kill("SIGKILL")
    } catch {
      // Already exited.
    }
  }, timeoutSeconds * 1000)

  const [launcherStderr, launcherExitCode] =
    await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ])

  clearTimeout(timer)

  const elapsedMs =
    Date.now() - started

  let exitCode = launcherExitCode

  const exitCodePath =
    join(runDir, "exit_code")

  if (existsSync(exitCodePath)) {
    const parsed = Number(
      readFileSync(
        exitCodePath,
        "utf8",
      ).trim(),
    )

    if (Number.isFinite(parsed)) {
      exitCode = parsed
    }
  }

  const afterStatus =
    gitStatus(worktree)

  const delta =
    statusDelta(
      beforeStatus,
      afterStatus,
    )

  const bytes =
    existsSync(combinedLog)
      ? statSync(combinedLog).size
      : 0

  const truncated =
    existsSync(join(runDir, "truncated"))

  const tail =
    readTail(combinedLog, 7000)

  return {
    content: [
      `run_id=${runID}`,
      `exit_code=${exitCode}`,
      `timed_out=${timedOut}`,
      `elapsed_ms=${elapsedMs}`,
      `log_bytes=${bytes}`,
      `log_truncated=${truncated}`,
      `worktree_status_changed=${delta.length > 0}`,
      delta.length > 0
        ? "worktree_status_delta:\n" +
          truncate(
            delta.slice(0, 30).join("\n"),
            6000,
          )
        : "worktree_status_delta:",
      launcherStderr
        ? "launcher_stderr:\n" +
          truncate(
            launcherStderr,
            5000,
          )
        : "launcher_stderr:",
      tail
        ? "log_tail:\n" + tail
        : "log_tail:",
      "",
      "Use sandbox_log with this run_id to search or inspect the persisted full log.",
    ].join("\n"),
  }
}


export const EXISTING_CONTAINER_RUNTIME_PATHS = [
  "/usr/bin/podman",
  "/usr/bin/docker",
] as const

export const CONTAINER_RUN_INPUT_PROPERTY_NAMES = [
  "argv",
  "workdir",
  "timeout_seconds",
] as const

export interface WorkerContainerCapability {
  version: 1
  container: string
  workspaceAccess: "read_only" | "writable"
  containerCwd: "auto" | string
  networkAccess: "inherit"
  hostCwd: string
}

export interface ContainerRunInput {
  argv: string[]
  workdir?: string
  timeout_seconds?: number
}

export function containerRunInputSchema() {
  return {
    type: "object" as const,
    properties: {
      argv: {
        type: "array",
        items: {
          type: "string",
        },
        minItems: 1,
        maxItems: 256,
        description:
          "Executable and arguments to run in the parent-selected container; no shell interpolation is performed",
      },
      workdir: {
        type: "string",
        minLength: 1,
        description:
          "Optional working directory inside the selected container",
      },
      timeout_seconds: {
        type: "integer",
        minimum: 1,
        maximum: RUNNER_MAX_TIMEOUT_SECONDS,
        description:
          "Maximum runtime in seconds",
      },
    },
    required: ["argv"],
    additionalProperties: false,
  }
}

function validateWorkerContainerCapability(
  value: unknown,
): WorkerContainerCapability {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("invalid worker container capability")
  }

  const {
    container,
    workspaceAccess,
    containerCwd,
    networkAccess,
    hostCwd,
  } = value

  if (
    typeof container !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container) ||
    container.length > 256 ||
    (
      workspaceAccess !== "read_only" &&
      workspaceAccess !== "writable"
    ) ||
    (
      containerCwd !== "auto" &&
      (
        typeof containerCwd !== "string" ||
        !isAbsolute(containerCwd)
      )
    ) ||
    networkAccess !== "inherit" ||
    typeof hostCwd !== "string" ||
    !isAbsolute(hostCwd)
  ) {
    throw new Error("invalid worker container capability")
  }

  return value as unknown as WorkerContainerCapability
}

export function readWorkerContainerCapability(
  sessionID: string,
  options?: {
    root?: string
    readFileSync?: typeof readFileSync
  },
): WorkerContainerCapability {
  const root =
    options?.root ??
    WORKER_CONTAINER_CAPABILITY_ROOT
  const path =
    workerContainerCapabilityPath(sessionID, root)
  const read =
    options?.readFileSync ?? readFileSync

  if (!options?.readFileSync) {
    let rootInfo

    try {
      rootInfo = lstatSync(root)
    } catch {
      throw new Error(
        "worker container capability root is unavailable",
      )
    }

    const currentUid =
      typeof process.getuid === "function"
        ? process.getuid()
        : undefined

    if (
      rootInfo.isSymbolicLink() ||
      !rootInfo.isDirectory() ||
      (
        currentUid !== undefined &&
        typeof rootInfo.uid === "number" &&
        rootInfo.uid !== currentUid
      )
    ) {
      throw new Error(
        "worker container capability root is unsafe",
      )
    }
  }

  let raw: string

  try {
    raw = read(path, "utf8") as string
  } catch {
    throw new Error(
      "worker container capability is unavailable for this session",
    )
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("invalid worker container capability")
  }

  return validateWorkerContainerCapability(parsed)
}

const CONTAINER_RUNTIME_PATH_ENV_KEYS = [
  "HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CONTAINERS_STORAGE_CONF",
  "CONTAINERS_CONF",
  "CONTAINERS_REGISTRIES_CONF",
] as const

export function containerRuntimeEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {
    PATH: "/usr/bin:/bin",
  }

  for (const key of CONTAINER_RUNTIME_PATH_ENV_KEYS) {
    const value = source[key]

    if (value === undefined || value === "") {
      continue
    }

    if (
      !isAbsolute(value) ||
      /[\0\r\n]/.test(value)
    ) {
      throw new Error(
        `invalid ${key} for existing-container runtime`,
      )
    }

    result[key] = value
  }

  return result
}

const FIXED_RUNTIME_SOCKET_PATHS = [
  "/run/docker.sock",
  "/var/run/docker.sock",
  "/run/podman/podman.sock",
  "/run/containerd/containerd.sock",
  "/var/run/containerd/containerd.sock",
  "/run/crio/crio.sock",
  "/var/run/crio/crio.sock",
]

function sourceMayContainRuntimeSocket(
  source: string,
): boolean {
  if (!isAbsolute(source)) return false

  const normalized = resolve(source)

  for (const socketPath of FIXED_RUNTIME_SOCKET_PATHS) {
    if (
      pathIsWithin(
        normalized,
        resolve(socketPath),
      )
    ) {
      return true
    }
  }

  return (
    normalized === "/run/user" ||
    /^\/run\/user\/[0-9]+(?:\/podman(?:\/podman\.sock)?)?$/.test(
      normalized,
    )
  )
}

export function validateExistingContainerInspect(
  info: unknown,
): void {
  if (!isRecord(info)) {
    throw new Error("invalid existing container inspection result")
  }

  if (
    !isRecord(info.State) ||
    info.State.Running !== true
  ) {
    throw new Error("selected existing container is not running")
  }

  if (!isRecord(info.HostConfig)) {
    throw new Error(
      "invalid existing container inspection HostConfig",
    )
  }

  const hostConfig = info.HostConfig

  if (typeof hostConfig.Privileged !== "boolean") {
    throw new Error(
      "invalid existing container inspection HostConfig.Privileged",
    )
  }

  if (typeof hostConfig.PidMode !== "string") {
    throw new Error(
      "invalid existing container inspection HostConfig.PidMode",
    )
  }

  if (hostConfig.Privileged) {
    throw new Error(
      "refusing privileged existing container",
    )
  }

  if (hostConfig.PidMode === "host") {
    throw new Error(
      "refusing existing container with host PID namespace",
    )
  }

  if (!Array.isArray(info.Mounts)) {
    throw new Error(
      "invalid existing container inspection Mounts",
    )
  }

  const mounts = info.Mounts

  for (const mount of mounts) {
    if (!isRecord(mount)) {
      throw new Error(
        "invalid existing container inspection mount",
      )
    }

    if (
      typeof mount.Type !== "string" ||
      typeof mount.Source !== "string" ||
      typeof mount.Destination !== "string" ||
      typeof mount.RW !== "boolean" ||
      mount.Destination === "" ||
      !isAbsolute(mount.Destination)
    ) {
      throw new Error(
        "invalid existing container inspection mount",
      )
    }

    const source = mount.Source
    const destination = mount.Destination
    const writable = mount.RW

    if (source === "/" && writable) {
      throw new Error(
        "refusing existing container with writable host root mount",
      )
    }

    if (
      writable &&
      isAbsolute(source) &&
      (
        pathIsWithin(
          resolve(source),
          resolve(WORKER_CONTAINER_CAPABILITY_ROOT),
        ) ||
        pathIsWithin(
          resolve(WORKER_CONTAINER_CAPABILITY_ROOT),
          resolve(source),
        )
      )
    ) {
      throw new Error(
        "refusing existing container with writable access to worker capability storage",
      )
    }

    if (
      sourceMayContainRuntimeSocket(source) ||
      /(?:docker|podman|containerd|cri-o)\.sock(?:$|\/)/i.test(destination)
    ) {
      throw new Error(
        "refusing existing container with container-runtime socket",
      )
    }
  }
}

export function resolveExistingContainerRuntime(
  container: string,
  options?: {
    existsSync?: typeof existsSync
    spawnSync?: typeof spawnSync
    runtimePaths?: readonly string[]
    env?: NodeJS.ProcessEnv
  },
): {
  runtime: string
  inspect: Record<string, unknown>
} {
  const exists =
    options?.existsSync ?? existsSync
  const spawn =
    options?.spawnSync ?? spawnSync
  const runtimePaths =
    options?.runtimePaths ??
    EXISTING_CONTAINER_RUNTIME_PATHS

  const matches: Array<{
    runtime: string
    inspect: Record<string, unknown>
  }> = []

  for (const runtime of runtimePaths) {
    if (!exists(runtime)) continue

    const result = spawn(
      runtime,
      ["inspect", container],
      {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          PATH: "/usr/bin:/bin",
        },
      },
    )

    if (result.status !== 0 || result.error) {
      continue
    }

    let parsed: unknown

    try {
      parsed = JSON.parse(String(result.stdout ?? ""))
    } catch {
      throw new Error(
        `invalid inspection output from ${runtime}`,
      )
    }

    const info =
      Array.isArray(parsed)
        ? parsed[0]
        : parsed

    validateExistingContainerInspect(info)

    matches.push({
      runtime,
      inspect: info as Record<string, unknown>,
    })
  }

  if (matches.length === 0) {
    throw new Error(
      `selected existing container was not found in a supported runtime: ${container}`,
    )
  }

  if (matches.length > 1) {
    throw new Error(
      `selected existing container is ambiguous across supported runtimes: ${container}`,
    )
  }

  return matches[0]!
}

export function buildContainerExecArgs(
  container: string,
  argv: readonly string[],
  workdir?: string,
  interactive = false,
): string[] {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    throw new Error("container_run argv must contain at least one valid string")
  }

  return [
    "exec",
    ...(interactive ? ["-i"] : []),
    ...(workdir
      ? ["--workdir", workdir]
      : []),
    container,
    ...argv,
  ]
}

function pathIsWithin(
  base: string,
  candidate: string,
): boolean {
  const rel = relative(
    resolve(base),
    resolve(candidate),
  )

  return (
    rel === "" ||
    (
      rel !== ".." &&
      !rel.startsWith(".." + sep) &&
      !isAbsolute(rel)
    )
  )
}

export function resolveContainerRunWorkdir(
  capability: WorkerContainerCapability,
  requested: string | undefined,
  inspect: Record<string, unknown>,
): string {
  if (requested !== undefined) {
    if (
      requested.trim() === "" ||
      !isAbsolute(requested)
    ) {
      throw new Error(
        "container_run workdir must be an absolute container path",
      )
    }

    return requested
  }

  if (capability.containerCwd !== "auto") {
    return capability.containerCwd
  }

  if (!Array.isArray(inspect.Mounts)) {
    throw new Error(
      "cannot auto-map worker cwd: existing container inspection has no valid mount table",
    )
  }

  const hostCwd = resolve(capability.hostCwd)
  const candidates: Array<{
    source: string
    destination: string
    writable: boolean
  }> = []

  for (const rawMount of inspect.Mounts) {
    if (
      !isRecord(rawMount) ||
      typeof rawMount.Source !== "string" ||
      typeof rawMount.Destination !== "string" ||
      typeof rawMount.RW !== "boolean" ||
      rawMount.Source === "" ||
      !isAbsolute(rawMount.Source) ||
      !isAbsolute(rawMount.Destination)
    ) {
      continue
    }

    const source = resolve(rawMount.Source)

    if (!pathIsWithin(source, hostCwd)) {
      continue
    }

    candidates.push({
      source,
      destination: rawMount.Destination,
      writable: rawMount.RW,
    })
  }

  candidates.sort(
    (left, right) =>
      right.source.length - left.source.length,
  )

  const selected = candidates[0]

  if (!selected) {
    throw new Error(
      "cannot auto-map worker cwd into the selected existing container from its inspected mount table; set execution.container_cwd explicitly",
    )
  }

  if (
    capability.workspaceAccess === "writable" &&
    !selected.writable
  ) {
    throw new Error(
      "cannot auto-map writable worker cwd through a read-only container mount; select an appropriate container or set execution.container_cwd explicitly",
    )
  }

  const suffix =
    relative(selected.source, hostCwd)

  return suffix === ""
    ? selected.destination
    : resolve(selected.destination, suffix)
}

export async function runCancellableLoggedProcess(
  command: string,
  argv: readonly string[],
  options: {
    logPath: string
    logLimitBytes: number
    timeoutMs: number
    signal?: AbortSignal
    writeFn?: typeof writeSync
  },
): Promise<{
  exitCode: number
  timedOut: boolean
  aborted: boolean
  elapsedMs: number
  truncated: boolean
  spawnError?: Error
  logError?: Error
}> {
  const started = Date.now()
  const logFd = openSync(
    options.logPath,
    "w",
    0o600,
  )
  let written = 0
  let truncated = false
  let stderrStarted = false
  let timedOut = false
  let aborted = options.signal?.aborted === true
  let logError: Error | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let child:
    | ReturnType<typeof spawn>
    | undefined

  const writeChunk = (chunk: unknown) => {
    const buffer =
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk))

    if (written < options.logLimitBytes) {
      const keep = buffer.subarray(
        0,
        Math.max(
          0,
          options.logLimitBytes - written,
        ),
      )

      if (keep.length > 0) {
        try {
          ;(options.writeFn ?? writeSync)(
            logFd,
            keep,
          )
          written += keep.length
        } catch (error) {
          logError =
            error instanceof Error
              ? error
              : new Error(String(error))
          killChild()
          return
        }
      }

      if (keep.length !== buffer.length) {
        truncated = true
      }
    } else if (buffer.length > 0) {
      truncated = true
    }
  }

  const writeStderr = (chunk: unknown) => {
    if (!stderrStarted) {
      stderrStarted = true
      writeChunk(Buffer.from("\n[stderr]\n"))
    }

    writeChunk(chunk)
  }

  const killChild = () => {
    try {
      child?.kill("SIGKILL")
    } catch {
      // Already exited.
    }
  }

  const onAbort = () => {
    aborted = true
    killChild()
  }

  try {
    child = spawn(
      command,
      [...argv],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin",
        },
      },
    )

    child.stdout?.on("data", writeChunk)
    child.stderr?.on("data", writeStderr)

    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        onAbort,
        { once: true },
      )
    }

    if (aborted) {
      killChild()
    }

    timer = setTimeout(() => {
      timedOut = true
      killChild()
    }, options.timeoutMs)

    const completion =
      await new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
        error?: Error
      }>((resolveCompletion) => {
        let settled = false

        const finish = (
          value: {
            code: number | null
            signal: NodeJS.Signals | null
            error?: Error
          },
        ) => {
          if (settled) return
          settled = true
          resolveCompletion(value)
        }

        child!.once(
          "error",
          (error) => finish({
            code: null,
            signal: null,
            error,
          }),
        )

        child!.once(
          "close",
          (code, signal) => finish({
            code,
            signal,
          }),
        )
      })

    const exitCode =
      Number.isInteger(completion.code)
        ? completion.code!
        : timedOut
          ? 124
          : aborted
            ? 130
            : 1

    return {
      exitCode,
      timedOut,
      aborted,
      elapsedMs: Date.now() - started,
      truncated,
      ...(completion.error
        ? { spawnError: completion.error }
        : {}),
      ...(logError
        ? { logError }
        : {}),
    }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }

    options.signal?.removeEventListener(
      "abort",
      onAbort,
    )

    closeSync(logFd)
  }
}

const MANAGED_DETACHED_PROCESS_EXIT_CODE = 197

const MANAGED_CONTAINER_WRAPPER = [
  "token=\"$1\"",
  "shift",
  "baseline=\"/tmp/.opencode-managed-$token.baseline\"",
  "",
  "if ! command -v setsid >/dev/null 2>&1; then",
  "  printf \"%s:error:setsid-unavailable\\n\" \"$token\"",
  "  exit 126",
  "fi",
  "",
  ": > \"$baseline\" || exit 126",
  "chmod 600 \"$baseline\" 2>/dev/null || true",
  "",
  "(",
  "  for path in /proc/[0-9]*; do",
  "    pid=\"${path##*/}\"",
  "    IFS= read -r stat < \"$path/stat\" || continue",
  "    rest=\"${stat##*) }\"",
  "    set -- $rest",
  "    state=\"$1\"",
  "    starttime=\"$20\"",
  "    [ \"$state\" = \"Z\" ] && continue",
  "    printf \"%s:%s\\n\" \"$pid\" \"$starttime\"",
  "  done",
  ") > \"$baseline\" || exit 126",
  "",
  "printf \"%s:ready:%s\\n\" \"$token\" \"$$\"",
  "",
  "IFS= read -r ack || exit 125",
  "[ \"$ack\" = \"$token:go\" ] || exit 125",
  "",
  "\"$@\"",
  "status=$?",
  "",
  "# Give ordinary short-lived grandchildren a bounded grace period to exit.",
  "sleep 0.2",
  "",
  "detached=0",
  "for path in /proc/[0-9]*; do",
  "  pid=\"${path##*/}\"",
  "  [ \"$pid\" = \"$$\" ] && continue",
  "  IFS= read -r stat < \"$path/stat\" || continue",
  "  rest=\"${stat##*) }\"",
  "  set -- $rest",
  "  state=\"$1\"",
  "  starttime=\"$20\"",
  "  [ \"$state\" = \"Z\" ] && continue",
  "",
  "  seen=0",
  "  while IFS= read -r entry; do",
  "    if [ \"$entry\" = \"$pid:$starttime\" ]; then",
  "      seen=1",
  "      break",
  "    fi",
  "  done < \"$baseline\"",
  "",
  "  if [ \"$seen\" -eq 0 ]; then",
  "    detached=1",
  "    break",
  "  fi",
  "done",
  "",
  "if [ \"$detached\" -ne 0 ]; then",
  "  exit 197",
  "fi",
  "",
  "rm -f \"$baseline\"",
  "exit \"$status\"",
].join("\n")

const MANAGED_CONTAINER_TERMINATE = [
  "pid=\"$1\"",
  "token=\"$2\"",
  "baseline=\"/tmp/.opencode-managed-$token.baseline\"",
  "",
  "if [ -d \"/proc/$pid\" ]; then",
  "  stat=\"\"",
  "  IFS= read -r stat < \"/proc/$pid/stat\" || stat=\"\"",
  "",
  "  if [ -n \"$stat\" ]; then",
  "    rest=\"${stat##*) }\"",
  "    set -- $rest",
  "    pgid=\"$3\"",
  "    [ \"$pgid\" = \"$pid\" ] || exit 4",
  "  fi",
  "fi",
  "",
  "kill_tree() {",
  "  target=\"$1\"",
  "",
  "  if [ -r \"/proc/$target/task/$target/children\" ]; then",
  "    IFS= read -r children < \"/proc/$target/task/$target/children\" || children=\"\"",
  "    for child in $children; do",
  "      kill_tree \"$child\"",
  "    done",
  "  fi",
  "",
  "  kill -KILL \"$target\" 2>/dev/null || true",
  "}",
  "",
  "kill_tree \"$pid\"",
  "kill -KILL \"-$pid\" 2>/dev/null || true",
  "",
  "attempt=0",
  "while [ \"$attempt\" -lt 50 ]; do",
  "  root_alive=0",
  "",
  "  if [ -d \"/proc/$pid\" ]; then",
  "    stat=\"\"",
  "    IFS= read -r stat < \"/proc/$pid/stat\" || stat=\"\"",
  "",
  "    if [ -n \"$stat\" ]; then",
  "      rest=\"${stat##*) }\"",
  "      set -- $rest",
  "      state=\"$1\"",
  "      current_pgid=\"$3\"",
  "",
  "      if [ \"$state\" != \"Z\" ]; then",
  "        [ \"$current_pgid\" = \"$pid\" ] || exit 6",
  "        root_alive=1",
  "      fi",
  "    fi",
  "  fi",
  "",
  "  detached=0",
  "  if [ -f \"$baseline\" ]; then",
  "    for path in /proc/[0-9]*; do",
  "      current_pid=\"${path##*/}\"",
  "      [ \"$current_pid\" = \"$$\" ] && continue",
  "      [ \"$current_pid\" = \"$pid\" ] && continue",
  "      IFS= read -r current_stat < \"$path/stat\" || continue",
  "      rest=\"${current_stat##*) }\"",
  "      set -- $rest",
  "      state=\"$1\"",
  "      starttime=\"$20\"",
  "      [ \"$state\" = \"Z\" ] && continue",
  "",
  "      seen=0",
  "      while IFS= read -r entry; do",
  "        if [ \"$entry\" = \"$current_pid:$starttime\" ]; then",
  "          seen=1",
  "          break",
  "        fi",
  "      done < \"$baseline\"",
  "",
  "      if [ \"$seen\" -eq 0 ]; then",
  "        detached=1",
  "        break",
  "      fi",
  "    done",
  "  else",
  "    detached=1",
  "  fi",
  "",
  "  if [ \"$root_alive\" -eq 0 ] && [ \"$detached\" -eq 0 ]; then",
  "    rm -f \"$baseline\"",
  "    exit 0",
  "  fi",
  "",
  "  sleep 0.1",
  "  attempt=$((attempt + 1))",
  "done",
  "",
  "exit 5",
].join("\n")

async function terminateManagedContainerProcess(
  runtime: string,
  container: string,
  rootPid: number,
): Promise<boolean> {
  const child = spawn(
    runtime,
    buildContainerExecArgs(
      container,
      [
        "/bin/sh",
        "-c",
        MANAGED_CONTAINER_TERMINATE,
        "sh",
        String(rootPid),
      ],
    ),
    {
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        PATH: "/usr/bin:/bin",
      },
    },
  )

  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    const completion =
      await Promise.race([
        new Promise<{
          code: number | null
          error?: Error
        }>((resolveCompletion) => {
          let settled = false

          const finish = (
            value: {
              code: number | null
              error?: Error
            },
          ) => {
            if (settled) return
            settled = true
            resolveCompletion(value)
          }

          child.once(
            "error",
            (error) => finish({
              code: null,
              error,
            }),
          )

          child.once(
            "close",
            (code) => finish({ code }),
          )
        }),

        new Promise<{
          code: null
          error: Error
        }>((resolveTimeout) => {
          timer = setTimeout(() => {
            try {
              child.kill("SIGKILL")
            } catch {
              // Already exited.
            }

            resolveTimeout({
              code: null,
              error: new Error(
                "container termination verification timed out",
              ),
            })
          }, 7_000)
        }),
      ])

    return (
      completion.code === 0 &&
      !completion.error
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runManagedContainerProcess(
  runtime: string,
  container: string,
  argv: readonly string[],
  workdir: string,
  options: {
    logPath: string
    activityPath: string
    logLimitBytes: number
    timeoutMs: number
    signal?: AbortSignal
    writeFn?: typeof writeSync
  },
): Promise<{
  exitCode: number
  timedOut: boolean
  aborted: boolean
  elapsedMs: number
  truncated: boolean
  terminationConfirmed: boolean
  spawnError?: Error
  logError?: Error
}> {
  const started = Date.now()
  const token =
    "opencode-" +
    randomUUID().replaceAll("-", "")
  const logFd = openSync(
    options.logPath,
    "w",
    0o600,
  )

  writeFileSync(
    options.activityPath,
    JSON.stringify({
      version: 1,
      container,
      startedAt: new Date().toISOString(),
    }) + "\\n",
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  )

  let child:
    | ReturnType<typeof spawn>
    | undefined
  let controlBuffer = Buffer.alloc(0)
  let rootPid: number | undefined
  let commandStarted = false
  let stderrStarted = false
  let timedOut = false
  let aborted = options.signal?.aborted === true
  let protocolError: Error | undefined
  let logError: Error | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopRequested = false
  let written = 0
  let truncated = false

  const killClient = () => {
    try {
      child?.kill("SIGKILL")
    } catch {
      // Already exited.
    }
  }

  const requestStop = () => {
    if (stopRequested) return
    stopRequested = true
    killClient()
  }

  const writeLog = (chunk: unknown) => {
    if (logError) return

    const buffer =
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk))

    if (written >= options.logLimitBytes) {
      if (buffer.length > 0) truncated = true
      return
    }

    const keep =
      buffer.subarray(
        0,
        Math.max(
          0,
          options.logLimitBytes - written,
        ),
      )

    try {
      if (keep.length > 0) {
        ;(options.writeFn ?? writeSync)(
          logFd,
          keep,
        )
        written += keep.length
      }
    } catch (error) {
      logError =
        error instanceof Error
          ? error
          : new Error(String(error))
      requestStop()
      return
    }

    if (keep.length !== buffer.length) {
      truncated = true
    }
  }

  const writeStderr = (chunk: unknown) => {
    if (!stderrStarted) {
      stderrStarted = true
      writeLog(
        Buffer.from("\\n[stderr]\\n"),
      )
    }

    writeLog(chunk)
  }

  const processStdout = (chunk: unknown) => {
    const buffer =
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk))

    if (rootPid !== undefined) {
      writeLog(buffer)
      return
    }

    controlBuffer =
      Buffer.concat([controlBuffer, buffer])

    if (controlBuffer.length > 4096) {
      protocolError =
        new Error(
          "container_run startup handshake exceeded its safety bound",
        )
      requestStop()
      return
    }

    const newline =
      controlBuffer.indexOf(0x0a)

    if (newline < 0) return

    const line =
      controlBuffer
        .subarray(0, newline)
        .toString("utf8")
        .trim()
    const remainder =
      controlBuffer.subarray(newline + 1)
    controlBuffer = Buffer.alloc(0)

    const match =
      line.match(
        new RegExp(
          "^" +
          token +
          ":ready:([1-9][0-9]*)$",
        ),
      )

    if (!match) {
      protocolError =
        new Error(
          "container_run failed to establish a managed process group",
        )
      requestStop()
      return
    }

    rootPid = Number(match[1])

    try {
      child?.stdin?.write(
        token + ":go\n",
      )
      commandStarted = true
    } catch (error) {
      protocolError =
        error instanceof Error
          ? error
          : new Error(String(error))
      requestStop()
      return
    }

    if (remainder.length > 0) {
      writeLog(remainder)
    }
  }

  const onAbort = () => {
    aborted = true
    requestStop()
  }

  let completion:
    | {
        code: number | null
        signal: NodeJS.Signals | null
        error?: Error
      }
    | undefined

  try {
    child = spawn(
      runtime,
      buildContainerExecArgs(
        container,
        [
          "/bin/sh",
          "-c",
          MANAGED_CONTAINER_WRAPPER,
          "sh",
          token,
          ...argv,
        ],
        workdir,
        true,
      ),
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: "/usr/bin:/bin",
        },
      },
    )

    child.stdin?.on("error", () => {
      // Cancellation can close stdin while the runtime client is exiting.
    })
    child.stdout?.on("data", processStdout)
    child.stderr?.on("data", writeStderr)

    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        onAbort,
        { once: true },
      )
    }

    if (aborted) {
      requestStop()
    }

    timer = setTimeout(() => {
      timedOut = true
      requestStop()
    }, options.timeoutMs)

    completion =
      await new Promise((resolveCompletion) => {
        let settled = false

        const finish = (
          value: {
            code: number | null
            signal: NodeJS.Signals | null
            error?: Error
          },
        ) => {
          if (settled) return
          settled = true
          resolveCompletion(value)
        }

        child!.once(
          "error",
          (error) => finish({
            code: null,
            signal: null,
            error,
          }),
        )

        child!.once(
          "close",
          (code, signal) => finish({
            code,
            signal,
          }),
        )
      })
  } finally {
    if (timer) clearTimeout(timer)

    options.signal?.removeEventListener(
      "abort",
      onAbort,
    )

    closeSync(logFd)
  }

  const abnormalLauncherExit =
    completion?.error !== undefined ||
    completion?.signal !== null ||
    !Number.isInteger(completion?.code)

  const needsTermination =
    commandStarted &&
    (
      aborted ||
      timedOut ||
      logError !== undefined ||
      protocolError !== undefined ||
      abnormalLauncherExit
    )

  let terminationConfirmed = true

  if (
    needsTermination &&
    rootPid !== undefined
  ) {
    terminationConfirmed =
      await terminateManagedContainerProcess(
        runtime,
        container,
        rootPid,
      )
  }

  if (
    !commandStarted ||
    (
      !needsTermination ||
      terminationConfirmed
    )
  ) {
    rmSync(
      options.activityPath,
      { force: true },
    )
  }

  const exitCode =
    Number.isInteger(completion?.code)
      ? completion!.code!
      : timedOut
        ? 124
        : aborted
          ? 130
          : 1

  return {
    exitCode,
    timedOut,
    aborted,
    elapsedMs: Date.now() - started,
    truncated,
    terminationConfirmed,
    ...(completion?.error
      ? { spawnError: completion.error }
      : {}),
    ...(logError
      ? { logError }
      : {}),
    ...(protocolError && !completion?.error
      ? { spawnError: protocolError }
      : {}),
  }
}


async function executeContainerRun(
  sessionID: string,
  input: ContainerRunInput,
  abortSignal?: AbortSignal,
): Promise<{ content: string }> {
  if (abortSignal?.aborted) {
    throw new Error("container_run cancelled")
  }

  const capability =
    readWorkerContainerCapability(sessionID)
  const { runtime, inspect } =
    resolveExistingContainerRuntime(
      capability.container,
    )
  const limits = resolveSandboxLimits()

  pruneRunnerRuns({
    retentionMs: limits.runnerRetentionMs,
    maxRuns: limits.runnerRetentionCount,
  })

  const timeoutSeconds = Math.max(
    1,
    Math.min(
      input.timeout_seconds ??
        RUNNER_DEFAULT_TIMEOUT_SECONDS,
      RUNNER_MAX_TIMEOUT_SECONDS,
    ),
  )

  const workdir =
    resolveContainerRunWorkdir(
      capability,
      input.workdir,
      inspect,
    )

  ensureRunnerRoot()

  const runDir = mkdtempSync(
    join(RUNNER_ROOT, "run-"),
  )
  const runID = basename(runDir)
  const combinedLog =
    join(runDir, "combined.log")
  const activityPath =
    workerContainerActivityPath(sessionID)

  const beforeStatus =
    gitStatus(capability.hostCwd)

  const result =
    await runManagedContainerProcess(
      runtime,
      capability.container,
      input.argv,
      workdir,
      {
        logPath: combinedLog,
        activityPath,
        logLimitBytes:
          limits.runnerLogLimitBytes,
        timeoutMs:
          timeoutSeconds * 1000,
        signal: abortSignal,
      },
    )

  if (result.truncated) {
    writeFileSync(
      join(runDir, "truncated"),
      "1",
      { mode: 0o600 },
    )
  }

  writeFileSync(
    join(runDir, "exit_code"),
    String(result.exitCode),
    { mode: 0o600 },
  )

  if (!result.terminationConfirmed) {
    throw new Error(
      "container_run could not confirm termination of the in-container command; writer state remains quarantined",
    )
  }

  if (result.logError) {
    throw new Error(
      "container_run log persistence failed; the in-container command was terminated before returning",
    )
  }

  const afterStatus =
    gitStatus(capability.hostCwd)
  const delta =
    statusDelta(beforeStatus, afterStatus)
  const bytes =
    statSync(combinedLog).size
  const tail =
    readTail(combinedLog, 7000)

  return {
    content: [
      `run_id=${runID}`,
      `exit_code=${result.exitCode}`,
      `timed_out=${result.timedOut}`,
      `cancelled=${result.aborted}`,
      `termination_confirmed=${result.terminationConfirmed}`,
      `elapsed_ms=${result.elapsedMs}`,
      `log_bytes=${bytes}`,
      `log_truncated=${result.truncated}`,
      `workspace_access=${capability.workspaceAccess}`,
      "network_access=inherit",
      `container_workdir=${workdir}`,
      `worktree_status_changed=${delta.length > 0}`,
      delta.length > 0
        ? "worktree_status_delta:\n" +
          truncate(
            delta.slice(0, 30).join("\n"),
            6000,
          )
        : "worktree_status_delta:",
      result.spawnError
        ? "launcher_error:\n" +
          truncate(
            result.spawnError.message,
            5000,
          )
        : "launcher_error:",
      tail
        ? "log_tail:\n" + tail
        : "log_tail:",
      "",
      "Use sandbox_log with this run_id to search or inspect the persisted log up to the configured safety cap.",
    ].join("\n"),
  }
}

export function resolveSandboxLogSpawnResult(
  result: {
    status?: number | null
    signal?: unknown
    error?: unknown
    stdout?: unknown
  },
): {
  exitCode: number
  timedOut: boolean
  failed: boolean
  truncated: boolean
  output: string
} {
  const timedOut =
    isSpawnTimeout(result)
  const errorCode =
    isRecord(result.error) &&
    typeof result.error.code === "string"
      ? result.error.code
      : undefined
  const truncated =
    errorCode === "ENOBUFS"
  const signaled =
    result.signal !== null &&
    result.signal !== undefined
  const failed =
    result.error !== null &&
    result.error !== undefined ||
    signaled ||
    !Number.isInteger(result.status)
  const exitCode =
    Number.isInteger(result.status)
      ? result.status as number
      : timedOut
        ? 124
        : 1
  const output =
    typeof result.stdout === "string"
      ? result.stdout
      : ""

  return {
    exitCode,
    timedOut,
    failed,
    truncated,
    output,
  }
}


export default Plugin.define({
  id: "local.sandbox-tools",

  async setup(ctx) {
    const setupLimits = resolveSandboxLimits()

    pruneRunnerRuns({
      retentionMs: setupLimits.runnerRetentionMs,
      maxRuns: setupLimits.runnerRetentionCount,
    })

    await ctx.session.hook(
      "context",
      (input) => {
        stripUnreplayableMuseReasoning(input)
      },
      { providerID: "opencode" },
    )

    await ctx.session.hook(
      "http.request",
      async (input) => {
        if (
          await omitUnsupportedMuseFinalToolChoice(input)
        ) {
          console.warn(
            JSON.stringify({
              event:
                "opencode_orchestrator_muse_final_tool_choice_omitted",
              sessionID: input.sessionID,
              agent: input.agent,
              model: input.model.id,
              reason:
                "provider_supports_only_auto_and_request_has_no_tools",
            }),
          )
        }
      },
      { providerID: "opencode" },
    )

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "sandbox_shell",

        description:
          "Run a focused verification command in an isolated Linux sandbox. " +
          "Workspace is writable, Git metadata is read-only, network is disabled, " +
          "host HOME and provider credentials are unavailable.",

        input: {
          type: "object",
          properties: {
            command: {
              type: "string",
              minLength: 1,
            },
          },
          required: ["command"],
          additionalProperties: false,
        },

        options: {
          codemode: false,
        },

        execute: async (input, context) => {
          const { command } = input as {
            command: string
          }

          const worktree =
            await resolveSessionWorktree(
              context as
                | SessionWorktreeContext
                | undefined,
              (args) =>
                ctx.session.get(
                  args as never,
                ) as Promise<unknown>,
            )

          const shellLimits =
            resolveSandboxLimits()

          const argv = baseSandboxArgs(
            worktree,
            "/workspace",
          )

          argv.push(
            "/bin/bash",
            "--noprofile",
            "--norc",
            "-c",
            command,
          )

          const proc = Bun.spawn(argv, {
            stdout: "pipe",
            stderr: "pipe",
            env: {
              PATH: "/usr/bin:/bin",
            },
          })

          let timedOut = false

          const timer = setTimeout(() => {
            timedOut = true

            try {
              proc.kill("SIGKILL")
            } catch {
              // Already exited.
            }
          }, shellLimits.shellTimeoutMs)

          const [stdout, stderr, exitCode] =
            await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ])

          clearTimeout(timer)

          return {
            content: [
              `exit_code=${exitCode}`,
              `timed_out=${timedOut}`,
              `sandbox_root=${worktree}`,
              stdout
                ? `stdout:\n${truncate(stdout, shellLimits.shellMaxOutputBytes)}`
                : "stdout:",
              stderr
                ? `stderr:\n${truncate(stderr, shellLimits.shellMaxOutputBytes)}`
                : "stderr:",
            ].join("\n"),
          }
        },
      })

      editor.add({
        name: "sandbox_run",

        description:
          "Run one potentially noisy local command in a hard sandbox. " +
          "Full combined stdout/stderr is persisted outside model context for later inspection with sandbox_log. " +
          "Workspace is writable, Git metadata is read-only, network is disabled, host HOME and credentials are unavailable.",

        input: sandboxRunInputSchema(),

        options: {
          codemode: false,
        },

        execute: async (input, context) => {
          const worktree =
            await resolveSessionWorktree(
              context as
                | SessionWorktreeContext
                | undefined,
              (args) =>
                ctx.session.get(
                  args as never,
                ) as Promise<unknown>,
            )

          return executeSandboxRun(
            worktree,
            input as SandboxRunInput,
            { readonlyWorkspace: false },
          )
        },
      })

      editor.add({
        name: "sandbox_run_ro",

        description:
          "Run one potentially noisy local command in a hard sandbox with a read-only repository workspace. " +
          "Full combined stdout/stderr is persisted outside model context for later inspection with sandbox_log. " +
          "Workspace is read-only, /runner-output and /tmp remain writable, Git metadata is read-only, network is disabled, host HOME and credentials are unavailable.",

        input: sandboxRunInputSchema(),

        options: {
          codemode: false,
        },

        execute: async (input, context) => {
          const worktree =
            await resolveSessionWorktree(
              context as
                | SessionWorktreeContext
                | undefined,
              (args) =>
                ctx.session.get(
                  args as never,
                ) as Promise<unknown>,
            )

          return executeSandboxRun(
            worktree,
            input as SandboxRunInput,
            { readonlyWorkspace: true },
          )
        },
      })

      editor.add({
        name: "sandbox_run_network",

        description:
          "Run one potentially noisy local command in a hard sandbox with host network access. " +
          "Full combined stdout/stderr is persisted outside model context for later inspection with sandbox_log. " +
          "Workspace is writable and Git metadata is read-only. Host HOME, credential files, and inherited credential environment variables are not exposed; reachable host-network endpoints may expose sensitive data or credentials.",

        input: sandboxRunInputSchema(),

        options: {
          codemode: false,
        },

        execute: async (input, context) => {
          const worktree =
            await resolveSessionWorktree(
              context as
                | SessionWorktreeContext
                | undefined,
              (args) =>
                ctx.session.get(
                  args as never,
                ) as Promise<unknown>,
            )

          return executeSandboxRun(
            worktree,
            input as SandboxRunInput,
            {
              readonlyWorkspace: false,
              networkAccess: "host",
            },
          )
        },
      })

      editor.add({
        name: "sandbox_run_network_ro",

        description:
          "Run one potentially noisy local command in a hard sandbox with host network access and a read-only repository workspace. " +
          "Full combined stdout/stderr is persisted outside model context for later inspection with sandbox_log. " +
          "Workspace is read-only, /runner-output and /tmp remain writable, and Git metadata is read-only. Host HOME, credential files, and inherited credential environment variables are not exposed; reachable host-network endpoints may expose sensitive data or credentials.",

        input: sandboxRunInputSchema(),

        options: {
          codemode: false,
        },

        execute: async (input, context) => {
          const worktree =
            await resolveSessionWorktree(
              context as
                | SessionWorktreeContext
                | undefined,
              (args) =>
                ctx.session.get(
                  args as never,
                ) as Promise<unknown>,
            )

          return executeSandboxRun(
            worktree,
            input as SandboxRunInput,
            {
              readonlyWorkspace: true,
              networkAccess: "host",
            },
          )
        },
      })

      editor.add({
        name: "container_run",

        description:
          "Run argv in the one existing container selected by the parent for this Worker session. " +
          "The model cannot select a container or access generic Podman/Docker control. Output is persisted outside model context up to the configured runner safety cap for sandbox_log; excess output is drained and marked truncated. " +
          "The existing container retains its own mounts, devices, credentials, services, and network configuration.",

        input: containerRunInputSchema(),

        options: {
          codemode: false,
        },

        execute: async (input, context) => {
          const toolContext =
            context as
              | {
                  sessionID?: unknown
                  abort?: AbortSignal
                }
              | undefined
          const sessionID =
            toolContext?.sessionID

          if (typeof sessionID !== "string") {
            throw new Error(
              "container_run requires an OpenCode session id",
            )
          }

          return executeContainerRun(
            sessionID,
            input as ContainerRunInput,
            toolContext?.abort,
          )
        },
      })

      editor.add({
        name: "sandbox_log",

        description:
          "Inspect the persisted output of a previous sandbox_run* or container_run execution without loading the whole log into model context. " +
          "Supports grep, tail, head, and bounded line ranges.",

        input: {
          type: "object",

          properties: {
            run_id: {
              type: "string",
              minLength: 1,
            },

            mode: {
              type: "string",
              enum: [
                "grep",
                "tail",
                "head",
                "range",
              ],
            },

            pattern: {
              type: "string",
              description:
                "Regex for grep mode",
            },

            lines: {
              type: "integer",
              minimum: 1,
              maximum: 500,
              description:
                "Number of lines for head/tail",
            },

            start_line: {
              type: "integer",
              minimum: 1,
            },

            end_line: {
              type: "integer",
              minimum: 1,
            },

            context: {
              type: "integer",
              minimum: 0,
              maximum: 20,
              description:
                "Context lines around grep matches",
            },

            max_matches: {
              type: "integer",
              minimum: 1,
              maximum: 100,
            },

            case_sensitive: {
              type: "boolean",
            },
          },

          required: [
            "run_id",
            "mode",
          ],

          additionalProperties: false,
        },

        options: {
          codemode: false,
        },

        execute: async (input) => {
          const logLimits =
            resolveSandboxLimits()

          const {
            run_id,
            mode,
            pattern,
            lines,
            start_line,
            end_line,
            context,
            max_matches,
            case_sensitive,
          } = input as {
            run_id: string
            mode: string
            pattern?: string
            lines?: number
            start_line?: number
            end_line?: number
            context?: number
            max_matches?: number
            case_sensitive?: boolean
          }

          const runDir =
            validateRunID(run_id)

          const logPath =
            join(runDir, "combined.log")

          if (!existsSync(logPath)) {
            throw new Error(
              `log missing for ${run_id}`,
            )
          }

          let command: string
          let args: string[]

          if (mode === "grep") {
            if (!pattern) {
              throw new Error(
                "pattern is required for grep mode",
              )
            }

            command = "/usr/bin/rg"
            args = [
              "--no-heading",
              "--line-number",
              "--color",
              "never",
              "-m",
              String(max_matches ?? 30),
              "-C",
              String(context ?? 2),
            ]

            if (!case_sensitive) {
              args.push("-i")
            }

            args.push(
              "--",
              pattern,
              logPath,
            )
          } else if (mode === "tail") {
            command = "/usr/bin/tail"
            args = [
              "-n",
              String(lines ?? 80),
              logPath,
            ]
          } else if (mode === "head") {
            command = "/usr/bin/head"
            args = [
              "-n",
              String(lines ?? 80),
              logPath,
            ]
          } else if (mode === "range") {
            if (!start_line || !end_line) {
              throw new Error(
                "start_line and end_line are required for range mode",
              )
            }

            if (end_line < start_line) {
              throw new Error(
                "end_line must be >= start_line",
              )
            }

            if (
              end_line - start_line > 500
            ) {
              throw new Error(
                "range may contain at most 501 lines",
              )
            }

            command = "/usr/bin/sed"
            args = [
              "-n",
              `${start_line},${end_line}p`,
              logPath,
            ]
          } else {
            throw new Error(
              `unsupported mode: ${mode}`,
            )
          }

          const result = spawnSync(
            command,
            args,
            sandboxLogSpawnOptions(),
          )

          const summary =
            resolveSandboxLogSpawnResult(result)

          const boundedOutput =
            summary.output
              ? truncate(
                  summary.output,
                  logLimits.shellMaxOutputBytes,
                )
              : ""

          return {
            content: [
              `run_id=${run_id}`,
              `mode=${mode}`,
              `tool_exit_code=${summary.exitCode}`,
              `timed_out=${summary.timedOut}`,
              `tool_failed=${summary.failed}`,
              `output_truncated=${summary.truncated}`,
              summary.timedOut && !boundedOutput
                ? `result:\n[sandbox_log timed out after ${SANDBOX_LOG_TIMEOUT_MS}ms]`
                : summary.truncated
                  ? "result:\n[sandbox_log output truncated by inspection safety cap]\n" +
                    boundedOutput
                  : boundedOutput
                    ? "result:\n" +
                      boundedOutput
                    : summary.failed
                      ? "result:\n[sandbox_log inspection failed]"
                      : "result:",
            ].join("\n"),
          }
        },
      })
    })
  },
})
