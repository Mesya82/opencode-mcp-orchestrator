import {
  accessSync,
  constants,
  lstatSync,
  statSync,
} from "node:fs"

import {
  delimiter,
  join,
  resolve,
  sep,
} from "node:path"

const EXECUTABLE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isSafeExecutableName(name) {
  return (
    typeof name === "string" &&
    EXECUTABLE_NAME_PATTERN.test(name)
  )
}

/*
 * PATH lookup without spawning a shell.
 *
 * Replaces `bash -c "command -v ${name}"` interpolation. Only bare
 * executable names are accepted; anything containing a slash, whitespace,
 * or shell metacharacters resolves to null instead of being executed.
 */
export function findExecutable(name) {
  if (!isSafeExecutableName(name)) {
    return null
  }

  const pathValue =
    process.env.PATH ?? ""

  for (
    const directory
    of pathValue.split(delimiter)
  ) {
    if (!directory) {
      continue
    }

    const candidate =
      join(directory, name)

    try {
      accessSync(
        candidate,
        constants.X_OK,
      )
    } catch {
      continue
    }

    /*
     * Directories can also be "executable" (searchable). Only regular
     * files or symlinks to files satisfy `command -v` for these CLIs.
     */
    try {
      const stat =
        lstatSync(candidate)

      if (stat.isDirectory()) {
        continue
      }
    } catch {
      continue
    }

    return candidate
  }

  return null
}

export function commandExists(name) {
  return (
    findExecutable(name) !== null
  )
}

/*
 * Exact-path launcher prerequisite check without spawning a shell.
 *
 * Production launches fixed absolute paths (/bin/bash --noprofile --norc,
 * /usr/bin/python3, /usr/bin/bwrap). A PATH substitute must not satisfy
 * this check: only the exact path counts, and it must be an executable
 * regular file (following executable symlinks). Injectable filesystem overrides keep unit
 * tests deterministic without touching the real filesystem.
 */
export const LAUNCHER_PREREQUISITE_PATHS = Object.freeze([
  "/bin/bash",
  "/usr/bin/python3",
  "/usr/bin/bwrap",
])

export function isExecutableFile(path, overrides = {}) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/")
  ) {
    return false
  }

  if (path.includes("\0")) {
    return false
  }

  const accessFn =
    overrides.accessSync ?? accessSync

  const statFn =
    overrides.statSync ?? statSync

  try {
    accessFn(
      path,
      constants.X_OK,
    )
  } catch {
    return false
  }

  try {
    const stat =
      statFn(path)

    if (!stat.isFile()) {
      return false
    }
  } catch {
    return false
  }

  return true
}

export function missingExecutableFiles(paths, overrides = {}) {
  const list =
    Array.isArray(paths)
      ? paths
      : [paths]

  return list.filter(
    (path) =>
      !isExecutableFile(path, overrides),
  )
}

/*
 * Hardened discovery-candidate resolver for configurators.
 *
 * Applies the same safe executable-name/path rules as normal PATH
 * discovery without ever spawning a shell:
 * - Blank values resolve to null (not configured).
 * - Bare names must satisfy isSafeExecutableName and resolve via
 *   findExecutable (PATH lookup, executable non-directory).
 * - Absolute paths must be a real executable non-directory.
 * - Anything else (relative paths, slash-containing names, shell
 *   metacharacters, unsafe names) resolves to null so callers never
 *   spawn it.
 */
export function resolveDiscoveryCandidate(value) {
  if (typeof value !== "string") {
    return null
  }

  const trimmed =
    value.trim()

  if (trimmed === "") {
    return null
  }

  if (trimmed.includes("\0")) {
    return null
  }

  if (trimmed.startsWith("/")) {
    try {
      accessSync(
        trimmed,
        constants.X_OK,
      )
    } catch {
      return null
    }

    try {
      const stat =
        lstatSync(trimmed)

      if (stat.isDirectory()) {
        return null
      }
    } catch {
      return null
    }

    return trimmed
  }

  if (
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return null
  }

  if (!isSafeExecutableName(trimmed)) {
    return null
  }

  return findExecutable(trimmed)
}

/*
 * Validate an explicitly configured model-catalog cwd.
 *
 * The value must be an absolute, existing, real directory: symlinks and
 * files are rejected without following a final symlink. Errors are
 * clear and contain only the supplied path (no secrets, no
 * stdout/stderr, no environment).
 */
