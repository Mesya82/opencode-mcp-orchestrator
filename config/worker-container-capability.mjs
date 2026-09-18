import { resolve } from "node:path"

export const WORKER_CONTAINER_CAPABILITY_ROOT =
  "/tmp/opencode-mcp-orchestrator-worker-capabilities"

export function workerContainerCapabilityPath(
  sessionID,
  root = WORKER_CONTAINER_CAPABILITY_ROOT,
) {
  if (
    typeof sessionID !== "string" ||
    !/^[A-Za-z0-9._-]{1,200}$/.test(sessionID)
  ) {
    throw new Error("invalid OpenCode session id for worker container capability")
  }

  return resolve(root, `${sessionID}.json`)
}


export function workerContainerActivityPath(
  sessionID,
  root = WORKER_CONTAINER_CAPABILITY_ROOT,
) {
  if (
    typeof sessionID !== "string" ||
    !/^[A-Za-z0-9._-]{1,200}$/.test(sessionID)
  ) {
    throw new Error("invalid OpenCode session id for worker container activity")
  }

  return resolve(root, `${sessionID}.active`)
}
