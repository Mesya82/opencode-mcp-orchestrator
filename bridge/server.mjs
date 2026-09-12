import { realpath } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import * as z from "zod/v4"

import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

import {
  extractFinalText,
  messageType,
} from "./final-text.mjs"

let clientPromise

function configPath() {
  if (process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG) {
    return process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG
  }

  const home = process.env.HOME

  if (!home) {
    throw new Error(
      "HOME is not set and OPENCODE_MCP_ORCHESTRATOR_CONFIG was not provided"
    )
  }

  const configHome =
    process.env.XDG_CONFIG_HOME ||
    `${home}/.config`

  return `${configHome}/opencode-mcp-orchestrator/config.json`
}

function parseModelReference(reference, role) {
  if (
    typeof reference !== "string" ||
    reference.trim() === ""
  ) {
    throw new Error(
      `no model configured for role "${role}"`
    )
  }

  const value = reference.trim()
  const slash = value.indexOf("/")

  if (
    slash <= 0 ||
    slash === value.length - 1
  ) {
    throw new Error(
      `invalid model reference for role "${role}": ${value}`
    )
  }

  return {
    reference: value,
    providerID: value.slice(0, slash),
    id: value.slice(slash + 1),
  }
}

async function configuredModel(role) {
  const path = configPath()

  let raw

  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `configuration not found: ${path}. Run the model configurator first.`
      )
    }

    throw error
  }

  let config

  try {
    config = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `failed to parse configuration ${path}: ${error.message}`
    )
  }

  return parseModelReference(
    config?.models?.[role],
    role,
  )
}

function debug(message) {
  if (
    process.env.OPENCODE_MCP_ORCHESTRATOR_DEBUG === "1"
  ) {
    /*
     * stdout is reserved for MCP protocol traffic.
     */
    console.error(
      `[opencode-mcp-orchestrator] ${message}`
    )
  }
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const endpoint = await Service.ensure()

      return OpenCode.make({
        baseUrl: endpoint.url,
        headers: Service.headers(endpoint),
      })
    })()
  }

  return clientPromise
}

async function runAgent(directoryArg, task, agent, role) {
  const directory = await realpath(directoryArg)
  const client = await getClient()
  const model = await configuredModel(role)

  debug(
    `${role}: agent=${agent} model=${model.reference} cwd=${directory}`
  )

  const session = await client.session.create({
    location: { directory },
  })

  await client.session.switchAgent({
    sessionID: session.id,
    agent,
  })

  await client.session.switchModel({
    sessionID: session.id,
    model: {
      providerID: model.providerID,
      id: model.id,
    },
  })

  await client.session.prompt({
    sessionID: session.id,
    text: task,
  })

  await client.session.wait({
    sessionID: session.id,
  })

  const raw = await client.session.context({
    sessionID: session.id,
  })

  const messages =
    Array.isArray(raw) ? raw :
    Array.isArray(raw?.messages) ? raw.messages :
    Array.isArray(raw?.data) ? raw.data :
    []

  const assistants = messages.filter(
    (message) => messageType(message) === "assistant"
  )

  const last = assistants.at(-1)

  return extractFinalText(last, {
    agent,
    sessionID: session.id,
  })
}

function errorResult(name, error) {
  const message =
    error instanceof Error
      ? error.message
      : String(error)

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `OpenCode ${name} failed: ${message}`,
      },
    ],
  }
}

function createServer() {
  const server = new McpServer({
    name: "opencode-agents",
    version: "0.3.0",
  })

  server.registerTool(
    "scout",
    {
      title: "OpenCode Orchestrator Scout",
      description:
        "Run read-only repository reconnaissance in a fresh OpenCode session using the configured OpenCode model. " +
        "Use for code discovery, tracing, locating symbols, callers, state changes, tests, " +
        "configuration, and exact implementation facts.",
      inputSchema: z.object({
        cwd: z.string().min(1).describe(
          "Absolute path to the repository or worktree to inspect"
        ),
        task: z.string().min(1).describe(
          "Complete self-contained reconnaissance task"
        ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ cwd, task }) => {
      try {
        const text = await runAgent(cwd, task, "opencode-orchestrator-scout", "scout")
        return { content: [{ type: "text", text }] }
      } catch (error) {
        return errorResult("scout", error)
      }
    },
  )

  server.registerTool(
    "worker",
    {
      title: "OpenCode Orchestrator Worker",
      description:
        "Run a bounded repository implementation task in a fresh OpenCode session using the configured OpenCode model. " +
        "The worker may edit ordinary workspace files and use its isolated sandbox_shell for " +
        "focused verification. Git metadata is protected and model-controlled shell networking " +
        "is blocked.",
      inputSchema: z.object({
        cwd: z.string().min(1).describe(
          "Absolute path to the repository or worktree to modify"
        ),
        task: z.string().min(1).describe(
          "Complete self-contained bounded implementation task including acceptance criteria and verification"
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ cwd, task }) => {
      try {
        const text = await runAgent(cwd, task, "opencode-orchestrator-worker", "worker")
        return { content: [{ type: "text", text }] }
      } catch (error) {
        return errorResult("worker", error)
      }
    },
  )

  server.registerTool(
    "runner",
    {
      title: "OpenCode Orchestrator Runner",
      description:
        "Run a potentially noisy local build, test, diagnostic, lint, typecheck, or log-producing command and return only a concise delegated-model analysis. " +
        "The command runs in an isolated networkless sandbox with Git metadata protected. " +
        "Use this instead of running large-output commands directly in the root model.",
      inputSchema: z.object({
        cwd: z.string().min(1).describe(
          "Absolute path to the repository or worktree in which to run the command"
        ),
        command: z.string().min(1).describe(
          "Exact local command to execute"
        ),
        objective: z.string().min(1).describe(
          "What the runner should determine from the command result and output"
        ),
        expected: z.string().optional().describe(
          "Optional expected result or condition to check"
        ),
        timeout_seconds: z.number().int().min(1).max(3600).optional().describe(
          "Maximum command runtime in seconds"
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({
      cwd,
      command,
      objective,
      expected,
      timeout_seconds,
    }) => {
      try {
        const timeout = timeout_seconds ?? 900

        const task = [
          "Execute and analyze one local command.",
          "",
          "Command:",
          command,
          "",
          "Objective:",
          objective,
          "",
          "Expected condition:",
          expected ?? "None specified.",
          "",
          `Maximum runtime: ${timeout} seconds.`,
          "",
          "Run the command exactly once with sandbox_run.",
          "Pass the requested maximum runtime to sandbox_run.",
          "If the initial result is insufficient, inspect the persisted output with sandbox_log.",
          "Do not modify source files or attempt repairs.",
          "Do not run replacement or follow-up substantive commands.",
          "Return a concise result containing the actual exit code, whether the objective/expected condition was met, and only the smallest useful diagnostic evidence.",
        ].join("\\n")

        const text = await runAgent(
          cwd,
          task,
          "opencode-orchestrator-runner",
          "runner",
        )

        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        }
      } catch (error) {
        return errorResult(
          "runner",
          error,
        )
      }
    },
  )

  return server
}

serveStdio(createServer)
