import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

import {
  BWRAP_EXECUTABLE_PATH,
  BWRAP_MINIMUM_VERSION,
  BWRAP_VERSION_MAX_BUFFER_BYTES,
  checkBubblewrapVersion,
  evaluateBubblewrapResult,
  isExecutableFile,
  isSecureBubblewrapVersion,
  LAUNCHER_PREREQUISITE_PATHS,
  missingExecutableFiles,
  parseBubblewrapVersion,
  SUBPROCESS_PROBE_TIMEOUT_MS,
} from "../../installer/path-security.mjs"

const here = join(fileURLToPath(import.meta.url), "..")
const repoRoot = resolve(here, "..", "..")
const doctorPath = join(repoRoot, "installer", "doctor.mjs")
const installerDir = join(repoRoot, "installer")
const preloadPath = join(here, "fixtures", "launcher-prereq-fs-preload.mjs")

const EXACT_PATHS = ["/usr/bin/bash", "/usr/bin/python3", "/usr/bin/bwrap", "/usr/bin/git"]
const FAIL_KINDS = ["missing", "nonexec", "directory"]

function mockFs({ accessible = true, directory = false, throws = null } = {}) {
  return {
    accessSync: () => {
      if (!accessible) {
        const error = new Error("EACCES")
        error.code = "EACCES"
        throw error
      }
    },
    statSync: () => {
      if (throws) throw throws
      return { isFile: () => !directory }
    },
  }
}

test("launcher prerequisite paths are the exact production paths", () => {
  assert.deepEqual(
    [...LAUNCHER_PREREQUISITE_PATHS],
    ["/usr/bin/bash", "/usr/bin/python3", "/usr/bin/bwrap", "/usr/bin/git"],
  )
})

test("launcher prerequisites validate exact /usr/bin paths, not PATH git or host /bin/bash", () => {
  const source = readFileSync(join(repoRoot, "installer", "setup.mjs"), "utf8")
  const doctorSource = readFileSync(doctorPath, "utf8")
  for (const script of [source, doctorSource]) {
    assert.ok(
      script.includes("LAUNCHER_PREREQUISITE_PATHS"),
      "launcher checks must share LAUNCHER_PREREQUISITE_PATHS",
    )
    assert.ok(
      !script.includes('"/bin/bash"'),
      "launcher checks must not validate host /bin/bash",
    )
    assert.ok(
      !script.includes('commandExists("git")'),
      "launcher Git check must use the exact /usr/bin/git path",
    )
  }
  assert.ok(
    source.includes("LAUNCHER_PREREQUISITE_PATHS"),
    "setup must use the shared prerequisite list",
  )
})

test("isExecutableFile: valid executable file passes", () => {
  assert.equal(isExecutableFile("/usr/bin/bash", mockFs()), true)
})

test("isExecutableFile: missing/nonexecutable fails", () => {
  assert.equal(isExecutableFile("/usr/bin/bash", mockFs({ accessible: false })), false)
  assert.equal(
    isExecutableFile("/usr/bin/python3", mockFs({ accessible: false })),
    false,
  )
  assert.equal(isExecutableFile("/usr/bin/git", mockFs({ accessible: false })), false)
})

test("isExecutableFile: directory fails even when searchable", () => {
  assert.equal(
    isExecutableFile("/usr/bin/bash", mockFs({ directory: true })),
    false,
  )
})

test("isExecutableFile: stat failure fails closed", () => {
  const error = new Error("ENOENT")
  error.code = "ENOENT"
  assert.equal(isExecutableFile("/usr/bin/bash", mockFs({ throws: error })), false)
})

test("isExecutableFile: rejects non-absolute and NUL paths", () => {
  assert.equal(isExecutableFile("bash", mockFs()), false)
  assert.equal(isExecutableFile("/bin/ba\0sh", mockFs()), false)
})

test("isExecutableFile: special nonregular file fails even when executable", () => {
  // Character device (/dev/null) is executable-searchable but not a file.
  assert.equal(isExecutableFile("/dev/null"), false)
  // Injected nonregular (fifo/socket/device) fails even when searchable.
  assert.equal(
    isExecutableFile("/usr/bin/bash", {
      accessSync: () => {},
      statSync: () => ({ isFile: () => false }),
    }),
    false,
  )
})

