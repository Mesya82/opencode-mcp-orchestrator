export interface SandboxRuntimeTrustedRoot {
  root: string
  pathEntries: string[]
  environment: Record<string, string>
}

export interface SandboxRuntimeConfig {
  trustedRoots: SandboxRuntimeTrustedRoot[]
}

export const SANDBOX_RUNTIME_RESERVED_ENV_KEYS: readonly string[]

export function normalizeSandboxRuntime(
  value: unknown,
): SandboxRuntimeConfig
