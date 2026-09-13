import assert from "node:assert/strict"
import test from "node:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import {
  tmpdir,
} from "node:os"
import {
  dirname,
  join,
  resolve,
} from "node:path"
import {
  fileURLToPath,
} from "node:url"

import {
  validateReleaseManifest,
} from "../../installer/manifest.mjs"

const root =
  resolve(
    dirname(
      fileURLToPath(import.meta.url),
    ),
    "../..",
  )

const VALID_FILES = {
  mcpServer: "libexec/mcp-server.mjs",
  configurator: "libexec/configure-models.mjs",
  integrationsConfigurator: "libexec/configure-integrations.mjs",
  setup: "libexec/setup.mjs",
  plugin: "opencode/plugins/sandbox-tools/index.ts",
  agents: "opencode/agents",
  skill: "skills/orchestrate/SKILL.md",
}

function validManifest() {
  return {
    name: "opencode-mcp-orchestrator",
    version: "1.2.3",
    formatVersion: 1,
    runtime: {
      node: ">=20",
      platform: "linux",
    },
    tools: [
      "scout",
      "worker",
      "runner",
    ],
    files: { ...VALID_FILES },
  }
}

function makePayload() {
  const dir =
    mkdtempSync(
      join(tmpdir(), "manifest-payload-"),
    )

  for (const [key, relative] of Object.entries(VALID_FILES)) {
    const absolute = resolve(dir, relative)

    if (key === "agents") {
      mkdirSync(absolute, { recursive: true })
      writeFileSync(join(absolute, "agent.md"), "agent\n")
      continue
    }

    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, "payload\n")
  }

  return dir
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

function throwsField(manifest, dir, pattern) {
  assert.throws(
    () => validateReleaseManifest(manifest, dir),
    pattern,
  )
}

test("accepts the current dist manifest against the dist payload", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "dist/manifest.json"), "utf8"),
  )

  assert.equal(
    validateReleaseManifest(manifest, resolve(root, "dist")),
    manifest,
  )
})

test("accepts a minimal valid payload fixture", () => {
  const dir = makePayload()

  try {
    const manifest = validManifest()

    assert.equal(
      validateReleaseManifest(manifest, dir),
      manifest,
    )
  } finally {
    cleanup(dir)
  }
})

test("rejects non-object manifests and unknown keys", () => {
  const dir = makePayload()

  try {
    for (const bad of [null, [], "x", 42]) {
      assert.throws(
        () => validateReleaseManifest(bad, dir),
        /invalid release manifest: expected object at path ""/,
      )
    }

    throwsField(
      { ...validManifest(), extra: 1 },
      dir,
      /invalid release manifest: unknown key at path "extra"/,
    )

    throwsField(
      { ...validManifest(), runtime: { ...validManifest().runtime, extra: 1 } },
      dir,
      /invalid release manifest: unknown key at path "runtime\.extra"/,
    )

    throwsField(
      { ...validManifest(), files: { ...VALID_FILES, extra: "libexec/extra.mjs" } },
      dir,
      /invalid release manifest: unknown key at path "files\.extra"/,
    )
  } finally {
    cleanup(dir)
  }
})

test("rejects unsupported format versions", () => {
  const dir = makePayload()

  try {
    throwsField(
      { ...validManifest(), formatVersion: 2 },
      dir,
      /invalid release manifest: unsupported format version at path "formatVersion"/,
    )

    throwsField(
      { ...validManifest(), formatVersion: "1" },
      dir,
      /at path "formatVersion"/,
    )

    const missing = validManifest()
    delete missing.formatVersion
    throwsField(missing, dir, /at path "formatVersion"/)
  } finally {
    cleanup(dir)
  }
})

test("rejects unsafe versions without printing contents", () => {
  const dir = makePayload()

  try {
    for (const version of ["", "   ", "1.2", "v1.2.3", "1.2.3 with space", "EVIL-SENTINEL-9z9z", 42, null]) {
      let error = null

      try {
        validateReleaseManifest({ ...validManifest(), version }, dir)
      } catch (caught) {
        error = caught
      }

      assert.ok(error, `expected rejection for version: ${typeof version}`)
      assert.match(error.message, /at path "version"/)
      assert.ok(!error.message.includes("EVIL-SENTINEL-9z9z"))
      const versionText = typeof version === "string" ? version : ""
      if (versionText.trim().length >= 4 && /[A-Za-z0-9]{2,}/.test(versionText)) {
        assert.ok(!error.message.includes(versionText), `error must not echo version: ${versionText}`)
      }
    }

    const traversal = validManifest()
    traversal.version = "../EVIL-VERSION-SENTINEL"
    assert.throws(
      () => validateReleaseManifest(traversal, dir),
      (error) => {
        assert.match(error.message, /at path "version"/)
        assert.ok(!error.message.includes("EVIL-VERSION-SENTINEL"))
        return true
      },
    )
  } finally {
    cleanup(dir)
  }
})

