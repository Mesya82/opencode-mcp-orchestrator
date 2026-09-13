import assert from "node:assert/strict"
import test from "node:test"

import {
  assertOperationTimeoutFitsParent,
  assertRunnerTimeoutFits,
  CALLER_BUDGET_RESERVE_SECONDS,
  CALLER_CLEANUP_RESERVE_SECONDS,
  CALLER_RESULT_RESERVE_SECONDS,
  MIN_PARENT_RESERVE_SECONDS,
  normalizeConfigTimeoutLimits,
  normalizeTimeoutLimits,
  TIMEOUT_LIMIT_PROFILES,
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

test("caller-budget reserves stay within the existing parent reserve", () => {
  assert.equal(
    CALLER_BUDGET_RESERVE_SECONDS,
    CALLER_CLEANUP_RESERVE_SECONDS + CALLER_RESULT_RESERVE_SECONDS,
  )
  assert.ok(
    CALLER_BUDGET_RESERVE_SECONDS <= MIN_PARENT_RESERVE_SECONDS,
    `caller reserve ${CALLER_BUDGET_RESERVE_SECONDS}s must not exceed parent reserve ${MIN_PARENT_RESERVE_SECONDS}s`,
  )

  for (const profile of Object.values(TIMEOUT_LIMIT_PROFILES)) {
    const longest = Math.max(profile.scout, profile.worker, profile.runner)

    assert.ok(
      longest + CALLER_BUDGET_RESERVE_SECONDS <= profile.parent,
      `profile with parent ${profile.parent}s must still fit longest role ${longest}s plus caller reserve`,
    )
  }
})

test("operation timeout must fit within the configured parent budget", () => {
  assert.doesNotThrow(
    () => assertOperationTimeoutFitsParent(600, 1500, "worker", "configured parent"),
  )

  const reserve = CALLER_BUDGET_RESERVE_SECONDS
  const parent = 200

  assert.doesNotThrow(
    () => assertOperationTimeoutFitsParent(parent - reserve, parent, "worker", "configured parent"),
  )

  let error = null

  try {
    assertOperationTimeoutFitsParent(parent - reserve + 1, parent, "worker", "configured parent")
  } catch (caught) {
    error = caught
  }

  assert.ok(error instanceof Error, "expected budget rejection to throw")
  assert.match(error.message, /does not fit/)
  assert.match(error.message, /worker/)
  assert.match(error.message, /configured parent/)
  assert.match(error.message, new RegExp(`${reserve}s`))
  assert.match(error.message, new RegExp(`${parent}s`))
})
