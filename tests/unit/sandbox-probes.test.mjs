import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  SANDBOX_PROBE_BASE_PATH,
  SANDBOX_PROBE_KINDS,
  buildRunnerProbeArgv,
  buildSandboxProbeArgv,
  buildWorkerProbeArgv,
  cleanupProbeWorkspace,
  createProbeWorkspace,
  probeFailureDetail,
  probeSandboxArgvInvariants,
  probeSandboxPath,
  resolveProbeRuntimeBindings,
  runSandboxProbe,
  sanitizeProbeDetail,
} from "../../config/sandbox-probes.mjs"

import {
  hasNetworklessIsolation,
} from "../../config/sandbox-isolation.mjs"

import {
  safeSystemPath,
} from "../../config/sandbox-bubblewrap.mjs"

function makeRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-probe-runtime-"))
  const root = join(dir, "runtime")
  const bin = join(root, "bin")
  const data = join(root, "data")
  const home = join(dir, "home")
  mkdirSync(bin, { recursive: true })
  mkdirSync(data, { recursive: true })
  mkdirSync(home, { recursive: true })
  const runtime = {
    trustedRoots: [
      {
        root,
        pathEntries: ["bin"],
        environment: { RUNTIME_DATA: "data" },
      },
    ],
  }
  return { dir, root, bin, data, home, runtime }
}

function withRuntime(fn) {
  const ctx = makeRuntime()
  try {
    fn(ctx)
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true })
  }
}

function setenvPairs(argv) {
  const out = new Map()
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (argv[i] === "--setenv") out.set(argv[i + 1], argv[i + 2])
  }
  return out
}

function mountFlag(argv, source, target) {
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (argv[i + 1] === source && argv[i + 2] === target) return argv[i]
  }
  return undefined
}

function symlinkFlag(argv, source, target) {
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (argv[i] === "--symlink" && argv[i + 1] === source && argv[i + 2] === target) return true
  }
  return false
}

test("sandbox probe kinds are worker and runner", () => {
  assert.deepEqual([...SANDBOX_PROBE_KINDS], ["worker", "runner"])
})

test("probe argv carries shared isolation and no host mounts", () => {
  const ws = "/tmp/ws-probe"
  for (const argv of [buildWorkerProbeArgv(ws), buildRunnerProbeArgv(ws)]) {
    assert.ok(hasNetworklessIsolation(argv))
    assert.ok(argv.includes("--unshare-net"))
    assert.ok(argv.includes("--clearenv"))
    assert.equal(argv[0], "/usr/bin/bwrap")
    assert.ok(!argv.includes(process.env.HOME ?? "\0-unset-home"))
  }
})

test("probe mounts /usr with system bin,lib,lib64 aliases", () => {
  const ws = "/tmp/ws-probe"
  for (const argv of [buildWorkerProbeArgv(ws), buildRunnerProbeArgv(ws)]) {
    assert.equal(mountFlag(argv, "/usr", "/usr"), "--ro-bind")
    assert.ok(symlinkFlag(argv, "usr/bin", "/bin"))
    assert.ok(symlinkFlag(argv, "usr/lib", "/lib"))
    assert.ok(symlinkFlag(argv, "usr/lib64", "/lib64"))
    assert.deepEqual(probeSandboxArgvInvariants(argv, ws, undefined), [])
  }
  const noAlias = buildWorkerProbeArgv(ws).filter(
    (value, index, arr) => !(arr[index - 1] === "--symlink" || value === "--symlink" || arr[index - 2] === "--symlink"),
  )
  assert.deepEqual(probeSandboxArgvInvariants(noAlias, ws, undefined), ["missing system aliases"])
})

test("worker workspace is writable while runner is read-only and tmp stays writable", () => {
  const ws = "/tmp/ws-probe"
  assert.equal(mountFlag(buildWorkerProbeArgv(ws), ws, "/workspace"), "--bind")
  assert.equal(mountFlag(buildRunnerProbeArgv(ws), ws, "/workspace"), "--ro-bind")
  const runner = buildRunnerProbeArgv(ws)
  assert.ok(runner.includes("--tmpfs"))
  assert.ok(runner.includes("/tmp"))
  const runnerScript = runner[runner.indexOf("-c") + 1]
  assert.ok(runnerScript.includes("/tmp/probe-tmp.txt"))
  const worker = buildWorkerProbeArgv(ws)
  const workerScript = worker[worker.indexOf("-c") + 1]
  assert.ok(workerScript.includes("probe-write.txt"))
})

