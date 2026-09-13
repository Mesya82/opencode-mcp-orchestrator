import assert from "node:assert/strict"
import test from "node:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  isProbeTimeoutResult,
  probeTimeoutMessage,
  resolveCatalogCwd,
  resolveDiscoveryCandidate,
  SUBPROCESS_PROBE_TIMEOUT_MS,
} from "../../installer/path-security.mjs"

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

test("shared probe timeout is 20s", () => {
  assert.equal(SUBPROCESS_PROBE_TIMEOUT_MS, 20000)
})

test("timeout helpers stay basename-only", () => {
  assert.equal(isProbeTimeoutResult({ error: { code: "ETIMEDOUT" } }), true)
  assert.equal(isProbeTimeoutResult({ status: 1 }), false)

  const message = probeTimeoutMessage("/usr/local/bin/opencode")
  assert.match(message, /opencode/)
  assert.match(message, /timed out/i)
  assert.ok(!message.includes("/usr/local/bin"))
})

test("resolveDiscoveryCandidate rejects unsafe and relative values", () => {
  assert.equal(resolveDiscoveryCandidate(null), null)
  assert.equal(resolveDiscoveryCandidate(""), null)
  assert.equal(resolveDiscoveryCandidate("   "), null)
  assert.equal(resolveDiscoveryCandidate("foo;bar"), null)
  assert.equal(resolveDiscoveryCandidate("foo bar"), null)
  assert.equal(resolveDiscoveryCandidate("foo/bar"), null)
  assert.equal(resolveDiscoveryCandidate("./opencode"), null)
  assert.equal(resolveDiscoveryCandidate("../opencode"), null)
  assert.equal(resolveDiscoveryCandidate("rel/path"), null)
  assert.equal(resolveDiscoveryCandidate("/nonexistent-absolute-bin-xyz"), null)
})

test("resolveDiscoveryCandidate requires absolute paths to be executable non-directories", () => {
  const dir = makeTempDir("cfg-hard-bin-")

  try {
    const file = join(dir, "tool")
    writeFileSync(file, "#!/bin/sh\nexit 0\n")
    chmodSync(file, 0o755)

    assert.equal(resolveDiscoveryCandidate(file), file)
    assert.equal(resolveDiscoveryCandidate(dir), null)

    chmodSync(file, 0o644)
    assert.equal(resolveDiscoveryCandidate(file), null)
  } finally {
    cleanup(dir)
  }
})

test("resolveDiscoveryCandidate resolves safe bare names via PATH", () => {
  const dir = makeTempDir("cfg-hard-path-")

  try {
    const file = join(dir, "opencode")
    writeFileSync(file, "#!/bin/sh\nexit 0\n")
    chmodSync(file, 0o755)

    const previous = process.env.PATH
    process.env.PATH = dir

    try {
      assert.equal(resolveDiscoveryCandidate("opencode"), file)
    } finally {
      process.env.PATH = previous
    }
  } finally {
    cleanup(dir)
  }
})

test("resolveCatalogCwd validates absolute existing real directories", () => {
  const dir = makeTempDir("cfg-hard-cwd-")

  try {
    const real = join(dir, "real")
    mkdirSync(real)

    assert.equal(resolveCatalogCwd(real), real)

    assert.throws(() => resolveCatalogCwd("relative/path"), /absolute/)
    assert.throws(
      () => resolveCatalogCwd(join(dir, "missing")),
      /does not exist/,
    )

    const file = join(dir, "file")
    writeFileSync(file, "x")
    assert.throws(() => resolveCatalogCwd(file), /existing directory/)

    const link = join(dir, "link")
    symlinkSync(real, link)
    assert.throws(() => resolveCatalogCwd(link), /symlink/)
  } finally {
    cleanup(dir)
  }
})

test("configurators use hardened shared helpers and probe timeout", () => {
  const models = readFileSync(
    new URL("../../scripts/configure-models.mjs", import.meta.url),
    "utf8",
  )
  const integrations = readFileSync(
    new URL("../../scripts/configure-integrations.mjs", import.meta.url),
    "utf8",
  )

  assert.ok(models.includes("SUBPROCESS_PROBE_TIMEOUT_MS"))
  assert.ok(models.includes("isProbeTimeoutResult"))
  assert.ok(models.includes("probeTimeoutMessage"))
  assert.ok(models.includes("resolveDiscoveryCandidate"))
  assert.ok(models.includes("resolveCatalogCwd"))

  assert.ok(integrations.includes('from "../installer/path-security.mjs"'))
  assert.ok(integrations.includes("findExecutable"))
  assert.ok(!integrations.includes("function findExecutable"))
})
