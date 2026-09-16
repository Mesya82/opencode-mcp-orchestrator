export const SANDBOX_ISOLATION_FLAGS: readonly string[]

export const SANDBOX_NETWORK_ACCESS_MODES: readonly string[]

export type SandboxNetworkAccess = "disabled" | "host"

export function normalizeSandboxNetworkAccess(
  value: unknown,
): SandboxNetworkAccess

export function sandboxIsolationArgv(options?: {
  readonly networkAccess?: SandboxNetworkAccess | null | undefined
}): string[]

export function hasNetworklessIsolation(
  argv: unknown,
): boolean

export function hasHostNetworkIsolation(
  argv: unknown,
): boolean
