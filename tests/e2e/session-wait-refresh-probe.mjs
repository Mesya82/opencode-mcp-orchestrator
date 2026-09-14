#!/usr/bin/env node

// Deterministic session-wait refresh E2E against the packaged MCP server.
//
// Runs one scout call through the installed/bundled MCP server with a fake
// OpenCode HTTP service. The fake holds the first two session-wait long
// polls open until the bridge refreshes them, then completes the third,
// so the bridge must log exactly two structured session_wait_refresh
// records and finish without recreating or reprompting the session.

import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"

import {
  createServer as createHttpServer,
} from "node:http"

import {
  spawn,
} from "node:child_process"

import {
  tmpdir,
} from "node:os"

import {
  join,
} from "node:path"

const serverArg = process.argv[2]

if (!serverArg) {
  throw new Error(
    "usage: session-wait-refresh-probe.mjs PATH_TO_MCP_SERVER",
  )
}

const server = await realpath(serverArg)

const SESSION_ID = "ses_e2e_wait_refresh"
const REFRESH_MS = 50
const ELAPSED_BUDGET_MS = 5000

const root = await mkdtemp(join(tmpdir(), "mcp-wait-refresh-e2e-"))
const stateHome = join(root, "state-home")
const cwdDir = join(root, "cwd")

await mkdir(stateHome, { recursive: true })
await mkdir(cwdDir, { recursive: true })
await mkdir(join(stateHome, "opencode"), { recursive: true })

let fake = undefined
let child = undefined
let stderr = ""
let failed = true

const counts = {
  create: 0,
  prompt: 0,
  wait: 0,
  progress: 0,
  context: 0,
  remove: 0,
}

const sessionIds = {
  create: [],
  prompt: [],
  wait: [],
  progress: [],
  context: [],
  remove: [],
}

function sendJson(res, status, value) {
  const body = value === undefined ? "" : JSON.stringify(value)

  res.writeHead(status, {
    "content-type": value === undefined
      ? "text/plain"
      : "application/json",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  })

  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []

    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

async function startFakeOpenCode() {
  let waitCount = 0

  const http = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")

      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { version: "0.0.0-e2e", pid: process.pid })
        return
      }

      if (req.method === "POST" && url.pathname === "/api/session") {
        counts.create += 1
        sessionIds.create.push("(create)")
        await readBody(req)
        sendJson(res, 200, { data: { id: SESSION_ID } })
        return
      }

      const sessionMatch = url.pathname.match(
        /^\/api\/session\/([^/]+)(\/.*)?$/,
      )

      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1])
        const suffix = sessionMatch[2] ?? ""

        if (suffix === "/agent" && req.method === "POST") {
          await readBody(req)
          sendJson(res, 204, undefined)
          return
        }

        if (suffix === "/model" && req.method === "POST") {
          await readBody(req)
          sendJson(res, 204, undefined)
          return
        }

        if (suffix === "/prompt" && req.method === "POST") {
          counts.prompt += 1
          sessionIds.prompt.push(id)
          await readBody(req)
          sendJson(res, 200, { data: { messageID: "msg_e2e" } })
          return
        }

        if (suffix === "/wait" && req.method === "POST") {
          counts.wait += 1
          sessionIds.wait.push(id)
          waitCount += 1
          await readBody(req)

          if (waitCount <= 2) {
            // Hold the long poll open until the bridge refreshes it.
            // The client abort (connection close) must release it.
            await new Promise((resolve) => {
              const done = () => {
                req.off("close", done)
                res.off("close", done)
                resolve()
              }

              req.on("close", done)
              res.on("close", done)
            })

            try {
              res.destroy()
            } catch {
              // Best effort only.
            }

            return
          }

          sendJson(res, 204, undefined)
          return
        }

        if (suffix === "/context" && req.method === "GET") {
          counts.context += 1
          sessionIds.context.push(id)
          sendJson(res, 200, {
            data: [
              {
                type: "assistant",
                finish: "stop",
                content: [{ type: "text", text: "e2e wait refresh ok" }],
              },
            ],
          })
          return
        }

        if (suffix === "" && req.method === "GET") {
          counts.progress += 1
          sessionIds.progress.push(id)
          sendJson(res, 200, {
            data: {
              id,
              projectID: "proj_e2e",
              cost: 0.005,
              tokens: {
                input: 3,
                output: 4,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              time: { created: 1, updated: 7 },
              location: { directory: "/tmp" },
            },
          })
          return
        }

        if (suffix === "" && req.method === "DELETE") {
          counts.remove += 1
          sessionIds.remove.push(id)
          sendJson(res, 204, undefined)
          return
        }
      }

      sendJson(res, 404, { error: `unexpected ${req.method} ${url.pathname}` })
    } catch (error) {
      try {
        sendJson(res, 500, { error: String(error?.message ?? error) })
      } catch {
        // Best effort only.
      }
    }
  })

  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve))

  const address = http.address()

  if (!address || typeof address === "string") {
    throw new Error("fake OpenCode service did not bind a port")
  }

  const baseUrl = `http://127.0.0.1:${address.port}`

  await writeFile(
    join(stateHome, "opencode", "service.json"),
    JSON.stringify({
      id: "e2e-service",
      url: baseUrl,
      pid: process.pid,
    }) + "\n",
  )

  return { http, baseUrl }
}