export function resolveCatalogCwd(value) {
  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new Error(
      `invalid catalog cwd "${String(value ?? "")}": must be an absolute path`,
    )
  }

  if (!value.startsWith("/")) {
    throw new Error(
      `invalid catalog cwd "${value}": must be an absolute path`,
    )
  }

  const resolved =
    resolve(value)

  let stat = null

  try {
    stat =
      lstatSync(resolved)
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `invalid catalog cwd "${value}": does not exist`,
      )
    }

    throw error
  }

  if (stat.isSymbolicLink()) {
    throw new Error(
      `invalid catalog cwd "${resolved}": must not be a symlink`,
    )
  }

  if (!stat.isDirectory()) {
    throw new Error(
      `invalid catalog cwd "${resolved}": must be an existing directory`,
    )
  }

  return resolved
}

/*
 * Shared conservative timeout for version/path/MCP subprocess probes.
 *
 * Probes must never hang indefinitely when a CLI stalls. Long-running
 * installer orchestration (interactive configuration, payload install)
 * is intentionally excluded; only short probes use this timeout.
 */
export const SUBPROCESS_PROBE_TIMEOUT_MS = 20000

export function probeCommandName(command) {
  const text =
    String(command ?? "")

  const base =
    text.split("/").pop() || text

  return base || "command"
}

/*
 * Pure timeout detector for spawnSync results. Never inspects
 * stdout/stderr contents so timeout errors stay command-name-only.
 */
export function isProbeTimeoutResult(result) {
  return (
    result?.error?.code === "ETIMEDOUT"
  )
}

/*
 * Command-name-only timeout error. Callers must not append
 * stdout/stderr, argv, environment, or config contents.
 */
export function probeTimeoutMessage(command) {
  return (
    `${probeCommandName(command)} probe timed out`
  )
}

export function resolveHome(env = process.env) {
  const home =
    env.HOME

  if (!home) {
    throw new Error(
      "HOME is not set",
    )
  }

  if (!home.startsWith("/")) {
    throw new Error(
      `refusing to operate with non-absolute HOME: ${home}`,
    )
  }

  return resolve(home)
}

export function resolveDataHome(home, env = process.env) {
  const raw =
    env.XDG_DATA_HOME &&
    env.XDG_DATA_HOME.trim() !== ""
      ? env.XDG_DATA_HOME
      : join(home, ".local/share")

  if (!raw.startsWith("/")) {
    throw new Error(
      `refusing to operate with non-absolute XDG_DATA_HOME: ${raw}`,
    )
  }

  return resolve(raw)
}

export function resolveConfigHome(home, env = process.env) {
  const raw =
    env.XDG_CONFIG_HOME &&
    env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME
      : join(home, ".config")

  if (!raw.startsWith("/")) {
    throw new Error(
      `refusing to operate with non-absolute XDG_CONFIG_HOME: ${raw}`,
    )
  }

  return resolve(raw)
}

export function environmentPaths(env = process.env) {
  const home =
    resolveHome(env)

  const dataHome =
    resolveDataHome(home, env)

  const configHome =
    resolveConfigHome(home, env)

  return {
    home,
    dataHome,
    configHome,

    appData:
      resolve(
        dataHome,
        "opencode-mcp-orchestrator",
      ),

    appConfig:
      resolve(
        configHome,
        "opencode-mcp-orchestrator",
      ),
  }
}

function isBlankPath(value) {
  return (
    typeof value !== "string" ||
    value.trim() === ""
  )
}

function isAbsolutePath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/")
  )
}

function prefixesOf(resolvedPath) {
  if (resolvedPath === "/") {
    return ["/"]
  }

  const parts =
    resolvedPath
      .split(sep)
      .filter(Boolean)

  const prefixes = ["/"]

  let current = ""

  for (const part of parts) {
    current += `${sep}${part}`
    prefixes.push(current)
  }

  return prefixes
}

function assertExistingPrefixHasNoSymlink(prefix) {
  let stat = null

  try {
    stat =
      lstatSync(prefix)
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null
    }

    throw error
  }

  if (stat.isSymbolicLink()) {
    throw new Error(
      `refusing to operate on symlinked path: ${prefix}`,
    )
  }

  return stat
}

/*
 * Guard recursive replacement/removal targets.
 * - Normalizes with resolve() without following a final attacker-controlled
 *   symlink (lstat, never stat/realpath on the target itself).
 * - Rejects /, HOME, the data-home root, and anything outside the intended
 *   XDG data root / application data directory.
 * - Rejects symlink targets where removal/copy assumes a real directory.
 * - Fails closed with a clear message.
 */
