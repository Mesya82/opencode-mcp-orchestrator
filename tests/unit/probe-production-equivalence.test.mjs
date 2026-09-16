import assert from "node:assert/strict"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  baseSandboxArgs,
  buildSandboxRunArgv,
  SANDBOX_RUNTIME_CONFIG_ENV,
  SANDBOX_TOOLCHAIN_DIRS_ENV,
} from "../../opencode/plugins/sandbox-tools/index.ts"
import {
  buildRunnerProbeArgv,
  buildWorkerProbeArgv,
} from "../../config/sandbox-probes.mjs"

const UNSAFE_PATH_MARKER = "unsafe-evil-probe-path"

function setenvValue(argv, name) {
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (argv[i] === "--setenv" && argv[i + 1] === name) {
      return argv[i + 2]
    }
  }
  return undefined
}

function hasTriple(argv, flag, src, dst) {
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (argv[i] === flag && argv[i + 1] === src && argv[i + 2] === dst) {
      return true
    }
  }
  return false
}

function workspaceBindFlag(argv, ws) {
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (
      (argv[i] === "--bind" || argv[i] === "--ro-bind") &&
      argv[i + 1] === ws &&
      argv[i + 2] === "/workspace"
    ) {
      return argv[i]
    }
  }
  return undefined
}

for (const mode of ["empty", "populated"]) {
  test(`probe argv matches production sandbox construction (${mode})`, () => {
    const savedPath = process.env.PATH
    const savedToolchain = process.env[SANDBOX_TOOLCHAIN_DIRS_ENV]
    const savedRuntimeConfig = process.env[SANDBOX_RUNTIME_CONFIG_ENV]
    const base = mkdtempSync(join(tmpdir(), "probe-equiv-"))
    try {
      // Safe fixture: disposable workspace with Git marker, private output
      // dir, runtime root with bin/data, and a toolchain dir. No Git runs.
      const ws = join(base, "ws")
      const out = join(base, "out")
      const rt = join(base, "rt")
      const tc = join(base, "tc")
      mkdirSync(join(ws, ".git"), { recursive: true })
      writeFileSync(join(ws, ".git", "HEAD"), "ref: refs/heads/probe\n")
      mkdirSync(out, { recursive: true })
      mkdirSync(join(rt, "bin"), { recursive: true })
      mkdirSync(join(rt, "data"), { recursive: true })
      mkdirSync(tc, { recursive: true })

      process.env.PATH = `/tmp/${UNSAFE_PATH_MARKER}`

      let probeRuntime
      if (mode === "populated") {
        probeRuntime = {
          trustedRoots: [
            {
              root: rt,
              pathEntries: ["bin"],
              environment: { PROBE_RT: "data" },
            },
          ],
        }
        // Format consumed by loadSandboxRuntimeConfig: { sandboxRuntime }.
        const configPath = join(base, "config.json")
        writeFileSync(
          configPath,
          JSON.stringify({ sandboxRuntime: probeRuntime }),
        )
        process.env[SANDBOX_RUNTIME_CONFIG_ENV] = configPath
        process.env[SANDBOX_TOOLCHAIN_DIRS_ENV] = tc
      } else {
        probeRuntime = undefined
        delete process.env[SANDBOX_TOOLCHAIN_DIRS_ENV]
        process.env[SANDBOX_RUNTIME_CONFIG_ENV] = join(
          base,
          "missing-config.json",
        )
      }

      // Worker: production writable construction must equal probe prefix.
      const prodWorker = baseSandboxArgs(ws, "/workspace")
      const probeWorker = buildWorkerProbeArgv(ws, probeRuntime)
      assert.deepEqual(
        probeWorker.slice(0, prodWorker.length),
        prodWorker,
      )
      assert.equal(probeWorker[prodWorker.length], "/bin/sh")

      // Runner: production read-only construction plus output mount must
      // equal the probe prefix; only the capture implementation differs.
      const prodRun = buildSandboxRunArgv(ws, "/workspace", out, "true", {
        readonlyWorkspace: true,
      })
      const probeRun = buildRunnerProbeArgv(ws, probeRuntime, {
        runDir: out,
      })
      const probeSh = probeRun.indexOf("/bin/sh")
      const prodPy = prodRun.indexOf("/usr/bin/python3")
      assert.ok(probeSh > 0)
      assert.ok(prodPy > 0)
      assert.deepEqual(
        probeRun.slice(0, probeSh),
        prodRun.slice(0, prodPy),
      )

      // Git metadata read-only through both workspace paths.
      for (const argv of [prodWorker, probeWorker, prodRun, probeRun]) {
        assert.equal(
          hasTriple(argv, "--ro-bind", `${ws}/.git`, "/workspace/.git"),
          true,
        )
        assert.equal(
          hasTriple(argv, "--ro-bind", `${ws}/.git`, `${ws}/.git`),
          true,
        )
      }

      // Workspace mount: RW for Worker, RO for Runner.
      assert.equal(workspaceBindFlag(prodWorker, ws), "--bind")
      assert.equal(workspaceBindFlag(probeWorker, ws), "--bind")
      assert.equal(workspaceBindFlag(prodRun, ws), "--ro-bind")
      assert.equal(workspaceBindFlag(probeRun, ws), "--ro-bind")

      // Output mount only on Runner.
      assert.equal(prodWorker.includes("/runner-output"), false)
      assert.equal(probeWorker.includes("/runner-output"), false)
      assert.equal(hasTriple(prodRun, "--bind", out, "/runner-output"), true)
      assert.equal(hasTriple(probeRun, "--bind", out, "/runner-output"), true)

      // Unsafe inherited PATH absent; configured sandbox PATH present.
      for (const argv of [prodWorker, probeWorker, prodRun, probeRun]) {
        const sandboxPath = setenvValue(argv, "PATH")
        assert.ok(typeof sandboxPath === "string")
        assert.equal(sandboxPath.includes(UNSAFE_PATH_MARKER), false)
      }
      if (mode === "populated") {
        for (const argv of [prodWorker, probeWorker, prodRun, probeRun]) {
          const sandboxPath = setenvValue(argv, "PATH")
          assert.equal(sandboxPath.includes(tc), true)
          assert.equal(sandboxPath.includes(rt), true)
          assert.equal(setenvValue(argv, "PROBE_RT"), join(rt, "data"))
        }
      }
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      if (savedToolchain === undefined)
        delete process.env[SANDBOX_TOOLCHAIN_DIRS_ENV]
      else process.env[SANDBOX_TOOLCHAIN_DIRS_ENV] = savedToolchain
      if (savedRuntimeConfig === undefined)
        delete process.env[SANDBOX_RUNTIME_CONFIG_ENV]
      else process.env[SANDBOX_RUNTIME_CONFIG_ENV] = savedRuntimeConfig
      rmSync(base, { recursive: true, force: true })
    }
  })
}
