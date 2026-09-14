import { posix } from "node:path"

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/

export const SANDBOX_RUNTIME_RESERVED_ENV_KEYS = Object.freeze([
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "PYTHONPYCACHEPREFIX",
])

const RESERVED_ENV_KEYS = new Set(
  SANDBOX_RUNTIME_RESERVED_ENV_KEYS,
)

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

function invalid(reason, path) {
  return new Error(
    `invalid sandboxRuntime ${reason} at path "${path}"`,
  )
}

function rejectUnknownKeys(value, allowedKeys, basePath) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw invalid("unknown key", `${basePath}.${key}`)
    }
  }
}

function validateRoot(root, path) {
  if (
    typeof root !== "string" ||
    root === "" ||
    root === "/" ||
    !posix.isAbsolute(root) ||
    root.endsWith("/") ||
    posix.normalize(root) !== root ||
    hasControlCharacters(root)
  ) {
    throw invalid("expected non-root absolute normalized path", path)
  }
}

function validateRelativePath(candidate, path) {
  if (
    typeof candidate !== "string" ||
    candidate === "" ||
    posix.isAbsolute(candidate) ||
    candidate.endsWith("/") ||
    posix.normalize(candidate) !== candidate ||
    hasControlCharacters(candidate) ||
    candidate.split("/").includes("..")
  ) {
    throw invalid("expected contained relative normalized path", path)
  }
}

export function normalizeSandboxRuntime(value) {
  if (!isPlainObject(value)) {
    throw invalid("expected object", "sandboxRuntime")
  }

  rejectUnknownKeys(
    value,
    ["trustedRoots"],
    "sandboxRuntime",
  )

  if (!Array.isArray(value.trustedRoots)) {
    throw invalid(
      "expected trustedRoots array",
      "sandboxRuntime.trustedRoots",
    )
  }

  const seenRoots = new Set()
  const seenEnvironmentKeys = new Set()

  const trustedRoots = value.trustedRoots.map((entry, index) => {
    const basePath = `sandboxRuntime.trustedRoots[${index}]`

    if (!isPlainObject(entry)) {
      throw invalid("expected object", basePath)
    }

    rejectUnknownKeys(
      entry,
      ["root", "pathEntries", "environment"],
      basePath,
    )

    validateRoot(entry.root, `${basePath}.root`)

    if (seenRoots.has(entry.root)) {
      throw invalid("duplicate trusted root", basePath)
    }

    seenRoots.add(entry.root)

    if (
      !Array.isArray(entry.pathEntries) ||
      entry.pathEntries.length === 0
    ) {
      throw invalid(
        "expected non-empty pathEntries array",
        `${basePath}.pathEntries`,
      )
    }

    const seenPathEntries = new Set()
    const pathEntries = entry.pathEntries.map((candidate, entryIndex) => {
      const candidatePath = `${basePath}.pathEntries[${entryIndex}]`

      validateRelativePath(candidate, candidatePath)

      if (seenPathEntries.has(candidate)) {
        throw invalid("duplicate path entry", candidatePath)
      }

      seenPathEntries.add(candidate)
      return candidate
    })

    const environment = entry.environment ?? {}

    if (!isPlainObject(environment)) {
      throw invalid(
        "expected environment object",
        `${basePath}.environment`,
      )
    }

    for (const [name, candidate] of Object.entries(environment)) {
      const candidatePath = `${basePath}.environment`

      if (!ENV_KEY_PATTERN.test(name)) {
        throw invalid("expected environment variable name", candidatePath)
      }

      if (RESERVED_ENV_KEYS.has(name)) {
        throw invalid("reserved environment variable name", candidatePath)
      }

      if (seenEnvironmentKeys.has(name)) {
        throw invalid("duplicate environment variable name", candidatePath)
      }

      seenEnvironmentKeys.add(name)
      validateRelativePath(candidate, candidatePath)
    }

    return {
      root: entry.root,
      pathEntries,
      environment: { ...environment },
    }
  })

  return { trustedRoots }
}