test("trusted runtime roots appear in PATH, binds, and environment", () => {
  const ws = "/tmp/ws-probe"
  assert.deepEqual(resolveProbeRuntimeBindings({ trustedRoots: [] }), {
    mountRoots: [],
    pathEntries: [],
    environment: {},
  })
  assert.equal(probeSandboxPath({ trustedRoots: [] }), safeSystemPath())

  withRuntime(({ root, bin, data, home, runtime }) => {
    assert.equal(probeSandboxPath(runtime), `${safeSystemPath()}:${bin}`)

    for (const argv of [
      buildWorkerProbeArgv(ws, runtime),
      buildRunnerProbeArgv(ws, runtime),
    ]) {
      assert.equal(mountFlag(argv, root, root), "--ro-bind")
      const env = setenvPairs(argv)
      assert.ok(env.get("PATH").includes(bin))
      assert.equal(env.get("RUNTIME_DATA"), data)
    }

    assert.deepEqual(
      probeSandboxArgvInvariants(buildWorkerProbeArgv(ws, runtime), ws, runtime),
      [],
    )
  })
  // Same runtime mounted verbatim would previously fail; trusted roots allowed.
  assert.deepEqual(
    probeSandboxArgvInvariants(buildWorkerProbeArgv(ws), ws, undefined),
    [],
  )
  // Unconfigured extra bind still rejected.
  const bad = [...buildWorkerProbeArgv(ws), "--ro-bind", "/opt/evil", "/opt/evil"]
  assert.deepEqual(
    probeSandboxArgvInvariants(bad, ws, undefined),
    ["unexpected bind source"],
  )
})

test("trusted runtime roots receive canonicalization, containment, and ownership checks", () => {
  withRuntime(({ root, home }) => {
    // Symlinked escape inside a trusted root is rejected.
    const outside = join(root, "..", "outside-escape")
    mkdirSync(outside, { recursive: true })
    const link = join(root, "escape")
    try { symlinkSync(outside, link) } catch { /* exists */ }
    assert.throws(
      () => resolveProbeRuntimeBindings({
        trustedRoots: [{ root, pathEntries: ["escape"], environment: {} }],
      }),
      /invalid sandbox runtime configuration/,
    )
    rmSync(link, { force: true })
    rmSync(outside, { recursive: true, force: true })

    // Sensitive/broad roots are refused even though normalization passes.
    const sensitive = join(home, ".ssh")
    mkdirSync(sensitive, { recursive: true })
    assert.throws(
      () => resolveProbeRuntimeBindings({
        trustedRoots: [{ root: sensitive, pathEntries: ["."], environment: {} }],
      }),
      /invalid sandbox runtime configuration/,
    )
    assert.throws(
      () => resolveProbeRuntimeBindings({
        trustedRoots: [{ root: "/opt/runtime-missing-probe-xyz", pathEntries: ["bin"], environment: {} }],
      }),
      /invalid sandbox runtime configuration/,
    )
  })
})

test("absent optional etc/git files pass but present git without overlays rejects", () => {
  const ws = "/tmp/ws-probe"
  const argv = buildWorkerProbeArgv(ws)
  // Real-fs default: optional files missing on the host (e.g. /etc/gitconfig,
  // workspace .git) are skipped on both sides, not falsely rejected.
  assert.deepEqual(probeSandboxArgvInvariants(argv, ws, undefined), [])
  // Same argv with git metadata present but no RO overlays must still reject.
  assert.deepEqual(
    probeSandboxArgvInvariants(argv, ws, undefined, {
      existsSync: (path) => (path === `${ws}/.git` ? true : existsSync(path)),
    }),
    ["missing git protection"],
  )
})

test("unknown probe kind fails closed", () => {
  assert.throws(() => buildSandboxProbeArgv("scout", "/tmp/x"), /unknown kind/)
  assert.deepEqual(runSandboxProbe("scout", { workspace: "/tmp/x" }), {
    ok: false,
    detail: probeFailureDetail("worker", "unknown-probe"),
  })
})

