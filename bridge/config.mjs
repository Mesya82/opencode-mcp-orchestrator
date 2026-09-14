import {
  normalizeStepLimits,
} from "../config/step-limits.mjs"

import {
  normalizeTimeoutLimits,
} from "../config/timeout-limits.mjs"

export {
  normalizeSandboxRuntime,
} from "../config/sandbox-runtime.mjs"

import {
  normalizeSandboxRuntime,
} from "../config/sandbox-runtime.mjs"

export const SUPPORTED_CONFIG_VERSION = 1

export const MODEL_ROLES = Object.freeze([
  "scout",
  "worker",
  "runner",
])

export const MAX_MODEL_REFERENCE_LENGTH = 256

export const SUPPORTED_INTEGRATIONS = Object.freeze([
  "codex",
  "claude",
])

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)

  return (
    prototype === Object.prototype ||
    prototype === null
  )
}

function hasControlCharacters(value) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value)
}

export function validateModelReference(reference, role) {
  if (
    typeof reference !== "string" ||
    reference === ""
  ) {
    throw new Error(
      `invalid model reference for role "${role}" at path "models.${role}": expected provider/model`,
    )
  }

  if (
    reference.length > MAX_MODEL_REFERENCE_LENGTH
  ) {
    throw new Error(
      `invalid model reference for role "${role}" at path "models.${role}": reference is too long`,
    )
  }

  if (
    /\s/.test(reference) ||
    hasControlCharacters(reference)
  ) {
    throw new Error(
      `invalid model reference for role "${role}" at path "models.${role}": expected provider/model without whitespace or control characters`,
    )
  }

  const slash = reference.indexOf("/")

  if (
    slash <= 0 ||
    slash === reference.length - 1
  ) {
    throw new Error(
      `invalid model reference for role "${role}" at path "models.${role}": expected provider/model`,
    )
  }

  const providerID = reference.slice(0, slash)
  const id = reference.slice(slash + 1)

  if (
    providerID === "" ||
    id === ""
  ) {
    throw new Error(
      `invalid model reference for role "${role}" at path "models.${role}": expected provider/model`,
    )
  }

  return {
    reference,
    providerID,
    id,
  }
}

export function validateBridgeConfig(config, options = {}) {
  const label = options.configPath ?? "configuration"

  if (!isPlainObject(config)) {
    throw new Error(
      `invalid configuration ${label}: expected object at path ""`,
    )
  }

  for (const key of Object.keys(config)) {
    if (
      key !== "version" &&
      key !== "models" &&
      key !== "stepLimits" &&
      key !== "timeoutLimits" &&
      key !== "integrations" &&
      key !== "sandboxRuntime"
    ) {
      throw new Error(
        `invalid configuration ${label}: unknown key at path "${key}"`,
      )
    }
  }

  if (config.version !== SUPPORTED_CONFIG_VERSION) {
    throw new Error(
      `invalid configuration ${label}: unsupported version at path "version"`,
    )
  }

  if (!isPlainObject(config.models)) {
    throw new Error(
      `invalid configuration ${label}: expected models object at path "models"`,
    )
  }

  for (const role of MODEL_ROLES) {
    validateModelReference(
      config.models[role],
      role,
    )
  }

  let normalizedStepLimits
  let hasNormalizedStepLimits = false

  if (
    config.stepLimits !== undefined
  ) {
    if (!isPlainObject(config.stepLimits)) {
      throw new Error(
        `invalid configuration ${label}: expected stepLimits object at path "stepLimits"`,
      )
    }

    try {
      normalizedStepLimits = normalizeStepLimits(config.stepLimits)
    } catch {
      throw new Error(
        `invalid configuration ${label}: invalid stepLimits at path "stepLimits"`,
      )
    }

    hasNormalizedStepLimits = true
  }

  let normalizedTimeoutLimits
  let hasNormalizedTimeoutLimits = false

  if (
    config.timeoutLimits !== undefined
  ) {
    if (!isPlainObject(config.timeoutLimits)) {
      throw new Error(
        `invalid configuration ${label}: expected timeoutLimits object at path "timeoutLimits"`,
      )
    }

    try {
      normalizedTimeoutLimits = normalizeTimeoutLimits(config.timeoutLimits)
    } catch {
      throw new Error(
        `invalid configuration ${label}: invalid timeoutLimits at path "timeoutLimits"`,
      )
    }

    hasNormalizedTimeoutLimits = true
  }

  let normalizedSandboxRuntime
  let hasNormalizedSandboxRuntime = false

  if (
    config.sandboxRuntime !== undefined
  ) {
    try {
      normalizedSandboxRuntime = normalizeSandboxRuntime(config.sandboxRuntime)
    } catch (error) {
      throw new Error(
        `invalid configuration ${label}: ${error.message}`,
      )
    }

    hasNormalizedSandboxRuntime = true
  }

  if (
    config.integrations !== undefined
  ) {
    if (!Array.isArray(config.integrations)) {
      throw new Error(
        `invalid configuration ${label}: expected integrations array at path "integrations"`,
      )
    }

    const seenIntegrations = new Set()

    for (let index = 0; index < config.integrations.length; index += 1) {
      const entry = config.integrations[index]

      if (
        typeof entry !== "string" ||
        !SUPPORTED_INTEGRATIONS.includes(entry)
      ) {
        throw new Error(
          `invalid configuration ${label}: unsupported integration at path "integrations[${index}]"`,
        )
      }

      if (seenIntegrations.has(entry)) {
        throw new Error(
          `invalid configuration ${label}: duplicate integration at path "integrations[${index}]"`,
        )
      }

      seenIntegrations.add(entry)
    }
  }

  if (
    !hasNormalizedStepLimits &&
    !hasNormalizedTimeoutLimits &&
    !hasNormalizedSandboxRuntime
  ) {
    return config
  }

  return {
    ...config,
    ...(hasNormalizedStepLimits
      ? { stepLimits: normalizedStepLimits }
      : {}),
    ...(hasNormalizedTimeoutLimits
      ? { timeoutLimits: normalizedTimeoutLimits }
      : {}),
    ...(hasNormalizedSandboxRuntime
      ? { sandboxRuntime: normalizedSandboxRuntime }
      : {}),
  }
}
