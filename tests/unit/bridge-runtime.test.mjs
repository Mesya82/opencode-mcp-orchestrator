import assert from "node:assert/strict"
import test from "node:test"
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import {
  tmpdir,
} from "node:os"
import {
  join,
} from "node:path"
import {
  Client,
} from "@modelcontextprotocol/client"
import {
  InMemoryTransport,
} from "@modelcontextprotocol/server"

import {
  BRIDGE_TIMEOUT_ENV_VAR,
  configuredModel,
  configuredRoleTimeoutSeconds,
  createServer,
  createToolHandlers,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  getClient,
  mcpRequestSignal,
  resetBridgeStateForTests,
  resolveBridgeTimeoutMs,
  resolveCanonicalCwd,
  resolveServerVersion,
  runAgent,
  SERVER_VERSION_FALLBACK,
} from "../../bridge/server.mjs"
import {
  SUPPORTED_CONFIG_VERSION,
  validateBridgeConfig,
  validateModelReference,
} from "../../bridge/config.mjs"

const stubModel = {
  reference: "provider/model",
  providerID: "provider",
  id: "model",
}

function makeFakeClient(hooks = {}) {
  const calls = []

  const session = {
    create: async (input, options) => {
      calls.push(["create", input, options])

      if (hooks.create) {
        return hooks.create(input, options)
      }

      return { id: "ses_test" }
    },
    switchAgent: async (input, options) => {
      calls.push(["switchAgent", input, options])

      if (hooks.switchAgent) {
        await hooks.switchAgent(input, options)
      }
    },
    switchModel: async (input, options) => {
      calls.push(["switchModel", input, options])

      if (hooks.switchModel) {
        await hooks.switchModel(input, options)
      }
    },
    prompt: async (input, options) => {
      calls.push(["prompt", input, options])

      if (hooks.prompt) {
        await hooks.prompt(input, options)
      }
    },
    wait: async (input, options) => {
      calls.push(["wait", input, options])

      if (hooks.wait) {
        await hooks.wait(input, options)
      }
    },
    context: async (input, options) => {
      calls.push(["context", input, options])

      if (hooks.context) {
        return hooks.context(input, options)
      }

      return [
        {
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", text: "hello" }],
        },
      ]
    },
    interrupt: async (input, options) => {
      calls.push(["interrupt", input, options])

      if (hooks.interrupt) {
        await hooks.interrupt(input, options)
      }
    },
    remove: async (input, options) => {
      calls.push(["remove", input, options])

      if (hooks.remove) {
        await hooks.remove(input, options)
      }
    },
  }

  return { calls, client: { session } }
}

function callNames(calls, name) {
  return calls.filter(([entry]) => entry === name)
}

async function waitFor(condition, timeoutMs = 5000) {
  const start = Date.now()

  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for test condition")
    }

    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(join(tmpdir(), prefix))

  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function captureThrownError(fn, pattern) {
  let error = null

  try {
    fn()
  } catch (caught) {
    error = caught
  }

  assert.ok(error, "expected function to throw")

  if (pattern !== undefined) {
    assert.match(error.message, pattern)
  }

  return error
}

test("a rejected first initialization can be retried successfully", async () => {
  resetBridgeStateForTests()

  try {
    let attempts = 0
    const seen = []

    const ensureService = async () => {
      attempts += 1

      if (attempts === 1) {
        throw new Error("transient service failure")
      }

      return { url: "http://127.0.0.1:9", auth: undefined }
    }

    const makeClient = (options) => {
      seen.push(options)
      return { marker: "client" }
    }

    await assert.rejects(
      () => getClient({ ensureService, makeClient }),
      /transient service failure/,
    )

    const client = await getClient({ ensureService, makeClient })

    assert.equal(client.marker, "client")
    assert.equal(attempts, 2)
    assert.equal(seen[0].baseUrl, "http://127.0.0.1:9")

    const again = await getClient({ ensureService, makeClient })

    assert.equal(again, client)
    assert.equal(attempts, 2)
  } finally {
    resetBridgeStateForTests()
  }
})

test("bridge timeout uses a conservative default with strict bounds", () => {
  assert.equal(
    resolveBridgeTimeoutMs({}),
    DEFAULT_BRIDGE_TIMEOUT_MS,
  )

  assert.equal(
    resolveBridgeTimeoutMs({
      [BRIDGE_TIMEOUT_ENV_VAR]: "60000",
    }),
    60000,
  )

  for (
    const raw
    of [
      "",
      "   ",
      "nope",
      "12.5",
      "0",
      "-5",
      "999",
      "3600001",
      "Infinity",
      "NaN",
      "60s",
    ]
  ) {
    assert.equal(
      resolveBridgeTimeoutMs({ [BRIDGE_TIMEOUT_ENV_VAR]: raw }),
      DEFAULT_BRIDGE_TIMEOUT_MS,
      raw,
    )
  }

  assert.equal(
    resolveBridgeTimeoutMs({ [BRIDGE_TIMEOUT_ENV_VAR]: "1000" }),
    1000,
  )

  assert.equal(
    resolveBridgeTimeoutMs({ [BRIDGE_TIMEOUT_ENV_VAR]: "3600000" }),
    3600000,
  )
})

