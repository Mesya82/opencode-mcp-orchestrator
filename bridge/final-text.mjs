export function messageType(message) {
  return message?.type ?? message?.info?.type
}

export function messageParts(message) {
  if (Array.isArray(message?.content)) return message.content
  if (Array.isArray(message?.parts)) return message.parts
  return []
}

export function messageFinish(message) {
  return message?.finish ?? message?.info?.finish
}

export function messageError(message) {
  return message?.error ?? message?.info?.error
}

function errorDetail(error) {
  if (typeof error === "string") return error.trim()
  if (error && typeof error.message === "string" && error.message.trim() !== "") {
    return error.message.trim()
  }
  if (error && typeof error === "object") {
    try {
      const serialized = JSON.stringify(error)
      if (serialized && serialized !== "{}") return serialized
    } catch {
      // Fall through to generic fallback below.
    }
  }
  return ""
}

function hasPopulatedError(error) {
  if (error === undefined || error === null) return false
  if (typeof error === "string") return error.trim() !== ""
  if (typeof error === "object") return Object.keys(error).length > 0
  return true
}

export function extractFinalText(last, { agent, sessionID }) {
  if (!last) {
    throw new Error(
      `OpenCode ${agent} session ${sessionID} produced no assistant result`
    )
  }

  const finish = messageFinish(last)
  const error = messageError(last)

  if (finish === "error" || hasPopulatedError(error)) {
    const detail =
      errorDetail(error) ||
      (finish === "error"
        ? 'provider finish "error"'
        : "unknown provider/session error")

    throw new Error(
      `OpenCode ${agent} session ${sessionID} failed: ${detail}`
    )
  }

  const text = messageParts(last)
    .filter(
      (part) =>
        part?.type === "text" &&
        typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("\n")
    .trim()

  if (!text) {
    throw new Error(
      `OpenCode ${agent} session ${sessionID} produced no final text`
    )
  }

  return text
}
