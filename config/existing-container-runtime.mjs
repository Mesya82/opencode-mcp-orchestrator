import { isAbsolute, relative, resolve, sep } from "node:path"

import { WORKER_CONTAINER_CAPABILITY_ROOT } from "./worker-container-capability.mjs"

export const EXISTING_CONTAINER_RUNTIME_PATHS = Object.freeze([
  "/usr/bin/podman",
  "/usr/bin/docker",
])

export const CONTAINER_RUNTIME_PATH_ENV_KEYS = Object.freeze([
  "HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CONTAINERS_STORAGE_CONF",
  "CONTAINERS_CONF",
  "CONTAINERS_REGISTRIES_CONF",
])

const PINNED_RUNTIME_ENV_ALLOWED_KEYS = Object.freeze([
  "PATH",
  ...CONTAINER_RUNTIME_PATH_ENV_KEYS,
  "CONTAINER_HOST",
])

export const WORKER_CONTAINER_CAPABILITY_VERSION = 2

const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/

const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

function isRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  )
}

function pathIsWithin(base, candidate) {
  const rel = relative(resolve(base), resolve(candidate))
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      !isAbsolute(rel))
  )
}

export function validateLocalContainerHost(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    /[\0\r\n]/.test(value) ||
    value.includes("%") ||
    value.includes("\\")
  ) {
    throw new Error(
      "invalid CONTAINER_HOST for existing-container runtime",
    )
  }

  let parsed

  try {
    parsed = new URL(value)
  } catch {
    throw new Error(
      "invalid CONTAINER_HOST for existing-container runtime",
    )
  }

  if (
    parsed.protocol !== "unix:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.pathname.startsWith("/") ||
    parsed.pathname === "/"
  ) {
    throw new Error(
      "CONTAINER_HOST must be a local unix:///absolute/path endpoint",
    )
  }

  if (!value.startsWith("unix:///")) {
    throw new Error(
      "CONTAINER_HOST must be a local unix:///absolute/path endpoint",
    )
  }

  const rawPath = value.slice("unix://".length)
  const normalized = resolve(rawPath)

  if (rawPath !== parsed.pathname || normalized !== rawPath) {
    throw new Error(
      "CONTAINER_HOST must use a canonical absolute Unix-socket path",
    )
  }

  return `unix://${normalized}`
}

export function containerRuntimeEnv(source = process.env) {
  const result = { PATH: "/usr/bin:/bin" }

  for (const key of CONTAINER_RUNTIME_PATH_ENV_KEYS) {
    const value = source?.[key]

    if (value === undefined || value === "") {
      continue
    }

    if (!isAbsolute(value) || /[\0\r\n]/.test(value)) {
      throw new Error(
        `invalid ${key} for existing-container runtime`,
      )
    }

    result[key] = value
  }

  if (
    source?.CONTAINER_HOST !== undefined &&
    source?.CONTAINER_HOST !== ""
  ) {
    result.CONTAINER_HOST = validateLocalContainerHost(
      source.CONTAINER_HOST,
    )
  }

  return result
}

export function validateContainerId(value) {
  if (typeof value !== "string" || !CONTAINER_ID_PATTERN.test(value)) {
    throw new Error("invalid existing container ID")
  }

  return value.toLowerCase()
}

export function validatePinnedRuntimePath(value) {
  if (
    typeof value !== "string" ||
    !EXISTING_CONTAINER_RUNTIME_PATHS.includes(value)
  ) {
    throw new Error("invalid pinned existing-container runtime")
  }

  return value
}

export function validatePinnedRuntimeEnv(value) {
  if (!isRecord(value)) {
    throw new Error("invalid pinned existing-container runtime environment")
  }

  for (const key of Object.keys(value)) {
    if (!PINNED_RUNTIME_ENV_ALLOWED_KEYS.includes(key)) {
      throw new Error(
        `invalid pinned existing-container runtime environment key: ${key}`,
      )
    }
  }

  const result = {}

  if (value.PATH !== undefined) {
    if (value.PATH !== "/usr/bin:/bin") {
      throw new Error("invalid pinned existing-container PATH")
    }

    result.PATH = value.PATH
  } else {
    result.PATH = "/usr/bin:/bin"
  }

  for (const key of CONTAINER_RUNTIME_PATH_ENV_KEYS) {
    const entry = value[key]

    if (entry === undefined) continue

    if (
      typeof entry !== "string" ||
      entry === "" ||
      !isAbsolute(entry) ||
      /[\0\r\n]/.test(entry)
    ) {
      throw new Error(
        `invalid ${key} for existing-container runtime`,
      )
    }

    result[key] = entry
  }

  if (value.CONTAINER_HOST !== undefined) {
    if (typeof value.CONTAINER_HOST !== "string") {
      throw new Error(
        "invalid CONTAINER_HOST for existing-container runtime",
      )
    }

    result.CONTAINER_HOST = validateLocalContainerHost(value.CONTAINER_HOST)
  }

  return result
}

