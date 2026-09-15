/*
 * Networkless Doctor execution probes.
 *
 * Each probe executes a fixed, security-owned script inside the real shared
 * Bubblewrap construction (no OpenCode, provider, or MCP session). Worker
 * uses the effective writable sandbox_shell construction and must succeed
 * writing a disposable workspace. Runner uses the effective read-only
 * sandbox_run construction and must fail writing the disposable workspace
 * while a sandbox-private temporary location stays writable.
 *
 * Everything is bounded: each probe uses the existing subprocess probe
 * timeout (or a stricter fixed bound), captured output is bounded and
 * sanitized, and only fixed pass/fail wording is printed.
 */

import {
  mkdtempSync,
  realpathSync as fsRealpathSync,
  rmSync,
  statSync as fsStatSync,
} from "node:fs"

import {
  tmpdir,
} from "node:os"

import {
  join,
  relative,
  resolve,
  sep,
  isAbsolute,
} from "node:path"

import {
  spawnSync,
} from "node:child_process"

import {
  sandboxIsolationArgv,
  hasNetworklessIsolation,
} from "./sandbox-isolation.mjs"

import {
  normalizeSandboxRuntime,
} from "./sandbox-runtime.mjs"

import {
  SUBPROCESS_PROBE_TIMEOUT_MS,
} from "../installer/path-security.mjs"

export const SANDBOX_PROBE_TIMEOUT_MS = Math.min(
  SUBPROCESS_PROBE_TIMEOUT_MS,
  20000,
)

export const SANDBOX_PROBE_MAX_OUTPUT_BYTES = 4096

export const SANDBOX_PROBE_ERROR_CODES = Object.freeze({
  FAILED: "probe failed",
  TIMED_OUT: "probe timed out",
  INVALID_RUNTIME: "invalid sandbox runtime configuration",
  SPAWN_FAILED: "sandbox probe spawn failed",
  UNKNOWN_PROBE: "unknown sandbox probe",
})

export const SANDBOX_PROBE_KINDS = Object.freeze([
  "worker",
  "runner",
])

export const SANDBOX_PROBE_BASE_PATH = "/usr/bin:/bin"

const PROBE_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/

