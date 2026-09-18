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
  OPENCODE_MCP_ORCHESTRATOR_E2E_SESSION_WAIT_REFRESH_MS,
  resetBridgeStateForTests,
  resolveBridgeTimeoutMs,
  resolveCanonicalCwd,
  resolveRunnerSelection,
  resolveWorkerExecution,
  resolveServerVersion,
  resolveSessionWaitRefreshMs,
  runAgent as runAgentWithConfiguredBudget,
  SERVER_VERSION_FALLBACK,
  SESSION_WAIT_REFRESH_MS,
  waitForSessionCompletion,
} from "../../bridge/server.mjs"
import {
  normalizeSandboxRuntime,
  SUPPORTED_CONFIG_VERSION,
  validateBridgeConfig,
  validateModelReference,
} from "../../bridge/config.mjs"

const stubModel = {
  reference: "provider/model",
  providerID: "provider",
  id: "model",
}

/*
 * Runtime unit tests inject their caller budget so they do not depend on a
 * developer-machine config file. Tests for production config loading call
 * runAgentWithConfiguredBudget directly.
 */
function runAgent(directory, task, agent, role, overrides = {}) {
  return runAgentWithConfiguredBudget(
    directory,
    task,
    agent,
    role,
    {
      parentTimeoutSeconds: 7200,
      ...overrides,
    },
  )
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
    get: async (input, options) => {
      calls.push(["get", input, options])

      if (hooks.get) {
        return hooks.get(input, options)
      }

      return {
        id: input.sessionID,
        time: { created: 1, updated: 1 },
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        cost: 0,
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

  while (!(await condition())) {
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

test("session wait refresh env override resolves with strict bounds", () => {
  assert.equal(
    OPENCODE_MCP_ORCHESTRATOR_E2E_SESSION_WAIT_REFRESH_MS,
    "OPENCODE_MCP_ORCHESTRATOR_E2E_SESSION_WAIT_REFRESH_MS",
  )

  const cases = [
    [undefined, SESSION_WAIT_REFRESH_MS],
    ["50", 50],
    ["1", 1],
    ["240000", 240000],
    ["0", SESSION_WAIT_REFRESH_MS],
    ["-5", SESSION_WAIT_REFRESH_MS],
    ["12.5", SESSION_WAIT_REFRESH_MS],
    ["nope", SESSION_WAIT_REFRESH_MS],
    ["240001", SESSION_WAIT_REFRESH_MS],
  ]

  for (const [raw, expected] of cases) {
    const env = raw === undefined
      ? {}
      : {
          [OPENCODE_MCP_ORCHESTRATOR_E2E_SESSION_WAIT_REFRESH_MS]: raw,
        }

    assert.equal(
      resolveSessionWaitRefreshMs(env),
      expected,
      String(raw),
    )
  }

  assert.equal(resolveSessionWaitRefreshMs({}), SESSION_WAIT_REFRESH_MS)
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

test("session wait refreshes before the transport boundary without cancelling the session", async () => {
  const calls = []
  const getCalls = []
  const logs = []
  let waitAttempt = 0
  let getAttempt = 0

  const firstSnapshot = {
    id: "ses_refresh",
    time: { created: 1, updated: 100, idle: 50 },
    tokens: {
      input: 10,
      output: 5,
      reasoning: 1,
      cache: { read: 2, write: 3 },
    },
    cost: 0.01,
  }

  const secondSnapshot = {
    id: "ses_refresh",
    time: { created: 1, updated: 200, idle: 60 },
    tokens: {
      input: 20,
      output: 5,
      reasoning: 1,
      cache: { read: 2, write: 3 },
    },
    cost: 0.02,
  }

  const client = {
    session: {
      wait: async (input, options) => {
        calls.push([input, options])
        waitAttempt += 1

        if (waitAttempt > 3) {
          return
        }

        await new Promise((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("Transport", {
              cause: Object.assign(
                new Error("bounded request aborted"),
                { code: "ABORT_ERR" },
              ),
            })),
            { once: true },
          )
        })
      },
      get: async (input, options) => {
        getCalls.push([input, options])
        getAttempt += 1

        if (getAttempt === 2) {
          return { data: secondSnapshot }
        }

        if (getAttempt >= 3) {
          return secondSnapshot
        }

        return firstSnapshot
      },
    },
  }

  const operationController = new AbortController()

  await waitForSessionCompletion(
    client,
    "ses_refresh",
    operationController.signal,
    {
      refreshMs: 20,
      operationStartedAt: Date.now(),
      operationDeadlineAt: Date.now() + 5000,
      log: (message) => logs.push(JSON.parse(message)),
    },
  )

  assert.equal(calls.length, 4)
  assert.deepEqual(
    calls.map(([input]) => input.sessionID),
    ["ses_refresh", "ses_refresh", "ses_refresh", "ses_refresh"],
  )
  assert.equal(calls[0][1].signal.aborted, true)
  assert.equal(calls[1][1].signal.aborted, true)
  assert.equal(calls[2][1].signal.aborted, true)
  assert.equal(calls[3][1].signal.aborted, false)
  assert.equal(operationController.signal.aborted, false)
  assert.equal(SESSION_WAIT_REFRESH_MS, 240000)

  assert.equal(getCalls.length, 3)
  assert.deepEqual(
    getCalls.map(([input]) => input.sessionID),
    ["ses_refresh", "ses_refresh", "ses_refresh"],
  )

  for (const [, options] of getCalls) {
    assert.equal(options.signal.aborted, false)
  }

  assert.deepEqual(
    logs.map(({ event }) => event),
    [
      "session_wait_refresh",
      "session_progress",
      "session_wait_refresh",
      "session_progress",
      "session_wait_refresh",
      "session_progress",
    ],
  )
  assert.deepEqual(
    logs
      .filter(({ event }) => event === "session_wait_refresh")
      .map(({ session_id, wait_attempt, reason }) => ({
        session_id,
        wait_attempt,
        reason,
      })),
    [1, 2, 3].map((waitAttempt) => ({
      session_id: "ses_refresh",
      wait_attempt: waitAttempt,
      reason: "bounded_wait_refresh_elapsed",
    })),
  )

  const progressLogs = logs.filter(
    ({ event }) => event === "session_progress",
  )

  assert.deepEqual(
    progressLogs.map(({ session_id, wait_attempt }) => ({
      session_id,
      wait_attempt,
    })),
    [1, 2, 3].map((waitAttempt) => ({
      session_id: "ses_refresh",
      wait_attempt: waitAttempt,
    })),
  )
  assert.deepEqual(
    progressLogs.map(({ changed }) => changed),
    [null, true, false],
  )
  assert.equal(progressLogs[0].updated_at, 100)
  assert.equal(progressLogs[0].idle_at, 50)
  assert.equal(progressLogs[0].tokens_input, 10)
  assert.equal(progressLogs[0].tokens_output, 5)
  assert.equal(progressLogs[0].cost, 0.01)
  assert.equal(progressLogs[1].updated_at, 200)
  assert.equal(progressLogs[1].tokens_input, 20)
  assert.equal(progressLogs[2].updated_at, 200)

  for (const entry of progressLogs) {
    assert.ok(entry.elapsed_operation_ms >= 0)
    assert.ok(entry.remaining_operation_ms > 0)
    assert.ok(!("title" in entry))
    assert.ok(!("prompt" in entry))
    assert.ok(!("message" in entry))
    assert.ok(!("messages" in entry))
  }

  assert.equal(logs[0].error_name, "Error")
  assert.deepEqual(logs[0].error_cause_chain, [
    { name: "Error", code: "ABORT_ERR" },
  ])
  assert.ok(logs[0].elapsed_operation_ms >= 0)
  assert.ok(logs[0].remaining_operation_ms > 0)
})

test("a failed progress read does not prevent the next wait", async () => {
  const logs = []
  let waitAttempt = 0
  let getAttempt = 0

  const client = {
    session: {
      wait: async (input, options) => {
        waitAttempt += 1

        if (waitAttempt > 2) {
          return
        }

        await new Promise((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("Transport")),
            { once: true },
          )
        })
      },
      get: async (input, options) => {
        getAttempt += 1
        assert.equal(input.sessionID, "ses_progress_retry")
        assert.equal(options.signal.aborted, false)

        if (getAttempt === 1) {
          throw Object.assign(
            new Error("progress exploded"),
            { code: "GET_FAIL" },
          )
        }

        return {
          id: "ses_progress_retry",
          time: { created: 1, updated: 7 },
          tokens: {
            input: 3,
            output: 4,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          cost: 0.005,
        }
      },
    },
  }

  await waitForSessionCompletion(
    client,
    "ses_progress_retry",
    new AbortController().signal,
    {
      refreshMs: 20,
      operationStartedAt: Date.now(),
      operationDeadlineAt: Date.now() + 5000,
      log: (message) => logs.push(JSON.parse(message)),
    },
  )

  assert.equal(waitAttempt, 3)
  assert.equal(getAttempt, 2)
  assert.deepEqual(
    logs.map(({ event }) => event),
    [
      "session_wait_refresh",
      "session_progress_unavailable",
      "session_wait_refresh",
      "session_progress",
    ],
  )

  const unavailable = logs.find(
    ({ event }) => event === "session_progress_unavailable",
  )

  assert.equal(unavailable.session_id, "ses_progress_retry")
  assert.equal(unavailable.wait_attempt, 1)
  assert.equal(unavailable.reason, "session_get_failed")
  assert.equal(unavailable.error_name, "Error")
  assert.equal(unavailable.error_code, "GET_FAIL")
  assert.ok(unavailable.elapsed_operation_ms >= 0)
  assert.ok(unavailable.remaining_operation_ms > 0)

  const progress = logs.find(
    ({ event }) => event === "session_progress",
  )

  assert.equal(progress.session_id, "ses_progress_retry")
  assert.equal(progress.wait_attempt, 2)
  assert.equal(progress.changed, null)
  assert.equal(progress.updated_at, 7)
  assert.equal(progress.tokens_input, 3)
})

test("a hanging progress read cannot extend the absolute operation deadline", async () => {
  const logs = []
  let progressSignal
  const startedAt = Date.now()

  const client = {
    session: {
      wait: async (input, options) => {
        await new Promise((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("Transport")),
            { once: true },
          )
        })
      },
      get: async (input, options) => {
        progressSignal = options.signal
        await new Promise(() => {})
      },
    },
  }

  await assert.rejects(
    () => waitForSessionCompletion(
      client,
      "ses_progress_deadline",
      new AbortController().signal,
      {
        refreshMs: 20,
        operationStartedAt: startedAt,
        operationDeadlineAt: startedAt + 100,
        log: (message) => logs.push(JSON.parse(message)),
      },
    ),
    /exceeded its overall operation deadline/,
  )

  assert.ok(Date.now() - startedAt < 1000)
  assert.equal(progressSignal.aborted, true)
  assert.deepEqual(
    logs.map(({ event }) => event),
    ["session_wait_refresh", "session_progress_unavailable"],
  )
  assert.equal(logs[1].reason, "progress_read_timeout")
})

test("runAgent reissues multiple bounded waits without recreating or reprompting the session", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-wait-refresh-", async (dir) => {
    let attempts = 0
    let getAttempts = 0
    const { calls, client } = makeFakeClient({
      wait: async (_input, options) => {
        attempts += 1

        if (attempts > 3) {
          return
        }

        await new Promise((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("Transport")),
            { once: true },
          )
        })
      },
      get: async (input, options) => {
        getAttempts += 1
        assert.equal(input.sessionID, "ses_test")
        assert.equal(options.signal.aborted, false)

        return {
          id: "ses_test",
          time: { created: 1, updated: 100 + getAttempts },
          tokens: {
            input: getAttempts,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          cost: 0.001 * getAttempts,
        }
      },
    })

    const result = await runAgent(
      dir,
      "task",
      "opencode-orchestrator-scout",
      "scout",
      {
        client,
        model: stubModel,
        timeoutMs: 5000,
        sessionWaitRefreshMs: 20,
      },
    )

    assert.equal(result, "hello")
    assert.equal(callNames(calls, "create").length, 1)
    assert.equal(callNames(calls, "prompt").length, 1)
    assert.equal(callNames(calls, "wait").length, 4)
    assert.deepEqual(
      callNames(calls, "wait").map((call) => call[1].sessionID),
      ["ses_test", "ses_test", "ses_test", "ses_test"],
    )
    assert.equal(callNames(calls, "get").length, 3)
    assert.deepEqual(
      callNames(calls, "get").map((call) => call[1].sessionID),
      ["ses_test", "ses_test", "ses_test"],
    )
    assert.equal(getAttempts, 3)
    assert.equal(callNames(calls, "context").length, 1)
    assert.equal(callNames(calls, "interrupt").length, 0)
    assert.equal(callNames(calls, "remove").length, 1)
  })

  resetBridgeStateForTests()
})

