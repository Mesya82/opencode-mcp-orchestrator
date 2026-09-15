#!/usr/bin/env node

// Deterministic session.wait refresh regression probe against the
// packaged/built MCP server artifact.
//
// Uses a fake HTTP OpenCode service bound to 127.0.0.1 with isolated
// temporary service state, plus the packaged server via
// StdioClientTransport. Never imports bridge source.

import {
  createServer,
} from "node:http"
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises"
import {
  tmpdir,
} from "node:os"
import {
  join,
  resolve,
} from "node:path"
import {
  realpath,
} from "node:fs/promises"
import {
  Client,
} from "@modelcontextprotocol/client"
import {
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio"

const serverArg = process.argv[2]

if (!serverArg) {
  throw new Error(
    "usage: session-wait-refresh-probe.mjs PATH_TO_MCP_SERVER",
  )
}

const server = await realpath(serverArg)

const REFRESH_MS = "50"
const CLIENT_CALL_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 60_000
const SHORT_WALL_CLOCK_BUDGET_MS = 20_000
const HELD_WAIT_FALLBACK_MS = 10_000

// Failure-safe setup: register every temp path immediately after it is
// allocated so a later allocation/registration failure still cleans up.
const tmpDirs = []
let tmpState
let tmpConfigDir
let tmpWork
let configPath
let fake
const openSockets = new Set()
const heldTimers = new Set()
const heldResponses = new Set()
// Explicitly tracked client-aborted held waits: { sessionID, attempt }.
const heldAborts = []
let client
let transport
let stderr = ""
let failed = true

function trackHeldTimer(timer) {
  heldTimers.add(timer)
  return timer
}

function clearHeldTimer(timer) {
  if (timer !== undefined) {
    clearTimeout(timer)
    heldTimers.delete(timer)
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sessionIndex(sessions, sessionID) {
  return sessions.indexOf(sessionID)
}

try {
  tmpState = await mkdtemp(join(tmpdir(), "e2e-wait-refresh-state-"))
  tmpDirs.push(tmpState)
  tmpConfigDir = await mkdtemp(join(tmpdir(), "e2e-wait-refresh-config-"))
  tmpDirs.push(tmpConfigDir)
  tmpWork = await mkdtemp(join(tmpdir(), "e2e-wait-refresh-work-"))
  tmpDirs.push(tmpWork)
  configPath = join(tmpConfigDir, "config.json")

  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      models: {
        scout: "opencode/probe-model",
        worker: "opencode/probe-model",
        runner: "opencode/probe-model",
      },
      stepLimits: {
        profile: "standard",
      },
    }) + "\n",
  )

  const counts = {
    create: 0,
    prompt: 0,
    wait: [],
    get: 0,
    context: 0,
    remove: 0,
    interrupt: 0,
  }

  const sessions = []
  const waitAttemptsBySession = new Map()

  fake = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1")
    const pathname = url.pathname
    const method = req.method

    if (method === "GET" && pathname === "/api/health") {
      json(res, 200, { version: "0.0.0-e2e", pid: process.pid })
      return
    }

    if (method === "POST" && pathname === "/api/session") {
      counts.create += 1
      const sessionID = `ses_e2e_${counts.create}`
      sessions.push(sessionID)
      waitAttemptsBySession.set(sessionID, 0)
      // Drain body before responding.
      req.resume()
      req.on("end", () => {
        json(res, 200, { data: { id: sessionID } })
      })
      return
    }

    const sessionMatch = pathname.match(/^\/api\/session\/([^/]+)(?:\/(agent|model|prompt|wait|context|interrupt))?$/)

    if (!sessionMatch) {
      // DELETE /api/session/:id has no trailing segment.
      const removeMatch = pathname.match(/^\/api\/session\/([^/]+)$/)
      if (method === "DELETE" && removeMatch) {
        counts.remove += 1
        res.writeHead(204)
        res.end()
        return
      }

      if (method === "GET" && removeMatch) {
        counts.get += 1
        const sessionID = decodeURIComponent(removeMatch[1])
        json(res, 200, {
          data: {
            id: sessionID,
            time: { created: 1, updated: Date.now(), idle: 0 },
            tokens: {
              input: 1,
              output: 1,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            cost: 0,
          },
        })
        return
      }

      res.writeHead(404)
      res.end()
      return
    }

    const sessionID = decodeURIComponent(sessionMatch[1])
    const action = sessionMatch[2]

    if (method === "GET" && action === undefined) {
      counts.get += 1
      json(res, 200, {
        data: {
          id: sessionID,
          time: { created: 1, updated: Date.now(), idle: 0 },
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          cost: 0,
        },
      })
      return
    }

    if (method === "DELETE" && action === undefined) {
      counts.remove += 1
      res.writeHead(204)
      res.end()
      return
    }

    if (method === "POST" && (action === "agent" || action === "model")) {
      req.resume()
      req.on("end", () => {
        res.writeHead(204)
        res.end()
      })
      return
    }

    if (method === "POST" && action === "prompt") {
      counts.prompt += 1
      req.resume()
      req.on("end", () => {
        json(res, 200, { data: { id: "msg_1" } })
      })
      return
    }

    if (method === "POST" && action === "wait") {
      const attempt = (waitAttemptsBySession.get(sessionID) ?? 0) + 1
      waitAttemptsBySession.set(sessionID, attempt)
      counts.wait.push(sessionID)
      const index = sessionIndex(sessions, sessionID)

      if (index === 1) {
        // Second scenario: immediate genuine failure, no retry expected.
        req.resume()
        req.on("end", () => {
          json(res, 503, { message: "genuine wait failure" })
        })
        return
      }

      // First scenario: hold the first two waits until the bridge refresh
      // aborts the connection; the third wait succeeds.
      if (attempt <= 2) {
        // Drain the incoming request body without responding so the held
        // wait stays open until the client aborts it via refresh.
        req.resume()
        let settled = false
        const finishAbort = () => {
          if (settled) {
            return false
          }
          settled = true
          heldResponses.delete(res)
          return true
        }
        const safety = trackHeldTimer(setTimeout(() => {
          // Fallback: never counts as a refresh abort and never fabricates
          // success. Just tear down the held response so the probe can fail
          // loudly instead of hanging or passing spuriously.
          if (!finishAbort()) {
            return
          }
          clearHeldTimer(safety)
          try {
            res.destroy(new Error("held wait fallback timeout (no client abort observed)"))
          } catch {
            // Ignore.
          }
        }, HELD_WAIT_FALLBACK_MS))
        if (typeof safety.unref === "function") {
          safety.unref()
        }
        heldResponses.add(res)
        const onClose = () => {
          // res "close" fires for both normal completion and abort; only a
          // close where the response never normally ended is a client abort.
          // Also consult the socket in case the response object already
          // transitioned.
          const responseAborted = !res.writableEnded
          const socketAborted = req.socket ? req.socket.destroyed : false
          if (!responseAborted && !socketAborted) {
            return
          }
          if (!finishAbort()) {
            return
          }
          clearHeldTimer(safety)
          heldAborts.push({ sessionID, attempt })
          try {
            res.destroy()
          } catch {
            // Ignore.
          }
        }
        res.on("close", onClose)
        // Hold open: never respond until the client aborts or fallback fires.
        return
      }

      req.resume()
      req.on("end", () => {
        res.writeHead(204)
        res.end()
      })
      return
    }

    if (method === "GET" && action === "context") {
      counts.context += 1
      json(res, 200, {
        data: [
          {
            type: "assistant",
            finish: "stop",
            content: [{ type: "text", text: "refresh-probe-ok" }],
          },
        ],
      })
      return
    }

    if (method === "POST" && action === "interrupt") {
      counts.interrupt += 1
      json(res, 200, {})
      return
    }

    res.writeHead(404)
    res.end()
  })

  fake.on("connection", (socket) => {
    openSockets.add(socket)
    socket.on("close", () => {
      openSockets.delete(socket)
    })
  })

  await new Promise((resolvePromise, reject) => {
    fake.on("error", reject)
    fake.listen(0, "127.0.0.1", () => {
      fake.off("error", reject)
      resolvePromise()
    })
  })

  const fakePort = fake.address().port
  const fakeUrl = `http://127.0.0.1:${fakePort}`

  await mkdir(join(tmpState, "opencode"), { recursive: true })

  await writeFile(
    join(tmpState, "opencode", "service.json"),
    JSON.stringify({
      id: "e2e-fake-service",
      version: "0.0.0-e2e",
      url: fakeUrl,
      pid: process.pid,
    }) + "\n",
  )

  const childEnv = {
    ...process.env,
    XDG_STATE_HOME: tmpState,
    OPENCODE_MCP_ORCHESTRATOR_CONFIG: configPath,
    OPENCODE_MCP_ORCHESTRATOR_E2E_SESSION_WAIT_REFRESH_MS: REFRESH_MS,
    OPENCODE_MCP_ORCHESTRATOR_DEBUG: "1",
  }
  delete childEnv.OPENCODE_MCP_ORCHESTRATOR_PRESERVE_SESSIONS

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: childEnv,
    stderr: "pipe",
  })

  transport.stderr?.setEncoding("utf8")
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk
  })

  client = new Client({
    name: "opencode-mcp-orchestrator-wait-refresh-probe",
    version: "1.0.0",
  })

  function stderrEvents(event) {
    const matches = []
    for (const line of stderr.split("\n")) {
      const marker = "[opencode-mcp-orchestrator] "
      const index = line.indexOf(marker)
      if (index < 0) {
        continue
      }
      try {
        const parsed = JSON.parse(line.slice(index + marker.length))
        if (parsed?.event === event) {
          matches.push(parsed)
        }
      } catch {
        // Non-JSON stderr line; ignore.
      }
    }
    return matches
  }

  function toolText(result) {
    return (result?.content ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
  }

  // Race a client call against a probe timeout while always clearing the
  // timeout timer, even when the call settles first.
  async function callToolWithProbeTimeout(toolArgs, timeoutMessage) {
    let timer
    try {
      return await Promise.race([
        client.callTool(
          toolArgs,
          { timeout: CLIENT_CALL_TIMEOUT_MS },
        ),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(timeoutMessage)),
            PROBE_TIMEOUT_MS,
          )
          if (typeof timer.unref === "function") {
            timer.unref()
          }
        }),
      ])
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  }

  await client.connect(transport)

  const startedAt = Date.now()

  const first = await callToolWithProbeTimeout(
    {
      name: "scout",
      arguments: {
        cwd: await realpath(tmpWork),
        task: "session wait refresh regression probe",
      },
    },
    "probe timed out waiting for refresh scenario",
  )

  const wallClockMs = Date.now() - startedAt
  const firstText = toolText(first)

  if (first?.isError) {
    throw new Error(`refresh scenario returned MCP error: ${firstText.slice(0, 500)}`)
  }

  if (!firstText.includes("refresh-probe-ok")) {
    throw new Error(`refresh scenario returned unexpected text: ${firstText.slice(0, 500)}`)
  }

  const firstSession = sessions[0]

  if (!firstSession) {
    throw new Error("refresh scenario created no session")
  }

  if (counts.create !== 1) {
    throw new Error(`expected 1 session creation, got ${counts.create}`)
  }

  if (counts.prompt !== 1) {
    throw new Error(`expected 1 prompt, got ${counts.prompt}`)
  }

  if (counts.wait.length < 3) {
    throw new Error(`expected >=3 waits, got ${counts.wait.length}`)
  }

  if (!counts.wait.every((sessionID) => sessionID === firstSession)) {
    throw new Error(`expected all waits for same session ${firstSession}, got ${counts.wait.join(",")}`)
  }

  if (counts.context !== 1) {
    throw new Error(`expected 1 context read, got ${counts.context}`)
  }

  if (counts.remove !== 1) {
    throw new Error(`expected 1 session removal, got ${counts.remove}`)
  }

  // Explicit client-abort evidence for the first scenario: both held waits
  // must have been aborted by the client (refresh), tied to the first
  // session and the first two attempts. The fallback timeout never counts.
  const firstScenarioAborts = heldAborts.filter(
    (entry) => entry.sessionID === firstSession && entry.attempt <= 2,
  )

  if (firstScenarioAborts.length < 2) {
    throw new Error(`expected >=2 client-aborted held waits for ${firstSession}, got ${firstScenarioAborts.length}`)
  }

  if (!firstScenarioAborts.some((entry) => entry.attempt === 1) ||
    !firstScenarioAborts.some((entry) => entry.attempt === 2)) {
    throw new Error(`expected aborts for attempts 1 and 2, got ${JSON.stringify(firstScenarioAborts).slice(0, 300)}`)
  }

  const refreshEvents = stderrEvents("session_wait_refresh")

  if (refreshEvents.length < 2) {
    throw new Error(`expected >=2 session_wait_refresh diagnostics, got ${refreshEvents.length}`)
  }

  for (const event of refreshEvents) {
    if (event.session_id !== firstSession) {
      throw new Error(`session_wait_refresh for unexpected session: ${JSON.stringify(event).slice(0, 300)}`)
    }
  }

  if (wallClockMs >= SHORT_WALL_CLOCK_BUDGET_MS) {
    throw new Error(`refresh scenario wall clock too long: ${wallClockMs}ms`)
  }

  // Second scenario: immediate genuine wait failure, no retry.
  const waitsBefore = counts.wait.length
  const refreshBefore = stderrEvents("session_wait_refresh").length
  const failureBefore = stderrEvents("session_wait_failure").length

  const second = await callToolWithProbeTimeout(
    {
      name: "scout",
      arguments: {
        cwd: await realpath(tmpWork),
        task: "session wait genuine failure probe",
      },
    },
    "probe timed out waiting for failure scenario",
  )

  if (!second?.isError) {
    throw new Error("genuine wait failure did not return an MCP error")
  }

  const waitsAdded = counts.wait.length - waitsBefore

  if (waitsAdded !== 1) {
    throw new Error(`expected 1 wait with no retry, got ${waitsAdded}`)
  }

  const failureEvents = stderrEvents("session_wait_failure")

  if (failureEvents.length <= failureBefore) {
    throw new Error("expected a session_wait_failure diagnostic for the genuine failure")
  }

  if (stderrEvents("session_wait_refresh").length !== refreshBefore) {
    throw new Error("genuine wait failure must not emit session_wait_refresh")
  }

  failed = false
  console.log(`SESSION_WAIT_REFRESH_PROBE_PASS wall_clock_ms=${wallClockMs} client_aborted_held_waits=${firstScenarioAborts.length}`)
} catch (error) {
  console.error(error.stack || error.message || String(error))
  if (stderr.trim()) {
    console.error("\nMCP server stderr:")
    console.error(stderr.trim().slice(-4000))
  }
  process.exitCode = 1
} finally {
  for (const timer of [...heldTimers]) {
    try {
      clearTimeout(timer)
    } catch {
      // Ignore.
    }
    heldTimers.delete(timer)
  }
  for (const res of [...heldResponses]) {
    try {
      res.destroy()
    } catch {
      // Ignore.
    }
    heldResponses.delete(res)
  }
  if (client) {
    try {
      await client.close()
    } catch {
      // Ignore close errors; outcome already decided.
    }
  }
  if (transport) {
    try {
      await transport.close?.()
    } catch {
      // Ignore.
    }
    try {
      await transport.terminate?.()
    } catch {
      // Ignore.
    }
  }
  if (fake) {
    try {
      if (typeof fake.closeAllConnections === "function") {
        fake.closeAllConnections()
      } else {
        for (const socket of [...openSockets]) {
          try {
            socket.destroy()
          } catch {
            // Ignore.
          }
        }
      }
    } catch {
      // Ignore.
    }
    await new Promise((innerResolve) => {
      let done = false
      const finish = () => {
        if (!done) {
          done = true
          innerResolve()
        }
      }
      try {
        fake.close(() => finish())
      } catch {
        finish()
      }
      const guard = setTimeout(finish, 2000)
      if (typeof guard.unref === "function") {
        guard.unref()
      }
    })
  }
  for (const socket of [...openSockets]) {
    try {
      socket.destroy()
    } catch {
      // Ignore.
    }
  }
  openSockets.clear()
  for (const dir of [...tmpDirs]) {
    try {
      await rm(resolve(dir), { recursive: true, force: true })
    } catch {
      // Best effort cleanup.
    }
  }
  if (failed && process.exitCode !== 1) {
    process.exitCode = 1
  }
}
