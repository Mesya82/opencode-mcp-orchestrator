export const SANDBOX_ISOLATION_FLAGS: readonly string[]

export function sandboxIsolationArgv(): string[]

export function hasNetworklessIsolation(
  argv: unknown,
): boolean
