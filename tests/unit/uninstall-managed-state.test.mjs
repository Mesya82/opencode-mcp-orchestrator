import assert from "node:assert/strict"
import {
  spawnSync,
} from "node:child_process"
import test from "node:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import {
  tmpdir,
} from "node:os"
import {
  delimiter,
  join,
  resolve,
} from "node:path"

import {
  loadManagedState,
  validateManagedState,
} from "../../installer/managed-state.mjs"

function makeEnv() {
  const home = mkdtempSync(join(tmpdir(), "uninstall-state-home-"))
  const configHome = join(home, ".config")
  return { home, configHome }
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

function roots(env) {
  return { home: env.home, configHome: env.configHome }
}

const HASH_LOWER = "a".repeat(64)
const HASH_UPPER = "A".repeat(64)

function validFiles(env) {
  return {
    [resolve(env.configHome, "opencode/agents/opencode-orchestrator-scout.md")]: {
      sha256: HASH_LOWER,
    },
    [resolve(env.home, ".agents/skills/orchestrate/SKILL.md")]: {
      sha256: HASH_UPPER,
    },
    [resolve(env.home, ".claude/skills/orchestrate/SKILL.md")]: {
      sha256: HASH_LOWER,
    },
  }
}

function validState(env, overrides = {}) {
  return {
    formatVersion: 1,
    files: validFiles(env),
    integrations: {
      codex: {
        mcpName: "opencode-agents",
        node: "/usr/bin/node",
        server: resolve(env.home, ".local/share/opencode-mcp-orchestrator/current/libexec/mcp-server.mjs"),
        toolTimeoutSeconds: 1500,
      },
      claude: {
        mcpName: "opencode-agents",
        scope: "user",
        node: "/usr/bin/node",
        server: resolve(env.home, ".local/share/opencode-mcp-orchestrator/current/libexec/mcp-server.mjs"),
      },
    },
    ...overrides,
  }
}

test("accepts installer-emitted states (opencode-only, codex, claude, combined)", () => {
  const env = makeEnv()
  try {
    const opencodeOnly = {
      formatVersion: 1,
      files: {
        [resolve(env.configHome, "opencode/agents/opencode-orchestrator-scout.md")]: { sha256: HASH_LOWER },
      },
    }
    assert.deepEqual(validateManagedState(opencodeOnly, roots(env)).files, opencodeOnly.files)

    const codexOnly = {
      formatVersion: 1,
      files: {
        [resolve(env.home, ".agents/skills/orchestrate/SKILL.md")]: { sha256: HASH_LOWER },
      },
      integrations: { codex: { mcpName: "opencode-agents" } },
    }
    validateManagedState(codexOnly, roots(env))

    const claudeOnly = {
      formatVersion: 1,
      files: {
        [resolve(env.home, ".claude/skills/orchestrate/SKILL.md")]: { sha256: HASH_UPPER },
      },
      integrations: { claude: { mcpName: "opencode-agents", scope: "user" } },
    }
    validateManagedState(claudeOnly, roots(env))

    validateManagedState(validState(env), roots(env))
  } finally {
    cleanup(env.home)
  }
})

test("JSON parse errors become state-file errors without contents", () => {
  const env = makeEnv()
  try {
    const dir = mkdtempSync(join(tmpdir(), "uninstall-state-file-"))
    try {
      const sentinel = "SENTINEL-CONTENT-9z9z"
      const statePath = join(dir, "managed-files.json")
      writeFileSync(statePath, `{"files": {"${sentinel}": 1},`)
      assert.throws(
        () => loadManagedState(statePath, roots(env)),
        (error) => {
          assert.match(error.message, /invalid managed-files state/)
          assert.match(error.message, /state file/)
          assert.ok(!error.message.includes(sentinel))
          return true
        },
      )
    } finally {
      cleanup(dir)
    }
  } finally {
    cleanup(env.home)
  }
})

test("rejects non-object state, bad version, and non-object maps", () => {
  const env = makeEnv()
  try {
    for (const bad of [null, [], "x", 42]) {
      assert.throws(() => validateManagedState(bad, roots(env)), /invalid managed-files state: expected object/)
    }
    assert.throws(() => validateManagedState({ ...validState(env), formatVersion: 2 }, roots(env)), /unsupported version.*formatVersion/)
    assert.throws(() => validateManagedState({ ...validState(env), formatVersion: "1" }, roots(env)), /at path "formatVersion"/)
    const missing = validState(env)
    delete missing.formatVersion
    assert.throws(() => validateManagedState(missing, roots(env)), /at path "formatVersion"/)
    assert.throws(() => validateManagedState({ ...validState(env), files: [] }, roots(env)), /at path "files"/)
    assert.throws(() => validateManagedState({ ...validState(env), integrations: [] }, roots(env)), /at path "integrations"/)
    assert.throws(() => validateManagedState({ ...validState(env), files: { [resolve(env.home, ".agents/a.md")]: { sha256: "short" } }, integrations: "x" }, roots(env)), /at path "integrations"/)
  } finally {
    cleanup(env.home)
  }
})

test("rejects out-of-scope, root/HOME/.git/traversal/control/duplicate file keys", () => {
  const env = makeEnv()
  try {
    const good = resolve(env.home, ".agents/skills/orchestrate/SKILL.md")
    const cases = [
      "/",
      env.home,
      "/etc/passwd",
      resolve(env.home, ".agents/../.agents2/evil.md"),
      `${good}/../evil.md`,
      `${good}//dup`,
      resolve(env.home, ".agents/.git/hooks/evil.md"),
      `${good}\u0000`,
      "relative/path.md",
      resolve(env.configHome, "other-app/file.md"),
    ]
    for (const key of cases) {
      const state = { formatVersion: 1, files: { [key]: { sha256: HASH_LOWER } }, integrations: {} }
      assert.throws(() => validateManagedState(state, roots(env)), /invalid managed-files state.*at path "files\[\d+\]"/, `expected rejection for ${JSON.stringify(key)}`)
    }

    const normalized = resolve(env.home, ".agents/a.md")
    const nonNormalized = `${resolve(env.home, ".agents")}//a.md`
    const dupState = {
      formatVersion: 1,
      files: {
        [normalized]: { sha256: HASH_LOWER },
        [nonNormalized]: { sha256: HASH_LOWER },
      },
      integrations: {},
    }
    assert.throws(() => validateManagedState(dupState, roots(env)), /duplicate file|normalized/)
  } finally {
    cleanup(env.home)
  }
})

test("rejects non-hex hashes and bad integration ownership fields", () => {
  const env = makeEnv()
  try {
    const good = resolve(env.home, ".agents/skills/orchestrate/SKILL.md")
    for (const sha256 of ["", "xyz", "a".repeat(63), "a".repeat(65), "g".repeat(64), 42, null]) {
      assert.throws(() => validateManagedState({ formatVersion: 1, files: { [good]: { sha256 } }, integrations: {} }, roots(env)), /invalid managed-files state/)
    }
    assert.throws(() => validateManagedState({ formatVersion: 1, files: { [good]: {} }, integrations: {} }, roots(env)), /invalid file hash|at path "files/)

    const badIntegrations = [
      { codex: { mcpName: "" } },
      { codex: { mcpName: "../evil" } },
      { codex: { mcpName: "opencode-agents", toolTimeoutSeconds: 0 } },
      { codex: { mcpName: "opencode-agents", toolTimeoutSeconds: 7201 } },
      { codex: { mcpName: "opencode-agents", toolTimeoutSeconds: "1500" } },
      { codex: "x" },
      { claude: { mcpName: "opencode-agents", scope: "--evil" } },
      { claude: { mcpName: 42 } },
      { unknown: { mcpName: "opencode-agents" } },
    ]
    for (const integrations of badIntegrations) {
      assert.throws(() => validateManagedState({ formatVersion: 1, files: { [good]: { sha256: HASH_LOWER } }, integrations }, roots(env)), /invalid managed-files state/)
    }
  } finally {
    cleanup(env.home)
  }
})

test("uninstall validates state before integration removal or filesystem mutation", () => {
  const home = mkdtempSync(join(tmpdir(), "uninstall-order-home-"))

  try {
    const configHome = join(home, ".config")
    const dataHome = join(home, ".local/share")
    const appConfig = join(configHome, "opencode-mcp-orchestrator")
    const appData = join(dataHome, "opencode-mcp-orchestrator")

    mkdirSync(appConfig, { recursive: true })
    mkdirSync(appData, { recursive: true })

    const payloadSentinel = join(appData, "payload-sentinel.txt")
    writeFileSync(payloadSentinel, "payload-must-survive-validation-failure")

    const statePath = join(appConfig, "managed-files.json")
    const invalidState = {
      formatVersion: 1,
      files: {
        "/etc/passwd": { sha256: HASH_LOWER },
      },
      integrations: {
        codex: { mcpName: "opencode-agents" },
        claude: { mcpName: "opencode-agents", scope: "user" },
      },
    }
    writeFileSync(statePath, JSON.stringify(invalidState))

    const binDir = join(home, "bin")
    mkdirSync(binDir, { recursive: true })

    const codexMarker = join(binDir, "codex-invoked")
    const claudeMarker = join(binDir, "claude-invoked")

    for (const [name, marker] of [["codex", codexMarker], ["claude", claudeMarker]]) {
      const cliPath = join(binDir, name)
      writeFileSync(cliPath, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`)
      chmodSync(cliPath, 0o755)
    }

    const uninstallPath = resolve(
      new URL(".", import.meta.url).pathname,
      "../../installer/uninstall.mjs",
    )

    const result = spawnSync(
      process.execPath,
      [uninstallPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: configHome,
          XDG_DATA_HOME: dataHome,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    )

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`

    assert.notEqual(result.status, 0, `uninstall must fail on invalid state, got output:\n${output}`)
    assert.match(output, /invalid managed-files state/, "validation error must be reported")
    assert.equal(existsSync(codexMarker), false, "validation must precede integration removal (codex)")
    assert.equal(existsSync(claudeMarker), false, "validation must precede integration removal (claude)")
    assert.equal(existsSync(payloadSentinel), true, "validation must precede filesystem mutation (payload)")
    assert.equal(existsSync(statePath), true, "invalid state must not be deleted")
  } finally {
    cleanup(home)
  }
})
