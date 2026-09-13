import {
  lstatSync,
} from "node:fs"

import {
  posix,
  resolve,
  sep,
} from "node:path"

export const SUPPORTED_MANIFEST_FORMAT_VERSION = 1

export const SUPPORTED_MANIFEST_PRODUCT =
  "opencode-mcp-orchestrator"

export const SUPPORTED_MANIFEST_TOOLS = Object.freeze([
  "scout",
  "worker",
  "runner",
])

export const SUPPORTED_MANIFEST_RUNTIME_NODE = ">=20"

export const SUPPORTED_MANIFEST_RUNTIME_PLATFORM = "linux"

const SAFE_RELEASE_VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/

const TOP_LEVEL_KEYS = Object.freeze([
  "name",
  "version",
  "formatVersion",
  "runtime",
  "tools",
  "files",
])

const RUNTIME_KEYS = Object.freeze([
  "node",
  "platform",
])

const FILE_KEYS = Object.freeze([
  "mcpServer",
  "configurator",
  "integrationsConfigurator",
  "setup",
  "plugin",
  "agents",
  "skill",
])

const DIRECTORY_FILE_KEYS = Object.freeze([
  "agents",
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

function invalidManifest(message, path) {
  return new Error(
    `invalid release manifest: ${message} at path "${path}"`,
  )
}

function assertNoUnknownKeys(value, allowed, basePath) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalidManifest(
        "unknown key",
        basePath === ""
          ? key
          : `${basePath}.${key}`,
      )
    }
  }
}

function validateManifestPath(value, fieldPath) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.trim() === "" ||
    value.length > 512
  ) {
    throw invalidManifest(
      "expected repository-relative file path",
      fieldPath,
    )
  }

  if (
    hasControlCharacters(value) ||
    value.includes("\\")
  ) {
    throw invalidManifest(
      "expected repository-relative file path",
      fieldPath,
    )
  }

  if (value.startsWith("/")) {
    throw invalidManifest(
      "expected repository-relative file path",
      fieldPath,
    )
  }

  const segments = value.split("/")

  for (const segment of segments) {
    if (segment === "") {
      throw invalidManifest(
        "expected normalized repository-relative file path",
        fieldPath,
      )
    }

    if (
      segment === "." ||
      segment === ".."
    ) {
      throw invalidManifest(
        "expected repository-relative file path without traversal",
        fieldPath,
      )
    }
  }

  if (posix.normalize(value) !== value) {
    throw invalidManifest(
      "expected normalized repository-relative file path",
      fieldPath,
    )
  }
}