test("session wait does not retry a real transport failure", async () => {
  let attempts = 0
  let getAttempts = 0
  const logs = []
  const expected = new Error("real transport failure", {
    cause: Object.assign(
      new Error("headers timed out"),
      { code: "UND_ERR_HEADERS_TIMEOUT" },
    ),
  })
  const client = {
    session: {
      wait: async () => {
        attempts += 1
        throw expected
      },
      get: async () => {
        getAttempts += 1
        return {}
      },
    },
  }

  await assert.rejects(
    () => waitForSessionCompletion(
      client,
      "ses_failure",
      new AbortController().signal,
      {
        refreshMs: 20,
        operationDeadlineAt: Date.now() + 5000,
        log: (message) => logs.push(JSON.parse(message)),
      },
    ),
    (error) => error === expected,
  )

  assert.equal(attempts, 1)
  assert.equal(getAttempts, 0)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].event, "session_wait_failure")
  assert.equal(logs[0].reason, "wait_rejected_before_refresh_boundary")
  assert.deepEqual(logs[0].error_cause_chain, [
    { name: "Error", code: "UND_ERR_HEADERS_TIMEOUT" },
  ])
})

test("wait refreshes do not extend runAgent's absolute operation deadline", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-wait-deadline-", async (dir) => {
    const { calls, client } = makeFakeClient({
      wait: async (_input, options) => {
        await new Promise((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("Transport")),
            { once: true },
          )
        })
      },
    })
    const startedAt = Date.now()

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-scout",
        "scout",
        {
          client,
          model: stubModel,
          timeoutMs: 90,
          sessionWaitRefreshMs: 20,
        },
      ),
      /timed out after 90ms/,
    )

    assert.ok(Date.now() - startedAt < 1000)
    assert.equal(callNames(calls, "create").length, 1)
    assert.equal(callNames(calls, "prompt").length, 1)
    assert.ok(callNames(calls, "wait").length >= 3)
    assert.ok(
      callNames(calls, "wait")
        .every((call) => call[1].sessionID === "ses_test"),
    )
  })

  resetBridgeStateForTests()
})

