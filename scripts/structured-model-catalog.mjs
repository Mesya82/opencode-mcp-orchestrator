export const STRUCTURED_CATALOG_ATTEMPTS = 3
export const STRUCTURED_CATALOG_RETRY_BASE_DELAY_MS = 500

function isExplicitEmptyModelCatalog(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    return Array.isArray(parsed?.data) && parsed.data.length === 0
  } catch {
    return false
  }
}

function attemptFailureReason({
  result,
  stdout,
  entries,
  isTimeout,
}) {
  if (isTimeout(result)) {
    return "request timed out"
  }

  if (result?.error) {
    return `failed to execute: ${result.error.message ?? String(result.error)}`
  }

  if (result?.status !== 0) {
    return `exited with status ${result?.status ?? "unknown"}`
  }

  if (stdout.trim() === "") {
    return "returned empty output"
  }

  if (!entries) {
    return "returned unusable structured model metadata"
  }

  return "unknown failure"
}

export function discoverStructuredModelCatalog({
  run,
  parse,
  isTimeout,
  sleep,
}) {
  let lastReason = "unknown failure"

  for (
    let attempt = 1;
    attempt <= STRUCTURED_CATALOG_ATTEMPTS;
    attempt++
  ) {
    const response = run()
    const result = response?.result
    const stdout = response?.stdout ?? ""

    let entries = null

    if (
      !isTimeout(result) &&
      !result?.error &&
      result?.status === 0 &&
      stdout.trim() !== "" &&
      !isExplicitEmptyModelCatalog(stdout)
    ) {
      entries = parse(stdout)

      if (entries) {
        return {
          entries,
          attempts: attempt,
          fallbackReason: null,
        }
      }
    }

    lastReason =
      attemptFailureReason({
        result,
        stdout,
        entries,
        isTimeout,
      })

    if (attempt < STRUCTURED_CATALOG_ATTEMPTS) {
      sleep(
        attempt *
          STRUCTURED_CATALOG_RETRY_BASE_DELAY_MS,
      )
    }
  }

  return {
    entries: null,
    attempts: STRUCTURED_CATALOG_ATTEMPTS,
    fallbackReason:
      `structured OpenCode /api/model discovery failed after ${STRUCTURED_CATALOG_ATTEMPTS} attempts: ${lastReason}`,
  }
}