test("paths beneath /tmp remain valid directories", async () => {
  await withTempDir("bridge-ok-", async (dir) => {
    const canonical = await resolveCanonicalCwd(dir, {
      homeDir: "/nonexistent-home-bridge-test",
    })

    assert.equal(canonical, await realpath(dir))
  })
})

test("relative, missing, file, and dangerous cwd values fail before session creation", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-cwd-", async (root) => {
    const { calls, client } = makeFakeClient()
    const homeDir = join(root, "home")
    const options = {
      client,
      model: stubModel,
      timeoutMs: 5000,
      homeDir,
    }

    await assert.rejects(
      () => runAgent("relative/path", "task", "opencode-orchestrator-scout", "scout", options),
      /must be an absolute path/,
    )

    await assert.rejects(
      () => runAgent("", "task", "opencode-orchestrator-scout", "scout", options),
      /non-empty string/,
    )

    await assert.rejects(
      () => runAgent(join(root, "does-not-exist"), "task", "opencode-orchestrator-scout", "scout", options),
      /does not exist/,
    )

    const file = join(root, "file.txt")
    await writeFile(file, "x\n")

    await assert.rejects(
      () => runAgent(file, "task", "opencode-orchestrator-scout", "scout", options),
      /must be an existing directory/,
    )

    for (
      const dangerous
      of ["/", "/home", "/tmp", "/usr", "/etc", "/proc", "/dev", homeDir]
    ) {
      await assert.rejects(
        () => runAgent(dangerous, "task", "opencode-orchestrator-scout", "scout", options),
        /must not be a system or home root/,
        dangerous,
      )
    }

    assert.equal(calls.length, 0)
  })

  resetBridgeStateForTests()
})

test("a cwd resolving through a symlink to a dangerous root is rejected", async () => {
  resetBridgeStateForTests()

  try {
    const { calls, client } = makeFakeClient()

    await assert.rejects(
      () => runAgent("/tmp/link-to-root", "task", "opencode-orchestrator-scout", "scout", {
        client,
        model: stubModel,
        timeoutMs: 5000,
        homeDir: "/nonexistent-home-bridge-test",
        realpath: async () => "/",
      }),
      /must not be a system or home root/,
    )

    assert.equal(calls.length, 0)
  } finally {
    resetBridgeStateForTests()
  }
})

test("a never-resolving operation terminates within the configured timeout and cleans up", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-timeout-", async (dir) => {
    const { calls, client } = makeFakeClient({
      wait: () => new Promise(() => {}),
    })

    const start = Date.now()

    const error = await runAgent(
      dir,
      "do something secret",
      "opencode-orchestrator-scout",
      "scout",
      { client, model: stubModel, timeoutMs: 60 },
    ).then(
      () => { throw new Error("should have timed out") },
      (caught) => caught,
    )

    const elapsed = Date.now() - start

    assert.match(error.message, /timed out after 60ms/)
    assert.doesNotMatch(error.message, /do something secret/)
    assert.ok(elapsed < 5000, `took too long: ${elapsed}ms`)

    assert.equal(callNames(calls, "interrupt").length, 1)
    assert.deepEqual(callNames(calls, "interrupt")[0][1], { sessionID: "ses_test" })
    assert.equal(callNames(calls, "remove").length, 1)
    assert.deepEqual(callNames(calls, "remove")[0][1], { sessionID: "ses_test" })

    const createOptions = callNames(calls, "create")[0][2]
    assert.ok(createOptions.signal instanceof AbortSignal)
    assert.equal(createOptions.signal.aborted, true)
  })

  resetBridgeStateForTests()
})

test("a session created after the timeout still gets cleaned up", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-late-", async (dir) => {
    let releaseCreate
    const createGate = new Promise((resolve) => { releaseCreate = resolve })
    const { calls, client } = makeFakeClient({
      create: async () => {
        await createGate
        return { id: "ses_late" }
      },
    })

    const pending = runAgent(
      dir,
      "late task",
      "opencode-orchestrator-scout",
      "scout",
      { client, model: stubModel, timeoutMs: 50 },
    )

    await assert.rejects(() => pending, /timed out after 50ms/)
    assert.equal(callNames(calls, "remove").length, 0)

    releaseCreate()

    await waitFor(() => callNames(calls, "remove").length >= 1)

    assert.deepEqual(callNames(calls, "remove")[0][1], { sessionID: "ses_late" })
    assert.equal(callNames(calls, "remove").length, 1)
  })

  resetBridgeStateForTests()
})

test("cleanup also occurs after normal success and errors", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-cleanup-", async (dir) => {
    const success = makeFakeClient()

    const text = await runAgent(
      dir,
      "task",
      "opencode-orchestrator-scout",
      "scout",
      { client: success.client, model: stubModel, timeoutMs: 5000 },
    )

    assert.equal(text, "hello")
    assert.equal(callNames(success.calls, "interrupt").length, 0)
    assert.equal(callNames(success.calls, "remove").length, 1)
    assert.deepEqual(callNames(success.calls, "remove")[0][1], { sessionID: "ses_test" })

    const failing = makeFakeClient({
      wait: async () => { throw new Error("session exploded") },
    })

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        { client: failing.client, model: stubModel, timeoutMs: 5000 },
      ),
      /session exploded/,
    )

    assert.equal(callNames(failing.calls, "interrupt").length, 1)
    assert.equal(callNames(failing.calls, "remove").length, 1)
  })

  resetBridgeStateForTests()
})

