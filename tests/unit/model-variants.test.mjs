import assert from "node:assert/strict"
import test from "node:test"
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  configuredModel,
  resetBridgeStateForTests,
  runAgent,
} from "../../bridge/server.mjs"
import {
  validateBridgeConfig,
  validateModelVariant,
} from "../../bridge/config.mjs"

const baseConfig = {
  version: 1,
  models: {
    scout: "provider/scout-model",
    worker: "provider/worker-model",
    runner: "provider/runner-model",
  },
}

async function withTempDir(prefix, fn) {
  const directory = await mkdtemp(join(tmpdir(), prefix))

  try {
    return await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function fakeClient(calls) {
  return {
    session: {
      create: async (input) => {
        calls.push(["create", input])
        return { id: "ses_variant_test" }
      },
      switchAgent: async (input) => {
        calls.push(["switchAgent", input])
      },
      switchModel: async (input) => {
        calls.push(["switchModel", input])
      },
      prompt: async (input) => {
        calls.push(["prompt", input])
      },
      wait: async (input) => {
        calls.push(["wait", input])
      },
      context: async (input) => {
        calls.push(["context", input])
        return [
          {
            type: "assistant",
            finish: "stop",
            content: [
              { type: "text", text: "done" },
            ],
          },
        ]
      },
      interrupt: async (input) => {
        calls.push(["interrupt", input])
      },
      remove: async (input) => {
        calls.push(["remove", input])
      },
    },
  }
}

test("legacy config without modelVariants remains valid", () => {
  assert.deepEqual(
    validateBridgeConfig(baseConfig),
    baseConfig,
  )
})

test("modelVariants may independently configure each role", () => {
  const config = {
    ...baseConfig,
    modelVariants: {
      scout: "low",
      worker: "medium",
      runner: "minimal",
    },
  }

  assert.deepEqual(
    validateBridgeConfig(config),
    config,
  )
})

test("model variant validation rejects unsafe and unknown entries", () => {
  assert.equal(validateModelVariant("xhigh", "worker"), "xhigh")

  for (const invalid of ["", "two words", "line\nbreak", "\u0000bad"]) {
    assert.throws(
      () => validateModelVariant(invalid, "worker"),
      /invalid model variant/,
    )
  }

  assert.throws(
    () => validateBridgeConfig({
      ...baseConfig,
      modelVariants: {
        planner: "low",
      },
    }),
    /unknown role at path "modelVariants\.planner"/,
  )
})

test("configuredModel returns the role variant when configured", { concurrency: false }, async () => {
  await withTempDir("model-variant-config-", async (directory) => {
    const configPath = join(directory, "config.json")
    const previous = process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG

    await writeFile(
      configPath,
      JSON.stringify({
        ...baseConfig,
        modelVariants: {
          worker: "low",
        },
      }),
    )

    try {
      process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG = configPath

      assert.deepEqual(
        await configuredModel("worker"),
        {
          reference: "provider/worker-model",
          providerID: "provider",
          id: "worker-model",
          variant: "low",
        },
      )

      assert.deepEqual(
        await configuredModel("scout"),
        {
          reference: "provider/scout-model",
          providerID: "provider",
          id: "scout-model",
        },
      )
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG
      } else {
        process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG = previous
      }
    }
  })
})

test("runAgent sends a configured variant to session.switchModel", async () => {
  resetBridgeStateForTests()

  await withTempDir("model-variant-run-", async (directory) => {
    const calls = []

    const result = await runAgent(
      directory,
      "variant test",
      "opencode-orchestrator-scout",
      "scout",
      {
        client: fakeClient(calls),
        model: {
          reference: "provider/model",
          providerID: "provider",
          id: "model",
          variant: "low",
        },
        timeoutMs: 5000,
        parentTimeoutSeconds: 120,
      },
    )

    assert.equal(result, "done")

    const switchModel = calls.find(([name]) => name === "switchModel")

    assert.deepEqual(
      switchModel?.[1],
      {
        sessionID: "ses_variant_test",
        model: {
          providerID: "provider",
          id: "model",
          variant: "low",
        },
      },
    )
  })

  resetBridgeStateForTests()
})

test("runAgent omits variant when OpenCode default is selected", async () => {
  resetBridgeStateForTests()

  await withTempDir("model-default-run-", async (directory) => {
    const calls = []

    await runAgent(
      directory,
      "default variant test",
      "opencode-orchestrator-scout",
      "scout",
      {
        client: fakeClient(calls),
        model: {
          reference: "provider/model",
          providerID: "provider",
          id: "model",
        },
        timeoutMs: 5000,
        parentTimeoutSeconds: 120,
      },
    )

    const switchModel = calls.find(([name]) => name === "switchModel")

    assert.deepEqual(
      switchModel?.[1]?.model,
      {
        providerID: "provider",
        id: "model",
      },
    )
    assert.equal(
      Object.hasOwn(switchModel?.[1]?.model ?? {}, "variant"),
      false,
    )
  })

  resetBridgeStateForTests()
})

test("configurator discovers variants generically and retains fallback", async () => {
  const source = await readFile(
    new URL("../../scripts/configure-models.mjs", import.meta.url),
    "utf8",
  )

  assert.match(source, /\["api", "GET", "\/api\/model"\]/)
  assert.match(source, /raw\.variants/)
  assert.match(source, /variantsByModel/)
  assert.match(source, /\["models"\]/)
  assert.match(source, /previousVariants/)
  assert.match(source, /previousModels\[role\] === model/)

  for (const hardcoded of ["minimal", "low", "medium", "high", "xhigh"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`\\b${hardcoded}\\b`),
      `configurator must not hardcode variant ${hardcoded}`,
    )
  }
})