test("session wait refresh validates its internal interval", async () => {
  const client = { session: { wait: async () => {} } }

  await assert.rejects(
    () => waitForSessionCompletion(
      client,
      "ses_invalid",
      new AbortController().signal,
      { refreshMs: 0 },
    ),
    /positive integer/,
  )
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

    assert.equal(callNames(calls, "wait").length, 1)
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

test("a timed-out worker with unconfirmed removal quarantines its worktree", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-writer-timeout-", async (dir) => {
    const hanging = makeFakeClient({
      wait: () => new Promise(() => {}),
      remove: () => new Promise(() => {}),
    })

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        { client: hanging.client, model: stubModel, timeoutMs: 50, cleanupTimeoutMs: 20 },
      ),
      /timed out/,
    )

    const fresh = makeFakeClient()

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        { client: fresh.client, model: stubModel, timeoutMs: 5000 },
      ),
      /quarantined/,
    )

    assert.equal(callNames(fresh.calls, "create").length, 0)
  })

  resetBridgeStateForTests()
})

test("configured caller-budget preflight rejects before any session or client work", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-preflight-", async (dir) => {
    const secretTask = "preflight secret task abc123"
    const { calls, client } = makeFakeClient()
    let ensured = 0

    await assert.rejects(
      () => runAgent(
        dir,
        secretTask,
        "opencode-orchestrator-worker",
        "worker",
        {
          client,
          model: stubModel,
          timeoutMs: 200_000,
          parentTimeoutSeconds: 100,
        },
      ),
      /does not fit/,
    )

    assert.equal(callNames(calls, "create").length, 0)
    assert.equal(calls.length, 0)

    const error = await runAgent(
      dir,
      secretTask,
      "opencode-orchestrator-worker",
      "worker",
      {
        client,
        model: stubModel,
        timeoutMs: 200_000,
        parentTimeoutSeconds: 100,
      },
    ).then(
      () => { throw new Error("should have failed preflight") },
      (caught) => caught,
    )

    assert.match(error.message, /worker/)
    assert.match(error.message, /configured parent/)
    assert.match(error.message, /cleanup and result reserve/)
    assert.doesNotMatch(error.message, /preflight secret/)
    assert.doesNotMatch(error.message, /abc123/)

    // Sanity: a fitting budget with a real fake client still succeeds.
    const fitting = makeFakeClient()
    assert.equal(
      await runAgent(
        dir,
        "task",
        "opencode-orchestrator-scout",
        "scout",
        { client: fitting.client, model: stubModel, timeoutMs: 5_000, parentTimeoutSeconds: 1_500 },
      ),
      "hello",
    )

    // Oversized bridge env override fails before session creation.
    const envClient = makeFakeClient()

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        {
          client: envClient.client,
          model: stubModel,
          parentTimeoutSeconds: 60,
          env: { [BRIDGE_TIMEOUT_ENV_VAR]: "3600000" },
        },
      ),
      /does not fit/,
    )

    assert.equal(callNames(envClient.calls, "create").length, 0)

    // Preflight happens before client initialization when no client is injected.
    let ensureCalls = 0
    const ensureService = async () => {
      ensureCalls += 1
      return { url: "http://127.0.0.1:9", auth: undefined }
    }
    const makeClient = () => { throw new Error("makeClient must not run after preflight") }

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        {
          model: stubModel,
          timeoutMs: 200_000,
          parentTimeoutSeconds: 100,
          ensureService,
          makeClient,
        },
      ),
      /does not fit/,
    )

    assert.equal(ensureCalls, 0)
    assert.equal(ensured, 0)
  })

  resetBridgeStateForTests()
})

