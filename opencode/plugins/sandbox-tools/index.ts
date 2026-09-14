import { Plugin } from "@opencode/plugin"
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
import { spawnSync } from "node:child_process"

import {
  normalizeSandboxRuntime,
  type SandboxRuntimeConfig,
} from "../../../config/sandbox-runtime.mjs"

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

function roBindIfExists(argv: string[], source: string, target = source) {
  if (existsSync(source)) {
    argv.push("--ro-bind", source, target)
  }
}

export function addAbsoluteWorktreeBind(
  argv: string[],
  worktree: string,
  options?: {
    readonlyWorkspace?: boolean
  },
) {
  /*
   * Some repository-local tools embed the repository's original absolute
   * pathname in shebangs, generated launchers, caches, metadata, etc.
   *
   * Expose ONLY the active worktree at that same absolute path inside the
   * sandbox. Do not expose the containing host directories.
   *
   * Example:
   *
   *   host worktree:
   *     /home/user/projects/foo
   *
   *   sandbox:
   *     /workspace
   *     /home/user/projects/foo
   *
   * Both mount points reference the same worktree.
   */
  if (!isAbsolute(worktree)) {
    throw new Error(
      `worktree must be absolute: ${worktree}`,
    )
  }

  if (
    worktree === "/" ||
    worktree === "/home" ||
    worktree === "/tmp"
  ) {
    throw new Error(
      `refusing unsafe worktree root: ${worktree}`,
    )
  }

  /*
   * Never overlay one of the sandbox's system mount trees.
   */
  const first =
    worktree.split("/").filter(Boolean)[0] ?? ""

  const forbiddenRoots = new Set([
    "usr",
    "bin",
    "sbin",
    "lib",
    "lib64",
    "etc",
    "proc",
    "dev",
    "workspace",
  ])

  if (forbiddenRoots.has(first)) {
    throw new Error(
      `unsupported worktree location: ${worktree}`,
    )
  }

  /*
   * Refuse accidentally exposing an entire user HOME.
   * HOME realpath is best-effort only: when HOME is missing or
   * inaccessible, omit just this optional equality check. Earlier
   * forbidden-root checks still apply.
   */
  const home = process.env.HOME

  if (home) {
    try {
      if (realpathSync(home) === worktree) {
        throw new Error(
          "refusing to mount the entire host HOME as a worktree",
        )
      }
    } catch (error) {
      if (
        (error as Error)?.message ===
        "refusing to mount the entire host HOME as a worktree"
      ) {
        throw error
      }
      // HOME unavailable: skip only the HOME-equality check.
    }
  }

  /*
   * Construct only empty destination directories inside the sandbox.
   * These are NOT host-directory mounts.
   */
  const parts =
    worktree.split("/").filter(Boolean)

  let current = ""

  for (const part of parts) {
    current += "/" + part

    /*
     * /home already exists as a synthetic empty directory.
     * /tmp already exists as a private tmpfs.
     */
    if (
      current === "/home" ||
      current === "/tmp"
    ) {
      continue
    }

    argv.push(
      "--dir",
      current,
    )
  }

  /*
   * Mount exactly the worktree, and nothing above it.
   * The read-only flag is server-controlled only and never derived from
   * model-controlled tool input.
   */
  argv.push(
    options?.readonlyWorkspace
      ? "--ro-bind"
      : "--bind",
    worktree,
    worktree,
  )
}

export const SANDBOX_TOOLCHAIN_DIRS_ENV =
  "OPENCODE_SANDBOX_TOOLCHAIN_DIRS"

export const SANDBOX_RUNTIME_CONFIG_ENV =
  "OPENCODE_MCP_ORCHESTRATOR_CONFIG"

const SANDBOX_TOOLCHAIN_FORBIDDEN_EXACT =
  new Set([
    "/",
    "/home",
    "/tmp",
    "/usr",
    "/etc",
    "/proc",
    "/dev",
    "/bin",
    "/boot",
    "/sbin",
    "/lib",
    "/lib64",
    "/media",
    "/mnt",
    "/opt",
    "/root",
    "/srv",
    "/var",
  ])

const SANDBOX_RUNTIME_FORBIDDEN_PREFIXES = [
  "/dev",
  "/etc",
  "/proc",
  "/run",
  "/sys",
]

const SANDBOX_RUNTIME_HOME_SENSITIVE_PATHS = [
  ".agents",
  ".aws",
  ".azure",
  ".claude",
  ".codex",
  ".config",
  ".docker",
  ".gnupg",
  ".kube",
  ".password-store",
  ".ssh",
]

