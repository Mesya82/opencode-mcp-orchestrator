import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  PRESERVE_SESSIONS_ENV_VAR,
  resetBridgeStateForTests,
  resolvePreserveSessions,
  runAgent,
} from "../../bridge/server.mjs"

const stubModel = {
  reference: "provider/model",
  providerID: "provider",
  id: "model",
}

async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(join(tmpdir(), prefix))

  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function makeFakeClient(hooks = {}) {
  const calls = []
  const session = {
    create: async (input, options) => {
      calls.push(["create", input, options])
      return hooks.create ? hooks.create(input, options) : { id: "ses_preserved" }
    },
    switchAgent: async (input, options) => {
      calls.push(["switchAgent", input, options])
    },
    switchModel: async (input, options) => {
      calls.push(["switchModel", input, options])
    },
    prompt: async (input, options) => {
      calls.push(["prompt", input, options])
    },
    wait: async (input, options) => {
      calls.push(["wait", input, options])
      if (hooks.wait) await hooks.wait(input, options)
    },
    context: async (input, options) => {
      calls.push(["context", input, options])
      return [{
        type: "assistant",
        finish: "stop",
        content: [{ type: "text", text: "hello" }],
      }]
    },
    interrupt: async (input, options) => {
      calls.push(["interrupt", input, options])
      if (hooks.interrupt) await hooks.interrupt(input, options)
    },
    remove: async (input, options) => {
      calls.push(["remove", input, options])
    },
  }

  return { calls, client: { session } }
}

function count(calls, name) {
  return calls.filter(([entry]) => entry === name).length
}

async function assertSecondWriterBlocked(dir, calls, options) {
  const createsBefore = count(calls, "create")

  await assert.rejects(
    () => runAgent(
      dir,
      "second task",
      "opencode-orchestrator-worker",
      "worker",
      options,
    ),
    /preserved for diagnostics.*ses_preserved/,
  )

  assert.equal(count(calls, "create"), createsBefore)
}

test("session preservation env flag is opt-in and strict", () => {
  assert.equal(PRESERVE_SESSIONS_ENV_VAR, "OPENCODE_MCP_ORCHESTRATOR_PRESERVE_SESSIONS")
  assert.equal(resolvePreserveSessions({}), false)
  assert.equal(resolvePreserveSessions({ [PRESERVE_SESSIONS_ENV_VAR]: "0" }), false)
  assert.equal(resolvePreserveSessions({ [PRESERVE_SESSIONS_ENV_VAR]: "true" }), false)
  assert.equal(resolvePreserveSessions({ [PRESERVE_SESSIONS_ENV_VAR]: "1" }), true)
  assert.equal(resolvePreserveSessions({ [PRESERVE_SESSIONS_ENV_VAR]: " 1 " }), true)
})

test("normal cleanup remains enabled when preservation is not requested", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-preserve-disabled-", async (dir) => {
    const { calls, client } = makeFakeClient()
    const options = {
      client,
      model: stubModel,
      timeoutMs: 5000,
      parentTimeoutSeconds: 7200,
      env: {},
    }

    assert.equal(
      await runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        options,
      ),
      "hello",
    )
    assert.equal(
      await runAgent(
        dir,
        "second task",
        "opencode-orchestrator-worker",
        "worker",
        options,
      ),
      "hello",
    )

    assert.equal(count(calls, "create"), 2)
    assert.equal(count(calls, "interrupt"), 0)
    assert.equal(count(calls, "remove"), 2)
  })

  resetBridgeStateForTests()
})

test("successful diagnostic worker preserves session and blocks another writer", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-preserve-success-", async (dir) => {
    const { calls, client } = makeFakeClient()
    const events = []
    const options = {
      client,
      model: stubModel,
      timeoutMs: 5000,
      parentTimeoutSeconds: 7200,
      preserveSession: true,
      diagnosticLog: (event) => events.push(event),
    }

    assert.equal(
      await runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        options,
      ),
      "hello",
    )

    assert.equal(count(calls, "interrupt"), 0)
    assert.equal(count(calls, "remove"), 0)
    assert.deepEqual(events, [{
      event: "session_preserved",
      session_id: "ses_preserved",
      succeeded: true,
      role: "worker",
      agent: "opencode-orchestrator-worker",
      cwd: dir,
    }])

    await assertSecondWriterBlocked(dir, calls, options)
  })

  resetBridgeStateForTests()
})

test("failed diagnostic worker interrupts but does not remove preserved session", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-preserve-failure-", async (dir) => {
    const { calls, client } = makeFakeClient({
      wait: async () => {
        throw new Error("session exploded")
      },
    })
    const events = []
    const options = {
      client,
      model: stubModel,
      timeoutMs: 5000,
      parentTimeoutSeconds: 7200,
      preserveSession: true,
      diagnosticLog: (event) => events.push(event),
    }

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        options,
      ),
      (error) => {
        assert.match(error.message, /session exploded/)
        assert.doesNotMatch(error.message, /quarantined/)
        return true
      },
    )

    assert.equal(count(calls, "interrupt"), 1)
    assert.equal(count(calls, "remove"), 0)
    assert.equal(events.length, 1)
    assert.equal(events[0].event, "session_preserved")
    assert.equal(events[0].session_id, "ses_preserved")
    assert.equal(events[0].succeeded, false)
    await assertSecondWriterBlocked(dir, calls, options)
  })

  resetBridgeStateForTests()
})