test("configured caller-budget preflight preserves fail-closed config loading", async () => {
  resetBridgeStateForTests()

  const previous = process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG

  try {
    await withTempDir("bridge-preflight-config-", async (dir) => {
      const configFile = join(dir, "config.json")

      await writeFile(
        configFile,
        JSON.stringify({
          version: 1,
          models: {
            scout: "provider/model",
            worker: "provider/model",
            runner: "provider/model",
          },
          timeoutLimits: {
            profile: "custom",
            scout: 300,
            worker: 600,
            runner: 1200,
            parent: 1200,
          },
        }),
      )

      process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG = configFile

      const { calls, client } = makeFakeClient()

      await assert.rejects(
        () => runAgentWithConfiguredBudget(
          dir,
          "task",
          "opencode-orchestrator-worker",
          "worker",
          { client, model: stubModel, timeoutMs: 5_000 },
        ),
        /invalid timeoutLimits/,
      )

      assert.equal(calls.length, 0)
    })
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG
    } else {
      process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG = previous
    }

    resetBridgeStateForTests()
  }
})

test("writer quarantine frees only after confirmed removal", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-quarantine-free-", async (dir) => {
    const first = makeFakeClient()

    assert.equal(
      await runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        { client: first.client, model: stubModel, timeoutMs: 5000 },
      ),
      "hello",
    )

    assert.equal(callNames(first.calls, "remove").length, 1)

    const second = makeFakeClient()

    assert.equal(
      await runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        { client: second.client, model: stubModel, timeoutMs: 5000 },
      ),
      "hello",
    )
  })

  resetBridgeStateForTests()
})

test("writer cleanup state blocks a second writable operation", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-writer-cleaning-", async (dir) => {
    let releaseRemove
    const removeGate = new Promise((resolve) => { releaseRemove = resolve })
    const cleaning = makeFakeClient({
      remove: () => removeGate,
    })

    const first = runAgent(
      dir,
      "first task",
      "opencode-orchestrator-worker",
      "worker",
      { client: cleaning.client, model: stubModel, timeoutMs: 5000 },
    )

    await waitFor(() => callNames(cleaning.calls, "remove").length === 1)

    const blocked = makeFakeClient()

    await assert.rejects(
      () => runAgent(
        dir,
        "second task",
        "opencode-orchestrator-runner-writable",
        "runner",
        {
          client: blocked.client,
          model: stubModel,
          timeoutMs: 5000,
          workspaceAccess: "writable",
        },
      ),
      /cleanup is still in progress/,
    )

    assert.equal(blocked.calls.length, 0)

    releaseRemove()
    assert.equal(await first, "hello")

    const recovered = makeFakeClient()
    assert.equal(
      await runAgent(
        dir,
        "third task",
        "opencode-orchestrator-worker",
        "worker",
        { client: recovered.client, model: stubModel, timeoutMs: 5000 },
      ),
      "hello",
    )
  })

  resetBridgeStateForTests()
})

test("writer remove rejection quarantines the worktree fail-closed", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-quarantine-reject-", async (dir) => {
    const failing = makeFakeClient({
      remove: async () => { throw new Error("remove exploded") },
    })

    // The model work succeeds, but unconfirmed removal makes the overall
    // writable operation fail closed and report quarantine immediately.
    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        { client: failing.client, model: stubModel, timeoutMs: 5000 },
      ),
      /quarantined/,
    )

    assert.equal(callNames(failing.calls, "remove").length, 1)
    const fresh = makeFakeClient()

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        { client: fresh.client, model: stubModel, timeoutMs: 5000 },
      ),
      /quarantined/,
    )

    assert.equal(callNames(fresh.calls, "create").length, 0)

    const quarantineError = await runAgent(
      dir,
      "task",
      "opencode-orchestrator-worker",
      "worker",
      { client: fresh.client, model: stubModel, timeoutMs: 5000 },
    ).then(
      () => { throw new Error("should have been quarantined") },
      (caught) => caught,
    )

    assert.match(quarantineError.message, /quarantined/)
    assert.match(quarantineError.message, /restart/)
  })

  resetBridgeStateForTests()
})

test("writer hanging removal quarantines without waiting the full cleanup deadline", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-quarantine-hang-", async (dir) => {
    const hanging = makeFakeClient({
      remove: () => new Promise(() => {}),
    })

    const start = Date.now()

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        { client: hanging.client, model: stubModel, timeoutMs: 5000, cleanupTimeoutMs: 20 },
      ),
      /quarantined/,
    )

    const elapsed = Date.now() - start
    assert.ok(elapsed < 5000, `cleanup bound was not respected: ${elapsed}ms`)
    assert.equal(callNames(hanging.calls, "remove").length, 1)

    const fresh = makeFakeClient()

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        { client: fresh.client, model: stubModel, timeoutMs: 5000 },
      ),
      /quarantined/,
    )

    assert.equal(callNames(fresh.calls, "create").length, 0)
  })

  resetBridgeStateForTests()
})

test("late session creation with confirmed removal eventually frees quarantine", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-quarantine-late-", async (dir) => {
    let releaseCreate
    const createGate = new Promise((resolve) => { releaseCreate = resolve })
    const { calls, client } = makeFakeClient({
      create: async () => {
        await createGate
        return { id: "ses_late_writer" }
      },
    })

    await assert.rejects(
      () => runAgent(
        dir,
        "late writer task",
        "opencode-orchestrator-worker",
        "worker",
        { client, model: stubModel, timeoutMs: 50 },
      ),
      /timed out/,
    )

    const blocked = makeFakeClient()

    await assert.rejects(
      () => runAgent(
        dir,
        "second task",
        "opencode-orchestrator-worker",
        "worker",
        { client: blocked.client, model: stubModel, timeoutMs: 5000 },
      ),
      /already running|quarantined/,
    )

    assert.equal(callNames(blocked.calls, "create").length, 0)

    releaseCreate()

    await waitFor(() => callNames(calls, "remove").length >= 1)

    const fresh = makeFakeClient()

    await waitFor(async () => {
      try {
        assert.equal(
          await runAgent(
            dir,
            "recovered task",
            "opencode-orchestrator-worker",
            "worker",
            { client: fresh.client, model: stubModel, timeoutMs: 5000 },
          ),
          "hello",
        )
        return true
      } catch {
        return false
      }
    })
  })

  resetBridgeStateForTests()
})

