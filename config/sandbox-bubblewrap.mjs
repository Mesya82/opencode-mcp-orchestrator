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
  lstatSync as fsLstatSync,
  readFileSync as fsReadFileSync,
  realpathSync as fsRealpathSync,
  statSync as fsStatSync,
} from "node:fs"
import { isIP } from "node:net"

import {
  delimiter as pathDelimiter,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path"

import {
  normalizeSandboxNetworkAccess,
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

/*
 * Host-network support mounts: the only additional read-only mounts
 * permitted when networkAccess is "host". Resolver/hosts files keep
 * ordinary DNS behavior; the CA bundle/store keeps ordinary HTTPS CLI
 * behavior. Never broadened to /etc, /etc/ssl, /etc/ssl/private, HOME,
 * or a parent fallback.
 */
export const SANDBOX_NETWORK_RESOLVER_BINDS = Object.freeze([
  "/etc/resolv.conf",
  "/etc/hosts",
])

export const SANDBOX_NETWORK_CA_FILE_CANDIDATES = Object.freeze([
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/certs/ca-bundle.crt",
  "/etc/ssl/cert.pem",
])

export const SANDBOX_NETWORK_CA_DIR_CANDIDATES = Object.freeze([
  "/etc/ssl/certs",
  "/etc/pki/tls/certs",
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

export const SANDBOX_LINKED_GIT_MAX_FILE_BYTES = 4096

function isForbiddenGitMetadataRoot(canonical, home) {
  if (SANDBOX_TOOLCHAIN_FORBIDDEN_EXACT.has(canonical)) {
    return true
  }

  if (
    SANDBOX_RUNTIME_FORBIDDEN_PREFIXES.some(
      (prefix) => isWithin(prefix, canonical),
    )
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

function hasControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value)
}

function parseGitPointerFile(content, tag) {
  if (typeof content !== "string") return undefined
  if (content.length === 0 || content.length > SANDBOX_LINKED_GIT_MAX_FILE_BYTES) {
    return undefined
  }
  if (content.includes("\0")) return undefined
  // Allow single trailing newline only.
  let text = content
  if (text.endsWith("\n")) text = text.slice(0, -1)
  if (text.includes("\n") || text.includes("\r")) return undefined
  const trimmed = text.trim()
  const prefix = `${tag}: `
  if (!trimmed.startsWith(prefix)) return undefined
  const target = trimmed.slice(prefix.length).trim()
  if (target === "" || hasControlChars(target)) return undefined
  return target
}

/*
 * Bounded fail-closed resolver for linked (gitdir-file) worktrees.
 *
 * A linked worktree has `<worktree>/.git` as a small file containing
 * `gitdir: <absolute path>` pointing at the primary's
 * `<common>/.git/worktrees/<name>` directory, whose `commondir` file
 * points back at `<common>/.git` and whose `gitdir` file points back at
 * this worktree's `.git` file. Without mounting both external metadata
 * directories read-only at their original absolute paths, Git inside the
 * sandbox cannot resolve HEAD/objects/refs.
 *
 * Returns null when there is no linked metadata to mount (missing .git,
 * normal .git directory, or any malformed/forbidden case fail-closed).
 * Otherwise returns `{ linkedGitDir, commonDir }` as canonical absolute
 * paths that the caller may mount read-only.
 */
export function resolveLinkedGitMetadata(worktree, options = {}) {
  const existsFn = options.existsSync ?? fsExistsSync
  const readFileFn = options.readFileSync ?? fsReadFileSync
  const realpathFn = options.realpathSync ?? fsRealpathSync
  const statFn = options.statSync ?? fsStatSync
  const lstatFn = options.lstatSync ?? fsLstatSync
  const env = options.env ?? process.env

  try {
    const gitPath = `${worktree}/.git`
    // Lexical validation first: accept only a real regular file at .git.
    // Symlink/FIFO/device/other must fail closed here, not via raw binds.
    try {
      const lexical = lstatFn(gitPath)
      if (lexical.isDirectory()) return null
      if (!lexical.isFile()) return null
    } catch {
      // Missing .git remains supported (no linked metadata).
      // Distinguish missing from other lstat failures via stat probe:
      // any failure here means no resolvable linked metadata.
      return null
    }
    const readPointer = (path) => {
      const info = statFn(path)
      if (!info.isFile() || !Number.isSafeInteger(info.size) ||
          info.size < 1 || info.size > SANDBOX_LINKED_GIT_MAX_FILE_BYTES) {
        throw new Error("invalid Git metadata pointer")
      }
      const content = readFileFn(path, "utf8")
      if (Buffer.byteLength(content, "utf8") > SANDBOX_LINKED_GIT_MAX_FILE_BYTES) {
        throw new Error("invalid Git metadata pointer")
      }
      return content
    }
    let gitStat
    try {
      gitStat = statFn(gitPath)
    } catch {
      return null
    }
    if (gitStat.isDirectory()) return null
    // The .git file must exist as a non-directory; missing file was
    // already handled via stat failure above.
    if (!existsFn(gitPath)) return null

    let raw
    try {
      raw = readPointer(gitPath)
    } catch {
      return null
    }
    const rawGitDir = parseGitPointerFile(raw, "gitdir")
    if (rawGitDir === undefined) return null
    // Absolute pointers are historic; relative pointers (git worktree
    // add --relative-paths) resolve relative to the containing .git
    // directory, i.e. dirname(<worktree>/.git).
    const absGitDir = isAbsolute(rawGitDir)
      ? rawGitDir
      : resolve(dirname(gitPath), rawGitDir)
    if (absGitDir === "" || hasControlChars(absGitDir)) return null

    let canonicalGitFile
    try {
      canonicalGitFile = realpathFn(gitPath)
      if (canonicalGitFile !== resolve(gitPath)) return null
    } catch {
      return null
    }
    let canonicalGitDir
    try {
      canonicalGitDir = realpathFn(absGitDir)
    } catch {
      return null
    }
    if (!isAbsolute(canonicalGitDir)) return null
    try {
      if (!statFn(canonicalGitDir).isDirectory()) return null
    } catch {
      return null
    }

    // Symlink escapes are handled fail-closed by canonicalization
    // (realpath) plus the strict worktrees-child, backpointer, and
    // broad-root checks below.

    let commondirRaw
    try {
      commondirRaw = readPointer(resolve(canonicalGitDir, "commondir"))
    } catch {
      return null
    }
    // commondir is `../..`-style relative content without a tag.
    let commondirText = undefined
    if (typeof commondirRaw === "string" && commondirRaw.length <= SANDBOX_LINKED_GIT_MAX_FILE_BYTES && !commondirRaw.includes("\0")) {
      let t = commondirRaw
      if (t.endsWith("\n")) t = t.slice(0, -1)
      if (!t.includes("\n") && !t.includes("\r")) {
        t = t.trim()
        if (t !== "" && !hasControlChars(t)) commondirText = t
      }
    }
    if (commondirText === undefined) return null
    const rawCommon = resolve(canonicalGitDir, commondirText)
    let canonicalCommon
    try {
      canonicalCommon = realpathFn(rawCommon)
    } catch {
      return null
    }
    try {
      if (!statFn(canonicalCommon).isDirectory()) return null
    } catch {
      return null
    }

    // Linked gitdir must be exactly one child under <common>/worktrees.
    const worktreesDir = resolve(canonicalCommon, "worktrees")
    const rel = relative(worktreesDir, canonicalGitDir)
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.includes(sep)) {
      return null
    }

    // Common dir must be a real .git metadata directory, never a broad
    // root, HOME, system, or credential-adjacent directory.
    if (canonicalCommon.split(sep).pop() !== ".git") return null
    const homeValue = env?.HOME
    const canonicalHome = homeValue ? tryRealpath(homeValue, realpathFn) : undefined
    if (isForbiddenGitMetadataRoot(canonicalCommon, canonicalHome)) return null
    if (isForbiddenGitMetadataRoot(canonicalGitDir, canonicalHome)) return null
    // Never mount a host parent of the workspace as metadata (overly
    // broad). Metadata lexically inside the workspace itself is allowed
    // but overlaid read-only through both workspace aliases below.
    if (isWithin(canonicalCommon, worktree) || isWithin(canonicalGitDir, worktree)) return null
    // Prove the common dir is genuine Git metadata (HEAD or objects present).
    let isMetadata = false
    try {
      if (existsFn(resolve(canonicalCommon, "HEAD"))) isMetadata = true
    } catch { /* ignore */ }
    try {
      if (!isMetadata && existsFn(resolve(canonicalCommon, "objects"))) isMetadata = true
    } catch { /* ignore */ }
    if (!isMetadata) return null

    // Backpointer must resolve to this worktree's .git file.
    let backRaw
    try {
      backRaw = readPointer(resolve(canonicalGitDir, "gitdir"))
    } catch {
      return null
    }
    // Git writes the backpointer as a bare absolute path, not a gitdir tag.
    // Newer Git may write it relative; resolve relative to the private
    // gitdir directory (dirname(<gitdir>/gitdir)).
    let backPath
    if (typeof backRaw === "string") {
      let t = backRaw
      if (t.endsWith("\n")) t = t.slice(0, -1)
      if (!t.includes("\n") && !t.includes("\r")) {
        t = t.trim()
        if (t !== "") {
          if (isAbsolute(t)) {
            if (!hasControlChars(t)) backPath = t
          } else if (!hasControlChars(t)) {
            backPath = resolve(dirname(resolve(canonicalGitDir, "gitdir")), t)
          }
        }
      }
    }
    if (backPath === undefined || !isAbsolute(backPath)) return null
    let canonicalBack
    try {
      canonicalBack = realpathFn(backPath)
    } catch {
      return null
    }
    if (canonicalBack !== canonicalGitFile) return null

    return { linkedGitDir: canonicalGitDir, commonDir: canonicalCommon }
  } catch {
    return null
  }
}

function ensureEmptyAncestorDirs(argv, target) {
  const existing = new Set()
  for (let index = 0; index + 1 < argv.length; index += 1) {
    if (argv[index] === "--dir") existing.add(argv[index + 1])
  }
  const parent = dirname(target)
  const parts = parent.split("/").filter(Boolean)
  let current = ""
  for (const part of parts) {
    current += `/${part}`
    if (current === "/home" || current === "/tmp") continue
    if (existing.has(current)) continue
    argv.push("--dir", current)
    existing.add(current)
  }
}

function roBindValidatedGitMetadata(argv, paths) {
  const seen = new Set()
  for (const path of paths) {
    if (!path || seen.has(path)) continue
    seen.add(path)
    ensureEmptyAncestorDirs(argv, path)
    argv.push("--ro-bind", path, path)
  }
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

function isForbiddenNetworkTarget(canonical, home) {
  if (
    canonical === "/etc" ||
    canonical === "/etc/ssl" ||
    canonical === "/etc/ssl/private" ||
    canonical === "/etc/pki/private" ||
    canonical === "/etc/pki/tls/private" ||
    canonical === "/" ||
    canonical === "/home" ||
    canonical === "/tmp"
  ) {
    return true
  }
  if (isWithin("/etc/ssl/private", canonical)) return true
  if (isWithin("/etc/pki/private", canonical)) return true
  if (isWithin("/etc/pki/tls/private", canonical)) return true
  if (SANDBOX_TOOLCHAIN_FORBIDDEN_EXACT.has(canonical)) return true
  if (!home) return false
  if (canonical === home || isWithin(home, canonical)) return true
  return false
}

function isAllowedResolverCanonical(source, canonical) {
  if (source === "/etc/hosts") return canonical === source
  if (source !== "/etc/resolv.conf") return false
  if (canonical === source) return true
  return [
    "/run/systemd/resolve",
    "/run/NetworkManager",
    "/run/resolvconf",
    "/run/connman",
    "/etc/resolvconf/run",
  ].some((root) => isWithin(root, canonical))
}

function isAllowedCaCanonical(canonical) {
  if (
    isWithin("/etc/ssl/private", canonical) ||
    isWithin("/etc/pki/private", canonical) ||
    isWithin("/etc/pki/tls/private", canonical)
  ) {
    return false
  }
  return (
    canonical === "/etc/ssl/cert.pem" ||
    isWithin("/etc/ssl/certs", canonical) ||
    isWithin("/etc/pki/tls/certs", canonical) ||
    isWithin("/etc/pki/ca-trust/extracted", canonical) ||
    isWithin("/usr/share/ca-certificates", canonical)
  )
}

/*
 * Resolve the narrow read-only network-support mounts for host mode.
 * Returns [{ source, target }] with target === source. Symlink-backed
 * sources are resolved via realpath and validated for safe location and
 * file type. A usable resolver configuration and at least one usable CA
 * trust source (file or directory) are both required; host mode fails
 * closed when either capability is unavailable. /etc/hosts remains
 * optional because ordinary DNS does not depend on it.
 */
export function resolveSandboxNetworkMounts(options = {}) {
  const existsFn = options.existsSync ?? fsExistsSync
  const readFileFn = options.readFileSync ?? fsReadFileSync
  const realpathFn = options.realpathSync ?? fsRealpathSync
  const statFn = options.statSync ?? fsStatSync
  const env = options.env ?? process.env
  const home = env?.HOME
  let canonicalHome
  try {
    canonicalHome = home ? realpathFn(home) : undefined
  } catch {
    canonicalHome = undefined
  }
  const mounts = []
  const seen = new Set()
  let resolverFound = false

  const pushMount = (source, target = source) => {
    if (seen.has(`${source}\0${target}`)) return
    seen.add(`${source}\0${target}`)
    mounts.push({ source, target })
  }

  for (const source of SANDBOX_NETWORK_RESOLVER_BINDS) {
    let present = false
    try {
      present = existsFn(source)
    } catch {
      present = false
    }
    if (!present) continue
    let canonical
    try {
      canonical = realpathFn(source)
    } catch {
      continue
    }
    if (!isAbsolute(canonical)) continue
    let info
    try {
      info = statFn(canonical)
    } catch {
      continue
    }
    if (!info.isFile || !info.isFile()) continue
    if (!isAllowedResolverCanonical(source, canonical)) continue
    if (isForbiddenNetworkTarget(canonical, canonicalHome)) continue
    if (canonical !== source) {
      // Resolved target must itself be the validated file; bind the
      // original path only when the backing file is safe. bwrap
      // --ro-bind follows the host path, so both must be safe.
      if (isForbiddenNetworkTarget(source, canonicalHome)) continue
    }
    if (source === "/etc/resolv.conf") {
      let contents
      try {
        contents = readFileFn(source, "utf8")
      } catch {
        continue
      }
      if (
        typeof contents !== "string" ||
        contents.length > 64 * 1024 ||
        contents.includes("\0")
      ) {
        continue
      }
      const hasNameserver = contents.split("\n").some((line) => {
        const directive = line.replace(/[#;].*$/, "").trim().split(/\s+/)
        if (directive[0] !== "nameserver" || directive.length !== 2) {
          return false
        }
        return isIP(directive[1].split("%", 1)[0]) !== 0
      })
      if (!hasNameserver) continue
    }
    pushMount(source)
    if (source === "/etc/resolv.conf") resolverFound = true
  }

  if (!resolverFound) {
    throw new Error("no usable resolver configuration for host networking")
  }

  let caFound = false
  const considerCa = (source, kind) => {
    let present = false
    try {
      present = existsFn(source)
    } catch {
      present = false
    }
    if (!present) return
    let canonical
    try {
      canonical = realpathFn(source)
    } catch {
      return
    }
    if (!isAbsolute(canonical)) return
    let info
    try {
      info = statFn(canonical)
    } catch {
      return
    }
    if (kind === "file") {
      if (!info.isFile || !info.isFile()) return
    } else {
      if (!info.isDirectory || !info.isDirectory()) return
    }
    if (canonical === "/etc" || canonical === "/etc/ssl") return
    if (!isAllowedCaCanonical(canonical)) return
    if (isForbiddenNetworkTarget(canonical, canonicalHome)) return
    if (kind === "file" && canonical !== source) {
      // Symlink-backed CA file (notably Fedora/RHEL's
      // /etc/pki/tls/certs/ca-bundle.crt): never bind onto the lexical
      // symlink destination -- Bubblewrap 0.12.0 rejects that. Keep the
      // validated symlink-bearing parent directory at its lexical
      // destination and bind the validated canonical regular file at its
      // canonical destination so the preserved symlink resolves.
      pushMount(canonical, canonical)
      caFound = true
      return
    }
    pushMount(source)
    caFound = true
  }

  // Bubblewrap processes mounts in command-line order. Bind directories
  // before files so the preserved lexical CA directory is already in
  // place when the canonical trust file it links to is mounted
  // (notably Fedora/RHEL's symlink-backed
  // /etc/pki/tls/certs/ca-bundle.crt layout).
  for (const source of SANDBOX_NETWORK_CA_DIR_CANDIDATES) {
    considerCa(source, "dir")
  }
  for (const source of SANDBOX_NETWORK_CA_FILE_CANDIDATES) {
    considerCa(source, "file")
  }

  if (!caFound) {
    throw new Error("no usable CA trust source for host networking")
  }

  return mounts
}

function addSandboxNetworkBinds(argv, mounts) {
  for (const mount of mounts) {
    ensureEmptyAncestorDirs(argv, mount.target)
    argv.push("--ro-bind", mount.source, mount.target)
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
  const readFileFn = options.readFileSync ?? fsReadFileSync
  const lstatFn = options.lstatSync ?? fsLstatSync
  const realpathFn = options.realpathSync ?? fsRealpathSync
  const statFn = options.statSync ?? fsStatSync
  const readonlyWorkspace = options.readonlyWorkspace === true
  const networkAccess = normalizeSandboxNetworkAccess(
    options.networkAccess,
  )
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

    ...sandboxIsolationArgv({ networkAccess }),

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

  /*
   * Validate lexical .git BEFORE any bind: accept only a real directory
   * (normal repo) or a real regular gitfile whose linked metadata
   * validates. Symlink/FIFO/device/other or malformed gitfile must fail
   * closed at builder level (explicit bounded error, not raw bind).
   * Missing .git remains supported for ordinary non-Git workspaces.
   */
  let gitKind = "missing"
  try {
    const lexical = lstatFn(gitMetadata)
    if (lexical.isDirectory()) {
      gitKind = "dir"
    } else if (lexical.isFile()) {
      gitKind = "file"
    } else {
      throw new Error(
        "invalid Git metadata: .git is not a directory or regular file",
      )
    }
  } catch (error) {
    if (error?.message?.startsWith("invalid Git metadata")) throw error
    if (error?.code === "ENOENT") {
      gitKind = "missing"
    } else {
      throw new Error("invalid Git metadata: cannot stat .git")
    }
  }

  if (gitKind === "dir") {
    let canonicalGitDir
    try {
      canonicalGitDir = realpathFn(gitMetadata)
    } catch (error) {
      if (error?.message?.startsWith("invalid Git metadata")) throw error
      throw new Error("invalid Git metadata: cannot stat .git")
    }
    // Canonical directory must equal the lexical path; a mismatch means
    // the .git directory is a symlink escape and must fail closed here.
    if (canonicalGitDir !== resolve(gitMetadata)) {
      throw new Error("invalid Git metadata: .git directory mismatch")
    }
    try {
      if (!statFn(canonicalGitDir).isDirectory()) {
        throw new Error("invalid Git metadata: .git is not a directory")
      }
    } catch (error) {
      if (error?.message?.startsWith("invalid Git metadata")) throw error
      throw new Error("invalid Git metadata: cannot stat .git")
    }
  }

  let linked = null
  if (gitKind === "file") {
    // A regular .git file must be a valid linked-worktree pointer.
    // Anything else fails closed: no raw bind of attacker-shaped content.
    linked = resolveLinkedGitMetadata(worktree, {
      existsSync: existsFn,
      readFileSync: options.readFileSync,
      realpathSync: options.realpathSync,
      statSync: options.statSync,
      lstatSync: options.lstatSync,
      env: options.env,
    })
    if (!linked) {
      throw new Error("invalid Git metadata: malformed .git file")
    }
  }

  if (gitKind !== "missing") {
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

    /*
     * Linked worktrees store `.git` as a gitdir file pointing outside the
     * worktree at `<common>/.git/worktrees/<name>`. Mount only the
     * validated linked gitdir and common Git metadata read-only at their
     * original absolute paths. Fail closed (no extra mounts) on any
     * malformed, escaping, overly broad, or mismatched metadata.
     */
    if (linked) {
      roBindValidatedGitMetadata(argv, [linked.linkedGitDir, linked.commonDir])
      // Any validated metadata path inside the workspace is visible
      // through both aliases, so overlay it read-only through both paths
      // as well. Never writable.
      for (const path of [linked.linkedGitDir, linked.commonDir]) {
        if (path !== gitMetadata && isWithin(worktree, path) && path !== worktree) {
          const alias = `/workspace${path.slice(worktree.length)}`
          argv.push("--ro-bind", path, alias)
        }
      }
    }
  }

  for (const path of SANDBOX_ETC_RO_BINDS) {
    roBindIfExists(argv, path, existsFn)
  }

  if (networkAccess === "host") {
    addSandboxNetworkBinds(
      argv,
      resolveSandboxNetworkMounts({
        existsSync: existsFn,
        readFileSync: readFileFn,
        realpathSync: realpathFn,
        statSync: statFn,
        env: options.env,
      }),
    )
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
