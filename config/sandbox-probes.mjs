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
  existsSync as fsExistsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"

import {
  tmpdir,
} from "node:os"

import {
  join,
} from "node:path"

import {
  spawnSync,
} from "node:child_process"

import {
  hasNetworklessIsolation,
} from "./sandbox-isolation.mjs"

import {
  normalizeSandboxRuntime,
} from "./sandbox-runtime.mjs"

import {
  SANDBOX_ETC_RO_BINDS,
  buildBaseSandboxArgv,
  resolveSandboxRuntimeCapabilities,
  resolveSandboxToolchainDirs,
  runnerOutputBindArgs,
  safeSystemPath,
  sandboxPathWithToolchains,
} from "./sandbox-bubblewrap.mjs"

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
 * through the shared production filesystem validation (canonicalization,
 * symlink resolution, containment, directory and broad/sensitive-root
 * checks). The input is re-normalized so unvalidated caller shapes fail
 * closed instead of being mounted verbatim. Production failures carry
 * detailed messages; probes redact them to the fixed invalid-runtime
 * category.
 */
export function resolveProbeRuntimeBindings(sandboxRuntime, options = {}) {
  const normalized = normalizeSandboxRuntime(
    sandboxRuntime ?? { trustedRoots: [] },
  )
  try {
    return resolveSandboxRuntimeCapabilities({
      config: normalized,
      env: "home" in options
        ? { ...process.env, HOME: options.home }
        : process.env,
      realpathSync: options.realpathSync,
      statSync: options.statSync,
    })
  } catch {
    throw new Error("invalid sandbox runtime configuration")
  }
}

function probeProductionInputs(sandboxRuntime, options = {}) {
  const normalized = normalizeSandboxRuntime(
    sandboxRuntime ?? { trustedRoots: [] },
  )
  let runtime
  try {
    runtime = resolveSandboxRuntimeCapabilities({
      config: normalized,
      env: "home" in options
        ? { ...process.env, HOME: options.home }
        : process.env,
      realpathSync: options.realpathSync,
      statSync: options.statSync,
    })
  } catch {
    throw new Error("invalid sandbox runtime configuration")
  }
  let toolchainDirs = []
  try {
    toolchainDirs = resolveSandboxToolchainDirs(
      undefined,
      {
        env: options.env,
        delimiter: options.delimiter,
        realpathSync: options.realpathSync,
        statSync: options.statSync,
        ...("home" in options ? { home: options.home } : {}),
      },
    )
  } catch {
    throw new Error("invalid sandbox runtime configuration")
  }
  const safePath = safeSystemPath({
    path: options.path,
    delimiter: options.delimiter,
    env: options.env,
    realpathSync: options.realpathSync,
    statSync: options.statSync,
  })
  return { runtime, toolchainDirs, safePath }
}

export function probeSandboxPath(sandboxRuntime, options = {}) {
  const { runtime, toolchainDirs, safePath } = probeProductionInputs(
    sandboxRuntime,
    options,
  )
  return sandboxPathWithToolchains(
    safePath,
    [...runtime.pathEntries, ...toolchainDirs],
  )
}

export function probeWorkspacePrefix() {
  return join(tmpdir(), "doctor-probe-")
}

export function createProbeWorkspace() {
  const workspace = mkdtempSync(probeWorkspacePrefix())
  // Disposable Git metadata overlay: ensure the shared production .git
  // read-only overlays are actually exercised through both workspace paths.
  const gitDir = join(workspace, ".git")
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/probe\n")
  return workspace
}

export function cleanupProbeWorkspace(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup only.
  }
}

/*
 * Effective Worker construction: the production Bubblewrap builder with a
 * writable workspace, matching sandbox_shell. The disposable probe workspace
 * plays the role of the per-call session worktree: it is exposed both at
 * /workspace and at its absolute host path, with Git metadata (a probe
 * marker file) overlaid read-only through both paths exactly like
 * production. Only the disposable probe workspace is exposed; never the
 * repository or host HOME.
 */
export function buildWorkerProbeArgv(workspace, sandboxRuntime, options = {}) {
  const { runtime, toolchainDirs, safePath } = probeProductionInputs(
    sandboxRuntime,
    options,
  )
  const argv = buildBaseSandboxArgv(
    workspace,
    "/workspace",
    {
      readonlyWorkspace: false,
      runtime,
      toolchainDirs,
      safePath,
    },
  )

  argv.push(
    "/bin/sh",
    "-c",
    "printf probe-ok > probe-write.txt && test \"$(cat probe-write.txt)\" = probe-ok && printf probe-ok > \"$0/probe-abs.txt\" && test \"$(cat \"$0/probe-abs.txt\")\" = probe-ok && { if printf x >> .git/HEAD 2>/dev/null; then exit 1; fi; } && { if printf x >> \"$0/.git/HEAD\" 2>/dev/null; then exit 1; fi; } && test ! -w .git/HEAD",
    workspace,
  )

  return argv
}