test("delegated error messages redact prompt contents", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-redact-", async (dir) => {
    const secret = "super secret task words abc123"
    const { calls, client } = makeFakeClient({
      prompt: async () => {
        throw new Error(`upstream echoed the request: ${secret}`)
      },
    })

    const error = await runAgent(
      dir,
      secret,
      "opencode-orchestrator-scout",
      "scout",
      { client, model: stubModel, timeoutMs: 5000 },
    ).then(
      () => { throw new Error("should have failed") },
      (caught) => caught,
    )

    assert.doesNotMatch(error.message, /super secret/)
    assert.doesNotMatch(error.message, /abc123/)
    assert.match(error.message, /\[redacted\]/)

    assert.equal(callNames(calls, "interrupt").length, 1)
    assert.equal(callNames(calls, "remove").length, 1)
    assert.deepEqual(callNames(calls, "remove")[0][1], { sessionID: "ses_test" })
  })

  resetBridgeStateForTests()
})

test("external cancellation aborts the operation and still cleans up", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-cancel-", async (dir) => {
    const controller = new AbortController()
    const { calls, client } = makeFakeClient({
      wait: () => new Promise(() => {}),
    })

    const pending = runAgent(
      dir,
      "task",
      "opencode-orchestrator-scout",
      "scout",
      { client, model: stubModel, timeoutMs: 10000, signal: controller.signal },
    )

    await waitFor(() => callNames(calls, "wait").length >= 1)
    controller.abort()

    await assert.rejects(() => pending, /was cancelled/)

    assert.equal(callNames(calls, "interrupt").length, 1)
    assert.equal(callNames(calls, "remove").length, 1)
  })

  resetBridgeStateForTests()
})

test("two overlapping worker calls for the same canonical cwd cannot run concurrently", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-writer-", async (dir) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { calls, client } = makeFakeClient({ wait: () => gate })
    const options = { client, model: stubModel, timeoutMs: 10000 }

    const first = runAgent(
      dir,
      "first task",
      "opencode-orchestrator-worker",
      "worker",
      options,
    )

    await waitFor(() => callNames(calls, "wait").length >= 1)

    const createdBefore = callNames(calls, "create").length

    await assert.rejects(
      () => runAgent(
        dir,
        "second task",
        "opencode-orchestrator-worker",
        "worker",
        options,
      ),
      /already running/,
    )

    assert.equal(callNames(calls, "create").length, createdBefore)

    release()
    assert.equal(await first, "hello")

    assert.equal(
      await runAgent(
        dir,
        "third task",
        "opencode-orchestrator-worker",
        "worker",
        options,
      ),
      "hello",
    )
  })

  resetBridgeStateForTests()
})

test("worker calls for different worktrees are independent", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-writer-a-", async (dirA) => {
    await withTempDir("bridge-writer-b-", async (dirB) => {
      let release
      const gate = new Promise((resolve) => { release = resolve })
      const { calls, client } = makeFakeClient({ wait: () => gate })
      const options = { client, model: stubModel, timeoutMs: 10000 }

      const first = runAgent(
        dirA,
        "task a",
        "opencode-orchestrator-worker",
        "worker",
        options,
      )

      const second = runAgent(
        dirB,
        "task b",
        "opencode-orchestrator-worker",
        "worker",
        options,
      )

      await waitFor(() => callNames(calls, "wait").length >= 2)

      release()

      assert.deepEqual(await Promise.all([first, second]), ["hello", "hello"])
    })
  })

  resetBridgeStateForTests()
})

test("scout and runner calls never take the writer lock", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-read-", async (dir) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { calls, client } = makeFakeClient({ wait: () => gate })
    const options = { client, model: stubModel, timeoutMs: 10000 }

    const first = runAgent(
      dir,
      "scout task",
      "opencode-orchestrator-scout",
      "scout",
      options,
    )

    const second = runAgent(
      dir,
      "runner task",
      "opencode-orchestrator-runner",
      "runner",
      options,
    )

    await waitFor(() => callNames(calls, "wait").length >= 2)

    release()

    assert.deepEqual(await Promise.all([first, second]), ["hello", "hello"])
  })

  resetBridgeStateForTests()
})

test("a timed-out worker releases its worktree lock", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-writer-timeout-", async (dir) => {
    const hanging = makeFakeClient({
      wait: () => new Promise(() => {}),
    })

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        { client: hanging.client, model: stubModel, timeoutMs: 50 },
      ),
      /timed out/,
    )

    const fresh = makeFakeClient()

    assert.equal(
      await runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        { client: fresh.client, model: stubModel, timeoutMs: 5000 },
      ),
      "hello",
    )
  })

  resetBridgeStateForTests()
})

