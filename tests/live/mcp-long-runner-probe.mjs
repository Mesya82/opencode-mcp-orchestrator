#!/usr/bin/env node

// Live regression for OpenCode's approximately 300-second session.wait()
// response-header boundary. The source bridge must refresh only the wait
// request and allow the delegated read-only session to finish normally.

import {
  mkdtemp,
  realpath,
  rm,
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
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio"

const serverArg = process.argv[2]
const rawSleepSeconds = process.argv[3] ?? "330"
const sleepSeconds = Number.parseInt(rawSleepSeconds, 10)

if (!serverArg) {
  throw new Error(
    "usage: mcp-long-runner-probe.mjs PATH_TO_MCP_SERVER [SLEEP_SECONDS]",
  )
}

if (
  !Number.isInteger(sleepSeconds) ||
  sleepSeconds <= 300 ||
  sleepSeconds > 600
) {
  throw new Error(
    `invalid sleep seconds: ${JSON.stringify(rawSleepSeconds)} (expected 301..600)`,
  )
}

const server = await realpath(serverArg)
const probeDirectory = await mkdtemp(
  join(tmpdir(), "opencode-long-runner-probe-"),
)

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [server],
  env: {
    ...process.env,
    OPENCODE_MCP_ORCHESTRATOR_DEBUG: "1",
  },
  stderr: "pipe",
})

let stderr = ""

transport.stderr?.setEncoding("utf8")
transport.stderr?.on("data", (chunk) => {
  stderr += chunk
})

const client = new Client({
  name: "opencode-mcp-orchestrator-live-long-runner-test",
  version: "1.0.0",
})

const startedAt = Date.now()

try {
  await client.connect(transport)

  const result = await client.callTool(
    {
      name: "runner",
      arguments: {
        cwd: probeDirectory,
        command: `sleep ${sleepSeconds}`,
        objective:
          "Confirm that the command completed successfully after crossing the former OpenCode session wait transport boundary.",
        expected:
          `Exit status 0 after approximately ${sleepSeconds} seconds.`,
        timeout_seconds: sleepSeconds + 30,
        workspace_access: "read_only",
      },
    },
    {
      timeout: (sleepSeconds + 300) * 1000,
    },
  )

  const elapsedMs = Date.now() - startedAt
  const text = (result?.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()

  if (result?.isError) {
    throw new Error(text || "runner returned an MCP error without text")
  }

  if (elapsedMs <= 300_000) {
    throw new Error(
      `runner returned before crossing the regression boundary: ${elapsedMs}ms`,
    )
  }

  if (!text) {
    throw new Error("runner returned no final text")
  }

  const refreshRecords = stderr
    .split("\n")
    .filter((line) => line.includes('"event":"session_wait_refresh"'))
  const expectedRefreshes = Math.floor(sleepSeconds / 240)

  if (refreshRecords.length < expectedRefreshes) {
    throw new Error(
      `runner observed ${refreshRecords.length} wait refreshes; expected at least ${expectedRefreshes}: ${stderr}`,
    )
  }

  console.log(
    `LIVE_LONG_RUNNER_PASS elapsed_ms=${elapsedMs} sleep_seconds=${sleepSeconds} wait_refreshes=${refreshRecords.length}`,
  )
  console.log(refreshRecords.join("\n"))
  console.log(text)
} catch (error) {
  if (stderr.trim() !== "") {
    console.error(stderr.trim())
  }

  throw error
} finally {
  await client.close().catch(() => {})
  await rm(probeDirectory, { recursive: true, force: true })
}