export function assertSafeRecursiveTarget(
  target,
  {
    home,
    dataHome,
    appData,
  },
) {
  if (
    isBlankPath(home) ||
    isBlankPath(dataHome) ||
    isBlankPath(appData)
  ) {
    throw new Error(
      "refusing to operate without resolved home/data paths",
    )
  }

  if (
    !isAbsolutePath(home) ||
    !isAbsolutePath(dataHome) ||
    !isAbsolutePath(appData)
  ) {
    throw new Error(
      "refusing to operate with non-absolute home/data paths",
    )
  }

  if (isBlankPath(target)) {
    throw new Error(
      "refusing to operate on empty path",
    )
  }

  if (!isAbsolutePath(target)) {
    throw new Error(
      `refusing to operate with non-absolute target: ${target}`,
    )
  }

  const targetResolved =
    resolve(target)

  const homeResolved =
    resolve(home)

  const dataHomeResolved =
    resolve(dataHome)

  const appDataResolved =
    resolve(appData)

  if (targetResolved === "/") {
    throw new Error(
      `refusing to operate on filesystem root: ${targetResolved}`,
    )
  }

  if (targetResolved === homeResolved) {
    throw new Error(
      `refusing to operate on home directory: ${targetResolved}`,
    )
  }

  if (targetResolved === dataHomeResolved) {
    throw new Error(
      `refusing to operate on data-home root: ${targetResolved}`,
    )
  }

  if (dataHomeResolved === "/") {
    throw new Error(
      `refusing to operate with data-home root at filesystem root: ${dataHomeResolved}`,
    )
  }

  if (appDataResolved === dataHomeResolved) {
    throw new Error(
      `refusing to operate with application data at data-home root: ${appDataResolved}`,
    )
  }

  if (
    !appDataResolved.startsWith(
      dataHomeResolved + sep,
    )
  ) {
    throw new Error(
      `application data directory escapes data-home root: ${appDataResolved}`,
    )
  }

  if (
    targetResolved !== appDataResolved &&
    !targetResolved.startsWith(
      appDataResolved + sep,
    )
  ) {
    throw new Error(
      `refusing to operate outside application data directory: ${targetResolved}`,
    )
  }

  /*
   * Preserve the original final-component checks with their messages, then
   * harden the full chain below.
   */
  {
    let targetStat = null

    try {
      targetStat =
        lstatSync(targetResolved)
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error
      }
    }

    if (targetStat?.isSymbolicLink()) {
      throw new Error(
        `refusing to operate on symlinked path: ${targetResolved}`,
      )
    }
  }

  try {
    const appStat =
      lstatSync(appDataResolved)

    if (appStat.isSymbolicLink()) {
      throw new Error(
        `refusing to operate on symlinked application data directory: ${appDataResolved}`,
      )
    }
  } catch (error) {
    if (
      error?.message?.startsWith(
        "refusing to operate",
      )
    ) {
      throw error
    }

    if (error?.code !== "ENOENT") {
      throw error
    }
  }

  /*
   * The data-home root itself must be an existing real directory, or an
   * absent path whose nearest existing ancestors do not traverse symlinks.
   * lstat every existing prefix without following symlinks.
   */
  for (const prefix of prefixesOf(dataHomeResolved)) {
    assertExistingPrefixHasNoSymlink(prefix)
  }

  {
    let dataHomeStat = null

    try {
      dataHomeStat =
        lstatSync(dataHomeResolved)
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error
      }
    }

    if (
      dataHomeStat !== null &&
      !dataHomeStat.isDirectory()
    ) {
      throw new Error(
        `refusing to operate with data-home root that is not a directory: ${dataHomeResolved}`,
      )
    }
  }

  /*
   * Every existing component from the data-home root down to the target is
   * untrusted once XDG_DATA_HOME can point anywhere. lstat each existing
   * prefix without following symlinks so intermediate-parent and final
   * symlinks are rejected while not-yet-existing descendants stay allowed.
   */
  for (const prefix of prefixesOf(targetResolved)) {
    if (
      prefix !== dataHomeResolved &&
      !prefix.startsWith(
        dataHomeResolved + sep,
      )
    ) {
      continue
    }

    if (prefix === dataHomeResolved) {
      continue
    }

    assertExistingPrefixHasNoSymlink(prefix)
  }

  return targetResolved
}
