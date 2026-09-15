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
  isExecutableFile,
  LAUNCHER_PREREQUISITE_PATHS,
  missingExecutableFiles,
} from "../../installer/path-security.mjs"

const here = join(fileURLToPath(import.meta.url), "..")
const repoRoot = resolve(here, "..", "..")
const doctorPath = join(repoRoot, "installer", "doctor.mjs")
const installerDir = join(repoRoot, "installer")
const preloadPath = join(here, "fixtures", "launcher-prereq-fs-preload.mjs")

const EXACT_PATHS = ["/bin/bash", "/usr/bin/python3", "/usr/bin/bwrap"]
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
    ["/bin/bash", "/usr/bin/python3", "/usr/bin/bwrap"],
  )
})

test("isExecutableFile: valid executable file passes", () => {
  assert.equal(isExecutableFile("/bin/bash", mockFs()), true)
})

test("isExecutableFile: missing/nonexecutable fails", () => {
  assert.equal(isExecutableFile("/bin/bash", mockFs({ accessible: false })), false)
  assert.equal(
    isExecutableFile("/usr/bin/python3", mockFs({ accessible: false })),
    false,
  )
})

test("isExecutableFile: directory fails even when searchable", () => {
  assert.equal(
    isExecutableFile("/bin/bash", mockFs({ directory: true })),
    false,
  )
})

test("isExecutableFile: stat failure fails closed", () => {
  const error = new Error("ENOENT")
  error.code = "ENOENT"
  assert.equal(isExecutableFile("/bin/bash", mockFs({ throws: error })), false)
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
    isExecutableFile("/bin/bash", {
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
      if (path === "/bin/bash") return
      const error = new Error("ENOENT")
      error.code = "ENOENT"
      throw error
    },
    statSync: () => ({ isFile: () => true }),
  }

  assert.deepEqual(
    missingExecutableFiles(
      ["/bin/bash", "/usr/bin/python3", "/usr/bin/bwrap"],
      overrides,
    ),
    ["/usr/bin/python3", "/usr/bin/bwrap"],
  )
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
  for (const name of ["bash", "python3", "bwrap"]) {
    const fake = join(fakeBin, name)
    writeFileSync(fake, "#!/bin/sh\nexit 0\n")
    chmodSync(fake, 0o755)
  }
  return `${fakeBin}${delimiter}${process.env.PATH ?? ""}`
}

function runDoctor({ failPath, kind }) {
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
          LAUNCHER_PREREQ_FAIL_PATH: failPath,
          LAUNCHER_PREREQ_FAIL_KIND: kind,
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
          output.includes(`✗ ${failPath}`),
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

function makeSetupFixture({ failPath, kind }) {
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
      },
    },
  )
  return { base, result, installSentinel, configSentinel }
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
