export const STEP_LIMIT_ROLES = Object.freeze([
  "scout",
  "worker",
  "runner",
])

export const STEP_LIMIT_PROFILES = Object.freeze({
  standard: Object.freeze({
    scout: 16,
    worker: 32,
    runner: 40,
  }),
  extended: Object.freeze({
    scout: 32,
    worker: 48,
    runner: 64,
  }),
})

export const MIN_STEP_LIMIT = 4
export const MAX_STEP_LIMIT = 256

function validateLimit(value, role) {
  if (
    !Number.isInteger(value) ||
    value < MIN_STEP_LIMIT ||
    value > MAX_STEP_LIMIT
  ) {
    throw new Error(
      `step limit for role "${role}" must be an integer from ${MIN_STEP_LIMIT} to ${MAX_STEP_LIMIT}`,
    )
  }

  return value
}

export function normalizeStepLimits(value) {
  const profile = value?.profile ?? "standard"

  if (Object.hasOwn(STEP_LIMIT_PROFILES, profile)) {
    return {
      profile,
      limits: {
        ...STEP_LIMIT_PROFILES[profile],
      },
    }
  }

  if (profile !== "custom") {
    throw new Error(
      `unknown step-limit profile: ${profile}`,
    )
  }

  const limits = {}

  for (const role of STEP_LIMIT_ROLES) {
    limits[role] = validateLimit(
      value?.[role],
      role,
    )
  }

  return {
    profile,
    limits,
  }
}

export function stepLimitConfig(profile, limits) {
  const normalized = normalizeStepLimits(
    profile === "custom"
      ? {
          profile,
          ...limits,
        }
      : { profile },
  )

  if (normalized.profile !== "custom") {
    return {
      profile: normalized.profile,
    }
  }

  return {
    profile: "custom",
    ...normalized.limits,
  }
}

export function toolStepCutoff(limit) {
  const reserved = Math.max(
    2,
    Math.ceil(limit * 0.2),
  )

  return limit - reserved
}

export function renderAgentStepLimit(source, role, limit) {
  validateLimit(limit, role)

  const cutoff = toolStepCutoff(limit)
  const activity =
    role === "worker"
      ? "implementation and verification activity"
      : role === "runner"
        ? "command and log-inspection activity"
        : "tool activity"

  const replacements = [
    {
      pattern: /^steps: \d+$/m,
      replacement: `steps: ${limit}`,
      label: "frontmatter step limit",
    },
    {
      pattern: /^Step budget: .*$/m,
      replacement:
        `Step budget: you have at most ${limit} model steps. OpenCode's final step is text-only and cannot call tools.`,
      label: "step-budget guidance",
    },
    {
      pattern: /^Complete all .* activity by step \d+ of \d+ and reserve the remaining steps to synthesize and return your final response\.$/m,
      replacement:
        `Complete all ${activity} by step ${cutoff} of ${limit} and reserve the remaining steps to synthesize and return your final response.`,
      label: "step-reserve guidance",
    },
  ]

  let rendered = source

  for (const { pattern, replacement, label } of replacements) {
    if (!pattern.test(rendered)) {
      throw new Error(
        `cannot render ${label} for role "${role}"`,
      )
    }

    rendered = rendered.replace(
      pattern,
      replacement,
    )
  }

  return rendered
}
