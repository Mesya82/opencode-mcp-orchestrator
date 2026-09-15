export const SANDBOX_BWRAP_BIN: string

export const SANDBOX_TOOLCHAIN_DIRS_ENV: string

export const SANDBOX_ETC_RO_BINDS: readonly string[]

export function isWithin(root: string, candidate: string): boolean

export function addAbsoluteWorktreeBind(
  argv: string[],
  worktree: string,
  options?: {
    readonly readonlyWorkspace?: boolean
    readonly realpathSync?: (path: string) => string
    readonly env?: NodeJS.ProcessEnv
  },
): void

export function parseSandboxToolchainEntries(
  raw: string | undefined | null,
  delim?: string,
): string[]

export function resolveSandboxToolchainDirs(
  raw?: string,
  options?: {
    readonly delimiter?: string
    readonly home?: string | undefined
    readonly env?: NodeJS.ProcessEnv
    readonly realpathSync?: (path: string) => string
    readonly statSync?: (path: string) => {
      isDirectory(): boolean
    }
  },
): string[]

export function safeSystemPath(options?: {
  readonly path?: string
  readonly delimiter?: string
  readonly env?: NodeJS.ProcessEnv
  readonly realpathSync?: (path: string) => string
  readonly statSync?: (path: string) => {
    isDirectory(): boolean
  }
}): string

export function sandboxPathWithToolchains(
  basePath: string,
  toolchainDirs: string[],
): string

export function addSandboxToolchainBinds(
  argv: string[],
  dirs: string[],
): void

export function addSandboxRuntimeBinds(
  argv: string[],
  roots: string[],
): void

export function runnerOutputBindArgs(runDir: string): string[]

export interface SandboxBubblewrapRuntime {
  readonly mountRoots: string[]
  readonly pathEntries: string[]
  readonly environment: Record<string, string>
}

export function resolveSandboxRuntimeCapabilities(options?: {
  readonly config?: {
    readonly trustedRoots: ReadonlyArray<{
      readonly root: string
      readonly pathEntries: ReadonlyArray<string>
      readonly environment: Record<string, string>
    }>
  }
  readonly env?: NodeJS.ProcessEnv
  readonly realpathSync?: (path: string) => string
  readonly statSync?: (path: string) => {
    isDirectory(): boolean
  }
}): SandboxBubblewrapRuntime

export const SANDBOX_LINKED_GIT_MAX_FILE_BYTES: number

export function resolveLinkedGitMetadata(
  worktree: string,
  options?: {
    readonly existsSync?: (path: string) => boolean
    readonly readFileSync?: (path: string, encoding: "utf8") => string
    readonly realpathSync?: (path: string) => string
    readonly statSync?: (path: string) => {
      isDirectory(): boolean
      isFile(): boolean
      size: number
    }
    readonly env?: NodeJS.ProcessEnv
  },
): { linkedGitDir: string; commonDir: string } | null

export function buildBaseSandboxArgv(
  worktree: string,
  sandboxCwd: string,
  options?: {
    readonly readonlyWorkspace?: boolean
    readonly toolchainDirs?: string[]
    readonly runtime?: SandboxBubblewrapRuntime
    readonly safePath?: string
    readonly path?: string
    readonly delimiter?: string
    readonly env?: NodeJS.ProcessEnv
    readonly existsSync?: (path: string) => boolean
    readonly readFileSync?: (path: string, encoding: "utf8") => string
    readonly realpathSync?: (path: string) => string
    readonly statSync?: (path: string) => {
      isDirectory(): boolean
      isFile(): boolean
      size: number
    }
  },
): string[]
