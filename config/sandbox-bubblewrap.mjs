/*
 * Shared production Bubblewrap construction for delegated sandboxes and the
 * networkless Doctor execution probes.
 *
 * This module is the single production implementation for mounts,
 * runtime/toolchain handling, environment, and namespace flags. It is plain
 * Node-compatible JavaScript (no TypeScript syntax, no Bun APIs) so both the
 * OpenCode sandbox-tools plugin (TypeScript) and config/sandbox-probes.mjs
 * (Doctor) can call the exact same code instead of the probes maintaining a
 * separate approximation.
 *
 * Security semantics preserved here, not in callers:
 * - per-call session root resolution (worktree is always an explicit argument)
 * - writable workspace alias plus an absolute worktree bind of exactly the
 *   same worktree (never host parents, never HOME)
 * - Git metadata overlaid read-only through both workspace aliases when present
 * - read-only workspace variant is server-selected (readonlyWorkspace flag),
 *   never derived from model-controlled input
 * - trusted runtime roots and toolchain directories are canonicalized,
 *   containment-checked, and refused when broad or credential-adjacent
 * - cleared environment with a safe system PATH plus configured entries only
 * - shared networkless isolation flags (private network namespace)
 */

import {
  existsSync as fsExistsSync,
  realpathSync as fsRealpathSync,
  statSync as fsStatSync,
} from "node:fs"