type RuntimeTrustedRoot = {
  root: string
  pathEntries: string[]
  environment: Record<string, string>
}

export type SandboxRuntimeCapabilities = {
  mountRoots: string[]
  pathEntries: string[]
  environment: Record<string, string>
}

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

function isForbiddenRuntimeRoot(
  canonical: string,
  home: string | undefined,
): boolean {
  if (SANDBOX_TOOLCHAIN_FORBIDDEN_EXACT.has(canonical)) {
    return true
  }

  if (
    SANDBOX_RUNTIME_FORBIDDEN_PREFIXES.some(
      (prefix) => isWithin(prefix, canonical),
    ) ||
    canonical.split(sep).includes(".git")
  ) {
    return true
  }

  const segments = canonical.split(sep)

  if (
    SANDBOX_RUNTIME_HOME_SENSITIVE_PATHS.some(
      (sensitive) => segments.includes(sensitive),
    )
  ) {
    return true
  }

  if (!home) return false

  return (
    canonical === home ||
    SANDBOX_RUNTIME_HOME_SENSITIVE_PATHS.some(
      (relativePath) =>
        isWithin(resolve(home, relativePath), canonical),
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

function canonicalHome(
  home: string | undefined,
  realpathFn: (path: string) => string,
): string | undefined {
  if (!home) return undefined

  try {
    return realpathFn(home)
  } catch {
    return undefined
  }
}

function validateCanonicalRoot(
  entry: RuntimeTrustedRoot,
  home: string | undefined,
  realpathFn: (path: string) => string,
  statFn: (path: string) => { isDirectory(): boolean },
): string {
  let canonical: string

  try {
    canonical = realpathFn(entry.root)
  } catch {
    throw new Error("sandbox runtime root does not exist")
  }

  let info: { isDirectory(): boolean }

  try {
    info = statFn(canonical)
  } catch {
    throw new Error("sandbox runtime root does not exist")
  }

  if (!info.isDirectory()) {
    throw new Error("sandbox runtime root is not a directory")
  }

  if (isForbiddenRuntimeRoot(
    canonical,
    canonicalHome(home, realpathFn),
  )) {
    throw new Error("refusing broad sandbox runtime root")
  }

  return canonical
}

function resolveContainedRuntimePath(
  root: string,
  relativePath: string,
  kind: "path" | "environment",
  realpathFn: (path: string) => string,
  statFn: (path: string) => { isDirectory(): boolean },
): string {
  let canonical: string

  try {
    canonical = realpathFn(resolve(root, relativePath))
  } catch {
    throw new Error(`sandbox runtime ${kind} target does not exist`)
  }

  if (!isWithin(root, canonical)) {
    throw new Error(`sandbox runtime ${kind} target escapes its root`)
  }

  if (kind === "path") {
    let info: { isDirectory(): boolean }

    try {
      info = statFn(canonical)
    } catch {
      throw new Error("sandbox runtime path target does not exist")
    }

    if (!info.isDirectory()) {
      throw new Error("sandbox runtime path target is not a directory")
    }
  }

  return canonical
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
  const realpathFn = options?.realpathSync ?? realpathSync
  const statFn = options?.statSync ?? statSync
  const mountRoots: string[] = []
  const pathEntries: string[] = []
  const environment: Record<string, string> = {}
  const seenRoots = new Set<string>()
  const seenPaths = new Set<string>()

  for (const entry of config.trustedRoots) {
    const root = validateCanonicalRoot(
      entry,
      env.HOME,
      realpathFn,
      statFn,
    )

    if (seenRoots.has(root)) {
      throw new Error("duplicate canonical sandbox runtime root")
    }

    seenRoots.add(root)
    mountRoots.push(root)

    for (const relativePath of entry.pathEntries) {
      const path = resolveContainedRuntimePath(
        root,
        relativePath,
        "path",
        realpathFn,
        statFn,
      )

      if (seenPaths.has(path)) {
        throw new Error("duplicate canonical sandbox runtime path")
      }

      seenPaths.add(path)
      pathEntries.push(path)
    }

    for (const [name, relativePath] of Object.entries(entry.environment)) {
      environment[name] = resolveContainedRuntimePath(
        root,
        relativePath,
        "environment",
        realpathFn,
        statFn,
      )
    }
  }

  return { mountRoots, pathEntries, environment }
}

export function safeSystemPath(options?: {
  path?: string
  realpathSync?: (path: string) => string
  statSync?: (path: string) => { isDirectory(): boolean }
}): string {
  const realpathFn = options?.realpathSync ?? realpathSync
  const statFn = options?.statSync ?? statSync
  const inherited = (options?.path ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
  const safe: string[] = []

  for (const entry of [
    ...inherited,
    "/usr/local/bin",
    "/usr/bin",
  ]) {
    try {
      const canonical = realpathFn(entry)
      const info = statFn(canonical)

      if (
        info.isDirectory() &&
        (
          canonical === "/usr" ||
          canonical.startsWith("/usr/")
        ) &&
        !safe.includes(canonical)
      ) {
        safe.push(canonical)
      }
    } catch {
      // Ignore missing or inaccessible inherited PATH entries.
    }
  }

  return safe.join(delimiter)
}

export function parseSandboxToolchainEntries(
  raw: string | undefined | null,
  delim: string = delimiter,
): string[] {
  if (!raw) return []
  return raw
    .split(delim)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
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
  const delim =
    options?.delimiter ?? delimiter
  const rawValue =
    raw ??
    process.env[SANDBOX_TOOLCHAIN_DIRS_ENV] ??
    ""
  const entries = parseSandboxToolchainEntries(
    rawValue,
    delim,
  )
  const realpathFn =
    options?.realpathSync ?? realpathSync
  const statFn =
    options?.statSync ?? statSync
  const homeValue =
    options && "home" in options
      ? options.home
      : process.env.HOME

  let canonicalHome: string | undefined

  if (homeValue) {
    try {
      canonicalHome = realpathFn(homeValue)
    } catch {
      canonicalHome = undefined
    }
  }

  const seen = new Set<string>()
  const resolved: string[] = []

  for (const entry of entries) {
    if (!isAbsolute(entry)) {
      throw new Error(
        `sandbox toolchain directory must be absolute: ${entry}`,
      )
    }

    let canonical: string

    try {
      canonical = realpathFn(entry)
    } catch {
      throw new Error(
        `sandbox toolchain directory does not exist: ${entry}`,
      )
    }

    let stat: {
      isDirectory(): boolean
    }

    try {
      stat = statFn(canonical)
    } catch {
      throw new Error(
        `sandbox toolchain directory does not exist: ${entry}`,
      )
    }

    if (!stat.isDirectory()) {
      throw new Error(
        `sandbox toolchain directory is not a directory: ${entry}`,
      )
    }

    if (isForbiddenRuntimeRoot(canonical, canonicalHome)) {
      throw new Error(
        `refusing broad sandbox toolchain directory: ${entry}`,
      )
    }

    if (seen.has(canonical)) {
      throw new Error(
        `duplicate sandbox toolchain directory: ${entry}`,
      )
    }

    seen.add(canonical)
    resolved.push(canonical)
  }

  return resolved
}

export function sandboxPathWithToolchains(
  basePath: string,
  toolchainDirs: string[],
): string {
  const clean = toolchainDirs.filter(Boolean)
  if (clean.length === 0) return basePath
  return `${basePath}:${clean.join(":")}`
}

export function addSandboxToolchainBinds(
  argv: string[],
  dirs: string[],
): void {
  for (const dir of dirs) {
    argv.push("--ro-bind", dir, dir)
  }
}

export function addSandboxRuntimeBinds(
  argv: string[],
  roots: string[],
): void {
  const existingDirs = new Set<string>()

  for (let index = 0; index + 1 < argv.length; index += 1) {
    if (argv[index] === "--dir") {
      existingDirs.add(argv[index + 1]!)
    }
  }

  for (const root of roots) {
    if (
      root !== "/usr" &&
      !root.startsWith("/usr/")
    ) {
      const missingParents: string[] = []
      let current = resolve(root, "..")

      while (
        current !== "/" &&
        current !== "/home" &&
        current !== "/tmp" &&
        !existingDirs.has(current)
      ) {
        missingParents.push(current)
        current = resolve(current, "..")
      }

      for (const parent of missingParents.reverse()) {
        argv.push("--dir", parent)
        existingDirs.add(parent)
      }
    }

    argv.push("--ro-bind", root, root)
  }
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

export function baseSandboxArgs(
  worktree: string,
  sandboxCwd: string,
  options?: {
    readonlyWorkspace?: boolean
  },
): string[] {
  const argv: string[] = [
    "/usr/bin/bwrap",

    "--die-with-parent",
    "--new-session",

    "--unshare-net",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",

    "--ro-bind", "/usr", "/usr",

    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",

    "--proc", "/proc",
    "--dev", "/dev",

    "--tmpfs", "/tmp",

    "--dir", "/home",
    "--dir", "/home/sandbox",

    "--dir", "/etc",

    /*
     * Writable by default; read-only only when the server-selected tool
     * variant requests it. Never derived from model-controlled input.
     */
    options?.readonlyWorkspace ? "--ro-bind" : "--bind",
    worktree,
    "/workspace",
  ]

  /*
   * Also expose this same worktree at its original absolute host pathname.
   * This keeps repository-local absolute paths valid without exposing the
   * rest of the host filesystem.
   */
  addAbsoluteWorktreeBind(
    argv,
    worktree,
    options,
  )

  const gitMetadata = `${worktree}/.git`

  if (existsSync(gitMetadata)) {
    /*
     * The worktree is visible through two paths, therefore Git metadata
     * must be overlaid read-only through both paths as well.
     */
    argv.push(
      "--ro-bind",
      gitMetadata,
      "/workspace/.git",

      "--ro-bind",
      gitMetadata,
      `${worktree}/.git`,
    )
  }

  for (const path of [
    "/etc/ld.so.cache",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
    "/etc/localtime",
    "/etc/gitconfig",
  ]) {
    roBindIfExists(argv, path)
  }

  const toolchainDirs =
    resolveSandboxToolchainDirs()
  const runtime =
    resolveSandboxRuntimeCapabilities({ worktree })
  const mountRoots = [...new Set([
    ...runtime.mountRoots,
    ...toolchainDirs,
  ])]
  const pathEntries = [...new Set([
    ...runtime.pathEntries,
    ...toolchainDirs,
  ])]

  addSandboxRuntimeBinds(argv, mountRoots)

  argv.push(
    "--clearenv",

    "--setenv", "HOME", "/home/sandbox",
    "--setenv", "PATH", sandboxPathWithToolchains(safeSystemPath(), pathEntries),
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "LC_ALL", "C.UTF-8",
    "--setenv", "PYTHONPYCACHEPREFIX", "/tmp/pycache",
  )

  for (const [name, value] of Object.entries(runtime.environment)) {
    argv.push("--setenv", name, value)
  }

  argv.push("--chdir", sandboxCwd)

  return argv
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

function gitStatus(worktree: string): string {
  if (!existsSync(join(worktree, ".git"))) return ""

  const result = spawnSync(
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

  if (isSpawnTimeout(result)) {
    throw new Error(
      `git status timed out after ${GIT_STATUS_TIMEOUT_MS}ms`,
    )
  }

  return result.stdout ?? ""
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
  return ["--bind", runDir, "/runner-output"]
}

export function buildSandboxRunArgv(
  worktree: string,
  sandboxCwd: string,
  runDir: string,
  command: string,
  options?: {
    readonlyWorkspace?: boolean
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

export default Plugin.define({
  id: "local.sandbox-tools",

  async setup(ctx) {
    const configuredRoot =
      ctx.location.project?.canonical ||
      ctx.location.project?.directory ||
      ctx.location.directory

    const worktree = realpathSync(configuredRoot)

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

        execute: async (input) => {
          const { command } = input as {
            command: string
          }

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

        execute: async (input) => {
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

        execute: async (input) => {
          return executeSandboxRun(
            worktree,
            input as SandboxRunInput,
            { readonlyWorkspace: true },
          )
        },
      })

      editor.add({
        name: "sandbox_log",

        description:
          "Inspect the persisted output of a previous sandbox_run or sandbox_run_ro without loading the whole log into model context. " +
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

          const timedOut =
            isSpawnTimeout(result)

          const output =
            result.stdout ?? ""

          return {
            content: [
              `run_id=${run_id}`,
              `mode=${mode}`,
              `tool_exit_code=${result.status ?? 0}`,
              `timed_out=${timedOut}`,
              timedOut && !output
                ? `result:\n[sandbox_log timed out after ${SANDBOX_LOG_TIMEOUT_MS}ms]`
                : output
                  ? "result:\n" +
                    truncate(
                      output,
                      logLimits.shellMaxOutputBytes,
                    )
                  : "result:",
            ].join("\n"),
          }
        },
      })
    })
  },
})