const SYSTEM_RUNTIME_SOCKET_PATHS = [
  "/run/docker.sock",
  "/var/run/docker.sock",
  "/run/podman/podman.sock",
  "/run/containerd/containerd.sock",
  "/var/run/containerd/containerd.sock",
  "/run/crio/crio.sock",
  "/var/run/crio/crio.sock",
]

function rootlessRuntimeSocketPaths(uid) {
  const root = `/run/user/${uid}`

  return [
    `${root}/docker.sock`,
    `${root}/docker/docker.sock`,
    `${root}/podman/podman.sock`,
    `${root}/containerd/containerd.sock`,
    `${root}/containerd-rootless/api.sock`,
  ]
}

function sourceMayContainRuntimeSocket(source) {
  if (!isAbsolute(source)) return false

  const normalized = resolve(source)
  const candidates = [...SYSTEM_RUNTIME_SOCKET_PATHS]

  if (normalized === "/run" || normalized === "/run/user") {
    return true
  }

  const rootlessMatch = normalized.match(/^\/run\/user\/([0-9]+)(?:\/.*)?$/)

  if (rootlessMatch) {
    candidates.push(...rootlessRuntimeSocketPaths(rootlessMatch[1]))
  }

  return candidates.some((socketPath) =>
    pathIsWithin(normalized, resolve(socketPath)),
  )
}

export function validateExistingContainerInspect(info) {
  if (!isRecord(info)) {
    throw new Error("invalid existing container inspection result")
  }

  if (!isRecord(info.State) || info.State.Running !== true) {
    throw new Error("selected existing container is not running")
  }

  if (!isRecord(info.HostConfig)) {
    throw new Error("invalid existing container inspection HostConfig")
  }

  const hostConfig = info.HostConfig

  if (typeof hostConfig.Privileged !== "boolean") {
    throw new Error(
      "invalid existing container inspection HostConfig.Privileged",
    )
  }

  if (typeof hostConfig.PidMode !== "string") {
    throw new Error(
      "invalid existing container inspection HostConfig.PidMode",
    )
  }

  if (hostConfig.Privileged) {
    throw new Error("refusing privileged existing container")
  }

  if (hostConfig.PidMode === "host") {
    throw new Error("refusing existing container with host PID namespace")
  }

  if (!Array.isArray(info.Mounts)) {
    throw new Error("invalid existing container inspection Mounts")
  }

  for (const mount of info.Mounts) {
    if (!isRecord(mount)) {
      throw new Error("invalid existing container inspection mount")
    }

    if (
      typeof mount.Type !== "string" ||
      typeof mount.Source !== "string" ||
      typeof mount.Destination !== "string" ||
      typeof mount.RW !== "boolean" ||
      mount.Destination === "" ||
      !isAbsolute(mount.Destination)
    ) {
      throw new Error("invalid existing container inspection mount")
    }

    const source = mount.Source
    const destination = mount.Destination
    const writable = mount.RW

    if (source === "/" && writable) {
      throw new Error(
        "refusing existing container with writable host root mount",
      )
    }

    if (
      writable &&
      isAbsolute(source) &&
      (pathIsWithin(
        resolve(source),
        resolve(WORKER_CONTAINER_CAPABILITY_ROOT),
      ) ||
        pathIsWithin(
          resolve(WORKER_CONTAINER_CAPABILITY_ROOT),
          resolve(source),
        ))
    ) {
      throw new Error(
        "refusing existing container with writable access to worker capability storage",
      )
    }

    if (
      sourceMayContainRuntimeSocket(source) ||
      /(?:docker|podman|containerd|cri-o)\.sock(?:$|\/)/i.test(destination)
    ) {
      throw new Error(
        "refusing existing container with container-runtime socket",
      )
    }
  }
}

export function validateWorkerContainerCapability(value) {
  if (!isRecord(value)) {
    throw new Error("invalid worker container capability")
  }

  const allowedKeys = new Set([
    "version",
    "container",
    "containerId",
    "runtime",
    "runtimeEnv",
    "workspaceAccess",
    "containerCwd",
    "networkAccess",
    "hostCwd",
  ])

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error("invalid worker container capability")
    }
  }

  if (value.version !== WORKER_CONTAINER_CAPABILITY_VERSION) {
    throw new Error("invalid worker container capability")
  }

  const {
    container,
    containerId,
    runtime,
    runtimeEnv,
    workspaceAccess,
    containerCwd,
    networkAccess,
    hostCwd,
  } = value

  if (
    typeof container !== "string" ||
    !DISPLAY_NAME_PATTERN.test(container) ||
    container.length > 256
  ) {
    throw new Error("invalid worker container capability")
  }

  let normalizedContainerId
  let normalizedRuntime
  let normalizedRuntimeEnv

  try {
    normalizedContainerId = validateContainerId(containerId)
    normalizedRuntime = validatePinnedRuntimePath(runtime)
    normalizedRuntimeEnv = validatePinnedRuntimeEnv(runtimeEnv)
  } catch {
    throw new Error("invalid worker container capability")
  }

  if (workspaceAccess !== "read_only" && workspaceAccess !== "writable") {
    throw new Error("invalid worker container capability")
  }

  if (
    containerCwd !== "auto" &&
    (typeof containerCwd !== "string" || !isAbsolute(containerCwd))
  ) {
    throw new Error("invalid worker container capability")
  }

  if (networkAccess !== "inherit") {
    throw new Error("invalid worker container capability")
  }

  if (typeof hostCwd !== "string" || !isAbsolute(hostCwd)) {
    throw new Error("invalid worker container capability")
  }

  return {
    version: WORKER_CONTAINER_CAPABILITY_VERSION,
    container,
    containerId: normalizedContainerId,
    runtime: normalizedRuntime,
    runtimeEnv: normalizedRuntimeEnv,
    workspaceAccess,
    containerCwd,
    networkAccess,
    hostCwd,
  }
}