test("tool handlers preserve successful response shape and error shape", async () => {
  let captured

  const handlers = createToolHandlers(async (...args) => {
    captured = args
    return "handler text"
  })

  const result = await handlers.scout(
    { cwd: "/tmp/work", task: "find things" },
    undefined,
  )

  assert.deepEqual(result, {
    content: [{ type: "text", text: "handler text" }],
  })

  assert.deepEqual(captured.slice(0, 4), [
    "/tmp/work",
    "find things",
    "opencode-orchestrator-scout",
    "scout",
  ])

  const failing = createToolHandlers(async () => {
    throw new Error("kaboom")
  })

  const failure = await failing.worker(
    { cwd: "/tmp/work", task: "super secret task words" },
    undefined,
  )

  assert.equal(failure.isError, true)
  assert.match(failure.content[0].text, /OpenCode worker failed: kaboom/)
  assert.doesNotMatch(failure.content[0].text, /secret/)
})

test("tool handlers forward the MCP request cancellation signal", async () => {
  let captured

  const handlers = createToolHandlers(async (...args) => {
    captured = args
    return "ok"
  })

  const controller = new AbortController()

  await handlers.runner(
    { cwd: "/tmp/work", command: "cmd", objective: "goal" },
    { mcpReq: { signal: controller.signal } },
  )

  assert.equal(captured[4].signal, controller.signal)

  const legacySignal = new AbortController().signal

  await handlers.scout(
    { cwd: "/tmp/work", task: "task" },
    { signal: legacySignal },
  )

  assert.equal(captured[4].signal, legacySignal)

  await handlers.scout(
    { cwd: "/tmp/work", task: "task" },
    undefined,
  )

  assert.equal(captured[4].signal, undefined)
})

test("mcpRequestSignal prefers the versioned SDK signal and tolerates absence", () => {
  const versioned = new AbortController().signal
  const legacy = new AbortController().signal

  assert.equal(
    mcpRequestSignal({ mcpReq: { signal: versioned }, signal: legacy }),
    versioned,
  )

  assert.equal(
    mcpRequestSignal({ signal: legacy }),
    legacy,
  )

  assert.equal(mcpRequestSignal(undefined), undefined)
  assert.equal(mcpRequestSignal({}), undefined)
})

test("runner handler composes the delegated command task unchanged", async () => {
  let captured

  const handlers = createToolHandlers(async (...args) => {
    captured = args
    return "done"
  })

  const result = await handlers.runner(
    {
      cwd: "/tmp/work",
      command: "npm test",
      objective: "check tests",
      expected: "all green",
      timeout_seconds: 42,
    },
    undefined,
  )

  assert.deepEqual(result, {
    content: [{ type: "text", text: "done" }],
  })

  const task = captured[1]

  assert.match(task, /npm test/)
  assert.match(task, /check tests/)
  assert.match(task, /all green/)
  assert.match(task, /Maximum runtime: 42 seconds\./)
  assert.equal(captured[2], "opencode-orchestrator-runner")
  assert.equal(captured[3], "runner")
  assert.equal(captured[4].commandTimeoutSeconds, 42)

  await handlers.runner(
    {
      cwd: "/tmp/work",
      command: "npm test",
      objective: "check tests",
    },
    undefined,
  )

  assert.match(captured[1], /Maximum runtime: 900 seconds\./)
  assert.match(captured[1], /None specified\./)
})

test("the server exposes the unchanged scout, worker, and runner tools", async () => {
  const server = createServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await server.connect(serverTransport)

  const client = new Client({
    name: "bridge-runtime-test",
    version: "0.0.0",
  })

  await client.connect(clientTransport)

  try {
    const { tools } = await client.listTools()

    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["runner", "scout", "worker"],
    )

    const probe = await client.callTool({
      name: "scout",
      arguments: { cwd: "relative/path", task: "x" },
    })

    assert.equal(probe.isError, true)

    const text = (probe.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n")

    assert.match(text, /OpenCode scout failed: .*absolute/)
  } finally {
    await client.close()
    await server.close()
  }
})

test("runner handler defaults to the read-only permission-scoped agent", async () => {
  let captured

  const handlers = createToolHandlers(async (...args) => {
    captured = args
    return "done"
  })

  const result = await handlers.runner(
    { cwd: "/tmp/work", command: "npm test", objective: "check tests" },
    undefined,
  )

  assert.deepEqual(result, {
    content: [{ type: "text", text: "done" }],
  })
  assert.equal(captured[2], "opencode-orchestrator-runner")
  assert.equal(captured[3], "runner")
  assert.match(captured[1], /Workspace access mode: read_only\./)
})

test("runner handler selects the writable permission-scoped agent when requested", async () => {
  let captured

  const handlers = createToolHandlers(async (...args) => {
    captured = args
    return "done"
  })

  const result = await handlers.runner(
    {
      cwd: "/tmp/work",
      command: "npm test",
      objective: "check tests",
      workspace_access: "writable",
    },
    undefined,
  )

  assert.deepEqual(result, {
    content: [{ type: "text", text: "done" }],
  })
  assert.equal(captured[2], "opencode-orchestrator-runner-writable")
  assert.equal(captured[3], "runner")
  assert.match(captured[1], /Workspace access mode: writable\./)
})