test("worker and writable runner share quarantine while read-only paths stay free", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-quarantine-roles-", async (dir) => {
    const failing = makeFakeClient({
      remove: async () => { throw new Error("remove failed") },
    })

    try {
      await runAgent(
        dir,
        "worker task",
        "opencode-orchestrator-worker",
        "worker",
        { client: failing.client, model: stubModel, timeoutMs: 5000 },
      )
    } catch {
      // Success with unconfirmed removal still quarantines; ignore outcome.
    }

    const writableBlocked = makeFakeClient()

    await assert.rejects(
      () => runAgent(
        dir,
        "writable task",
        "opencode-orchestrator-runner-writable",
        "runner",
        { client: writableBlocked.client, model: stubModel, timeoutMs: 5000, workspaceAccess: "writable" },
      ),
      /quarantined/,
    )

    assert.equal(callNames(writableBlocked.calls, "create").length, 0)

    const workerBlocked = makeFakeClient()

    await assert.rejects(
      () => runAgent(
        dir,
        "worker task",
        "opencode-orchestrator-worker",
        "worker",
        { client: workerBlocked.client, model: stubModel, timeoutMs: 5000 },
      ),
      /quarantined/,
    )

    // Scout and read-only runner never consult writer quarantine.
    const scoutClient = makeFakeClient()

    assert.equal(
      await runAgent(
        dir,
        "scout task",
        "opencode-orchestrator-scout",
        "scout",
        { client: scoutClient.client, model: stubModel, timeoutMs: 5000 },
      ),
      "hello",
    )

    const readOnlyClient = makeFakeClient()

    assert.equal(
      await runAgent(
        dir,
        "read-only task",
        "opencode-orchestrator-runner",
        "runner",
        { client: readOnlyClient.client, model: stubModel, timeoutMs: 5000, workspaceAccess: "read_only" },
      ),
      "hello",
    )
  })

  resetBridgeStateForTests()
})

test("worker execution defaults to sandbox and validates existing-container grants", () => {
  assert.deepEqual(
    resolveWorkerExecution(undefined),
    {
      kind: "sandbox",
      agent: "opencode-orchestrator-worker",
    },
  )

  assert.deepEqual(
    resolveWorkerExecution({
      kind: "existing_container",
      container: "dev-box",
    }),
    {
      kind: "existing_container",
      container: "dev-box",
      workspaceAccess: "writable",
      containerCwd: "auto",
      networkAccess: "inherit",
      agent: "opencode-orchestrator-worker-container",
    },
  )

  assert.equal(
    resolveWorkerExecution({
      kind: "existing_container",
      container: "dev-box",
      workspace_access: "read_only",
      container_cwd: "/workspace",
      network_access: "inherit",
    }).agent,
    "opencode-orchestrator-worker-container-readonly",
  )

  assert.throws(
    () => resolveWorkerExecution({
      kind: "existing_container",
      container: "",
    }),
    /invalid worker existing_container container/,
  )
  assert.throws(
    () => resolveWorkerExecution({
      kind: "existing_container",
      container: "dev-box",
      network_access: "host",
    }),
    /only "inherit"/,
  )
})