test("timed out diagnostic worker interrupts and preserves the session", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-preserve-timeout-", async (dir) => {
    const { calls, client } = makeFakeClient({
      wait: async (_input, options) => {
        await new Promise((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          )
        })
      },
    })
    const options = {
      client,
      model: stubModel,
      timeoutMs: 60,
      parentTimeoutSeconds: 7200,
      preserveSession: true,
      diagnosticLog: () => {},
    }

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        options,
      ),
      /timed out after 60ms/,
    )

    assert.equal(count(calls, "interrupt"), 1)
    assert.equal(count(calls, "remove"), 0)
    await assertSecondWriterBlocked(dir, calls, options)
  })

  resetBridgeStateForTests()
})

test("late session creation after timeout is interrupted and preserved", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-preserve-late-create-", async (dir) => {
    let releaseCreate
    const createGate = new Promise((resolve) => {
      releaseCreate = resolve
    })
    let createResolved = false
    const { calls, client } = makeFakeClient({
      create: async () => {
        await createGate
        createResolved = true
        return { id: "ses_late" }
      },
    })
    const events = []
    const options = {
      client,
      model: stubModel,
      timeoutMs: 60,
      parentTimeoutSeconds: 7200,
      preserveSession: true,
      diagnosticLog: (event) => events.push(event),
    }

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        options,
      ),
      /timed out after 60ms/,
    )

    assert.equal(createResolved, false)
    assert.equal(count(calls, "interrupt"), 0)
    assert.equal(count(calls, "remove"), 0)

    const createsBefore = count(calls, "create")

    await assert.rejects(
      () => runAgent(
        dir,
        "second task",
        "opencode-orchestrator-worker",
        "worker",
        options,
      ),
      /preserved for diagnostics/,
    )

    assert.equal(count(calls, "create"), createsBefore)

    releaseCreate()

    const deadline = Date.now() + 5000

    while (
      (count(calls, "interrupt") !== 1 || events.length !== 1) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    assert.equal(count(calls, "interrupt"), 1)
    assert.equal(count(calls, "remove"), 0)
    assert.deepEqual(events, [{
      event: "session_preserved",
      session_id: "ses_late",
      succeeded: false,
      role: "worker",
      agent: "opencode-orchestrator-worker",
      cwd: dir,
    }])

    await assert.rejects(
      () => runAgent(
        dir,
        "third task",
        "opencode-orchestrator-worker",
        "worker",
        options,
      ),
      /preserved for diagnostics.*ses_late/,
    )

    assert.equal(count(calls, "remove"), 0)
  })

  resetBridgeStateForTests()
})

test("preserved scout via env flag retains session without blocking writable delegation", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-preserve-scout-env-", async (dir) => {
    const { calls, client } = makeFakeClient()
    const events = []
    const baseOptions = {
      client,
      model: stubModel,
      timeoutMs: 5000,
      parentTimeoutSeconds: 7200,
      diagnosticLog: (event) => events.push(event),
      env: { [PRESERVE_SESSIONS_ENV_VAR]: "1" },
    }

    assert.equal(
      await runAgent(
        dir,
        "task",
        "opencode-orchestrator-scout",
        "scout",
        baseOptions,
      ),
      "hello",
    )

    assert.equal(count(calls, "interrupt"), 0)
    assert.equal(count(calls, "remove"), 0)
    assert.deepEqual(events, [{
      event: "session_preserved",
      session_id: "ses_preserved",
      succeeded: true,
      role: "scout",
      agent: "opencode-orchestrator-scout",
      cwd: dir,
    }])

    assert.equal(
      await runAgent(
        dir,
        "second task",
        "opencode-orchestrator-worker",
        "worker",
        baseOptions,
      ),
      "hello",
    )

    assert.equal(count(calls, "create"), 2)
    assert.equal(count(calls, "remove"), 0)
  })

  resetBridgeStateForTests()
})

test("diagnostic cleanup is bounded when interruption does not settle", async () => {
  resetBridgeStateForTests()

  await withTempDir("bridge-preserve-hanging-interrupt-", async (dir) => {
    const { calls, client } = makeFakeClient({
      wait: async () => {
        throw new Error("session exploded")
      },
      interrupt: async () => new Promise(() => {}),
    })
    const events = []

    await assert.rejects(
      () => runAgent(
        dir,
        "task",
        "opencode-orchestrator-worker",
        "worker",
        {
          client,
          model: stubModel,
          timeoutMs: 5000,
          parentTimeoutSeconds: 7200,
          cleanupTimeoutMs: 20,
          preserveSession: true,
          diagnosticLog: (event) => events.push(event),
        },
      ),
      /session exploded/,
    )

    assert.equal(count(calls, "interrupt"), 1)
    assert.equal(count(calls, "remove"), 0)
    assert.equal(events.length, 1)
    assert.equal(events[0].session_id, "ses_preserved")
  })

  resetBridgeStateForTests()
})