function validateStructure(manifest) {
  if (!isPlainObject(manifest)) {
    throw invalidManifest(
      "expected object",
      "",
    )
  }

  assertNoUnknownKeys(
    manifest,
    TOP_LEVEL_KEYS,
    "",
  )

  for (const key of TOP_LEVEL_KEYS) {
    if (manifest[key] === undefined) {
      throw invalidManifest(
        "missing key",
        key,
      )
    }
  }

  if (manifest.name !== SUPPORTED_MANIFEST_PRODUCT) {
    throw invalidManifest(
      "unexpected product",
      "name",
    )
  }

  if (
    manifest.formatVersion !== SUPPORTED_MANIFEST_FORMAT_VERSION
  ) {
    throw invalidManifest(
      "unsupported format version",
      "formatVersion",
    )
  }

  if (
    typeof manifest.version !== "string" ||
    manifest.version.trim() === "" ||
    manifest.version !== manifest.version.trim() ||
    hasControlCharacters(manifest.version) ||
    /[\s\\]/.test(manifest.version) ||
    !SAFE_RELEASE_VERSION_PATTERN.test(manifest.version)
  ) {
    throw invalidManifest(
      "invalid release version",
      "version",
    )
  }

  if (!isPlainObject(manifest.runtime)) {
    throw invalidManifest(
      "expected object",
      "runtime",
    )
  }

  assertNoUnknownKeys(
    manifest.runtime,
    RUNTIME_KEYS,
    "runtime",
  )

  if (
    manifest.runtime.node !== SUPPORTED_MANIFEST_RUNTIME_NODE
  ) {
    throw invalidManifest(
      "unsupported runtime",
      "runtime.node",
    )
  }

  if (
    manifest.runtime.platform !== SUPPORTED_MANIFEST_RUNTIME_PLATFORM
  ) {
    throw invalidManifest(
      "unsupported runtime",
      "runtime.platform",
    )
  }

  if (!Array.isArray(manifest.tools)) {
    throw invalidManifest(
      "expected tools array",
      "tools",
    )
  }

  if (
    manifest.tools.length !== SUPPORTED_MANIFEST_TOOLS.length
  ) {
    throw invalidManifest(
      "unexpected tools",
      "tools",
    )
  }

  const seenTools = new Set()

  for (let index = 0; index < manifest.tools.length; index += 1) {
    const entry = manifest.tools[index]
    const entryPath = `tools[${index}]`

    if (
      typeof entry !== "string" ||
      !SUPPORTED_MANIFEST_TOOLS.includes(entry)
    ) {
      throw invalidManifest(
        "unsupported tool",
        entryPath,
      )
    }

    if (seenTools.has(entry)) {
      throw invalidManifest(
        "duplicate tool",
        entryPath,
      )
    }

    seenTools.add(entry)
  }

  for (const tool of SUPPORTED_MANIFEST_TOOLS) {
    if (!seenTools.has(tool)) {
      throw invalidManifest(
        "unexpected tools",
        "tools",
      )
    }
  }

  if (!isPlainObject(manifest.files)) {
    throw invalidManifest(
      "expected object",
      "files",
    )
  }

  assertNoUnknownKeys(
    manifest.files,
    FILE_KEYS,
    "files",
  )

  for (const key of FILE_KEYS) {
    if (manifest.files[key] === undefined) {
      throw invalidManifest(
        "missing key",
        `files.${key}`,
      )
    }
  }

  const seenPaths = new Map()

  for (const key of FILE_KEYS) {
    const fieldPath = `files.${key}`

    validateManifestPath(
      manifest.files[key],
      fieldPath,
    )

    const normalized = posix.normalize(manifest.files[key])

    if (seenPaths.has(normalized)) {
      throw invalidManifest(
        "duplicate file",
        fieldPath,
      )
    }

    seenPaths.set(
      normalized,
      key,
    )
  }
}

function validatePayloadFiles(manifest, payloadDir) {
  if (
    typeof payloadDir !== "string" ||
    payloadDir === "" ||
    !payloadDir.startsWith("/")
  ) {
    throw invalidManifest(
      "invalid payload directory",
      "files",
    )
  }

  const payloadResolved = resolve(payloadDir)

  for (const key of FILE_KEYS) {
    const fieldPath = `files.${key}`
    const relative = manifest.files[key]
    const resolved = resolve(
      payloadResolved,
      relative,
    )

    if (
      resolved !== payloadResolved &&
      !resolved.startsWith(payloadResolved + sep)
    ) {
      throw invalidManifest(
        "file escapes payload directory",
        fieldPath,
      )
    }

    let entryStat = null

    try {
      entryStat = lstatSync(resolved)
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw invalidManifest(
          "missing payload file",
          fieldPath,
        )
      }

      throw invalidManifest(
        "unreadable payload file",
        fieldPath,
      )
    }

    if (entryStat.isSymbolicLink()) {
      throw invalidManifest(
        "payload file must not be a symlink",
        fieldPath,
      )
    }

    if (DIRECTORY_FILE_KEYS.includes(key)) {
      if (!entryStat.isDirectory()) {
        throw invalidManifest(
          "expected payload directory",
          fieldPath,
        )
      }

      continue
    }

    if (!entryStat.isFile()) {
      throw invalidManifest(
        "expected payload file",
        fieldPath,
      )
    }
  }
}

export function validateReleaseManifest(manifest, payloadDir) {
  validateStructure(manifest)
  validatePayloadFiles(
    manifest,
    payloadDir,
  )

  return manifest
}
