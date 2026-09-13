import assert from "node:assert/strict"
import test from "node:test"

import {
  assertRunnerTimeoutFits,
  normalizeConfigTimeoutLimits,
  normalizeTimeoutLimits,
  timeoutLimitConfig,
} from "../../config/timeout-limits.mjs"

test("timeout profiles provide independent role and parent budgets", () => {
  assert.deepEqual(
    normalizeTimeoutLimits(undefined),
    {
      profile: "standard",
      limits: {
        scout: 300,
        worker: 600,
        runner: 1200,
      },
      parentTimeoutSeconds: 1500,
    },
  )

  assert.equal(
    normalizeTimeoutLimits({ profile: "extended" }).parentTimeoutSeconds,
    2100,
  )

  assert.equal(
    normalizeConfigTimeoutLimits({
      stepLimits: { profile: "extended" },
    }).profile,
    "extended",
  )
})

test("custom timeout profile validates every deadline and reserve", () => {
  const value = {
    profile: "custom",
    scout: 400,
    worker: 800,
    runner: 1000,
    parent: 1100,
  }

  assert.deepEqual(
    timeoutLimitConfig("custom", value),
    value,
  )

  assert.throws(
    () => normalizeTimeoutLimits({ ...value, scout: 0 }),
    /timeout for role "scout"/,
  )

  assert.throws(
    () => normalizeTimeoutLimits({ ...value, parent: 1059 }),
    /at least 60 seconds longer/,
  )
})

test("Runner command timeout must leave operation reserve", () => {
  assert.doesNotThrow(
    () => assertRunnerTimeoutFits(900, 1200),
  )

  assert.throws(
    () => assertRunnerTimeoutFits(1141, 1200),
    /does not fit/,
  )
})
