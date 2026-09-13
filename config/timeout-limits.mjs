export const TIMEOUT_LIMIT_ROLES = Object.freeze([
  "scout",
  "worker",
  "runner",
])

export const TIMEOUT_LIMIT_PROFILES = Object.freeze({
  standard: Object.freeze({
    scout: 300,
    worker: 600,
    runner: 1200,
    parent: 1500,
  }),
  extended: Object.freeze({
    scout: 900,
    worker: 1500,
    runner: 1800,
    parent: 2100,
  }),
})

export const MIN_ROLE_TIMEOUT_SECONDS = 30
export const MAX_ROLE_TIMEOUT_SECONDS = 3600
export const MIN_PARENT_TIMEOUT_SECONDS = 90
export const MAX_PARENT_TIMEOUT_SECONDS = 7200
export const MIN_PARENT_RESERVE_SECONDS = 60
export const RUNNER_COMMAND_RESERVE_SECONDS = 60

/*
 * Configured caller-budget preflight reserves. The operation timeout plus
 * this reserve must fit within the configured parent timeout so interrupt,
 * session removal, and structured result handling can complete before the
 * caller stops waiting. The total stays within the existing 60-second
 * parent reserve so every currently valid profile remains compatible.
 */
export const CALLER_CLEANUP_RESERVE_SECONDS = 30
export const CALLER_RESULT_RESERVE_SECONDS = 10
export const CALLER_BUDGET_RESERVE_SECONDS =
  CALLER_CLEANUP_RESERVE_SECONDS + CALLER_RESULT_RESERVE_SECONDS

function validateInteger(value, minimum, maximum, label) {
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum} seconds`,
    )
  }

  return value
}

function validateResolvedTimeouts(profile, limits) {
  for (const role of TIMEOUT_LIMIT_ROLES) {
    validateInteger(
      limits[role],
      MIN_ROLE_TIMEOUT_SECONDS,
      MAX_ROLE_TIMEOUT_SECONDS,
      `timeout for role "${role}"`,
    )
  }

  validateInteger(
    limits.parent,
    MIN_PARENT_TIMEOUT_SECONDS,
    MAX_PARENT_TIMEOUT_SECONDS,
    "parent MCP timeout",
  )

  const longestRoleTimeout = Math.max(
    ...TIMEOUT_LIMIT_ROLES.map((role) => limits[role]),
  )

  if (
    limits.parent <
      longestRoleTimeout + MIN_PARENT_RESERVE_SECONDS
  ) {
    throw new Error(
      `parent MCP timeout must be at least ${MIN_PARENT_RESERVE_SECONDS} seconds longer than every role timeout`,
    )
  }

  return {
    profile,
    limits: {
      scout: limits.scout,
      worker: limits.worker,
      runner: limits.runner,
    },
    parentTimeoutSeconds: limits.parent,
  }
}

export function normalizeTimeoutLimits(value) {
  const profile = value?.profile ?? "standard"

  if (Object.hasOwn(TIMEOUT_LIMIT_PROFILES, profile)) {
    return validateResolvedTimeouts(
      profile,
      TIMEOUT_LIMIT_PROFILES[profile],
    )
  }

  if (profile !== "custom") {
    throw new Error(
      `unknown timeout profile: ${profile}`,
    )
  }

  return validateResolvedTimeouts(
    profile,
    {
      scout: value?.scout,
      worker: value?.worker,
      runner: value?.runner,
      parent: value?.parent,
    },
  )
}

export function normalizeConfigTimeoutLimits(config) {
  if (config?.timeoutLimits !== undefined) {
    return normalizeTimeoutLimits(config.timeoutLimits)
  }

  const stepProfile = config?.stepLimits?.profile

  if (Object.hasOwn(TIMEOUT_LIMIT_PROFILES, stepProfile)) {
    return normalizeTimeoutLimits({ profile: stepProfile })
  }

  return normalizeTimeoutLimits(undefined)
}

export function timeoutLimitConfig(profile, limits) {
  const normalized = normalizeTimeoutLimits(
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
    parent: normalized.parentTimeoutSeconds,
  }
}

export function assertRunnerTimeoutFits(
  commandTimeoutSeconds,
  operationTimeoutSeconds,
) {
  validateInteger(
    commandTimeoutSeconds,
    1,
    MAX_ROLE_TIMEOUT_SECONDS,
    "Runner command timeout",
  )

  validateInteger(
    operationTimeoutSeconds,
    MIN_ROLE_TIMEOUT_SECONDS,
    MAX_ROLE_TIMEOUT_SECONDS,
    "Runner operation timeout",
  )

  if (
    commandTimeoutSeconds + RUNNER_COMMAND_RESERVE_SECONDS >
      operationTimeoutSeconds
  ) {
    throw new Error(
      `Runner command timeout ${commandTimeoutSeconds}s does not fit within the ${operationTimeoutSeconds}s Runner operation timeout with the required ${RUNNER_COMMAND_RESERVE_SECONDS}s synthesis and cleanup reserve`,
    )
  }
}

/*
 * Nesting for synchronous delegation:
 *   Runner command timeout fits Runner operation timeout
 *     (assertRunnerTimeoutFits, with RUNNER_COMMAND_RESERVE_SECONDS);
 *   operation timeout fits configured parent/caller budget
 *     (assertOperationTimeoutFitsParent, with CALLER_BUDGET_RESERVE_SECONDS).
 *
 * This enforces only the configured parent budget. The bridge context
 * exposes an MCP request AbortSignal but no reliable live host deadline,
 * so this validator must not be described as knowing an MCP host's live
 * deadline.
 */
export function assertOperationTimeoutFitsParent(
  operationTimeoutSeconds,
  parentTimeoutSeconds,
  operation = "operation",
  caller = "configured parent",
) {
  if (
    !Number.isInteger(operationTimeoutSeconds) ||
    operationTimeoutSeconds < 1
  ) {
    throw new Error(
      "Operation timeout must be a positive integer number of seconds",
    )
  }

  if (
    !Number.isInteger(parentTimeoutSeconds) ||
    parentTimeoutSeconds < 1
  ) {
    throw new Error(
      "Parent timeout must be a positive integer number of seconds",
    )
  }

  if (
    operationTimeoutSeconds + CALLER_BUDGET_RESERVE_SECONDS >
      parentTimeoutSeconds
  ) {
    throw new Error(
      `${operation} operation timeout ${operationTimeoutSeconds}s does not fit within the ${caller} budget ${parentTimeoutSeconds}s with the required ${CALLER_BUDGET_RESERVE_SECONDS}s cleanup and result reserve`,
    )
  }
}
