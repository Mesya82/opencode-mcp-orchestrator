#!/usr/bin/env node

// Live MCP cancellation probe for the current source bridge.
//
// This probes the bundled server at PATH_TO_MCP_SERVER against the currently
// installed OpenCode backend/agent/plugin unless an isolated deployment is
// explicitly supplied (isolated config, HOME, and PATH). It uses a read-only
// runner task and never edits the repository through the live task.

import {
  execFileSync,
} from "node:child_process"
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
const repositoryArg = process.argv[3]

if (!serverArg || !repositoryArg) {
  throw new Error(
    "usage: mcp-cancel-probe.mjs PATH_TO_MCP_SERVER REPOSITORY [ABORT_DELAY_MS]",
  )
}

const server = await realpath(serverArg)
const repository = await realpath(repositoryArg)

const rawAbortDelay =
  process.argv[4] ??
  process.env.OPENCODE_MCP_CANCEL_PROBE_ABORT_MS ??
  "3000"
const abortDelayMs = Number.parseInt(rawAbortDelay, 10)

if (!Number.isInteger(abortDelayMs) || abortDelayMs <= 0) {
  throw new Error(
    `invalid abort delay: ${JSON.stringify(rawAbortDelay)} (expected a positive integer in milliseconds)`,
  )
}

const CLIENT_CALL_TIMEOUT_MS = 120_000
const CANCELLATION_PROMPT_BUDGET_MS = 30_000

function gitStatusPorcelain(cwd) {
  return execFileSync(
    "git",
    ["status", "--porcelain"],
    {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
    },
  )
}

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
  name: "opencode-mcp-orchestrator-live-cancel-test",
  version: "1.0.0",
})

const probeStartedAt = Date.now()
let abortTimer = undefined
let cancelElapsedMs = 0
let failed = true

try {
  await client.connect(transport)

  const before = gitStatusPorcelain(repository)

  const controller = new AbortController()
  abortTimer = setTimeout(() => {
    controller.abort()
  }, abortDelayMs)

  const callStartedAt = Date.now()

  try {
    const result = await client.callTool(
      {
        name: "runner",
        arguments: {
          cwd: repository,
          command: "sleep 60",
          objective:
            "Cancellation probe only: confirm the request can be cancelled promptly without editing any files.",
          timeout_seconds: 90,
          workspace_access: "read_only",
        },
      },
      {
        signal: controller.signal,
        timeout: CLIENT_CALL_TIMEOUT_MS,
      },
    )

    throw new Error(
      `expected runner call to reject on cancellation but it resolved as an ordinary tool result: ${JSON.stringify(result)?.slice(0, 500)}`,
    )
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(
        "expected runner call to reject on cancellation",
      )
    ) {
      throw error
    }

    cancelElapsedMs = Date.now() - callStartedAt

    if (cancelElapsedMs >= CANCELLATION_PROMPT_BUDGET_MS) {
      throw new Error(
        `cancellation was not prompt: rejected after ${cancelElapsedMs}ms (budget ${CANCELLATION_PROMPT_BUDGET_MS}ms): ${error?.stack || error?.message || String(error)}`,
      )
    }

    const haystack =
      `${error?.name ?? ""} ${error?.code ?? ""} ${error?.message ?? String(error)}`.toLowerCase()
    const looksLikeCancellation =
      haystack.includes("abort") ||
      haystack.includes("cancel") ||
      haystack.includes("timeout") ||
      haystack.includes("timed out")

    if (!looksLikeCancellation) {
      throw new Error(
        `runner call rejected but not as cancellation (elapsed ${cancelElapsedMs}ms): ${error?.stack || error?.message || String(error)}`,
      )
    }
  } finally {
    if (abortTimer !== undefined) {
      clearTimeout(abortTimer)
      abortTimer = undefined
    }
  }

  const tools = await client.listTools()

  const toolNames = (tools?.tools ?? []).map((tool) => tool?.name)
  if (!toolNames.includes("runner")) {
    throw new Error(
      `client.listTools did not still work after cancellation (tools: ${JSON.stringify(toolNames)})`,
    )
  }

  const after = gitStatusPorcelain(repository)

  if (after !== before) {
    throw new Error(
      `worktree snapshot changed across the cancellation probe:\nbefore:\n${before}\nafter:\n${after}`,
    )
  }

  failed = false
  const elapsedMs = Date.now() - probeStartedAt
  console.log(
    `LIVE_MCP_CANCELLATION_PASS elapsed_ms=${elapsedMs} cancel_elapsed_ms=${cancelElapsedMs}`,
  )
} catch (error) {
  console.error(error.stack || error.message || String(error))

  if (stderr.trim()) {
    console.error("\nMCP server stderr:")
    console.error(stderr.trim())
  }

  process.exitCode = 1
} finally {
  if (abortTimer !== undefined) {
    clearTimeout(abortTimer)
    abortTimer = undefined
  }

  try {
    await client.close()
  } catch {
    // Ignore close errors; the probe outcome is already decided.
  }

  try {
    await transport.close?.()
  } catch {
    // Ignore close errors; the probe outcome is already decided.
  }

  if (!failed && stderr.trim()) {
    // Captured stderr is diagnostic only; print it solely on failure.
  }
}