const PROBE_FORBIDDEN_EXACT = new Set([
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

const PROBE_FORBIDDEN_PREFIXES = ["/dev", "/etc", "/proc", "/run", "/sys"]

const PROBE_HOME_SENSITIVE = [
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

export const SANDBOX_PROBE_FAILURE_REASONS = Object.freeze([
  "exit-nonzero",
  "timeout",
  "spawn-error",
  "invalid-runtime",
  "invalid-argv",
  "unknown-probe",
])

export function probeFailureDetail(kind, reason) {
  const safeKind = kind === "runner" ? "runner" : "worker"
  const safeReason = SANDBOX_PROBE_FAILURE_REASONS.includes(reason)
    ? reason
    : "exit-nonzero"
  if (safeReason === "timeout") return `${safeKind} probe timed out`
  if (safeReason === "invalid-runtime") return `${safeKind} probe invalid runtime`
  if (safeReason === "spawn-error") return `${safeKind} probe spawn failed`
  if (safeReason === "invalid-argv") return `${safeKind} probe rejected`
  if (safeReason === "unknown-probe") return `${safeKind} probe unknown kind`
  return `${safeKind} probe failed`
}

function isWithinProbeRoot(root, candidate) {
  const rel = relative(root, candidate)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function canonicalHomeProbe(home, realpathFn) {
  if (!home) return undefined
  try {
    return realpathFn(home)
  } catch {
    return undefined
  }
}

function isForbiddenProbeRoot(canonical, home) {
  if (PROBE_FORBIDDEN_EXACT.has(canonical)) return true
  if (PROBE_FORBIDDEN_PREFIXES.some((prefix) => isWithinProbeRoot(prefix, canonical))) return true
  if (canonical.split(sep).includes(".git")) return true
  if (PROBE_HOME_SENSITIVE.some((sensitive) => canonical.split(sep).includes(sensitive))) return true
  if (!home) return false
  if (canonical === home) return true
  return PROBE_HOME_SENSITIVE.some((sensitive) =>
    isWithinProbeRoot(resolve(home, sensitive), canonical),
  )
}

function invalidProbeRuntime() {
  return new Error("invalid sandbox runtime configuration")
}

export function sanitizeProbeDetail(value) {
  if (typeof value !== "string") return ""
  let text = ""
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if ((code >= 0 && code <= 31) || code === 127) continue
    text += ch
  }
  if (text.length <= 160) return text
  return `${text.slice(0, 160)}...[truncated]`
}

/*
 * Project the configured sandboxRuntime into probe mounts/PATH/environment
 * with the same filesystem validation delegated sandboxes consume
 * (canonicalization, symlink resolution, containment, directory and
 * broad/sensitive-root checks). Normalization alone is not trusted.
 * The input is re-normalized so unvalidated caller shapes fail closed
 * instead of being mounted verbatim.
 */
export function resolveProbeRuntimeBindings(sandboxRuntime, options = {}) {
  const normalized = normalizeSandboxRuntime(
    sandboxRuntime ?? { trustedRoots: [] },
  )
  const realpathFn = options.realpathSync ?? fsRealpathSync
  const statFn = options.statSync ?? fsStatSync
  const home = "home" in options ? options.home : process.env.HOME
  const canonicalHome = canonicalHomeProbe(home, realpathFn)

  const mountRoots = []
  const pathEntries = []
  const environment = {}
  const seenRoots = new Set()
  const seenPaths = new Set()

  for (const entry of normalized.trustedRoots) {
    let root
    try {
      root = realpathFn(entry.root)
    } catch {
      throw invalidProbeRuntime()
    }
    let info
    try {
      info = statFn(root)
    } catch {
      throw invalidProbeRuntime()
    }
    if (!info.isDirectory()) throw invalidProbeRuntime()
    if (isForbiddenProbeRoot(root, canonicalHome)) throw invalidProbeRuntime()
    if (seenRoots.has(root)) throw invalidProbeRuntime()
    seenRoots.add(root)
    mountRoots.push(root)

    for (const relativePath of entry.pathEntries) {
      let canonical
      try {
        canonical = realpathFn(resolve(root, relativePath))
      } catch {
        throw invalidProbeRuntime()
      }
      if (!isWithinProbeRoot(root, canonical)) throw invalidProbeRuntime()
      let pathInfo
      try {
        pathInfo = statFn(canonical)
      } catch {
        throw invalidProbeRuntime()
      }
      if (!pathInfo.isDirectory()) throw invalidProbeRuntime()
      if (seenPaths.has(canonical)) throw invalidProbeRuntime()
      seenPaths.add(canonical)
      pathEntries.push(canonical)
    }

    for (const [name, relativePath] of Object.entries(entry.environment)) {
      if (!PROBE_ENV_KEY_PATTERN.test(name)) continue
      let canonical
      try {
        canonical = realpathFn(resolve(root, relativePath))
      } catch {
        throw invalidProbeRuntime()
      }
      if (!isWithinProbeRoot(root, canonical)) throw invalidProbeRuntime()
      environment[name] = canonical
    }
  }

  return { mountRoots, pathEntries, environment }
}

export function probeSandboxPath(sandboxRuntime, options = {}) {
  const { pathEntries } = resolveProbeRuntimeBindings(sandboxRuntime, options)
  if (pathEntries.length === 0) return SANDBOX_PROBE_BASE_PATH
  return `${SANDBOX_PROBE_BASE_PATH}:${pathEntries.join(":")}`
}

function pushProbeRuntimeBinds(argv, sandboxRuntime, options = {}) {
  const { mountRoots } = resolveProbeRuntimeBindings(sandboxRuntime, options)

  for (const root of mountRoots) {
    argv.push("--ro-bind", root, root)
  }
}

function pushProbeEnv(argv, sandboxRuntime, options = {}) {
  const { environment } = resolveProbeRuntimeBindings(sandboxRuntime, options)

  argv.push(
    "--clearenv",
    "--setenv",
    "HOME",
    "/home/sandbox",
    "--setenv",
    "PATH",
    probeSandboxPath(sandboxRuntime, options),
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "LC_ALL",
    "C.UTF-8",
  )

  for (const [name, value] of Object.entries(environment)) {
    argv.push("--setenv", name, value)
  }
}

export function probeWorkspacePrefix() {
  return join(tmpdir(), "doctor-probe-")
}

export function createProbeWorkspace() {
  return mkdtempSync(probeWorkspacePrefix())
}

export function cleanupProbeWorkspace(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup only.
  }
}

/*
 * Effective Worker construction: writable workspace, matching sandbox_shell.
 * Only the disposable probe workspace is exposed; never the repository or
 * host HOME.
 */
export function buildWorkerProbeArgv(workspace, sandboxRuntime, options = {}) {
  const argv = [
    "/usr/bin/bwrap",
    ...sandboxIsolationArgv(),
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/etc",
    "--bind",
    workspace,
    "/workspace",
  ]

  pushProbeRuntimeBinds(argv, sandboxRuntime, options)
  pushProbeEnv(argv, sandboxRuntime, options)

  argv.push(
    "--chdir",
    "/workspace",
    "/bin/sh",
    "-c",
    "printf probe-ok > probe-write.txt && test \"$(cat probe-write.txt)\" = probe-ok",
  )

  return argv
}

/*
 * Effective Runner construction: read-only workspace with writable
 * sandbox-private locations, matching sandbox_run_ro. The disposable
 * workspace write must fail while /tmp stays writable.
 */
export function buildRunnerProbeArgv(workspace, sandboxRuntime, options = {}) {
  const argv = [
    "/usr/bin/bwrap",
    ...sandboxIsolationArgv(),
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/etc",
    "--ro-bind",
    workspace,
    "/workspace",
  ]

  pushProbeRuntimeBinds(argv, sandboxRuntime, options)
  pushProbeEnv(argv, sandboxRuntime, options)

  argv.push(
    "--chdir",
    "/workspace",
    "/bin/sh",
    "-c",
    "if printf probe-fail > probe-write.txt 2>/dev/null; then exit 1; fi; printf tmp-ok > /tmp/probe-tmp.txt && test \"$(cat /tmp/probe-tmp.txt)\" = tmp-ok",
  )

  return argv
}

export function buildSandboxProbeArgv(kind, workspace, sandboxRuntime, options = {}) {
  if (kind === "worker") return buildWorkerProbeArgv(workspace, sandboxRuntime, options)
  if (kind === "runner") return buildRunnerProbeArgv(workspace, sandboxRuntime, options)
  throw new Error(probeFailureDetail("worker", "unknown-probe"))
}

export function probeSandboxArgvInvariants(argv, workspace, sandboxRuntime) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return ["empty probe argv"]
  }

  if (!hasNetworklessIsolation(argv)) {
    return ["missing networkless isolation"]
  }

  const home = process.env.HOME

  if (
    typeof home === "string" &&
    home !== "" &&
    home !== "/home/sandbox" &&
    argv.includes(home)
  ) {
    return ["mounts host HOME"]
  }

  let allowedExtra = []

  try {
    allowedExtra = resolveProbeRuntimeBindings(sandboxRuntime).mountRoots
  } catch {
    return ["invalid sandbox runtime configuration"]
  }

  const allowed = new Set([workspace, "/usr", ...allowedExtra])

  const hasAlias = (link, target) => {
    for (let index = 0; index + 2 < argv.length; index += 1) {
      if (argv[index] === "--symlink" && argv[index + 1] === target && argv[index + 2] === link) return true
    }
    return false
  }

  if (!hasAlias("/bin", "usr/bin") || !hasAlias("/lib", "usr/lib") || !hasAlias("/lib64", "usr/lib64")) {
    return ["missing system aliases"]
  }

  // Never expose anything besides the disposable workspace, /usr, and the
  // configured trusted runtime roots.
  for (let index = 0; index + 2 < argv.length; index += 1) {
    const flag = argv[index]
    if (flag !== "--bind" && flag !== "--ro-bind") continue
    const source = argv[index + 1]
    if (allowed.has(source)) continue
    return ["unexpected bind source"]
  }

  if (!argv.includes(workspace)) {
    return ["missing disposable workspace"]
  }

  return []
}

