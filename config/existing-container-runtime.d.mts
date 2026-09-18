export const EXISTING_CONTAINER_RUNTIME_PATHS: readonly string[]
export const CONTAINER_RUNTIME_PATH_ENV_KEYS: readonly string[]
export const WORKER_CONTAINER_CAPABILITY_VERSION: number

export interface SelectedExistingContainerBinding {
  readonly runtime: string
  readonly inspect: Record<string, unknown>
  readonly env: Record<string, string>
  readonly containerId: string
}

export interface PinnedExistingContainerBinding {
  readonly inspect: Record<string, unknown>
  readonly runtime: string
  readonly containerId: string
  readonly env: Record<string, string>
}

export interface WorkerContainerCapabilityV2 {
  readonly version: 2
  readonly container: string
  readonly containerId: string
  readonly runtime: string
  readonly runtimeEnv: Record<string, string>
  readonly workspaceAccess: "read_only" | "writable"
  readonly containerCwd: "auto" | string
  readonly networkAccess: "inherit"
  readonly hostCwd: string
}

export function validateLocalContainerHost(value: string): string
export function containerRuntimeEnv(source?: NodeJS.ProcessEnv): Record<string, string>
export function validateContainerId(value: unknown): string
export function validatePinnedRuntimePath(value: unknown): string
export function validatePinnedRuntimeEnv(value: unknown): Record<string, string>
export function validateExistingContainerInspect(info: unknown): void
export function validateWorkerContainerCapability(value: unknown): WorkerContainerCapabilityV2
export function validateDisplayContainerName(container: unknown): string
export function resolveSelectedExistingContainer(
  container: string,
  options: {
    readonly existsSync: (path: string) => boolean
    readonly spawnSync: (
      command: string,
      args: string[],
      options: { encoding: "utf8"; timeout: number; maxBuffer: number; env: Record<string, string> },
    ) => { status?: number | null; error?: unknown; stdout?: unknown; stderr?: unknown }
    readonly runtimePaths?: readonly string[]
    readonly env?: NodeJS.ProcessEnv
  },
): SelectedExistingContainerBinding
export function inspectPinnedExistingContainer(
  binding: { readonly runtime: string; readonly containerId: string; readonly runtimeEnv: Record<string, string> },
  options: {
    readonly spawnSync: (
      command: string,
      args: string[],
      options: { encoding: "utf8"; timeout: number; maxBuffer: number; env: Record<string, string> },
    ) => { status?: number | null; error?: unknown; stdout?: unknown; stderr?: unknown }
  },
): PinnedExistingContainerBinding
export function buildContainerExecArgs(
  containerId: string,
  argv: readonly string[],
  workdir?: string,
  interactive?: boolean,
): string[]
