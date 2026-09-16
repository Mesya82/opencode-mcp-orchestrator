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

export function sandboxIsolationArgv() {
  return [...SANDBOX_ISOLATION_FLAGS]
}

export function hasNetworklessIsolation(argv) {
  return (
    Array.isArray(argv) &&
    argv.includes("--unshare-net") &&
    argv.includes("--clearenv")
  )
}
