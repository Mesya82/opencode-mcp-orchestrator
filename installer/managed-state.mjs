import {
  readFileSync,
} from "node:fs"

import {
  resolve,
} from "node:path"

export const SUPPORTED_MANAGED_STATE_VERSION = 1

const TOP_LEVEL_KEYS = Object.freeze([
  "formatVersion",
  "files",
  "integrations",
])

const INTEGRATION_KEYS = Object.freeze([
  "codex",
  "claude",
])

const CODEX_KEYS = Object.freeze([
  "mcpName",
  "node",
  "server",
  "toolTimeoutSeconds",
])

const CLAUDE_KEYS = Object.freeze([
  "mcpName",
  "scope",
  "node",
  "server",
])

const FILE_RECORD_KEYS = Object.freeze([
  "sha256",
])

const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/

const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

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

function invalidState(message, path) {
  return new Error(
    `invalid managed-files state: ${message} at path "${path}"`,
  )
}

function assertNoUnknownKeys(value, allowed, basePath) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalidState(
        "unknown key",
        basePath === ""
          ? key
          : `${basePath}.${key}`,
      )
    }
  }
}

function managedRoots({ home, configHome }) {
  const homeResolved = resolve(home)
  const configHomeResolved = resolve(configHome)

  return {
    homeResolved,
    roots: Object.freeze([
      resolve(homeResolved, ".agents"),
      resolve(homeResolved, ".claude"),
      resolve(configHomeResolved, "opencode"),
    ]),
  }
}

function validateIntegrationEntry(name, value, basePath) {
  if (!isPlainObject(value)) {
    throw invalidState(
      "expected object",
      basePath,
    )
  }

  const allowed =
    name === "codex"
      ? CODEX_KEYS
      : CLAUDE_KEYS

  assertNoUnknownKeys(value, allowed, basePath)

  if (
    typeof value.mcpName !== "string" ||
    value.mcpName === "" ||
    hasControlCharacters(value.mcpName) ||
    !MCP_NAME_PATTERN.test(value.mcpName)
  ) {
    throw invalidState(
      "invalid MCP registration name",
      `${basePath}.mcpName`,
    )
  }

  if (name === "claude" && value.scope !== undefined) {
    if (value.scope !== "user") {
      throw invalidState(
        "unsupported scope",
        `${basePath}.scope`,
      )
    }
  }

  if (
    name === "codex" &&
    value.toolTimeoutSeconds !== undefined &&
    (
      !Number.isInteger(value.toolTimeoutSeconds) ||
      value.toolTimeoutSeconds <= 0 ||
      value.toolTimeoutSeconds > 7200
    )
  ) {
    throw invalidState(
      "invalid Codex MCP timeout",
      `${basePath}.toolTimeoutSeconds`,
    )
  }

  for (const key of ["node", "server"]) {
    if (value[key] === undefined) {
      continue
    }

    if (
      typeof value[key] !== "string" ||
      value[key] === "" ||
      hasControlCharacters(value[key]) ||
      !value[key].startsWith("/") ||
      resolve(value[key]) !== value[key]
    ) {
      throw invalidState(
        "expected absolute normalized path",
        `${basePath}.${key}`,
      )
    }
  }
}

function validateFileKey(rawKey, index, { homeResolved, roots, seen }) {
  const fieldPath = `files[${index}]`

  if (
    typeof rawKey !== "string" ||
    rawKey === "" ||
    hasControlCharacters(rawKey) ||
    !rawKey.startsWith("/")
  ) {
    throw invalidState(
      "expected absolute normalized path",
      fieldPath,
    )
  }

  const normalized = resolve(rawKey)

  if (seen.has(normalized)) {
    throw invalidState(
      "duplicate file",
      fieldPath,
    )
  }

  seen.set(normalized, index)

  if (rawKey !== normalized) {
    throw invalidState(
      "expected normalized path without traversal",
      fieldPath,
    )
  }

  if (
    rawKey === "/" ||
    rawKey === homeResolved
  ) {
    throw invalidState(
      "refusing to manage filesystem root or home directory",
      fieldPath,
    )
  }

  if (rawKey.split("/").includes(".git")) {
    throw invalidState(
      "refusing to manage .git path",
      fieldPath,
    )
  }

  const beneath = roots.some((root) =>
    rawKey.startsWith(`${root}/`),
  )

  if (!beneath) {
    throw invalidState(
      "file escapes managed roots",
      fieldPath,
    )
  }
}

function validateFileRecord(record, index) {
  const fieldPath = `files[${index}]`

  if (!isPlainObject(record)) {
    throw invalidState(
      "expected object",
      fieldPath,
    )
  }

  assertNoUnknownKeys(record, FILE_RECORD_KEYS, fieldPath)

  if (
    typeof record.sha256 !== "string" ||
    !SHA256_PATTERN.test(record.sha256)
  ) {
    throw invalidState(
      "invalid file hash",
      `${fieldPath}.sha256`,
    )
  }
}

export function validateManagedState(state, { home, configHome }) {
  if (
    typeof home !== "string" ||
    home === "" ||
    !home.startsWith("/") ||
    typeof configHome !== "string" ||
    configHome === "" ||
    !configHome.startsWith("/")
  ) {
    throw invalidState(
      "unresolved home paths",
      "",
    )
  }

  if (!isPlainObject(state)) {
    throw invalidState(
      "expected object",
      "",
    )
  }

  assertNoUnknownKeys(state, TOP_LEVEL_KEYS, "")

  if (state.formatVersion === undefined) {
    throw invalidState(
      "missing key",
      "formatVersion",
    )
  }

  if (state.formatVersion !== SUPPORTED_MANAGED_STATE_VERSION) {
    throw invalidState(
      "unsupported version",
      "formatVersion",
    )
  }

  if (state.files === undefined) {
    throw invalidState(
      "missing key",
      "files",
    )
  }

  if (!isPlainObject(state.files)) {
    throw invalidState(
      "expected object",
      "files",
    )
  }

  let integrations = state.integrations

  if (integrations === undefined) {
    integrations = {}
  }

  if (!isPlainObject(integrations)) {
    throw invalidState(
      "expected object",
      "integrations",
    )
  }

  assertNoUnknownKeys(integrations, INTEGRATION_KEYS, "integrations")

  for (const name of INTEGRATION_KEYS) {
    if (integrations[name] === undefined) {
      continue
    }

    validateIntegrationEntry(
      name,
      integrations[name],
      `integrations.${name}`,
    )
  }

  const { homeResolved, roots } = managedRoots({ home, configHome })
  const seen = new Map()
  const entries = Object.entries(state.files)

  for (let index = 0; index < entries.length; index += 1) {
    const [rawKey, record] = entries[index]

    validateFileKey(
      rawKey,
      index,
      { homeResolved, roots, seen },
    )

    validateFileRecord(record, index)
  }

  return {
    formatVersion: SUPPORTED_MANAGED_STATE_VERSION,
    files: state.files,
    integrations,
  }
}

export function loadManagedState(statePath, { home, configHome }) {
  let raw = null

  try {
    raw = readFileSync(statePath, "utf8")
  } catch {
    throw invalidState(
      "unreadable state file",
      "state file",
    )
  }

  let parsed = null

  try {
    parsed = JSON.parse(raw)
  } catch {
    throw invalidState(
      `invalid JSON in state file "${statePath}"`,
      "state file",
    )
  }

  return validateManagedState(parsed, { home, configHome })
}