import {
  delimiter as pathDelimiter,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path"

import {
  sandboxIsolationArgv,
} from "./sandbox-isolation.mjs"

export const SANDBOX_BWRAP_BIN = "/usr/bin/bwrap"

export const SANDBOX_TOOLCHAIN_DIRS_ENV =
  "OPENCODE_SANDBOX_TOOLCHAIN_DIRS"

export const SANDBOX_ETC_RO_BINDS = Object.freeze([
  "/etc/ld.so.cache",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/gitconfig",
])

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

export function isWithin(root, candidate) {
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

function tryRealpath(path, realpathFn) {
  try {
    return realpathFn(path)
  } catch {
    return undefined
  }
}

function isForbiddenRuntimeRoot(canonical, home) {
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

function roBindIfExists(argv, source, existsFn) {
  if (existsFn(source)) {
    argv.push("--ro-bind", source, source)
  }
}

export function addAbsoluteWorktreeBind(
  argv,
  worktree,
  options = {},
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
  const realpathFn = options.realpathSync ?? fsRealpathSync
  const env = options.env ?? process.env
  const home = env.HOME

  if (home) {
    try {
      if (realpathFn(home) === worktree) {
        throw new Error(
          "refusing to mount the entire host HOME as a worktree",
        )
      }
    } catch (error) {
      if (
        (error)?.message ===
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

export function parseSandboxToolchainEntries(
  raw,
  delim = pathDelimiter,
) {
  if (!raw) return []
  return raw
    .split(delim)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
}

export function resolveSandboxToolchainDirs(
  raw,
  options = {},
) {
  const delim =
    options?.delimiter ?? pathDelimiter
  const env = options?.env ?? process.env
  const rawValue =
    raw ??
    env[SANDBOX_TOOLCHAIN_DIRS_ENV] ??
    ""
  const entries = parseSandboxToolchainEntries(
    rawValue,
    delim,
  )
  const realpathFn =
    options?.realpathSync ?? fsRealpathSync
  const statFn =
    options?.statSync ?? fsStatSync
  const homeValue =
    options && "home" in options
      ? options.home
      : env.HOME

  let canonicalHome

  if (homeValue) {
    canonicalHome = tryRealpath(homeValue, realpathFn)
  }

  const seen = new Set()
  const resolved = []

  for (const entry of entries) {
    if (!isAbsolute(entry)) {
      throw new Error(
        `sandbox toolchain directory must be absolute: ${entry}`,
      )
    }

    let canonical

    try {
      canonical = realpathFn(entry)
    } catch {
      throw new Error(
        `sandbox toolchain directory does not exist: ${entry}`,
      )
    }

    let stat

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

export function safeSystemPath(options = {}) {
  const realpathFn = options?.realpathSync ?? fsRealpathSync
  const statFn = options?.statSync ?? fsStatSync
  const delim = options?.delimiter ?? pathDelimiter
  const env = options?.env ?? process.env
  const inherited = (options?.path ?? env.PATH ?? "")
    .split(delim)
    .filter(Boolean)
  const safe = []

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

  return safe.join(delim)
}

export function sandboxPathWithToolchains(
  basePath,
  toolchainDirs,
) {
  const clean = toolchainDirs.filter(Boolean)
  if (clean.length === 0) return basePath
  return `${basePath}:${clean.join(":")}`
}

export function addSandboxToolchainBinds(argv, dirs) {
  for (const dir of dirs) {
    argv.push("--ro-bind", dir, dir)
  }
}

/*
 * Production runner output mount semantics: /runner-output is always a
 * writable bind in both sandbox_run variants.
 */
export function runnerOutputBindArgs(runDir) {
  return ["--bind", runDir, "/runner-output"]
}

export function addSandboxRuntimeBinds(argv, roots) {
  const existingDirs = new Set()

  for (let index = 0; index + 1 < argv.length; index += 1) {
    if (argv[index] === "--dir") {
      existingDirs.add(argv[index + 1])
    }
  }

  for (const root of roots) {
    if (
      root !== "/usr" &&
      !root.startsWith("/usr/")
    ) {
      const missingParents = []
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

function validateCanonicalRoot(entry, home, realpathFn, statFn) {
  let canonical

  try {
    canonical = realpathFn(entry.root)
  } catch {
    throw new Error("sandbox runtime root does not exist")
  }

  let info

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
    tryRealpath(home, realpathFn),
  )) {
    throw new Error("refusing broad sandbox runtime root")
  }

  return canonical
}

function resolveContainedRuntimePath(
  root,
  relativePath,
  kind,
  realpathFn,
  statFn,
) {
  let canonical

  try {
    canonical = realpathFn(resolve(root, relativePath))
  } catch {
    throw new Error(`sandbox runtime ${kind} target does not exist`)
  }

  if (!isWithin(root, canonical)) {
    throw new Error(`sandbox runtime ${kind} target escapes its root`)
  }

  if (kind === "path") {
    let info

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

export function resolveSandboxRuntimeCapabilities(options = {}) {
  const env = options?.env ?? process.env
  const config = options?.config ?? { trustedRoots: [] }
  const realpathFn = options?.realpathSync ?? fsRealpathSync
  const statFn = options?.statSync ?? fsStatSync
  const mountRoots = []
  const pathEntries = []
  const environment = {}
  const seenRoots = new Set()
  const seenPaths = new Set()

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

/*
 * Production Bubblewrap construction shared by delegated sandbox tools and
 * Doctor probes. The worktree is always an explicit per-call argument;
 * readonlyWorkspace is server-selected only.
 */
export function buildBaseSandboxArgv(
  worktree,
  sandboxCwd,
  options = {},
) {
  const existsFn = options.existsSync ?? fsExistsSync
  const readonlyWorkspace = options.readonlyWorkspace === true
  const toolchainDirs = options.toolchainDirs ?? []
  const runtime = options.runtime ?? {
    mountRoots: [],
    pathEntries: [],
    environment: {},
  }
  const safePath = options.safePath ?? safeSystemPath({
    path: options.path,
    delimiter: options.delimiter,
    env: options.env,
    realpathSync: options.realpathSync,
    statSync: options.statSync,
  })

  const argv = [
    SANDBOX_BWRAP_BIN,

    ...sandboxIsolationArgv(),

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
    readonlyWorkspace ? "--ro-bind" : "--bind",
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
    {
      readonlyWorkspace,
      realpathSync: options.realpathSync,
      env: options.env,
    },
  )

  const gitMetadata = `${worktree}/.git`

  if (existsFn(gitMetadata)) {
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

  for (const path of SANDBOX_ETC_RO_BINDS) {
    roBindIfExists(argv, path, existsFn)
  }

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
    "--setenv", "PATH", sandboxPathWithToolchains(safePath, pathEntries),
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
