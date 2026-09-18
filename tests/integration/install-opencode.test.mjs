import assert from "node:assert/strict"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import {
  tmpdir,
} from "node:os"
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
import test from "node:test"

const root =
  resolve(
    dirname(
      fileURLToPath(import.meta.url),
    ),
    "../..",
  )

function runInstaller(testRoot, configPath) {
  return spawnSync(
    process.execPath,
    [
      resolve(root, "installer/install-opencode.mjs"),
      "--payload",
      resolve(root, "dist"),
      "--config",
      configPath,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: testRoot,
        XDG_CONFIG_HOME: resolve(testRoot, "config"),
      },
    },
  )
}

function runDoctor(testRoot, configPath) {
  return spawnSync(
    process.execPath,
    [
      resolve(root, "installer/doctor.mjs"),
      "--config",
      configPath,
      "--no-sandbox-probes",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: testRoot,
        XDG_CONFIG_HOME: resolve(testRoot, "config"),
        XDG_DATA_HOME: resolve(testRoot, "data"),
        OPENCODE_BIN: process.execPath,
      },
    },
  )
}

function writeConfig(path, stepLimits) {
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      models: {
        scout: "provider/scout",
        worker: "provider/worker",
        runner: "provider/runner",
      },
      ...(stepLimits ? { stepLimits } : {}),
      integrations: ["codex"],
    }) + "\n",
  )
}

function installedAgent(testRoot, role) {
  return readFileSync(
    resolve(
      testRoot,
      `config/opencode/agents/opencode-orchestrator-${role}.md`,
    ),
    "utf8",
  )
}

function installedPlugin(testRoot) {
  return readFileSync(
    resolve(
      testRoot,
      "config/opencode/plugins/opencode-mcp-orchestrator/index.ts",
    ),
    "utf8",
  )
}

test("installer renders default and custom step-limit profiles", () => {
  const testRoot =
    mkdtempSync(
      resolve(tmpdir(), "opencode-orchestrator-install-test-"),
    )

  try {
    const configPath =
      resolve(testRoot, "settings.json")

    writeConfig(configPath)

    const standard =
      runInstaller(testRoot, configPath)

    assert.equal(
      standard.status,
      0,
      standard.stderr || standard.stdout,
    )

    assert.match(installedAgent(testRoot, "scout"), /^steps: 16$/m)
    assert.match(installedAgent(testRoot, "worker"), /^steps: 32$/m)
    assert.match(installedAgent(testRoot, "runner"), /^steps: 40$/m)
    assert.match(installedAgent(testRoot, "runner-writable"), /^steps: 40$/m)
    assert.match(
      installedAgent(testRoot, "runner-writable"),
      /at most 40 model steps/,
    )
    assert.match(
      installedAgent(testRoot, "runner-writable"),
      /by step 32 of 40/,
    )
    for (const role of ["runner-network", "runner-writable-network"]) {
      assert.match(installedAgent(testRoot, role), /^steps: 40$/m)
      assert.match(
        installedAgent(testRoot, role),
        /at most 40 model steps/,
      )
      assert.match(
        installedAgent(testRoot, role),
        /by step 32 of 40/,
      )
    }
    assert.match(
      installedPlugin(testRoot),
      /opencode_orchestrator_muse_final_tool_choice_omitted/,
    )
    assert.match(standard.stdout, /OPENCODE_RESTART_REQUIRED/)
    assert.equal(
      existsSync(resolve(
        testRoot,
        "config/opencode-mcp-orchestrator/opencode-service-restart-required",
      )),
      true,
    )

    const doctor = runDoctor(testRoot, configPath)
    assert.notEqual(doctor.status, 0)
    assert.match(
      doctor.stdout,
      /plugin generation is not activated; rerun full orchestrator setup/,
    )

    writeConfig(
      configPath,
      {
        profile: "custom",
        scout: 24,
        worker: 36,
        runner: 48,
      },
    )

    const custom =
      runInstaller(testRoot, configPath)

    assert.equal(
      custom.status,
      0,
      custom.stderr || custom.stdout,
    )

    assert.match(installedAgent(testRoot, "scout"), /^steps: 24$/m)
    assert.match(installedAgent(testRoot, "scout"), /by step 19 of 24/)
    assert.match(installedAgent(testRoot, "worker"), /^steps: 36$/m)
    assert.match(installedAgent(testRoot, "runner"), /^steps: 48$/m)
    assert.match(installedAgent(testRoot, "runner"), /by step 38 of 48/)
    assert.match(installedAgent(testRoot, "runner-writable"), /^steps: 48$/m)
    assert.match(
      installedAgent(testRoot, "runner-writable"),
      /at most 48 model steps/,
    )
    assert.match(
      installedAgent(testRoot, "runner-writable"),
      /by step 38 of 48/,
    )
    for (const role of ["runner-network", "runner-writable-network"]) {
      assert.match(installedAgent(testRoot, role), /^steps: 48$/m)
      assert.match(
        installedAgent(testRoot, role),
        /at most 48 model steps/,
      )
      assert.match(
        installedAgent(testRoot, role),
        /by step 38 of 48/,
      )
    }
  } finally {
    rmSync(
      testRoot,
      {
        recursive: true,
        force: true,
      },
    )
  }
})