test("isExecutableFile: real executable symlink passes, symlink-to-directory fails", () => {
  const base = mkdtempSync(join(tmpdir(), "launcher-exec-"))
  try {
    const target = join(base, "tool.sh")
    writeFileSync(target, "#!/bin/sh\nexit 0\n")
    chmodSync(target, 0o755)
    const fileLink = join(base, "tool-link")
    symlinkSync(target, fileLink)
    // Real symlink behavior: no overrides, statSync follows the link.
    assert.equal(isExecutableFile(target), true)
    assert.equal(isExecutableFile(fileLink), true)

    const dirTarget = join(base, "realdir")
    mkdirSync(dirTarget, { recursive: true })
    chmodSync(dirTarget, 0o755)
    const dirLink = join(base, "dir-link")
    symlinkSync(dirTarget, dirLink)
    assert.equal(isExecutableFile(dirLink), false)
    assert.equal(isExecutableFile(dirTarget), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("missingExecutableFiles reports each missing exact path", () => {
  const overrides = {
    accessSync: (path) => {
      if (path === "/usr/bin/bash") return
      const error = new Error("ENOENT")
      error.code = "ENOENT"
      throw error
    },
    statSync: () => ({ isFile: () => true }),
  }

  assert.deepEqual(
    missingExecutableFiles(
      ["/usr/bin/bash", "/usr/bin/python3", "/usr/bin/bwrap", "/usr/bin/git"],
      overrides,
    ),
    ["/usr/bin/python3", "/usr/bin/bwrap", "/usr/bin/git"],
  )
})

test("host /bin/bash never satisfies the exact launcher Bash path", () => {
  const overrides = {
    accessSync: (path) => {
      // Simulate a host where legacy /bin/bash exists but mapped /usr/bin/bash is absent.
      if (path === "/usr/bin/bash") {
        const error = new Error("ENOENT")
        error.code = "ENOENT"
        throw error
      }
    },
    statSync: (path) => {
      if (path === "/usr/bin/bash") {
        const error = new Error("ENOENT")
        error.code = "ENOENT"
        throw error
      }
      return { isFile: () => true }
    },
  }

  assert.equal(isExecutableFile("/usr/bin/bash", overrides), false)
  assert.deepEqual(missingExecutableFiles([...LAUNCHER_PREREQUISITE_PATHS], overrides), ["/usr/bin/bash"])
})

/*
 * Behavioral launcher-prerequisite regression tests.
 *
 * These run the real doctor.mjs / setup.mjs CLIs in disposable subprocesses
 * with an isolated HOME and a Node --import preload fixture that simulates
 * one exact launcher path being missing, non-executable, or non-regular
 * (see fixtures/launcher-prereq-fs-preload.mjs). Nothing outside the
 * fixture is touched: no writes to /bin, /usr, HOME, or the install tree.
 */

function makePoisonedPath(base) {
  const fakeBin = join(base, "fakebin")
  mkdirSync(fakeBin, { recursive: true })
  // PATH substitutes must never satisfy the fixed-path check.
  for (const name of ["bash", "python3", "bwrap", "git"]) {
    const fake = join(fakeBin, name)
    writeFileSync(fake, "#!/bin/sh\nexit 0\n")
    chmodSync(fake, 0o755)
  }
  return `${fakeBin}${delimiter}${process.env.PATH ?? ""}`
}

function runDoctor({ failPath, kind, bwrapVersion, bwrapError }) {
  const base = mkdtempSync(join(tmpdir(), "launcher-doctor-"))
  try {
    const home = join(base, "home")
    mkdirSync(home, { recursive: true })
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(preloadPath).href,
        doctorPath,
        "--config",
        join(base, "config.json"),
        "--no-sandbox-probes",
      ],
      {
        encoding: "utf8",
        timeout: 60000,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local/share"),
          OPENCODE_BIN: process.execPath,
          PATH: makePoisonedPath(base),
          LAUNCHER_PREREQ_FAIL_PATH: failPath ?? "",
          LAUNCHER_PREREQ_FAIL_KIND: kind ?? "missing",
          // Deterministic Bubblewrap version mock: only the exact
          // /usr/bin/bwrap --version call is mocked; nothing else.
          LAUNCHER_PREREQ_BWRAP_VERSION: bwrapVersion ?? "bubblewrap 0.12.0\n",
          LAUNCHER_PREREQ_BWRAP_ERROR: bwrapError ?? "none",
        },
      },
    )
    return { base, result }
  } catch (error) {
    rmSync(base, { recursive: true, force: true })
    throw error
  }
}

for (const failPath of EXACT_PATHS) {
  for (const kind of FAIL_KINDS) {
    test(`doctor fails closed when ${failPath} is ${kind} even with --no-sandbox-probes`, () => {
      const { base, result } = runDoctor({ failPath, kind })
      try {
        assert.notEqual(
          result.status,
          0,
          `doctor must exit nonzero when ${failPath} is ${kind}: ${result.stdout ?? ""}${result.stderr ?? ""}`,
        )
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
        assert.ok(
          output.includes(`✗ ${failPath}`) || (failPath === "/usr/bin/bwrap" && output.includes("✗ bubblewrap")),
          `doctor must fail the exact path ${failPath}, got:\n${output}`,
        )
        assert.ok(
          !output.includes("DOCTOR_HEALTHY"),
          "doctor must never emit DOCTOR_HEALTHY with a missing prerequisite",
        )
        assert.match(output, /DOCTOR_UNHEALTHY/, "doctor must report unhealthy")
        assert.ok(
          output.includes("sandbox probes skipped"),
          "launcher checks must still run when sandbox probes are skipped",
        )
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    })
  }
}

function makeSetupFixture({ failPath, kind, bwrapVersion, bwrapError }) {
  const base = mkdtempSync(join(tmpdir(), "launcher-setup-"))
  const fixtureInstaller = join(base, "installer")
  mkdirSync(fixtureInstaller, { recursive: true })
  // Bundle the real installer scripts into the disposable fixture so the
  // component-presence gate passes without touching the real install tree.
  for (const entry of readdirSync(installerDir)) {
    if (entry.endsWith(".mjs")) {
      copyFileSync(join(installerDir, entry), join(fixtureInstaller, entry))
    }
  }
  // setup.mjs refuses to run when a sibling component is absent, before it
  // ever reaches the prerequisite gate. Guarantee every required sibling
  // exists: stub only names absent from the real installer tree.
  const setupSource = readFileSync(join(installerDir, "setup.mjs"), "utf8")
  const requiredBlock = setupSource.match(/requiredComponents\s*=\s*\[([\s\S]*?)\]/)
  const requiredNames = new Set(
    [...(requiredBlock?.[1] ?? "").matchAll(/"([^"]+\.mjs)"/g)].map((m) => m[1]),
  )
  for (const name of requiredNames) {
    const target = join(fixtureInstaller, name)
    try {
      readFileSync(target)
    } catch {
      writeFileSync(target, "export {}\n")
    }
  }
  symlinkSync(join(repoRoot, "config"), join(base, "config"))

  const home = join(base, "home")
  const configHome = join(home, ".config")
  const dataHome = join(home, ".local/share")
  const appConfig = join(configHome, "opencode-mcp-orchestrator")
  const appData = join(dataHome, "opencode-mcp-orchestrator")
  mkdirSync(appConfig, { recursive: true })
  mkdirSync(appData, { recursive: true })

  // Pre-existing installation/config that must survive the fail-closed exit.
  const installSentinel = join(appData, "payload-sentinel.txt")
  writeFileSync(installSentinel, "existing-installation-untouched")
  const configSentinel = join(appConfig, "config-sentinel.txt")
  writeFileSync(configSentinel, "existing-config-untouched")

  const payload = join(base, "payload.bin")
  writeFileSync(payload, "payload-bytes")

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(preloadPath).href,
      join(fixtureInstaller, "setup.mjs"),
      "--payload",
      payload,
      "--version",
      "0.0.0-test",
      "--non-interactive",
      "--config",
      join(base, "config.json"),
    ],
    {
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        OPENCODE_BIN: process.execPath,
        PATH: makePoisonedPath(base),
        LAUNCHER_PREREQ_FAIL_PATH: failPath,
        LAUNCHER_PREREQ_FAIL_KIND: kind,
        LAUNCHER_PREREQ_BWRAP_VERSION: bwrapVersion ?? "bubblewrap 0.12.0\n",
        LAUNCHER_PREREQ_BWRAP_ERROR: bwrapError ?? "none",
      },
    },
  )
  return { base, result, installSentinel, configSentinel }
}