/*
 * Effective Runner construction: the production Bubblewrap builder with a
 * read-only workspace, matching sandbox_run_ro. The disposable
 * workspace write must fail while /tmp stays writable.
 */
export function buildRunnerProbeArgv(workspace, sandboxRuntime, options = {}) {
  const { runtime, toolchainDirs, safePath } = probeProductionInputs(
    sandboxRuntime,
    options,
  )
  const runDir = options.runDir ?? join(workspace, "..", "probe-runner-output")
  const argv = buildBaseSandboxArgv(
    workspace,
    "/workspace",
    {
      readonlyWorkspace: true,
      runtime,
      toolchainDirs,
      safePath,
    },
  )

  argv.push(
    ...runnerOutputBindArgs(runDir),

    "/bin/sh",
    "-c",
    "if printf probe-fail > probe-write.txt 2>/dev/null; then exit 1; fi; "
    + "if printf probe-fail > \"$0/probe-abs.txt\" 2>/dev/null; then exit 1; fi; "
    + "{ if printf x >> .git/HEAD 2>/dev/null; then exit 1; fi; }; "
    + "{ if printf x >> \"$0/.git/HEAD\" 2>/dev/null; then exit 1; fi; }; "
    + "printf runner-ok > /runner-output/probe-out.txt && test \"$(cat /runner-output/probe-out.txt)\" = runner-ok && "
    + "printf tmp-ok > /tmp/probe-tmp.txt && test \"$(cat /tmp/probe-tmp.txt)\" = tmp-ok",
    workspace,
  )

  return argv
}

export function buildSandboxProbeArgv(kind, workspace, sandboxRuntime, options = {}) {
  if (kind === "worker") return buildWorkerProbeArgv(workspace, sandboxRuntime, options)
  if (kind === "runner") return buildRunnerProbeArgv(workspace, sandboxRuntime, options)
  throw new Error(probeFailureDetail("worker", "unknown-probe"))
}

