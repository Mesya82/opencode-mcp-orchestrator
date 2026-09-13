import assert from "node:assert/strict"
import test from "node:test"

import {
  codexConfigPath,
  readCodexMcpToolTimeout,
  setCodexMcpToolTimeout,
} from "../../installer/codex-config.mjs"

test("Codex config path honors an absolute CODEX_HOME", () => {
  assert.equal(
    codexConfigPath({ CODEX_HOME: "/tmp/codex", HOME: "/home/test" }),
    "/tmp/codex/config.toml",
  )

  assert.throws(
    () => codexConfigPath({ CODEX_HOME: "relative", HOME: "/home/test" }),
    /absolute path/,
  )
})

test("Codex MCP timeout is inserted without changing other sections", () => {
  const source = [
    "model = \"example\"",
    "",
    "[mcp_servers.opencode-agents]",
    "command = \"node\"",
    "args = [\"server.mjs\"]",
    "",
    "[features]",
    "example = true",
    "",
  ].join("\n")

  const result = setCodexMcpToolTimeout(
    source,
    "opencode-agents",
    2100,
  )

  assert.equal(readCodexMcpToolTimeout(result, "opencode-agents"), 2100)
  assert.match(result, /\[features\]\nexample = true/)
})

test("Codex MCP timeout updates a quoted section and rejects ambiguity", () => {
  const source = [
    "[mcp_servers.\"opencode-agents\"]",
    "tool_timeout_sec = 900 # old",
    "",
  ].join("\n")

  const result = setCodexMcpToolTimeout(
    source,
    "opencode-agents",
    1500,
  )

  assert.equal(readCodexMcpToolTimeout(result, "opencode-agents"), 1500)
  assert.doesNotMatch(result, /900/)

  assert.throws(
    () => setCodexMcpToolTimeout(
      `${source}[mcp_servers.opencode-agents]\n`,
      "opencode-agents",
      1500,
    ),
    /exactly one/,
  )
})