function assertSetupFailsBeforeMutation(result, installSentinel, configSentinel, context) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  assert.notEqual(result.status, 0, `setup must exit nonzero (${context}): ${output}`)
  assert.match(output, /required prerequisites are missing/, "setup must fail closed")
  assert.ok(!output.includes("Installing core payload"), "must not reach install")
  assert.ok(!output.includes("Removing existing installation"), "must not reach cleanup")
  assert.equal(readFileSync(installSentinel, "utf8"), "existing-installation-untouched")
  assert.equal(readFileSync(configSentinel, "utf8"), "existing-config-untouched")
  assert.ok(output.includes("Bubblewrap") || /bwrap/i.test(output), `must name Bubblewrap (${context})`)
}

function assertDoctorUnhealthy(result, context) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  assert.notEqual(result.status, 0, `doctor must exit nonzero (${context}): ${output}`)
  assert.ok(!output.includes("DOCTOR_HEALTHY"), "must never report healthy")
  assert.match(output, /DOCTOR_UNHEALTHY/, "must report unhealthy")
  assert.ok(output.includes("sandbox probes skipped"), "launcher checks run with probes skipped")
}

for (const failPath of EXACT_PATHS) {
  test(`setup fails before install when ${failPath} is missing`, () => {
    const { base, result, installSentinel, configSentinel } = makeSetupFixture({
      failPath,
      kind: "missing",
    })
    try {
      assert.notEqual(
        result.status,
        0,
        `setup must exit nonzero when ${failPath} is missing: ${result.stdout ?? ""}${result.stderr ?? ""}`,
      )
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      assert.ok(
        output.split("\n").some((line) => line.includes("✗") && line.includes(failPath)),
        `setup must fail the exact path ${failPath}, got:\n${output}`,
      )
      assert.match(
        output,
        /required prerequisites are missing/,
        "setup must fail closed on missing prerequisites",
      )
      assert.ok(
        !output.includes("Installing core payload"),
        "setup must not reach component installation",
      )
      assert.ok(
        !output.includes("Removing existing installation"),
        "setup must not reach replacement cleanup",
      )
      assert.equal(
        readFileSync(installSentinel, "utf8"),
        "existing-installation-untouched",
        "existing installation must be untouched",
      )
      assert.equal(
        readFileSync(configSentinel, "utf8"),
        "existing-config-untouched",
        "existing config must be untouched",
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
}

test("bubblewrap version probe uses exact path, timeout, and bounded buffer", () => {
  const calls = []
  const ok = checkBubblewrapVersion((command, args, options) => {
    calls.push({ command, args, options })
    return { status: 0, stdout: "bubblewrap 0.12.0\n", stderr: "", signal: null }
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.version.text, "0.12.0")
  assert.deepEqual(calls[0].command, BWRAP_EXECUTABLE_PATH)
  assert.deepEqual(calls[0].args, ["--version"])
  assert.equal(calls[0].options.timeout, SUBPROCESS_PROBE_TIMEOUT_MS)
  assert.equal(calls[0].options.maxBuffer, BWRAP_VERSION_MAX_BUFFER_BYTES)
  assert.equal(calls[0].options.encoding, "utf8")
})

test("bubblewrap accepts strict numeric stable versions >=0.12.0", () => {
  for (const output of ["bubblewrap 0.12.0\n", "bubblewrap 0.12.1", "bubblewrap 0.13.0\n", "bubblewrap 1.0.0"]) {
    assert.equal(isSecureBubblewrapVersion(parseBubblewrapVersion(output)), true, output)
    assert.equal(
      evaluateBubblewrapResult({ status: 0, stdout: output, stderr: "", signal: null }).ok,
      true,
      output,
    )
  }
  assert.equal(parseBubblewrapVersion("bubblewrap 0.12.0").text, "0.12.0")
  assert.equal(BWRAP_MINIMUM_VERSION, "0.12.0")
})

test("bubblewrap rejects old 0.8.0 and 0.11.x versions", () => {
  for (const output of ["bubblewrap 0.8.0\n", "bubblewrap 0.11.0\n", "bubblewrap 0.11.5", "bubblewrap 0.1.0"]) {
    const parsed = parseBubblewrapVersion(output)
    assert.ok(parsed, `must parse ${output}`)
    assert.equal(isSecureBubblewrapVersion(parsed), false, output)
    const status = evaluateBubblewrapResult({ status: 0, stdout: output, stderr: "", signal: null })
    assert.equal(status.ok, false)
    assert.equal(status.reason, "vulnerable")
  }
})

test("bubblewrap rejects malformed and prerelease versions with no backport exceptions", () => {
  for (const output of [
    "",
    "not installed",
    "bubblewrap",
    "bubblewrap x.y.z",
    "0.12.0",
    "bubblewrap 0.12",
    "bubblewrap 0.12.0-1",
    "bubblewrap 0.12.0~bpo1",
    "bubblewrap 0.12.0+deb1",
    "bubblewrap 0.12.0rc1",
    "bubblewrap 0.12.0.1",
    "bubblewrap 0.12.0 backported-fix",
  ]) {
    assert.equal(parseBubblewrapVersion(output), null, JSON.stringify(output))
    const status = evaluateBubblewrapResult({ status: 0, stdout: output, stderr: "", signal: null })
    assert.equal(status.ok, false)
    assert.equal(status.reason, "unparseable")
  }
})

test("bubblewrap rejects nonzero, spawn error, signal, and timeout results", () => {
  const timeoutError = new Error("timed out")
  timeoutError.code = "ETIMEDOUT"
  assert.deepEqual(evaluateBubblewrapResult({ error: timeoutError }).reason, "timeout")
  const spawnError = new Error("missing")
  spawnError.code = "ENOENT"
  assert.deepEqual(evaluateBubblewrapResult({ error: spawnError }).reason, "spawn-error")
  assert.deepEqual(evaluateBubblewrapResult(null).reason, "spawn-error")
  assert.deepEqual(
    evaluateBubblewrapResult({ status: 0, stdout: "bubblewrap 0.12.0", signal: "SIGKILL" }).reason,
    "signal",
  )
  assert.deepEqual(
    evaluateBubblewrapResult({ status: 1, stdout: "bubblewrap 0.12.0", signal: null }).reason,
    "nonzero",
  )
  assert.equal(checkBubblewrapVersion(() => { throw new Error("boom") }).ok, false)
})

for (const bwrapVersion of ["bubblewrap 0.8.0\n", "bubblewrap 0.11.0\n"]) {
  test(`setup fails before mutation on vulnerable bwrap ${bwrapVersion.trim()}`, () => {
    const { base, result, installSentinel, configSentinel } = makeSetupFixture({
      failPath: "___none___",
      kind: "missing",
      bwrapVersion,
    })
    try {
      assertSetupFailsBeforeMutation(result, installSentinel, configSentinel, bwrapVersion.trim())
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test(`doctor --no-sandbox-probes never healthy on vulnerable bwrap ${bwrapVersion.trim()}`, () => {
    const { base, result } = runDoctor({ bwrapVersion })
    try {
      assertDoctorUnhealthy(result, bwrapVersion.trim())
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      assert.ok(output.includes("GHSA-pxhw-h44j-8pfx"), "doctor must cite the advisory floor")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
}

test("setup fails before mutation on malformed bwrap version", () => {
  const { base, result, installSentinel, configSentinel } = makeSetupFixture({
    failPath: "___none___",
    kind: "missing",
    bwrapVersion: "bubblewrap bogus\n",
  })
  try {
    assertSetupFailsBeforeMutation(result, installSentinel, configSentinel, "malformed")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

for (const bwrapError of ["spawn", "timeout", "signal", "nonzero", "throw"]) {
  test(`setup fails before mutation when bwrap probe ${bwrapError}s`, () => {
    const { base, result, installSentinel, configSentinel } = makeSetupFixture({
      failPath: "___none___",
      kind: "missing",
      bwrapError,
    })
    try {
      assertSetupFailsBeforeMutation(result, installSentinel, configSentinel, bwrapError)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test(`doctor --no-sandbox-probes never healthy when bwrap probe ${bwrapError}s`, () => {
    const { base, result } = runDoctor({ bwrapError })
    try {
      assertDoctorUnhealthy(result, bwrapError)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
}

for (const bwrapVersion of ["bubblewrap 0.12.0\n", "bubblewrap 1.4.0\n"]) {
  test(`doctor --no-sandbox-probes passes bwrap gate on ${bwrapVersion.trim()}`, () => {
    const { base, result } = runDoctor({ bwrapVersion })
    try {
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      assert.ok(output.includes(`/usr/bin/bwrap ${bwrapVersion.trim().split(" ")[1]}`), output)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
}

test("doctor --no-sandbox-probes reports readiness unverified when other checks pass", () => {
  const base = mkdtempSync(join(tmpdir(), "launcher-doctor-unverified-"))
  try {
    const home = join(base, "home")
    const configHome = join(home, ".config")
    const dataHome = join(home, ".local/share")
    const appConfig = join(configHome, "opencode-mcp-orchestrator")
    const appData = join(dataHome, "opencode-mcp-orchestrator")
    const current = join(appData, "current")
    mkdirSync(home, { recursive: true })
    for (const relative of [
      "libexec/mcp-server.mjs",
      "libexec/configure-models.mjs",
      "libexec/configure-integrations.mjs",
      "opencode/plugins/sandbox-tools/index.ts",
      "skills/orchestrate/SKILL.md",
    ]) {
      const target = join(current, relative)
      mkdirSync(join(target, ".."), { recursive: true })
      writeFileSync(target, "ok\n")
    }
    const agentDefs = [
      ["agents/opencode-orchestrator-scout.md", 16],
      ["agents/opencode-orchestrator-worker.md", 32],
      ["agents/opencode-orchestrator-runner.md", 40],
      ["agents/opencode-orchestrator-runner-writable.md", 40],
      ["agents/opencode-orchestrator-runner-network.md", 40],
      ["agents/opencode-orchestrator-runner-writable-network.md", 40],
    ]
    for (const [relative, limit] of agentDefs) {
      const target = join(configHome, "opencode", relative)
      mkdirSync(join(target, ".."), { recursive: true })
      writeFileSync(target, `steps: ${limit}\nat most ${limit} model steps\n`)
    }
    const pluginTarget = join(configHome, "opencode", "plugins", "opencode-mcp-orchestrator", "index.ts")
    mkdirSync(join(pluginTarget, ".."), { recursive: true })
    writeFileSync(pluginTarget, "ok\n")
    writeFileSync(
      join(base, "config.json"),
      JSON.stringify({ models: { scout: "p/s", worker: "p/w", runner: "p/r" }, integrations: [] }),
    )
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preloadPath).href, doctorPath, "--config", join(base, "config.json"), "--no-sandbox-probes"],
      {
        encoding: "utf8",
        timeout: 60000,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: configHome,
          XDG_DATA_HOME: dataHome,
          OPENCODE_BIN: process.execPath,
          PATH: makePoisonedPath(base),
          LAUNCHER_PREREQ_FAIL_PATH: "",
          LAUNCHER_PREREQ_FAIL_KIND: "missing",
          LAUNCHER_PREREQ_BWRAP_VERSION: "bubblewrap 0.12.0\n",
          LAUNCHER_PREREQ_BWRAP_ERROR: "none",
        },
      },
    )
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    assert.equal(result.status, 0, output)
    assert.ok(output.includes("sandbox probes skipped"), output)
    assert.ok(output.includes("DOCTOR_READINESS_UNVERIFIED"), output)
    assert.ok(!output.includes("DOCTOR_HEALTHY"), "skipped probes must never report healthy")
    assert.ok(!output.includes("DOCTOR_UNHEALTHY"), output)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
