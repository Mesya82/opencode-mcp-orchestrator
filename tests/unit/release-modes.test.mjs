import assert from "node:assert/strict"
import test from "node:test"
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs"
import {
  dirname,
  resolve,
} from "node:path"
import {
  fileURLToPath,
} from "node:url"
import {
  spawnSync,
} from "node:child_process"

const root =
  resolve(
    dirname(
      fileURLToPath(import.meta.url),
    ),
    "../..",
  )

const dist =
  resolve(root, "dist")

const release =
  resolve(root, "release")

function modeOf(path) {
  return statSync(path).mode & 0o777
}

function hasDist() {
  return existsSync(resolve(dist, "manifest.json"))
}

function findArchive() {
  if (!existsSync(release)) return null

  for (const entry of readdirSync(release)) {
    if (entry.endsWith(".tar.gz")) {
      return resolve(release, entry)
    }
  }

  return null
}

function tarVerbose(archive) {
  const result =
    spawnSync(
      "tar",
      ["-tzvf", archive],
      { encoding: "utf8" },
    )

  assert.equal(result.status, 0, result.stderr || "tar failed")

  return result.stdout
}

function permsForEntry(verbose, suffix) {
  for (const line of verbose.split("\n")) {
    if (!line.trim()) continue

    const name = line.trim().split(/\s+/).at(-1)

    if (name === suffix || name.endsWith(`/${suffix}`) || name.endsWith(suffix)) {
      // First column looks like drwxr-xr-x or -rw-r--r--.
      const perms = line.trim().split(/\s+/)[0]
      if (name.endsWith(suffix)) return perms
    }
  }

  return null
}

test("dist directories use explicit 0755", () => {
  if (!hasDist()) return

  for (const relative of [
    ".",
    "libexec",
    "opencode",
    "opencode/agents",
    "opencode/plugins",
    "opencode/plugins/sandbox-tools",
    "skills",
    "skills/orchestrate",
  ]) {
    const path = resolve(dist, relative)
    assert.equal(modeOf(path), 0o755, `${relative}: ${modeOf(path).toString(8)}`)
  }
})

test("dist public files use explicit 0644", () => {
  if (!hasDist()) return

  const files = [
    "manifest.json",
    "libexec/mcp-server.mjs",
    "opencode/plugins/sandbox-tools/index.ts",
    "opencode/agents/opencode-orchestrator-scout.md",
    "opencode/agents/opencode-orchestrator-worker.md",
    "opencode/agents/opencode-orchestrator-runner.md",
    "opencode/agents/opencode-orchestrator-runner-writable.md",
    "skills/orchestrate/SKILL.md",
  ]

  for (const relative of files) {
    const path = resolve(dist, relative)
    assert.ok(existsSync(path), `missing ${relative}`)
    assert.equal(modeOf(path), 0o644, `${relative}: ${modeOf(path).toString(8)}`)
  }
})

test("dist executable entry scripts use explicit 0755", () => {
  if (!hasDist()) return

  for (const relative of [
    "libexec/setup.mjs",
    "libexec/install-core.mjs",
    "libexec/install-opencode.mjs",
    "libexec/install-codex.mjs",
    "libexec/install-claude.mjs",
    "libexec/doctor.mjs",
    "libexec/uninstall.mjs",
    "libexec/configure-models.mjs",
    "libexec/configure-integrations.mjs",
  ]) {
    const path = resolve(dist, relative)
    assert.ok(existsSync(path), `missing ${relative}`)
    assert.equal(modeOf(path), 0o755, `${relative}: ${modeOf(path).toString(8)}`)
  }
})

test("release checksums stay public and bootstrap stays executable", () => {
  const checksum = resolve(release, "SHA256SUMS")
  const bootstrap = resolve(release, "install.sh")

  if (existsSync(checksum)) {
    assert.equal(modeOf(checksum), 0o644)
  }

  if (existsSync(bootstrap)) {
    assert.equal(modeOf(bootstrap), 0o755)
  }
})

test("release archive preserves intended executable/public modes", () => {
  const archive = findArchive()
  if (!archive || !hasDist()) return

  const verbose = tarVerbose(archive)

  // Directories preserve 0755.
  assert.equal(permsForEntry(verbose, "libexec/"), "drwxr-xr-x")

  // Executable payload entries preserve 0755.
  assert.equal(permsForEntry(verbose, "install.sh"), "-rwxr-xr-x")
  assert.equal(permsForEntry(verbose, "libexec/setup.mjs"), "-rwxr-xr-x")
  assert.equal(permsForEntry(verbose, "libexec/configure-models.mjs"), "-rwxr-xr-x")

  // Public payload entries preserve 0644.
  assert.equal(permsForEntry(verbose, "manifest.json"), "-rw-r--r--")
  assert.equal(permsForEntry(verbose, "libexec/mcp-server.mjs"), "-rw-r--r--")
  assert.equal(permsForEntry(verbose, "SKILL.md"), "-rw-r--r--")
})

test("private local config remains excluded", () => {
  assert.ok(!existsSync(resolve(dist, "config.local.json")))
  assert.ok(!existsSync(resolve(dist, "config/config.local.json")))
  assert.ok(!existsSync(resolve(dist, ".env")))
  assert.ok(!existsSync(resolve(dist, "node_modules")))

  const archive = findArchive()
  if (archive) {
    const listing =
      spawnSync("tar", ["-tzf", archive], { encoding: "utf8" })

    assert.equal(listing.status, 0)
    assert.ok(!listing.stdout.includes("config.local.json"))
    assert.ok(!listing.stdout.includes("node_modules"))
    assert.ok(!listing.stdout.split("\n").some((line) => line.endsWith("/.env")))
  }

  const packaging = readFileSync(resolve(root, "scripts/package-release.mjs"), "utf8")
  assert.match(packaging, /config\.local\.json/)
  assert.match(packaging, /scanForbidden/)
})

test("packaging keeps forbidden-content scan and checksums", () => {
  const packaging = readFileSync(resolve(root, "scripts/package-release.mjs"), "utf8")
  assert.match(packaging, /forbidden release content/)
  assert.match(packaging, /sha256sum/)
  assert.match(packaging, /SHA256SUMS/)
})