test("runner schema rejects an invalid workspace_access value", async () => {
  const server = createServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await server.connect(serverTransport)

  const client = new Client({
    name: "bridge-runtime-workspace-access-test",
    version: "0.0.0",
  })

  await client.connect(clientTransport)

  try {
    let outcome

    try {
      outcome = await client.callTool({
        name: "runner",
        arguments: {
          cwd: "/tmp/work",
          command: "npm test",
          objective: "check tests",
          workspace_access: "bogus",
        },
      })
    } catch (error) {
      assert.match(String(error?.message ?? error), /workspace_access/i)
      return
    }

    assert.equal(outcome.isError, true)

    const text = (outcome.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n")

    assert.match(text, /workspace_access/i)
  } finally {
    await client.close()
    await server.close()
  }
})

function validBridgeConfig(overrides = {}) {
  return {
    version: SUPPORTED_CONFIG_VERSION,
    models: {
      scout: "provider/scout-model",
      worker: "provider/worker-model",
      runner: "provider/runner-model",
    },
    ...overrides,
  }
}

test("bridge config accepts version 1 with scout/worker/runner models", () => {
  const config = validBridgeConfig()

  assert.equal(validateBridgeConfig(config, { configPath: "/tmp/config.json" }), config)
  assert.equal(SUPPORTED_CONFIG_VERSION, 1)

  for (const role of ["scout", "worker", "runner"]) {
    const parsed = validateModelReference(config.models[role], role)

    assert.equal(parsed.providerID, "provider")
    assert.match(parsed.id, /model/)
  }
})

test("bridge config rejects unsupported versions without echoing contents", () => {
  const secret = "super-secret-version-value"

  for (const version of [0, 2, "1", null, undefined, secret]) {
    const error = captureThrownError(
      () => validateBridgeConfig(
        validBridgeConfig({ version }),
        { configPath: "/tmp/config.json" },
      ),
      /path "version"/,
    )

    assert.match(error.message, /\/tmp\/config\.json/)
    assert.doesNotMatch(error.message, /super-secret/)
  }
})

test("bridge config rejects invalid model references without echoing contents", () => {
  const secret = "super-secret-model-value-abc123"

  for (const bad of ["", "no-slash", "/missing", "missing/", "has space/a", secret, undefined, 42, null]) {
    const error = captureThrownError(
      () => validateBridgeConfig(
        validBridgeConfig({ models: { scout: bad, worker: "p/w", runner: "p/r" } }),
        { configPath: "/tmp/config.json" },
      ),
      /path "models\.scout"/,
    )

    // Delegated validateModelReference reports a field-specific safe
    // error without the config label; path coverage is asserted above.
    assert.doesNotMatch(error.message, /super-secret/)
    assert.doesNotMatch(error.message, /abc123/)
  }

  const missing = captureThrownError(
    () => validateBridgeConfig({ version: 1 }, { configPath: "/tmp/config.json" }),
    /path "models"/,
  )

  assert.match(missing.message, /\/tmp\/config\.json/)
})

test("bridge config validates optional stepLimits through the normalizer", () => {
  assert.equal(
    validateBridgeConfig(validBridgeConfig(), { configPath: "/tmp/config.json" }).version,
    1,
  )

  validateBridgeConfig(
    validBridgeConfig({ stepLimits: { profile: "standard" } }),
    { configPath: "/tmp/config.json" },
  )

  validateBridgeConfig(
    validBridgeConfig({ stepLimits: { profile: "custom", scout: 4, worker: 8, runner: 16 } }),
    { configPath: "/tmp/config.json" },
  )

  const bad = captureThrownError(
    () => validateBridgeConfig(
      validBridgeConfig({ stepLimits: { profile: "super-secret-step-abc123" } }),
      { configPath: "/tmp/config.json" },
    ),
    /path "stepLimits"/,
  )

  assert.match(bad.message, /\/tmp\/config\.json/)
  assert.doesNotMatch(bad.message, /super-secret/)
  assert.doesNotMatch(bad.message, /abc123/)

  assert.throws(
    () => validateBridgeConfig(
      validBridgeConfig({ stepLimits: [] }),
      { configPath: "/tmp/config.json" },
    ),
    /path "stepLimits"/,
  )
})

test("bridge config validates and normalizes optional timeoutLimits", () => {
  const result = validateBridgeConfig(
    validBridgeConfig({ timeoutLimits: { profile: "extended" } }),
    { configPath: "/tmp/config.json" },
  )

  assert.deepEqual(result.timeoutLimits, {
    profile: "extended",
    limits: { scout: 900, worker: 1500, runner: 1800 },
    parentTimeoutSeconds: 2100,
  })

  assert.throws(
    () => validateBridgeConfig(
      validBridgeConfig({ timeoutLimits: { profile: "custom", scout: 300, worker: 600, runner: 1200, parent: 1200 } }),
      { configPath: "/tmp/config.json" },
    ),
    /path "timeoutLimits"/,
  )
})

test("bridge config validates optional integrations without echoing contents", () => {
  validateBridgeConfig(
    validBridgeConfig({ integrations: ["codex"] }),
    { configPath: "/tmp/config.json" },
  )

  validateBridgeConfig(
    validBridgeConfig({ integrations: ["codex", "claude"] }),
    { configPath: "/tmp/config.json" },
  )

  const secret = "super-secret-integration-abc123"

  const bad = captureThrownError(
    () => validateBridgeConfig(
      validBridgeConfig({ integrations: [secret] }),
      { configPath: "/tmp/config.json" },
    ),
    /path "integrations\[0\]"/,
  )

  assert.match(bad.message, /\/tmp\/config\.json/)
  assert.doesNotMatch(bad.message, /super-secret/)
  assert.doesNotMatch(bad.message, /abc123/)

  assert.throws(
    () => validateBridgeConfig(
      validBridgeConfig({ integrations: "codex" }),
      { configPath: "/tmp/config.json" },
    ),
    /path "integrations"/,
  )
})

test("configuredModel validates the whole bridge config before returning a model", async () => {
  const previous = process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG

  await withTempDir("bridge-config-", async (dir) => {
    const good = join(dir, "good.json")
    await writeFile(good, JSON.stringify(validBridgeConfig()))
    process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG = good

    const model = await configuredModel("scout")

    assert.equal(model.reference, "provider/scout-model")
    assert.equal(model.providerID, "provider")

    const bad = join(dir, "bad.json")
    await writeFile(
      bad,
      JSON.stringify(validBridgeConfig({ version: 999 })),
    )
    process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG = bad

    const error = await configuredModel("scout").then(
      () => { throw new Error("should have failed") },
      (caught) => caught,
    )

    assert.match(error.message, /path "version"/)
    assert.match(error.message, new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  })

  if (previous === undefined) {
    delete process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG
  } else {
    process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG = previous
  }
})

test("bridge rejects control characters, edge whitespace, and excessive model length", () => {
  const secret = "SECRET-EDGE-abc123"

  for (
    const bad
    of [
      `provider/${secret} with-space`,
      ` provider/model`,
      "provider/model ",
      "provider/mod\tel",
      "provider/mod\nel",
      "provider/mod\rel",
      "pro\x00vider/model",
      "provider/mod\x7fel",
      `${"a".repeat(200)}/${"b".repeat(200)}`,
    ]
  ) {
    const error = captureThrownError(
      () => validateModelReference(bad, "scout"),
      /invalid model reference for role "scout" at path "models\.scout"/,
    )

    assert.doesNotMatch(error.message, /SECRET-EDGE/)
    assert.doesNotMatch(error.message, /abc123/)
  }

  assert.throws(
    () => validateModelReference("", "worker"),
    /path "models\.worker"/,
  )
})

test("configuredModel rejects malformed JSON with path context and no contents", async () => {
  const previous = process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG

  await withTempDir("bridge-malformed-", async (dir) => {
    const path = join(dir, "config.json")
    const secret = "MALFORMED-SECRET-abc123"

    await writeFile(path, `{ "models": { "scout": "${secret}" `)

    process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG = path

    const error = await configuredModel("scout").then(
      () => { throw new Error("should have failed") },
      (caught) => caught,
    )

    assert.match(error.message, /failed to parse configuration/)
    assert.match(error.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.doesNotMatch(error.message, /MALFORMED-SECRET/)
    assert.doesNotMatch(error.message, /abc123/)
  })

  if (previous === undefined) {
    delete process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG
  } else {
    process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG = previous
  }
})

test("server version comes from the authoritative build version, never a hardcoded literal", async () => {
  const { readFileSync } = await import("node:fs")
  const { dirname, join: joinPath, resolve: resolvePath } = await import("node:path")
  const { fileURLToPath } = await import("node:url")

  const here = dirname(fileURLToPath(import.meta.url))
  const root = resolvePath(joinPath(here, "..", ".."))
  const pkgVersion = JSON.parse(readFileSync(joinPath(root, "package.json"), "utf8"))?.version

  assert.equal(typeof pkgVersion, "string")
  assert.ok(pkgVersion.length > 0)

  const version = resolveServerVersion()

  assert.equal(typeof version, "string")
  assert.notEqual(version, "0.3.0")
  assert.doesNotMatch(version, /\s/)
  assert.ok(version.length > 0)

  /*
   * Source execution has no installed sibling manifest and no injected
   * define, so it deterministically falls back to the package.json
   * version rather than a hardcoded literal.
   */
  assert.equal(version, pkgVersion)

  /*
   * build-release writes dist/manifest.json from the same package.json
   * version it injects as __ORCHESTRATOR_VERSION__, so the installed
   * bundle reports the manifest version.
   */
  const manifestVersion = JSON.parse(readFileSync(joinPath(root, "dist", "manifest.json"), "utf8"))?.version

  assert.equal(manifestVersion, pkgVersion)

  const bridgeSource = readFileSync(joinPath(root, "bridge", "server.mjs"), "utf8")

  assert.doesNotMatch(bridgeSource, /0\.3\.0/)
  assert.doesNotMatch(bridgeSource, /\.\.\/dist\/manifest\.json/)

  const server = createServer()

  assert.ok(server)
  await server.close()
})

test("bridge config rejects unknown top-level keys", () => {
  validateBridgeConfig(
    validBridgeConfig({
      stepLimits: { profile: "standard" },
      integrations: ["codex"],
    }),
    { configPath: "/tmp/config.json" },
  )

  const error = captureThrownError(
    () => validateBridgeConfig(
      validBridgeConfig({ extra: true }),
      { configPath: "/tmp/config.json" },
    ),
    /unknown key.*path "extra"/,
  )

  assert.match(error.message, /\/tmp\/config\.json/)
})

test("bridge config rejects duplicate integrations", () => {
  const error = captureThrownError(
    () => validateBridgeConfig(
      validBridgeConfig({ integrations: ["codex", "codex"] }),
      { configPath: "/tmp/config.json" },
    ),
    /duplicate integration.*path "integrations\[1\]"/,
  )

  assert.match(error.message, /\/tmp\/config\.json/)
})

test("validateBridgeConfig preserves normalized stepLimits", () => {
  const result = validateBridgeConfig(
    validBridgeConfig({ stepLimits: { profile: "standard" } }),
    { configPath: "/tmp/config.json" },
  )

  assert.deepEqual(result.stepLimits, {
    profile: "standard",
    limits: { scout: 16, worker: 32, runner: 40 },
  })

  const custom = validateBridgeConfig(
    validBridgeConfig({ stepLimits: { profile: "custom", scout: 4, worker: 8, runner: 16 } }),
    { configPath: "/tmp/config.json" },
  )

  assert.deepEqual(custom.stepLimits, {
    profile: "custom",
    limits: { scout: 4, worker: 8, runner: 16 },
  })
})

test("configuredModel rejects an unsupported role before indexing models", async () => {
  const previous = process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG

  await withTempDir("bridge-config-role-", async (dir) => {
    const good = join(dir, "good.json")
    await writeFile(good, JSON.stringify(validBridgeConfig()))
    process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG = good

    await assert.rejects(
      () => configuredModel("planner"),
      /unsupported.*role.*planner/,
    )
  })

  if (previous === undefined) {
    delete process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG
  } else {
    process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG = previous
  }
})

test("configured role timeout follows explicit and step-profile defaults", async () => {
  const previous = process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG

  await withTempDir("bridge-timeout-config-", async (dir) => {
    const path = join(dir, "config.json")
    process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG = path

    await writeFile(
      path,
      JSON.stringify(validBridgeConfig({
        stepLimits: { profile: "extended" },
      })),
    )

    assert.equal(await configuredRoleTimeoutSeconds("worker"), 1500)

    await writeFile(
      path,
      JSON.stringify(validBridgeConfig({
        timeoutLimits: {
          profile: "custom",
          scout: 400,
          worker: 800,
          runner: 1000,
          parent: 1100,
        },
      })),
    )

    assert.equal(await configuredRoleTimeoutSeconds("worker"), 800)
  })

  if (previous === undefined) {
    delete process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG
  } else {
    process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG = previous
  }
})

test("worker and writable runner conflict on the same worktree", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-writer-mix-", async (dir) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { calls, client } = makeFakeClient({ wait: () => gate })
    const base = { client, model: stubModel, timeoutMs: 10000 }

    const workerFirst = runAgent(
      dir,
      "worker task",
      "opencode-orchestrator-worker",
      "worker",
      base,
    )

    await waitFor(() => callNames(calls, "wait").length >= 1)

    const createdBefore = callNames(calls, "create").length

    await assert.rejects(
      () => runAgent(
        dir,
        "writable task",
        "opencode-orchestrator-runner-writable",
        "runner",
        { ...base, workspaceAccess: "writable" },
      ),
      /already running/,
    )

    assert.equal(callNames(calls, "create").length, createdBefore)

    release()
    assert.equal(await workerFirst, "hello")

    assert.equal(
      await runAgent(
        dir,
        "writable task",
        "opencode-orchestrator-runner-writable",
        "runner",
        { ...base, workspaceAccess: "writable" },
      ),
      "hello",
    )
  })

  await withTempDir("bridge-writer-mix-rev-", async (dir) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { calls, client } = makeFakeClient({ wait: () => gate })
    const base = { client, model: stubModel, timeoutMs: 10000 }

    const writableFirst = runAgent(
      dir,
      "writable task",
      "opencode-orchestrator-runner-writable",
      "runner",
      { ...base, workspaceAccess: "writable" },
    )

    await waitFor(() => callNames(calls, "wait").length >= 1)

    await assert.rejects(
      () => runAgent(
        dir,
        "worker task",
        "opencode-orchestrator-worker",
        "worker",
        base,
      ),
      /already running/,
    )

    release()
    assert.equal(await writableFirst, "hello")

    assert.equal(
      await runAgent(
        dir,
        "worker task",
        "opencode-orchestrator-worker",
        "worker",
        base,
      ),
      "hello",
    )
  })

  resetBridgeStateForTests()
})

