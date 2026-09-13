import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

import {
  isProbeTimeoutResult,
  probeCommandName,
  probeTimeoutMessage,
  SUBPROCESS_PROBE_TIMEOUT_MS,
} from "../../installer/path-security.mjs"

test("probe timeout is a shared conservative value", () => {
  assert.equal(typeof SUBPROCESS_PROBE_TIMEOUT_MS, "number")
  assert.ok(
    SUBPROCESS_PROBE_TIMEOUT_MS >= 15000 &&
      SUBPROCESS_PROBE_TIMEOUT_MS <= 30000,
    `expected 15000-30000ms, got ${SUBPROCESS_PROBE_TIMEOUT_MS}`,
  )
})

test("isProbeTimeoutResult distinguishes ETIMEDOUT from nonzero exit", () => {
  assert.equal(
    isProbeTimeoutResult({ error: { code: "ETIMEDOUT" } }),
    true,
  )
  assert.equal(isProbeTimeoutResult({ status: 1 }), false)
  assert.equal(isProbeTimeoutResult({ status: 0 }), false)
  assert.equal(isProbeTimeoutResult({ error: { code: "ENOENT" } }), false)
  assert.equal(isProbeTimeoutResult(null), false)
  assert.equal(isProbeTimeoutResult(undefined), false)
})

test("probeTimeoutMessage is command-name-only", () => {
  const codexMessage = probeTimeoutMessage("codex")
  assert.match(codexMessage, /codex/)
  assert.match(codexMessage, /timed out/i)
  assert.ok(!codexMessage.includes("secret-token"))
  assert.ok(!codexMessage.includes("--scope"))

  const absolute = probeTimeoutMessage("/usr/local/bin/claude")
  assert.match(absolute, /claude/)
  assert.ok(!absolute.includes("/usr/local/bin"))
  assert.ok(!absolute.includes("stdout"))
})

test("probeCommandName uses basename only", () => {
  assert.equal(probeCommandName("codex"), "codex")
  assert.equal(probeCommandName("/opt/tools/codex"), "codex")
  assert.equal(probeCommandName(""), "command")
})

test("real spawnSync timeout is detected as timeout, not nonzero exit", () => {
  const result = spawnSync(
    process.execPath,
    ["-e", "setTimeout(() => {}, 5000)"],
    {
      encoding: "utf8",
      timeout: 50,
    },
  )

  assert.equal(isProbeTimeoutResult(result), true)
  assert.notEqual(result.status, 1)

  const message = probeTimeoutMessage("node")
  assert.match(message, /node/)
  assert.ok(!String(result.stdout ?? "").includes(message))
})
