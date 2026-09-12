import assert from "node:assert/strict"
import test from "node:test"

import {
  MAX_STEP_LIMIT,
  MIN_STEP_LIMIT,
  normalizeStepLimits,
  renderAgentStepLimit,
  STEP_LIMIT_PROFILES,
  stepLimitConfig,
  toolStepCutoff,
} from "../../config/step-limits.mjs"

test("missing settings select the raised standard profile", () => {
  assert.deepEqual(
    normalizeStepLimits(undefined),
    {
      profile: "standard",
      limits: {
        scout: 16,
        worker: 32,
        runner: 40,
      },
    },
  )
})

test("extended selects the larger preset", () => {
  assert.deepEqual(
    normalizeStepLimits({ profile: "extended" }).limits,
    STEP_LIMIT_PROFILES.extended,
  )
})

test("custom requires a valid integer for every role", () => {
  assert.deepEqual(
    normalizeStepLimits({
      profile: "custom",
      scout: 20,
      worker: 36,
      runner: 44,
    }),
    {
      profile: "custom",
      limits: {
        scout: 20,
        worker: 36,
        runner: 44,
      },
    },
  )

  for (const value of [
    MIN_STEP_LIMIT - 1,
    MAX_STEP_LIMIT + 1,
    12.5,
    undefined,
  ]) {
    assert.throws(
      () => normalizeStepLimits({
        profile: "custom",
        scout: value,
        worker: 36,
        runner: 44,
      }),
      /step limit for role "scout"/,
    )
  }
})

test("stepLimitConfig stores preset profiles without redundant numbers", () => {
  assert.deepEqual(
    stepLimitConfig("extended"),
    { profile: "extended" },
  )

  assert.deepEqual(
    stepLimitConfig("custom", {
      scout: 20,
      worker: 36,
      runner: 44,
    }),
    {
      profile: "custom",
      scout: 20,
      worker: 36,
      runner: 44,
    },
  )
})

test("tool cutoff reserves twenty percent with a two-step minimum", () => {
  assert.equal(toolStepCutoff(4), 2)
  assert.equal(toolStepCutoff(16), 12)
  assert.equal(toolStepCutoff(32), 25)
  assert.equal(toolStepCutoff(40), 32)
})

test("agent rendering keeps frontmatter and guidance synchronized", () => {
  const source = `---
steps: 16
---
Step budget: you have at most 16 model steps. OpenCode's final step is text-only and cannot call tools.
Complete all tool activity by step 12 of 16 and reserve the remaining steps to synthesize and return your final response.
`

  const rendered = renderAgentStepLimit(
    source,
    "scout",
    32,
  )

  assert.match(rendered, /^steps: 32$/m)
  assert.match(rendered, /at most 32 model steps/)
  assert.match(rendered, /by step 25 of 32/)
})

test("agent rendering fails closed when a template marker drifts", () => {
  assert.throws(
    () => renderAgentStepLimit(
      "steps: 16\n",
      "scout",
      32,
    ),
    /cannot render step-budget guidance/,
  )
})