test("worker handler binds existing-container execution without exposing container in task", async () => {
  let captured
  const handlers = createToolHandlers(async (...args) => {
    captured = args
    return "done"
  })

  const result = await handlers.worker({
    cwd: "/tmp/work",
    task: "implement it",
    execution: {
      kind: "existing_container",
      container: "dev-box",
    },
  })

  assert.deepEqual(result, {
    content: [{ type: "text", text: "done" }],
  })
  assert.equal(captured[2], "opencode-orchestrator-worker-container")
  assert.equal(captured[3], "worker")
  assert.equal(captured[4].workerExecution.container, "dev-box")
  assert.equal(captured[4].workerExecution.workspaceAccess, "writable")
  assert.match(captured[1], /container_run/)
  assert.match(captured[1], /Network access: inherit|network access: inherit/i)
  assert.doesNotMatch(captured[1], /dev-box/)
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

test("bridge config accepts a valid multi-root sandboxRuntime and defaults environment", () => {
  const config = validBridgeConfig({
    sandboxRuntime: {
      trustedRoots: [
        {
          root: "/srv/sandbox-alpha",
          pathEntries: [".", "bin"],
          environment: {
            ALPHA_TOOLS: "bin",
          },
        },
        {
          root: "/opt/sandbox-beta",
          pathEntries: ["tools/bin"],
        },
      ],
    },
  })

  const result = validateBridgeConfig(
    config,
    { configPath: "/tmp/config.json" },
  )

  assert.deepEqual(result.sandboxRuntime, {
    trustedRoots: [
      {
        root: "/srv/sandbox-alpha",
        pathEntries: [".", "bin"],
        environment: {
          ALPHA_TOOLS: "bin",
        },
      },
      {
        root: "/opt/sandbox-beta",
        pathEntries: ["tools/bin"],
        environment: {},
      },
    ],
  })

  const direct = normalizeSandboxRuntime(config.sandboxRuntime)

  assert.deepEqual(direct, result.sandboxRuntime)
})

test("bridge config without sandboxRuntime remains accepted unchanged", () => {
  const config = validBridgeConfig()

  assert.equal(
    validateBridgeConfig(config, { configPath: "/tmp/config.json" }),
    config,
  )
  assert.ok(!("sandboxRuntime" in config))
})

test("bridge config accepts an empty sandboxRuntime trustedRoots list", () => {
  const result = validateBridgeConfig(
    validBridgeConfig({ sandboxRuntime: { trustedRoots: [] } }),
    { configPath: "/tmp/config.json" },
  )

  assert.deepEqual(result.sandboxRuntime, { trustedRoots: [] })
})

test("bridge config rejects unknown keys in sandboxRuntime", () => {
  const topLevel = captureThrownError(
    () => validateBridgeConfig(
      validBridgeConfig({
        sandboxRuntime: {
          trustedRoots: [],
          extra: true,
        },
      }),
      { configPath: "/tmp/config.json" },
    ),
    /unknown key.*path "sandboxRuntime\.extra"/,
  )

  assert.match(topLevel.message, /\/tmp\/config\.json/)

  const entry = captureThrownError(
    () => validateBridgeConfig(
      validBridgeConfig({
        sandboxRuntime: {
          trustedRoots: [
            {
              root: "/srv/sandbox-alpha",
              pathEntries: ["bin"],
              extra: true,
            },
          ],
        },
      }),
      { configPath: "/tmp/config.json" },
    ),
    /unknown key.*path "sandboxRuntime\.trustedRoots\[0\]\.extra"/,
  )

  assert.match(entry.message, /\/tmp\/config\.json/)
  assert.doesNotMatch(entry.message, /\/srv\/sandbox-alpha/)
})

test("bridge config rejects sandboxRuntime with missing fields", () => {
  assert.throws(
    () => validateBridgeConfig(
      validBridgeConfig({ sandboxRuntime: {} }),
      { configPath: "/tmp/config.json" },
    ),
    /path "sandboxRuntime\.trustedRoots"/,
  )

  assert.throws(
    () => validateBridgeConfig(
      validBridgeConfig({
        sandboxRuntime: {
          trustedRoots: [
            { pathEntries: ["bin"] },
          ],
        },
      }),
      { configPath: "/tmp/config.json" },
    ),
    /path "sandboxRuntime\.trustedRoots\[0\]\.root"/,
  )

  assert.throws(
    () => validateBridgeConfig(
      validBridgeConfig({
        sandboxRuntime: {
          trustedRoots: [
            { root: "/srv/sandbox-alpha" },
          ],
        },
      }),
      { configPath: "/tmp/config.json" },
    ),
    /path "sandboxRuntime\.trustedRoots\[0\]\.pathEntries"/,
  )

  assert.throws(
    () => validateBridgeConfig(
      validBridgeConfig({
        sandboxRuntime: {
          trustedRoots: [
            {
              root: "/srv/sandbox-alpha",
              pathEntries: [],
            },
          ],
        },
      }),
      { configPath: "/tmp/config.json" },
    ),
    /path "sandboxRuntime\.trustedRoots\[0\]\.pathEntries"/,
  )

  assert.throws(
    () => validateBridgeConfig(
      validBridgeConfig({ sandboxRuntime: [] }),
      { configPath: "/tmp/config.json" },
    ),
    /path "sandboxRuntime"/,
  )

  assert.throws(
    () => validateBridgeConfig(
      validBridgeConfig({ sandboxRuntime: { trustedRoots: "bin" } }),
      { configPath: "/tmp/config.json" },
    ),
    /path "sandboxRuntime\.trustedRoots"/,
  )
})

test("bridge config rejects invalid sandboxRuntime roots without echoing values", () => {
  const secret = "sandbox-root-secret-abc123"

  for (
    const root
    of [
      "",
      "relative/root",
      "/",
      "/srv/../sandbox-escape",
      `/srv/${secret}/../sandbox-escape`,
      `/srv/bad\x00root`,
      "/srv/trailing/",
      42,
      null,
    ]
  ) {
    const error = captureThrownError(
      () => validateBridgeConfig(
        validBridgeConfig({
          sandboxRuntime: {
            trustedRoots: [
              {
                root,
                pathEntries: ["bin"],
              },
            ],
          },
        }),
        { configPath: "/tmp/config.json" },
      ),
      /path "sandboxRuntime\.trustedRoots\[0\]\.root"/,
    )

    assert.match(error.message, /\/tmp\/config\.json/)
    assert.doesNotMatch(error.message, /sandbox-root-secret/)
    assert.doesNotMatch(error.message, /abc123/)
  }
})

test("bridge config rejects invalid sandboxRuntime paths without echoing values", () => {
  const secret = "sandbox-path-secret-abc123"

  for (
    const candidate
    of [
      "",
      "/absolute/path",
      "..",
      "../escape",
      "nested/../escape-parent",
      "bin/",
      "./bin",
      `nested/${secret}/../escape-parent`,
      "bin\x00tool",
      "a//b",
      42,
      null,
    ]
  ) {
    const forPathEntries = captureThrownError(
      () => validateBridgeConfig(
        validBridgeConfig({
          sandboxRuntime: {
            trustedRoots: [
              {
                root: "/srv/sandbox-alpha",
                pathEntries: [candidate],
              },
            ],
          },
        }),
        { configPath: "/tmp/config.json" },
      ),
      /path "sandboxRuntime\.trustedRoots\[0\]\.pathEntries\[0\]"/,
    )

    assert.match(forPathEntries.message, /\/tmp\/config\.json/)
    assert.doesNotMatch(forPathEntries.message, /sandbox-path-secret/)
    assert.doesNotMatch(forPathEntries.message, /abc123/)

    const forEnvironment = captureThrownError(
      () => validateBridgeConfig(
        validBridgeConfig({
          sandboxRuntime: {
            trustedRoots: [
              {
                root: "/srv/sandbox-alpha",
                pathEntries: ["bin"],
                environment: {
                  ALPHA_TOOLS: candidate,
                },
              },
            ],
          },
        }),
        { configPath: "/tmp/config.json" },
      ),
      /path "sandboxRuntime\.trustedRoots\[0\]\.environment"/,
    )

    assert.match(forEnvironment.message, /\/tmp\/config\.json/)
    assert.doesNotMatch(forEnvironment.message, /sandbox-path-secret/)
    assert.doesNotMatch(forEnvironment.message, /abc123/)
  }

  assert.ok(
    validateBridgeConfig(
      validBridgeConfig({
        sandboxRuntime: {
          trustedRoots: [
            {
              root: "/srv/sandbox-alpha",
              pathEntries: ["."],
              environment: {
                ALPHA_ROOT: ".",
              },
            },
          ],
        },
      }),
      { configPath: "/tmp/config.json" },
    ),
  )
})

test("bridge config rejects invalid sandboxRuntime environment forms", () => {
  const secret = "sandbox-env-secret-abc123"

  assert.throws(
    () => validateBridgeConfig(
      validBridgeConfig({
        sandboxRuntime: {
          trustedRoots: [
            {
              root: "/srv/sandbox-alpha",
              pathEntries: ["bin"],
              environment: [],
            },
          ],
        },
      }),
      { configPath: "/tmp/config.json" },
    ),
    /path "sandboxRuntime\.trustedRoots\[0\]\.environment"/,
  )

  for (
    const name
    of [
      "lowercase",
      "1LEADING_DIGIT",
      "HAS-DASH",
      "HAS SPACE",
      "",
      secret,
    ]
  ) {
    const error = captureThrownError(
      () => validateBridgeConfig(
        validBridgeConfig({
          sandboxRuntime: {
            trustedRoots: [
              {
                root: "/srv/sandbox-alpha",
                pathEntries: ["bin"],
                environment: {
                  [name]: "bin",
                },
              },
            ],
          },
        }),
        { configPath: "/tmp/config.json" },
      ),
      /path "sandboxRuntime\.trustedRoots\[0\]\.environment"/,
    )

    assert.match(error.message, /\/tmp\/config\.json/)
    assert.doesNotMatch(error.message, /sandbox-env-secret/)
    assert.doesNotMatch(error.message, /abc123/)
  }
})

test("bridge config rejects duplicate sandboxRuntime roots and duplicate path entries", () => {
  const duplicateRoots = captureThrownError(
    () => validateBridgeConfig(
      validBridgeConfig({
        sandboxRuntime: {
          trustedRoots: [
            {
              root: "/srv/sandbox-alpha",
              pathEntries: ["bin"],
            },
            {
              root: "/srv/sandbox-alpha",
              pathEntries: ["tools"],
            },
          ],
        },
      }),
      { configPath: "/tmp/config.json" },
    ),
    /duplicate trusted root.*path "sandboxRuntime\.trustedRoots\[1\]"/,
  )

  assert.match(duplicateRoots.message, /\/tmp\/config\.json/)
  assert.doesNotMatch(duplicateRoots.message, /\/srv\/sandbox-alpha/)

  assert.throws(
    () => validateBridgeConfig(
      validBridgeConfig({
        sandboxRuntime: {
          trustedRoots: [
            {
              root: "/srv/sandbox-alpha",
              pathEntries: ["bin", "bin"],
            },
          ],
        },
      }),
      { configPath: "/tmp/config.json" },
    ),
    /duplicate path entry.*path "sandboxRuntime\.trustedRoots\[0\]\.pathEntries\[1\]"/,
  )
})

test("bridge config rejects duplicate and reserved sandboxRuntime environment keys", () => {
  const secret = "sandbox-duplicate-abc123"

  const duplicate = captureThrownError(
    () => validateBridgeConfig(
      validBridgeConfig({
        sandboxRuntime: {
          trustedRoots: [
            {
              root: "/srv/sandbox-alpha",
              pathEntries: ["bin"],
              environment: {
                SHARED_TOOLS: "bin",
              },
            },
            {
              root: "/opt/sandbox-beta",
              pathEntries: ["tools"],
              environment: {
                SHARED_TOOLS: "tools",
              },
            },
          ],
        },
      }),
        { configPath: "/tmp/config.json" },
    ),
    /duplicate environment variable name.*path "sandboxRuntime\.trustedRoots\[1\]\.environment"/,
  )

  assert.doesNotMatch(duplicate.message, /SHARED_TOOLS/)
  assert.doesNotMatch(duplicate.message, /sandbox-duplicate/)

  for (
    const name
    of ["HOME", "PATH", "LANG", "LC_ALL", "PYTHONPYCACHEPREFIX"]
  ) {
    const reserved = captureThrownError(
      () => validateBridgeConfig(
        validBridgeConfig({
          sandboxRuntime: {
            trustedRoots: [
              {
                root: "/srv/sandbox-alpha",
                pathEntries: ["bin"],
                environment: {
                  [name]: "bin",
                },
              },
            ],
          },
        }),
        { configPath: "/tmp/config.json" },
      ),
      /reserved environment variable name.*path "sandboxRuntime\.trustedRoots\[0\]\.environment"/,
    )

    assert.match(reserved.message, /\/tmp\/config\.json/)
    assert.doesNotMatch(reserved.message, new RegExp(name))
  }
})

test("bridge config rejects non-object sandboxRuntime entries", () => {
  assert.throws(
    () => validateBridgeConfig(
      validBridgeConfig({
        sandboxRuntime: {
          trustedRoots: ["not-an-object"],
        },
      }),
      { configPath: "/tmp/config.json" },
    ),
    /path "sandboxRuntime\.trustedRoots\[0\]"/,
  )
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

  await withTempDir("bridge-writer-network-fallback-", async (dir) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { calls, client } = makeFakeClient({ wait: () => gate })
    const base = { client, model: stubModel, timeoutMs: 10000 }

    const writableNetworkFirst = runAgent(
      dir,
      "writable network task",
      "opencode-orchestrator-runner-writable-network",
      "runner",
      base,
    )

    await waitFor(() => callNames(calls, "wait").length >= 1)

    const createdBefore = callNames(calls, "create").length
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
    assert.equal(callNames(calls, "create").length, createdBefore)

    release()
    assert.equal(await writableNetworkFirst, "hello")
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

test("resolveRunnerSelection maps all four workspace/network combinations", () => {
  assert.deepEqual(
    resolveRunnerSelection("read_only", "disabled"),
    { agent: "opencode-orchestrator-runner", executionTool: "sandbox_run_ro" },
  )
  assert.deepEqual(
    resolveRunnerSelection("writable", "disabled"),
    { agent: "opencode-orchestrator-runner-writable", executionTool: "sandbox_run" },
  )
  assert.deepEqual(
    resolveRunnerSelection("read_only", "host"),
    { agent: "opencode-orchestrator-runner-network", executionTool: "sandbox_run_network_ro" },
  )
  assert.deepEqual(
    resolveRunnerSelection("writable", "host"),
    { agent: "opencode-orchestrator-runner-writable-network", executionTool: "sandbox_run_network" },
  )
  assert.deepEqual(
    resolveRunnerSelection(undefined, undefined),
    { agent: "opencode-orchestrator-runner", executionTool: "sandbox_run_ro" },
  )
  assert.throws(() => resolveRunnerSelection("read_only", "bogus"), /invalid network_access/)
  assert.throws(() => resolveRunnerSelection("read_only", "HOST"), /invalid network_access/)
  assert.throws(() => resolveRunnerSelection("bogus", "disabled"), /invalid workspace_access/)
})

test("runner handler defaults omitted network_access to disabled behavior", async () => {
  let captured

  const handlers = createToolHandlers(async (...args) => {
    captured = args
    return "done"
  })

  const before = createToolHandlers(async (...args) => {
    captured = args
    return "done"
  })

  await handlers.runner(
    { cwd: "/tmp/work", command: "npm test", objective: "check tests" },
    undefined,
  )

  const omittedTask = captured[1]
  const omittedAgent = captured[2]

  await before.runner(
    {
      cwd: "/tmp/work",
      command: "npm test",
      objective: "check tests",
      workspace_access: "read_only",
      network_access: "disabled",
    },
    undefined,
  )

  assert.equal(omittedAgent, "opencode-orchestrator-runner")
  assert.equal(omittedAgent, captured[2])
  assert.match(omittedTask, /Network access mode: disabled\./)
  assert.match(omittedTask, /Network is unavailable/)
  assert.match(omittedTask, /Use exactly sandbox_run_ro/)
  assert.match(omittedTask, /Run the command exactly once with sandbox_run_ro\./)
  assert.match(omittedTask, /Pass the requested maximum runtime to sandbox_run_ro\./)
})

test("runner handler rejects invalid network_access before session creation", async () => {
  let called = false

  const handlers = createToolHandlers(async () => {
    called = true
    return "done"
  })

  for (const bad of ["bogus", "HOST", "", "host ", "none"]) {
    const result = await handlers.runner(
      {
        cwd: "/tmp/work",
        command: "npm test",
        objective: "check tests",
        network_access: bad,
      },
      undefined,
    )

    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /invalid network_access/)
  }

  assert.equal(called, false)
})

test("runner handler selects the exact agent for all four combinations", async () => {
  const cases = [
    ["read_only", "disabled", "opencode-orchestrator-runner", "sandbox_run_ro"],
    ["writable", "disabled", "opencode-orchestrator-runner-writable", "sandbox_run"],
    ["read_only", "host", "opencode-orchestrator-runner-network", "sandbox_run_network_ro"],
    ["writable", "host", "opencode-orchestrator-runner-writable-network", "sandbox_run_network"],
  ]

  for (const [workspaceAccess, networkAccess, agent, tool] of cases) {
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
        workspace_access: workspaceAccess,
        network_access: networkAccess,
      },
      undefined,
    )

    assert.deepEqual(result, { content: [{ type: "text", text: "done" }] })
    assert.equal(captured[2], agent, `${workspaceAccess}+${networkAccess}`)
    assert.match(captured[1], new RegExp(`Workspace access mode: ${workspaceAccess}\\.`))
    assert.match(captured[1], new RegExp(`Network access mode: ${networkAccess}\\.`))
    assert.match(captured[1], new RegExp(`Use exactly ${tool}`))
    assert.match(captured[1], new RegExp(`Run the command exactly once with ${tool}\\.`))

    if (networkAccess === "host") {
      assert.match(captured[1], /parent explicitly granted host network access/)
      assert.match(captured[1], /do not fetch unrelated resources/)
    } else {
      assert.match(captured[1], /Network is unavailable/)
    }
  }
})

test("network access alone never takes the writer lock", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-runner-host-", async (dir) => {
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

    const readOnlyHost = runAgent(
      dir,
      "read-only host task",
      "opencode-orchestrator-runner-network",
      "runner",
      { ...base, workspaceAccess: "read_only" },
    )

    await waitFor(() => callNames(calls, "wait").length >= 2)

    release()

    assert.deepEqual(
      await Promise.all([workerFirst, readOnlyHost]),
      ["hello", "hello"],
    )
  })

  await withTempDir("bridge-runner-host-w-", async (dir) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const { calls, client } = makeFakeClient({ wait: () => gate })
    const base = { client, model: stubModel, timeoutMs: 10000 }

    const writableHostFirst = runAgent(
      dir,
      "writable host task",
      "opencode-orchestrator-runner-writable-network",
      "runner",
      { ...base, workspaceAccess: "writable" },
    )

    await waitFor(() => callNames(calls, "wait").length >= 1)

    const createdBefore = callNames(calls, "create").length

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

    assert.equal(callNames(calls, "create").length, createdBefore)

    release()
    assert.equal(await writableHostFirst, "hello")
  })

  resetBridgeStateForTests()
})