try {
  fake = await startFakeOpenCode()

  child = spawn(
    process.execPath,
    [server],
    {
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        OPENCODE_MCP_ORCHESTRATOR_E2E_SESSION_WAIT_REFRESH_MS: String(REFRESH_MS),
        OPENCODE_MCP_ORCHESTRATOR_DEBUG: "1",
        OPENCODE_MCP_ORCHESTRATOR_BRIDGE_TIMEOUT_MS: "5000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")

  child.stderr.on("data", (chunk) => {
    stderr += chunk
  })

  let buffer = ""
  let nextId = 1
  const pending = new Map()

  child.stdout.on("data", (chunk) => {
    buffer += chunk

    while (true) {
      const newline = buffer.indexOf("\n")

      if (newline < 0) {
        break
      }

      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)

      if (!line) {
        continue
      }

      let message

      try {
        message = JSON.parse(line)
      } catch {
        continue
      }

      if (message.id === undefined || !pending.has(message.id)) {
        continue
      }

      const entry = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(entry.timer)

      if (message.error) {
        entry.reject(new Error(JSON.stringify(message.error)))
      } else {
        entry.resolve(message.result)
      }
    }
  })

  const send = (message) => {
    child.stdin.write(JSON.stringify(message) + "\n")
  }

  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }, ELAPSED_BUDGET_MS)

      pending.set(id, { resolve, reject, timer })
      send({ jsonrpc: "2.0", id, method, params })
    })

  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: {
      name: "opencode-mcp-orchestrator-wait-refresh-e2e",
      version: "1.0.0",
    },
  })

  send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  })

  const startedAt = Date.now()

  const result = await request(
    "tools/call",
    {
      name: "scout",
      arguments: {
        cwd: cwdDir,
        task: "session wait refresh probe task",
      },
    },
  )

  const elapsed = Date.now() - startedAt

  const text = (result?.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()

  if (result?.isError) {
    throw new Error(text || "scout returned an MCP error without text")
  }

  if (!text) {
    throw new Error("scout returned no final text")
  }

  if (counts.create !== 1) {
    throw new Error(`expected create=1, got ${counts.create}`)
  }

  if (counts.prompt !== 1) {
    throw new Error(`expected prompt=1, got ${counts.prompt}`)
  }

  if (counts.wait !== 3) {
    throw new Error(`expected waits=3, got ${counts.wait}`)
  }

  if (counts.progress !== 2) {
    throw new Error(`expected progress=2, got ${counts.progress}`)
  }

  if (counts.context !== 1) {
    throw new Error(`expected context=1, got ${counts.context}`)
  }

  if (counts.remove !== 1) {
    throw new Error(`expected remove=1, got ${counts.remove}`)
  }

  for (const [name, ids] of Object.entries(sessionIds)) {
    if (name === "create") {
      continue
    }

    for (const id of ids) {
      if (id !== SESSION_ID) {
        throw new Error(
          `expected every ${name} session ID to be ${SESSION_ID}, got ${id}`,
        )
      }
    }
  }

  const relevantRecords = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[opencode-mcp-orchestrator] "))
    .map((line) =>
      line.slice("[opencode-mcp-orchestrator] ".length),
    )
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })
    .filter((record) =>
      record?.event === "session_wait_refresh" ||
      record?.event === "session_progress" ||
      record?.event === "session_progress_unavailable",
    )

  const refreshRecords = relevantRecords.filter(
    (record) => record?.event === "session_wait_refresh",
  )

  const progressRecords = relevantRecords.filter(
    (record) => record?.event === "session_progress",
  )

  const unavailableRecords = relevantRecords.filter(
    (record) => record?.event === "session_progress_unavailable",
  )

  if (refreshRecords.length !== 2) {
    throw new Error(
      `expected exactly two session_wait_refresh records, got ${refreshRecords.length}`,
    )
  }

  refreshRecords.forEach((record, index) => {
    if (record.session_id !== SESSION_ID) {
      throw new Error(
        `refresh record ${index + 1} has wrong session id: ${record.session_id}`,
      )
    }

    if (record.wait_attempt !== index + 1) {
      throw new Error(
        `refresh record ${index + 1} has wrong attempt: ${record.wait_attempt}`,
      )
    }

    if (record.reason !== "bounded_wait_refresh_elapsed") {
      throw new Error(
        `refresh record ${index + 1} has wrong reason: ${record.reason}`,
      )
    }

    if (record.refresh_ms !== REFRESH_MS) {
      throw new Error(
        `refresh record ${index + 1} has wrong refresh_ms: ${record.refresh_ms}`,
      )
    }
  })

  if (progressRecords.length !== 2) {
    throw new Error(
      `expected exactly two session_progress records, got ${progressRecords.length}`,
    )
  }

  progressRecords.forEach((record, index) => {
    if (record.session_id !== SESSION_ID) {
      throw new Error(
        `progress record ${index + 1} has wrong session id: ${record.session_id}`,
      )
    }

    if (record.wait_attempt !== index + 1) {
      throw new Error(
        `progress record ${index + 1} has wrong attempt: ${record.wait_attempt}`,
      )
    }
  })

  if (unavailableRecords.length !== 0) {
    throw new Error(
      `expected no session_progress_unavailable records, got ${unavailableRecords.length}`,
    )
  }

  if (elapsed >= ELAPSED_BUDGET_MS) {
    throw new Error(
      `probe took too long: ${elapsed}ms (budget ${ELAPSED_BUDGET_MS}ms)`,
    )
  }

  failed = false
  console.log("MCP_SESSION_WAIT_REFRESH_E2E_OK")
} catch (error) {
  console.error(error.stack || error.message || String(error))

  if (stderr.trim()) {
    console.error()
    console.error("MCP server stderr:")
    console.error(stderr.trim())
  }

  process.exitCode = 1
} finally {
  if (child) {
    child.stdin.end()

    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve))
      child.kill("SIGTERM")
      await exited
    }
  }

  try {
    await new Promise((resolve) => fake?.http.close(resolve))
  } catch {
    // Ignore close errors; the probe outcome is already decided.
  }

  await rm(root, { recursive: true, force: true })

  if (failed && process.exitCode !== 1) {
    process.exitCode = 1
  }
}