test("rejects wrong, duplicate, or unknown tools", () => {
  const dir = makePayload()

  try {
    throwsField(
      { ...validManifest(), tools: "scout" },
      dir,
      /at path "tools"/,
    )

    throwsField(
      { ...validManifest(), tools: ["scout", "worker"] },
      dir,
      /unexpected tools at path "tools"/,
    )

    throwsField(
      { ...validManifest(), tools: ["scout", "scout", "runner"] },
      dir,
      /duplicate tool at path "tools\[1\]"/,
    )

    throwsField(
      { ...validManifest(), tools: ["scout", "worker", "EVIL-TOOL-SENTINEL"] },
      dir,
      (error) => {
        assert.match(error.message, /unsupported tool at path "tools\[2\]"/)
        assert.ok(!error.message.includes("EVIL-TOOL-SENTINEL"))
        return true
      },
    )

    throwsField(
      { ...validManifest(), tools: ["scout", "worker", "worker"] },
      dir,
      /duplicate tool at path "tools\[2\]"/,
    )
  } finally {
    cleanup(dir)
  }
})

test("rejects unsafe, non-normalized, or duplicate file paths", () => {
  const dir = makePayload()

  try {
    const cases = [
      ["/absolute/path.mjs", /repository-relative file path at path "files\.mcpServer"/],
      ["../escape.mjs", /traversal at path "files\.mcpServer"/],
      ["a/../../b.mjs", /traversal at path "files\.mcpServer"/],
      ["a\\b.mjs", /repository-relative file path at path "files\.mcpServer"/],
      ["", /repository-relative file path at path "files\.mcpServer"/],
      ["   ", /repository-relative file path at path "files\.mcpServer"/],
      ["a\u0000b.mjs", /repository-relative file path at path "files\.mcpServer"/],
      ["libexec//mcp-server.mjs", /normalized repository-relative file path at path "files\.mcpServer"/],
      ["./libexec/mcp-server.mjs", /at path "files\.mcpServer"/],
      ["libexec/./mcp-server.mjs", /(normalized repository-relative file path|repository-relative file path without traversal) at path "files\.mcpServer"/],
      ["libexec/mcp-server.mjs/", /normalized repository-relative file path at path "files\.mcpServer"/],
    ]

    for (const [relative, pattern] of cases) {
      const manifest = validManifest()
      manifest.files = { ...VALID_FILES, mcpServer: relative }

      assert.throws(
        () => validateReleaseManifest(manifest, dir),
        pattern,
      )
    }

    const duplicate = validManifest()
    duplicate.files = { ...VALID_FILES, setup: VALID_FILES.mcpServer }
    throwsField(duplicate, dir, /duplicate file at path "files\.setup"/)

    const missing = validManifest()
    missing.files = { ...VALID_FILES }
    delete missing.files.skill
    throwsField(missing, dir, /missing key at path "files\.skill"/)
  } finally {
    cleanup(dir)
  }
})

test("rejects missing, symlinked, or mistyped payload entries", () => {
  const dir = makePayload()

  try {
    unlinkSync(resolve(dir, VALID_FILES.skill))
    throwsField(validManifest(), dir, /missing payload file at path "files\.skill"/)
  } finally {
    cleanup(dir)
  }

  {
    const dir = makePayload()

    try {
      const target = resolve(dir, VALID_FILES.skill)
      const outside =
        mkdtempSync(join(tmpdir(), "manifest-out-"))

      try {
        const external = resolve(outside, "external.mjs")
        writeFileSync(external, "external\n")
        unlinkSync(target)
        symlinkSync(external, target)

        throwsField(validManifest(), dir, /must not be a symlink at path "files\.skill"/)
      } finally {
        cleanup(outside)
      }
    } finally {
      cleanup(dir)
    }
  }

  {
    const dir = makePayload()

    try {
      const target = resolve(dir, VALID_FILES.mcpServer)
      unlinkSync(target)
      mkdirSync(target, { recursive: true })

      throwsField(validManifest(), dir, /expected payload file at path "files\.mcpServer"/)
    } finally {
      cleanup(dir)
    }
  }

  {
    const dir = makePayload()

    try {
      rmSync(resolve(dir, VALID_FILES.agents), { recursive: true, force: true })
      writeFileSync(resolve(dir, VALID_FILES.agents), "not a directory\n")

      throwsField(validManifest(), dir, /expected payload directory at path "files\.agents"/)
    } finally {
      cleanup(dir)
    }
  }
})

test("never prints manifest contents in field errors", () => {
  const dir = makePayload()

  try {
    const manifest = validManifest()
    manifest.files = { ...VALID_FILES, skill: "libexec/SENTINEL-CONTENT-abc123.mjs" }

    assert.throws(
      () => validateReleaseManifest(manifest, dir),
      (error) => {
        assert.match(error.message, /at path "files\.skill"/)
        assert.ok(!error.message.includes("SENTINEL-CONTENT-abc123"))
        return true
      },
    )
  } finally {
    cleanup(dir)
  }
})
