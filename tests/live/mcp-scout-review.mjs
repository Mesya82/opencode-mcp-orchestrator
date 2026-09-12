#!/usr/bin/env node

import {
  readFile,
  realpath,
} from "node:fs/promises"
import {
  resolve,
} from "node:path"
import {
  Client,
} from "@modelcontextprotocol/client"
import {
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio"

import {
  normalizeStepLimits,
  toolStepCutoff,
} from "../../config/step-limits.mjs"

const serverArg = process.argv[2]
const repositoryArg = process.argv[3]

if (!serverArg || !repositoryArg) {
  throw new Error(
    "usage: mcp-scout-review.mjs PATH_TO_MCP_SERVER REPOSITORY",
  )
}

const server = await realpath(serverArg)
const repository = await realpath(repositoryArg)

const configPath =
  process.env.OPENCODE_MCP_ORCHESTRATOR_CONFIG ||
  resolve(
    process.env.XDG_CONFIG_HOME ||
      resolve(process.env.HOME, ".config"),
    "opencode-mcp-orchestrator/config.json",
  )

const config =
  JSON.parse(
    await readFile(
      configPath,
      "utf8",
    ),
  )

const scoutLimit =
  normalizeStepLimits(
    config.stepLimits,
  ).limits.scout

const scoutCutoff =
  toolStepCutoff(
    scoutLimit,
  )

const task = `Step-budget requirement:
You have at most ${scoutLimit} model steps. OpenCode's final step is text-only and cannot call tools.
Complete all tool activity by step ${scoutCutoff} of ${scoutLimit} and reserve the remaining steps to synthesize and return your final response.

Goal:
Perform a thorough, read-only repository review that gives the parent agent enough factual evidence to assess architecture, implementation quality, reliability, security, testing, documentation, packaging, and maintainability.

Relevant known context:
This repository is named opencode-mcp-orchestrator. The user wants what is good, what is bad, and what can be improved. Do not modify anything and do not run Git-mutating commands.

Facts to find:
1. Repository purpose, supported workflows, major modules, and end-to-end control/data flow.
2. Public interfaces and protocol boundaries, especially MCP-facing input/output, process/session lifecycle, filesystem/worktree access, sandboxing, model/provider configuration, and error handling.
3. Strong design choices, each tied to exact repository evidence.
4. Defects, correctness risks, security risks, concurrency/lifecycle hazards, fragile assumptions, misleading documentation, missing validation, and maintainability problems. Rank each by severity and confidence.
5. Test architecture and coverage: what important behavior is covered and what meaningful behaviors are absent or weak.
6. Build, lint, typing, packaging, CI, and release setup. Identify exact verification commands.
7. Documentation quality and any discrepancies between docs, configuration, and code.
8. Git/worktree state only insofar as read-only status reveals uncommitted files that could affect review attribution.

Evidence required:
Use repository-relative paths and line numbers where possible; name exact functions, classes, and symbols. For parsing, deserialization, subprocess invocation, environment assignment, path resolution, session mutation, permission checks, and cleanup, include the literal operation and its containing function. Distinguish confirmed problems from possible risks. Avoid generic advice unsupported by repository evidence.

Constraints:
Read-only. No file edits. No Git mutations. Do not access secrets or include credential contents. Keep the report comprehensive but evidence-dense, not a tutorial.

Output format:
A. Executive architecture map
B. What is good with evidence
C. Findings ordered Critical, High, Medium, and Low, including severity, confidence, evidence, impact, and suggested direction
D. Test and quality tooling assessment
E. Documentation assessment
F. Exact recommended verification commands
G. Prioritized improvement roadmap: Now, Next, Later
H. Review limitations`

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [server],
  env: process.env,
  stderr: "pipe",
})

let stderr = ""

transport.stderr?.setEncoding("utf8")
transport.stderr?.on("data", (chunk) => {
  stderr += chunk
})

const client = new Client({
  name: "opencode-mcp-orchestrator-live-scout-test",
  version: "1.0.0",
})

try {
  await client.connect(transport)

  const result = await client.callTool(
    {
      name: "scout",
      arguments: {
        cwd: repository,
        task,
      },
    },
    {
      timeout: 300_000,
    },
  )

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

  console.log(text)
  console.log("\nLIVE_SCOUT_REVIEW_PASS")
} catch (error) {
  console.error(error.stack || error.message || String(error))

  if (stderr.trim()) {
    console.error("\nMCP server stderr:")
    console.error(stderr.trim())
  }

  process.exitCode = 1
} finally {
  await client.close()
}