test("writable runners collide per worktree and release on success, error, and timeout", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-writable-", async (dir) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { calls, client } = makeFakeClient({ wait: () => gate })
    const base = { client, model: stubModel, timeoutMs: 10000 }
    const writable = (overrides = {}) => runAgent(
      dir,
      "writable task",
      "opencode-orchestrator-runner-writable",
      "runner",
      { ...base, workspaceAccess: "writable", ...overrides },
    )

    const first = writable()

    await waitFor(() => callNames(calls, "wait").length >= 1)

    const createdBefore = callNames(calls, "create").length

    await assert.rejects(() => writable(), /already running/)
    assert.equal(callNames(calls, "create").length, createdBefore)

    release()
    assert.equal(await first, "hello")
    assert.equal(await writable(), "hello")
  })

  await withTempDir("bridge-writable-err-", async (dir) => {
    const failing = makeFakeClient({
      prompt: async () => { throw new Error("writable exploded") },
    })
    const fresh = makeFakeClient()

    await assert.rejects(
      () => runAgent(
        dir,
        "writable task",
        "opencode-orchestrator-runner-writable",
        "runner",
        { client: failing.client, model: stubModel, timeoutMs: 5000, workspaceAccess: "writable" },
      ),
      /writable exploded/,
    )

    assert.equal(
      await runAgent(
        dir,
        "writable task",
        "opencode-orchestrator-runner-writable",
        "runner",
        { client: fresh.client, model: stubModel, timeoutMs: 5000, workspaceAccess: "writable" },
      ),
      "hello",
    )
  })

  await withTempDir("bridge-writable-timeout-", async (dir) => {
    const hanging = makeFakeClient({
      wait: () => new Promise(() => {}),
    })
    const fresh = makeFakeClient()

    await assert.rejects(
      () => runAgent(
        dir,
        "writable task",
        "opencode-orchestrator-runner-writable",
        "runner",
        { client: hanging.client, model: stubModel, timeoutMs: 50, workspaceAccess: "writable" },
      ),
      /timed out/,
    )

    assert.equal(
      await runAgent(
        dir,
        "writable task",
        "opencode-orchestrator-runner-writable",
        "runner",
        { client: fresh.client, model: stubModel, timeoutMs: 5000, workspaceAccess: "writable" },
      ),
      "hello",
    )
  })

  await withTempDir("bridge-writable-a-", async (dirA) => {
    await withTempDir("bridge-writable-b-", async (dirB) => {
      let release
      const gate = new Promise((resolve) => { release = resolve })
      const { calls, client } = makeFakeClient({ wait: () => gate })
      const base = { client, model: stubModel, timeoutMs: 10000 }

      const first = runAgent(
        dirA,
        "task a",
        "opencode-orchestrator-runner-writable",
        "runner",
        { ...base, workspaceAccess: "writable" },
      )
      const second = runAgent(
        dirB,
        "task b",
        "opencode-orchestrator-runner-writable",
        "runner",
        { ...base, workspaceAccess: "writable" },
      )

      await waitFor(() => callNames(calls, "wait").length >= 2)

      release()

      assert.deepEqual(await Promise.all([first, second]), ["hello", "hello"])
    })
  })

  await withTempDir("bridge-writable-mix-trees-", async (dirA) => {
    await withTempDir("bridge-writable-mix-trees-b-", async (dirB) => {
      let release
      const gate = new Promise((resolve) => { release = resolve })
      const { calls, client } = makeFakeClient({ wait: () => gate })
      const base = { client, model: stubModel, timeoutMs: 10000 }

      const workerFirst = runAgent(
        dirA,
        "worker task",
        "opencode-orchestrator-worker",
        "worker",
        base,
      )
      const writableSecond = runAgent(
        dirB,
        "writable task",
        "opencode-orchestrator-runner-writable",
        "runner",
        { ...base, workspaceAccess: "writable" },
      )

      await waitFor(() => callNames(calls, "wait").length >= 2)

      release()

      assert.deepEqual(
        await Promise.all([workerFirst, writableSecond]),
        ["hello", "hello"],
      )
    })
  })

  resetBridgeStateForTests()
})

