#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, realpath } from "node:path"
import { spawnSync } from "node:child_process"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

const serverArg = process.argv[2]

if (!serverArg) {
  throw new Error("usage: mcp-worker-probe.mjs PATH_TO_MCP_SERVER")
}

const server = await realpath(serverArg)
const workspace = await mkdtemp(join(tmpdir(), "opencode-worker-live-"))
const markerPath = join(workspace, "worker-probe.txt")
const expectedMarker = "STABLE-V2-WORKER-PASS\n"

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
  })

  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    )
  }

  return result.stdout.trim()
}

await writeFile(join(workspace, "README.md"), "worker live probe\n", "utf8")
runGit(["init", "-q"])
runGit(["add", "README.md"])
runGit([
  "-c", "user.name=OpenCode Worker Probe",
  "-c", "user.email=worker-probe@example.invalid",
  "commit", "-qm", "probe baseline",
])

const gitHeadBefore = runGit(["rev-parse", "HEAD"])

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
  name: "opencode-mcp-orchestrator-live-worker-test",
  version: "1.0.0",
})

try {
  await client.connect(transport)

  const result = await client.callTool(
    {
      name: "worker",
      arguments: {
        cwd: workspace,
        task: [
          "Perform exactly this bounded implementation task:",
          "1. Create worker-probe.txt in the repository root containing exactly STABLE-V2-WORKER-PASS followed by one newline.",
          "2. Use sandbox_shell to run: test \"$(cat worker-probe.txt)\" = STABLE-V2-WORKER-PASS", 
          "3. Do not modify any other file.",
          "4. Do not perform any Git mutation.",
          "Return a concise final response after verification.",
        ].join("\n"),
      },
    },
    { timeout: 300_000 },
  )

  const text = (result?.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()

  if (result?.isError) {
    throw new Error(text || "worker returned an MCP error without text")
  }

  const marker = await readFile(markerPath, "utf8")
  if (marker !== expectedMarker) {
    throw new Error(`worker marker mismatch: ${JSON.stringify(marker)}`)
  }

  const gitHeadAfter = runGit(["rev-parse", "HEAD"])
  if (gitHeadAfter !== gitHeadBefore) {
    throw new Error("worker modified Git HEAD")
  }

  const status = runGit(["status", "--porcelain"])
  if (status !== "?? worker-probe.txt") {
    throw new Error(`unexpected workspace changes: ${JSON.stringify(status)}`)
  }

  console.log(text)
  console.log("\nLIVE_WORKER_PASS")
} catch (error) {
  console.error(error.stack || error.message || String(error))

  if (stderr.trim()) {
    console.error("\nMCP server stderr:")
    console.error(stderr.trim())
  }

  process.exitCode = 1
} finally {
  await client.close()
  await rm(workspace, { recursive: true, force: true })
}