test("runner tool annotation is statically open-world with conservative write hints", async () => {
  const server = createServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await server.connect(serverTransport)

  const client = new Client({
    name: "bridge-runtime-runner-annotation-test",
    version: "0.0.0",
  })

  await client.connect(clientTransport)

  try {
    const { tools } = await client.listTools()
    const runner = tools.find((tool) => tool.name === "runner")

    assert.ok(runner)
    assert.equal(runner.annotations.readOnlyHint, false)
    assert.equal(runner.annotations.destructiveHint, true)
    assert.equal(runner.annotations.openWorldHint, true)

    const schema = runner.inputSchema
    assert.ok(schema.properties.network_access)
    assert.deepEqual(schema.properties.network_access.enum, ["disabled", "host"])
    assert.equal(schema.properties.network_access.default, "disabled")
  } finally {
    await client.close()
    await server.close()
  }
})

test("runner schema rejects an invalid network_access value", async () => {
  const server = createServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await server.connect(serverTransport)

  const client = new Client({
    name: "bridge-runtime-network-access-test",
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
          network_access: "bogus",
        },
      })
    } catch (error) {
      assert.match(String(error?.message ?? error), /network_access/i)
      return
    }

    assert.equal(outcome.isError, true)

    const text = (outcome.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n")

    assert.match(text, /network_access/i)
  } finally {
    await client.close()
    await server.close()
  }
})
