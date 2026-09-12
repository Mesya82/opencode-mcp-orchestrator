#!/usr/bin/env node

import {
  spawn,
} from "node:child_process"

const server =
  process.argv[2]

if (!server) {
  throw new Error(
    "usage: mcp-probe.mjs PATH_TO_MCP_SERVER",
  )
}

const child =
  spawn(
    process.execPath,
    [
      server,
    ],
    {
      env:
        process.env,

      stdio: [
        "pipe",
        "pipe",
        "pipe",
      ],
    },
  )

child.stdout.setEncoding("utf8")
child.stderr.setEncoding("utf8")

let stderr = ""
let buffer = ""
let nextId = 1

const pending =
  new Map()

child.stderr.on(
  "data",
  (chunk) => {
    stderr += chunk
  },
)

child.stdout.on(
  "data",
  (chunk) => {
    buffer += chunk

    while (true) {
      const newline =
        buffer.indexOf("\n")

      if (newline < 0) {
        break
      }

      const line =
        buffer
          .slice(0, newline)
          .trim()

      buffer =
        buffer.slice(
          newline + 1,
        )

      if (!line) {
        continue
      }

      let message

      try {
        message =
          JSON.parse(line)
      } catch {
        continue
      }

      if (
        message.id !== undefined &&
        pending.has(message.id)
      ) {
        const {
          resolve,
          reject,
          timer,
        } =
          pending.get(message.id)

        pending.delete(
          message.id,
        )

        clearTimeout(timer)

        if (message.error) {
          reject(
            new Error(
              JSON.stringify(
                message.error,
              ),
            ),
          )
        } else {
          resolve(
            message.result,
          )
        }
      }
    }
  },
)

function send(message) {
  child.stdin.write(
    JSON.stringify(message) +
      "\n",
  )
}

function request(
  method,
  params = {},
) {
  const id =
    nextId++

  return new Promise(
    (
      resolve,
      reject,
    ) => {
      const timer =
        setTimeout(
          () => {
            pending.delete(id)

            reject(
              new Error(
                `timeout waiting for ${method}`,
              ),
            )
          },
          10000,
        )

      pending.set(
        id,
        {
          resolve,
          reject,
          timer,
        },
      )

      send({
        jsonrpc:
          "2.0",

        id,

        method,

        params,
      })
    },
  )
}

try {
  const initialized =
    await request(
      "initialize",
      {
        protocolVersion:
          "2025-06-18",

        capabilities:
          {},

        clientInfo: {
          name:
            "opencode-mcp-orchestrator-e2e",

          version:
            "1.0.0",
        },
      },
    )

  if (
    !initialized ||
    typeof initialized !== "object"
  ) {
    throw new Error(
      "invalid initialize response",
    )
  }

  send({
    jsonrpc:
      "2.0",

    method:
      "notifications/initialized",

    params:
      {},
  })

  const result =
    await request(
      "tools/list",
      {},
    )

  const actual =
    (result?.tools ?? [])
      .map(
        (tool) =>
          tool.name,
      )
      .sort()

  const expected = [
    "runner",
    "scout",
    "worker",
  ]

  if (
    JSON.stringify(actual) !==
    JSON.stringify(expected)
  ) {
    throw new Error(
      [
        "unexpected MCP tool set",
        `expected: ${expected.join(", ")}`,
        `actual:   ${actual.join(", ")}`,
      ].join("\n"),
    )
  }

  console.log(
    `MCP tools: ${actual.join(", ")}`,
  )

  console.log(
    "MCP_TOOLS_OK",
  )
} catch (error) {
  console.error(
    error.stack ||
    error.message ||
    String(error),
  )

  if (stderr.trim()) {
    console.error()
    console.error(
      "MCP server stderr:",
    )
    console.error(
      stderr.trim(),
    )
  }

  process.exitCode = 1
} finally {
  child.stdin.end()
  child.kill("SIGTERM")
}