test("read-only runner never takes the writer lock", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-readonly-", async (dir) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { calls, client } = makeFakeClient({ wait: () => gate })
    const base = { client, model: stubModel, timeoutMs: 10000 }

    const workerFirst = runAgent(
      dir,
      "worker task",
      "opencode-orchestrator-worker",
      "worker",
      base,
    )

    await waitFor(() => callNames(calls, "wait").length >= 1)

    const readOnly = runAgent(
      dir,
      "read-only task",
      "opencode-orchestrator-runner",
      "runner",
      { ...base, workspaceAccess: "read_only" },
    )

    await waitFor(() => callNames(calls, "wait").length >= 2)

    release()

    assert.deepEqual(
      await Promise.all([workerFirst, readOnly]),
      ["hello", "hello"],
    )
  })

  resetBridgeStateForTests()
})

test("runner instructions are mode-specific about workspace writes", async () => {
  let captured

  const handlers = createToolHandlers(async (...args) => {
    captured = args
    return "done"
  })

  await handlers.runner(
    { cwd: "/tmp/work", command: "npm test", objective: "check tests" },
    undefined,
  )

  const readOnlyTask = captured[1]

  assert.match(readOnlyTask, /Workspace access mode: read_only\./)
  assert.match(readOnlyTask, /Do not modify workspace files/)
  assert.equal(captured[2], "opencode-orchestrator-runner")
  assert.equal(captured[4].workspaceAccess, "read_only")

  await handlers.runner(
    {
      cwd: "/tmp/work",
      command: "npm test",
      objective: "check tests",
      workspace_access: "writable",
    },
    undefined,
  )

  const writableTask = captured[1]

  assert.match(writableTask, /Workspace access mode: writable\./)
  assert.match(
    writableTask,
    /permitted only when required by the parent-requested command/,
  )
  assert.match(writableTask, /unrelated edits/)
  assert.match(writableTask, /attempt repairs/)
  assert.doesNotMatch(writableTask, /Do not modify workspace files/)
  assert.doesNotMatch(writableTask, /Do not modify source files/)
  assert.equal(captured[2], "opencode-orchestrator-runner-writable")
  assert.equal(captured[4].workspaceAccess, "writable")
})