export function runSandboxProbe(
  kind,
  {
    workspace,
    sandboxRuntime,
    spawn = spawnSync,
    timeoutMs = SANDBOX_PROBE_TIMEOUT_MS,
    maxOutputBytes = SANDBOX_PROBE_MAX_OUTPUT_BYTES,
  } = {},
) {
  const safeKind = kind === "runner" ? "runner" : "worker"
  if (kind !== "worker" && kind !== "runner") {
    return { ok: false, detail: probeFailureDetail(safeKind, "unknown-probe") }
  }
  const created = workspace === undefined
  const activeWorkspace = workspace ?? createProbeWorkspace()

  try {
    let argv
    try {
      argv = buildSandboxProbeArgv(kind, activeWorkspace, sandboxRuntime)
    } catch {
      return { ok: false, detail: probeFailureDetail(safeKind, "invalid-runtime") }
    }

    let invariants = []
    try {
      invariants = probeSandboxArgvInvariants(
        argv,
        activeWorkspace,
        sandboxRuntime,
      )
    } catch {
      return { ok: false, detail: probeFailureDetail(safeKind, "invalid-runtime") }
    }
    if (invariants.length > 0) {
      if (invariants[0] === "invalid sandbox runtime configuration") {
        return { ok: false, detail: probeFailureDetail(safeKind, "invalid-runtime") }
      }
      return { ok: false, detail: probeFailureDetail(safeKind, "invalid-argv") }
    }

    let result
    try {
      result = spawn(argv[0], argv.slice(1), {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        env: { PATH: "/usr/bin:/bin" },
      })
    } catch {
      return { ok: false, detail: probeFailureDetail(safeKind, "spawn-error") }
    }

    if (result?.error?.code === "ETIMEDOUT") {
      return { ok: false, detail: probeFailureDetail(safeKind, "timeout") }
    }

    if (result?.error) {
      return { ok: false, detail: probeFailureDetail(safeKind, "spawn-error") }
    }

    if (result?.status === 0) {
      return { ok: true, detail: "" }
    }

    return {
      ok: false,
      detail: probeFailureDetail(safeKind, "exit-nonzero"),
    }
  } finally {
    if (created) cleanupProbeWorkspace(activeWorkspace)
  }
}
