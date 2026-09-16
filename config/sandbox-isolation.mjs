/*
 * Shared Bubblewrap isolation primitive.
 *
 * The delegated sandbox tools and the networkless Doctor execution probes
 * must apply the same effective isolation boundary: no network namespace,
 * a cleared environment, system files mounted read-only, and no host HOME
 * or credential mounts. Centralizing the namespace/effective isolation
 * check keeps the security-sensitive construction verifiable in one
 * provider-free place instead of duplicating it across the plugin and the
 * installer.
 */

export const SANDBOX_ISOLATION_FLAGS = Object.freeze([
  "--die-with-parent",
  "--new-session",

  "--unshare-net",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
])

export const SANDBOX_NETWORK_ACCESS_MODES = Object.freeze([
  "disabled",
  "host",
])

/*
 * Server-selected network mode. Omitted/undefined means "disabled".
 * Anything else fails closed before spawning.
 */
export function normalizeSandboxNetworkAccess(value) {
  if (value === undefined) return "disabled"
  if (value === "disabled" || value === "host") return value
  throw new Error("invalid networkAccess")
}

export function sandboxIsolationArgv(options = {}) {
  const networkAccess = normalizeSandboxNetworkAccess(
    options?.networkAccess,
  )
  if (networkAccess === "host") {
    return SANDBOX_ISOLATION_FLAGS.filter(
      (flag) => flag !== "--unshare-net",
    )
  }
  return [...SANDBOX_ISOLATION_FLAGS]
}

export function hasNetworklessIsolation(argv) {
  return (
    Array.isArray(argv) &&
    argv.includes("--unshare-net") &&
    argv.includes("--clearenv")
  )
}

export function hasHostNetworkIsolation(argv) {
  return (
    Array.isArray(argv) &&
    !argv.includes("--unshare-net") &&
    argv.includes("--unshare-pid") &&
    argv.includes("--unshare-ipc") &&
    argv.includes("--unshare-uts") &&
    argv.includes("--clearenv")
  )
}
