import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  buildRunnerProbeArgv,
  buildWorkerProbeArgv,
  probeSandboxArgvInvariants,
  runSandboxProbe,
} from "../../config/sandbox-probes.mjs"

function runnerSource(argv) {
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (argv[i + 2] === "/runner-output") return argv[i + 1]
  }
  return undefined
}

test("runner spawn sees unique private output dir that is cleaned up on success", () => {
  const ws = mkdtempSync(join(tmpdir(), "doctor-probe-keep-"))
  let seen
  let existedDuringSpawn = false
  try {
    const result = runSandboxProbe("runner", {
      workspace: ws,
      spawn: (bin, args) => {
        const argv = [bin, ...args]
        seen = runnerSource(argv)
        existedDuringSpawn = typeof seen === "string" && existsSync(seen)
        assert.ok(seen.includes("doctor-runner-output-"))
        return { status: 0, stdout: "", stderr: "" }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(existedDuringSpawn, true)
    assert.equal(existsSync(seen), false)
    assert.equal(existsSync(ws), true)
  } finally {
    rmSync(ws, { recursive: true, force: true })
    if (seen) rmSync(seen, { recursive: true, force: true })
  }
})

test("runner output dir cleaned up on nonzero, throw, and timeout; explicit workspace retained", () => {
  const cases = [
    () => ({ status: 1, stdout: "", stderr: "" }),
    () => { throw new Error("boom") },
    () => ({ error: { code: "ETIMEDOUT" } }),
    () => ({ error: { code: "ENOENT" } }),
  ]
  for (const spawn of cases) {
    const ws = mkdtempSync(join(tmpdir(), "doctor-probe-keep-"))
    let seen
    try {
      runSandboxProbe("runner", {
        workspace: ws,
        spawn: (bin, args) => {
          seen = runnerSource([bin, ...args])
          return spawn()
        },
      })
      assert.ok(typeof seen === "string")
      assert.equal(existsSync(seen), false)
      assert.equal(existsSync(ws), true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
      if (seen) rmSync(seen, { recursive: true, force: true })
    }
  }
})

test("runner dirs are unique per call and never a shared global", () => {
  const ws = mkdtempSync(join(tmpdir(), "doctor-probe-keep-"))
  try {
    const seen = []
    for (let i = 0; i < 2; i += 1) {
      runSandboxProbe("runner", {
        workspace: ws,
        spawn: (bin, args) => {
          seen.push(runnerSource([bin, ...args]))
          return { status: 0, stdout: "", stderr: "" }
        },
      })
    }
    assert.notEqual(seen[0], seen[1])
    for (const dir of seen) {
      assert.equal(existsSync(dir), false)
      assert.ok(!dir.endsWith("probe-runner-output"))
    }
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test("invariant rejects arbitrary /runner-output source and wrong mode", () => {
  const ws = "/tmp/ws-probe"
  const argv = buildRunnerProbeArgv(ws)
  const badSource = [...argv]
  const idx = badSource.lastIndexOf("/runner-output")
  badSource[idx - 1] = "/tmp/evil-output"
  assert.deepEqual(
    probeSandboxArgvInvariants(badSource, ws, undefined, { kind: "runner" }),
    ["unexpected bind source"],
  )
  // Wrong mode: --ro-bind for output target rejected.
  const roMode = [...argv]
  roMode[idx - 2] = "--ro-bind"
  assert.deepEqual(
    probeSandboxArgvInvariants(roMode, ws, undefined, { kind: "runner" }),
    ["unexpected bind source"],
  )
  // Worker must reject any output mount.
  const worker = [...buildWorkerProbeArgv(ws), "--bind", "/tmp/x", "/runner-output"]
  assert.deepEqual(
    probeSandboxArgvInvariants(worker, ws, undefined, { kind: "worker" }),
    ["unexpected bind source"],
  )
  // Runner argv without the output mount is rejected.
  const missing = argv.filter(
    (v, i, a) => !(a[i - 2] === "--bind" && a[i - 1] !== undefined && v === "/runner-output") &&
      !(a[i - 1] === "--bind" && v !== undefined && a[i + 1] === "/runner-output") &&
      !(v === "--bind" && a[i + 2] === "/runner-output"),
  )
  assert.deepEqual(
    probeSandboxArgvInvariants(missing, ws, undefined, { kind: "runner" }),
    ["runner output not writable"],
  )
})

test("explicit runDir source must match exactly", () => {
  const ws = "/tmp/ws-probe"
  const argv = buildRunnerProbeArgv(ws, undefined, { runDir: "/tmp/expected-out" })
  assert.equal(runnerSource(argv), "/tmp/expected-out")
  assert.deepEqual(
    probeSandboxArgvInvariants(argv, ws, undefined, { runDir: "/tmp/expected-out", kind: "runner" }),
    [],
  )
  assert.deepEqual(
    probeSandboxArgvInvariants(argv, ws, undefined, { runDir: "/tmp/other", kind: "runner" }),
    ["unexpected bind source"],
  )
  assert.equal(runnerSource(argv), "/tmp/expected-out")
})