export function probeSandboxArgvInvariants(argv, workspace, sandboxRuntime, options = {}) {
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

  let runtime
  let toolchainDirs = []

  try {
    const inputs = probeProductionInputs(sandboxRuntime, options)
    runtime = inputs.runtime
    toolchainDirs = inputs.toolchainDirs
  } catch {
    return ["invalid sandbox runtime configuration"]
  }

  const allowedMountRoots = new Set([...runtime.mountRoots, ...toolchainDirs])
  const allowed = new Set([workspace, "/usr", ...allowedMountRoots])

  // Exact expected Runner output source: supplied runDir, or the deterministic
  // builder default for side-effect-free direct builder API tests.
  const expectedRunDir = options.runDir ?? join(workspace, "..", "probe-runner-output")

  for (const path of SANDBOX_ETC_RO_BINDS) {
    allowed.add(path)
  }

  const workspaceGit = `${workspace}/.git`
  allowed.add(workspaceGit)

  const hasAlias = (link, target) => {
    for (let index = 0; index + 2 < argv.length; index += 1) {
      if (argv[index] === "--symlink" && argv[index + 1] === target && argv[index + 2] === link) return true
    }
    return false
  }

  if (!hasAlias("/bin", "usr/bin") || !hasAlias("/lib", "usr/lib") || !hasAlias("/lib64", "usr/lib64")) {
    return ["missing system aliases"]
  }

  // Expected production binds: exactly the fixed /etc RO set that exists,
  // only when the caller-supplied existence check agrees. Default to the
  // real filesystem so optional files (e.g. /etc/gitconfig) missing on the
  // host do not falsely reject, while present files without RO overlays
  // still reject via the seen/expected comparison below.
  const existsFn = options.existsSync ?? fsExistsSync
  const expectedEtc = new Set(
    SANDBOX_ETC_RO_BINDS.filter((path) => existsFn(path)),
  )
  const seenEtc = new Set()

  let workspaceBindFlag
  let absoluteBindFlag
  let aliasGitCount = 0
  let absGitCount = 0
  let runnerOutputFlag
  let runnerOutputSource

  // Never expose anything besides the disposable workspace, /usr, the fixed
  // /etc RO set, the protected .git overlays, and validated configured
  // toolchain/runtime roots. Unsafe broad binds fail closed here rather than
  // being suppressed.
  for (let index = 0; index + 2 < argv.length; index += 1) {
    const flag = argv[index]
    if (flag !== "--bind" && flag !== "--ro-bind") continue
    const source = argv[index + 1]
    const target = argv[index + 2]
    if (expectedEtc.has(source) && source === target && flag === "--ro-bind") {
      seenEtc.add(source)
      continue
    }
    if (source === workspace && target === "/workspace") {
      workspaceBindFlag = flag
      continue
    }
    if (source === workspace && target === workspace) {
      absoluteBindFlag = flag
      continue
    }
    if (source === workspaceGit && target === "/workspace/.git" && flag === "--ro-bind") {
      aliasGitCount += 1
      continue
    }
    if (source === workspaceGit && target === workspaceGit && flag === "--ro-bind") {
      absGitCount += 1
      continue
    }
    if (target === "/runner-output") {
      if (flag !== "--bind" || source !== expectedRunDir) {
        return ["unexpected bind source"]
      }
      if (runnerOutputFlag !== undefined) {
        return ["unexpected bind source"]
      }
      runnerOutputFlag = flag
      runnerOutputSource = source
      continue
    }
    if (allowed.has(source) && source === target && flag === "--ro-bind") continue
    return ["unexpected bind source"]
  }

  if (!argv.includes(workspace)) {
    return ["missing disposable workspace"]
  }

  if (workspaceBindFlag === undefined || absoluteBindFlag === undefined) {
    return ["missing disposable workspace"]
  }

  // The absolute host-path alias must duplicate the /workspace bind exactly.
  if (workspaceBindFlag !== absoluteBindFlag) {
    return ["workspace alias mismatch"]
  }

  // Git metadata must be protected read-only through both workspace paths.
  const gitExists = existsFn(workspaceGit)
  if (gitExists && (aliasGitCount !== 1 || absGitCount !== 1)) {
    return ["missing git protection"]
  }
  if (!gitExists && (aliasGitCount > 0 || absGitCount > 0)) {
    return ["unexpected bind source"]
  }

  for (const path of expectedEtc) {
    if (!seenEtc.has(path)) return ["missing etc bind"]
  }
  for (const path of seenEtc) {
    if (!expectedEtc.has(path)) return ["unexpected bind source"]
  }

  // Runner probes must keep the production writable output mount.
  // RO mode (runner) requires the exact expected output source; RW mode
  // (worker) must not mount an output directory at all.
  const isReadonly = workspaceBindFlag === "--ro-bind"
  const kindHint = options.kind === "runner" || options.kind === "worker"
    ? options.kind
    : undefined
  const requiresOutput = kindHint !== undefined
    ? kindHint === "runner"
    : isReadonly
  if (requiresOutput) {
    if (runnerOutputFlag === undefined) {
      return ["runner output not writable"]
    }
    if (runnerOutputSource !== expectedRunDir) {
      return ["unexpected bind source"]
    }
  } else if (runnerOutputFlag !== undefined) {
    return ["unexpected bind source"]
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
  let activeWorkspace
  let created = workspace === undefined
  try {
    activeWorkspace = workspace ?? createProbeWorkspace()
  } catch {
    return { ok: false, detail: probeFailureDetail(safeKind, "spawn-error") }
  }

  // Runner probes use a unique private output directory per call; never a
  // shared global probe-runner-output. Allocated here so spawn failures,
  // throws, timeouts, and invalid argv still clean up via finally below.
  let runDir
  if (kind === "runner") {
    try {
      runDir = mkdtempSync(join(tmpdir(), "doctor-runner-output-"))
    } catch {
      if (created) cleanupProbeWorkspace(activeWorkspace)
      return { ok: false, detail: probeFailureDetail(safeKind, "spawn-error") }
    }
  }

  try {
    let argv
    try {
      argv = buildSandboxProbeArgv(
        kind,
        activeWorkspace,
        sandboxRuntime,
        kind === "runner" ? { runDir } : undefined,
      )
    } catch {
      return { ok: false, detail: probeFailureDetail(safeKind, "invalid-runtime") }
    }

    let invariants = []
    try {
      invariants = probeSandboxArgvInvariants(
        argv,
        activeWorkspace,
        sandboxRuntime,
        kind === "runner" ? { runDir, kind } : { kind },
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
    if (runDir !== undefined) cleanupProbeWorkspace(runDir)
  }
}