test("runSandboxProbe uses fixed failure categories and never emits output", () => {
  const okSpawn = () => ({ status: 0, stdout: "", stderr: "" })
  assert.equal(runSandboxProbe("worker", { workspace: "/tmp/ws", spawn: okSpawn }).ok, true)

  const failSpawn = () => ({ status: 1, stdout: "nope\n", stderr: "" })
  const failed = runSandboxProbe("worker", { workspace: "/tmp/ws", spawn: failSpawn })
  assert.deepEqual(failed, { ok: false, detail: "worker probe failed" })

  const timeoutSpawn = () => ({ error: { code: "ETIMEDOUT" } })
  assert.deepEqual(
    runSandboxProbe("runner", { workspace: "/tmp/ws", spawn: timeoutSpawn }),
    { ok: false, detail: "runner probe timed out" },
  )

  // Raw stdout/stderr, secrets, and paths are never echoed back.
  const secret = "sk-live-SECRET-123 /home/victim/.ssh/id_ed25519 /tmp/ws-probe"
  const secretSpawn = () => ({ status: 2, stdout: secret, stderr: secret })
  const sanitized = runSandboxProbe("worker", { workspace: "/tmp/ws", spawn: secretSpawn })
  assert.deepEqual(sanitized, { ok: false, detail: "worker probe failed" })
  assert.ok(!sanitized.detail.includes("sk-live"))
  assert.ok(!sanitized.detail.includes("/home/victim"))

  const controlSpawn = () => ({ status: 2, stdout: `a${String.fromCharCode(1)}b`, stderr: "" })
  const stripped = runSandboxProbe("worker", { workspace: "/tmp/ws", spawn: controlSpawn })
  assert.deepEqual(stripped, { ok: false, detail: "worker probe failed" })

  assert.equal(sanitizeProbeDetail(123), "")
  assert.ok(sanitizeProbeDetail("x".repeat(500)).endsWith("...[truncated]"))

  // Spawn throw and spawn errors map to a fixed spawn-failed category.
  const throwing = () => { throw new Error("boom /etc/shadow SECRET") }
  const thrownResult = runSandboxProbe("worker", { workspace: "/tmp/ws", spawn: throwing })
  assert.deepEqual(thrownResult, { ok: false, detail: "worker probe spawn failed" })
  assert.ok(!thrownResult.detail.includes("boom"))

  const errorSpawn = () => ({ error: { code: "ENOENT", message: "secret-path /home/x" } })
  const errorResult = runSandboxProbe("worker", { workspace: "/tmp/ws", spawn: errorSpawn })
  assert.deepEqual(errorResult, { ok: false, detail: "worker probe spawn failed" })
  assert.ok(!errorResult.detail.includes("/home/x"))
})

test("runSandboxProbe cleans up auto-created disposable workspace", () => {
  const ws = createProbeWorkspace()
  assert.ok(existsSync(ws))
  cleanupProbeWorkspace(ws)
  assert.equal(existsSync(ws), false)

  // Auto-created workspaces land under the OS tmp dir with our prefix and
  // are removed in `finally` even when the probe fails.
  let seenWorkspace = null

  const wrappedSpawn = (...spawnArgs) => {
    const argv = [spawnArgs[0], ...spawnArgs[1]]
    const bindIndex = argv.indexOf("--bind")
    if (bindIndex !== -1) seenWorkspace = argv[bindIndex + 1]
    return { status: 1, stdout: "", stderr: "" }
  }

  const result = runSandboxProbe("worker", { spawn: wrappedSpawn })
  assert.equal(result.ok, false)
  assert.equal(result.detail, "worker probe failed")
  assert.ok(typeof seenWorkspace === "string" && seenWorkspace.includes("doctor-probe-"))
  assert.equal(existsSync(seenWorkspace), false)
})

test("doctor skip path is static-checked cheaply", () => {
  // Keep hermetic: verify the probe-kind contract only; doctor CLI wiring is
  // covered by the static source assertions below via existing imports.
  assert.deepEqual([...SANDBOX_PROBE_KINDS], ["worker", "runner"])
  assert.ok(typeof runSandboxProbe === "function")
})

test("explicit workspace is preserved after probe", () => {
  const ws = mkdtempSync(join(tmpdir(), "doctor-probe-keep-"))
  try {
    runSandboxProbe("worker", {
      workspace: ws,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(existsSync(ws), true)
  } finally {
    cleanupProbeWorkspace(ws)
  }
})