function extractContainerId(info, runtime) {
  const rawId = info?.Id

  if (typeof rawId !== "string" || rawId.trim() === "") {
    throw new Error(`invalid inspection output from ${runtime}`)
  }

  try {
    return validateContainerId(rawId.trim().toLowerCase())
  } catch {
    throw new Error(`invalid inspection output from ${runtime}`)
  }
}

function parseInspectPayload(stdout, runtime) {
  let parsed

  try {
    parsed = JSON.parse(String(stdout ?? ""))
  } catch {
    throw new Error(`invalid inspection output from ${runtime}`)
  }

  const info = Array.isArray(parsed) ? parsed[0] : parsed

  if (!isRecord(info)) {
    throw new Error(`invalid inspection output from ${runtime}`)
  }

  return info
}

function inspectOneRuntime({
  runtime,
  target,
  runtimeEnv,
  spawnSync,
  expectId,
}) {
  const result = spawnSync(runtime, ["inspect", target], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: runtimeEnv,
  })

  if (result?.status !== 0 || result?.error) {
    return { status: "missing" }
  }

  const info = parseInspectPayload(result.stdout, runtime)
  validateExistingContainerInspect(info)
  const foundId = extractContainerId(info, runtime)

  if (expectId !== undefined && foundId !== expectId) {
    throw new Error(
      "existing container identity changed since capability installation",
    )
  }

  return { status: "ok", info, containerId: foundId }
}

export function validateDisplayContainerName(container) {
  const name = typeof container === "string" ? container.trim() : ""

  if (
    name === "" ||
    name.length > 256 ||
    !DISPLAY_NAME_PATTERN.test(name)
  ) {
    throw new Error("invalid worker existing_container container")
  }

  return name
}

export function resolveSelectedExistingContainer(
  container,
  options = {},
) {
  const name = validateDisplayContainerName(container)
  const existsSync = options.existsSync
  const spawnSync = options.spawnSync
  const runtimePaths =
    options.runtimePaths ?? EXISTING_CONTAINER_RUNTIME_PATHS

  if (typeof existsSync !== "function" || typeof spawnSync !== "function") {
    throw new Error("existing-container runtime resolution requires host hooks")
  }

  const runtimeEnv = containerRuntimeEnv(options.env ?? process.env)
  const matches = []

  for (const runtime of runtimePaths) {
    validatePinnedRuntimePath(runtime)

    if (!existsSync(runtime)) continue

    const outcome = inspectOneRuntime({
      runtime,
      target: name,
      runtimeEnv,
      spawnSync,
    })

    if (outcome.status === "missing") continue

    matches.push({
      runtime,
      inspect: outcome.info,
      env: runtimeEnv,
      containerId: outcome.containerId,
    })
  }

  if (matches.length === 0) {
    throw new Error(
      `selected existing container was not found in a supported runtime: ${name}`,
    )
  }

  if (matches.length > 1) {
    throw new Error(
      `selected existing container is ambiguous across supported runtimes: ${name}`,
    )
  }

  return matches[0]
}

export function inspectPinnedExistingContainer(
  { runtime, containerId, runtimeEnv },
  options = {},
) {
  validatePinnedRuntimePath(runtime)
  const expectedId = validateContainerId(containerId)
  const env = validatePinnedRuntimeEnv(runtimeEnv)
  const spawnSync = options.spawnSync

  if (typeof spawnSync !== "function") {
    throw new Error("existing-container inspection requires host hooks")
  }

  const outcome = inspectOneRuntime({
    runtime,
    target: expectedId,
    runtimeEnv: env,
    spawnSync,
    expectId: expectedId,
  })

  if (outcome.status === "missing") {
    throw new Error(
      "selected existing container is unavailable through its pinned runtime",
    )
  }

  return { inspect: outcome.info, runtime, containerId: expectedId, env }
}

export function buildContainerExecArgs(containerId, argv, workdir, interactive = false) {
  const id = validateContainerId(containerId)

  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    throw new Error("container_run argv must contain at least one valid string")
  }

  if (
    workdir !== undefined &&
    (
      typeof workdir !== "string" ||
      !isAbsolute(workdir) ||
      /[\0\r\n]/.test(workdir)
    )
  ) {
    throw new Error("container_run workdir must be an absolute path")
  }

  return [
    "exec",
    ...(interactive ? ["-i"] : []),
    ...(workdir ? ["--workdir", workdir] : []),
    id,
    ...argv,
  ]
}
