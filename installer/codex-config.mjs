import {
  isAbsolute,
  resolve,
} from "node:path"

export function codexConfigPath(env = process.env) {
  const codexHome = env.CODEX_HOME

  if (
    typeof codexHome === "string" &&
    codexHome.trim() !== ""
  ) {
    if (!isAbsolute(codexHome.trim())) {
      throw new Error("CODEX_HOME must be an absolute path")
    }

    return resolve(codexHome.trim(), "config.toml")
  }

  if (
    typeof env.HOME !== "string" ||
    env.HOME.trim() === ""
  ) {
    throw new Error("HOME is not set")
  }

  return resolve(env.HOME, ".codex/config.toml")
}

function sectionBounds(lines, serverName) {
  const plainHeader = `[mcp_servers.${serverName}]`
  const quotedHeader = `[mcp_servers.${JSON.stringify(serverName)}]`
  const matches = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()

    if (
      line === plainHeader ||
      line === quotedHeader
    ) {
      matches.push(index)
    }
  }

  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one Codex MCP section for ${serverName}, found ${matches.length}`,
    )
  }

  const start = matches[0]
  let end = lines.length

  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index
      break
    }
  }

  return { start, end }
}

export function readCodexMcpToolTimeout(source, serverName) {
  const lines = source.split("\n")
  const { start, end } = sectionBounds(lines, serverName)
  const matches = []

  for (let index = start + 1; index < end; index += 1) {
    const match = lines[index].match(
      /^\s*tool_timeout_sec\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*(?:#.*)?$/,
    )

    if (match) {
      matches.push(Number(match[1]))
    }
  }

  if (matches.length > 1) {
    throw new Error(
      `duplicate tool_timeout_sec in Codex MCP section for ${serverName}`,
    )
  }

  return matches[0]
}

export function setCodexMcpToolTimeout(
  source,
  serverName,
  timeoutSeconds,
) {
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    throw new Error("Codex MCP timeout must be a positive integer")
  }

  const hadTrailingNewline = source.endsWith("\n")
  const lines = source.split("\n")

  if (hadTrailingNewline) {
    lines.pop()
  }

  const { start, end } = sectionBounds(lines, serverName)
  const keyIndexes = []

  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*tool_timeout_sec\s*=/.test(lines[index])) {
      keyIndexes.push(index)
    }
  }

  if (keyIndexes.length > 1) {
    throw new Error(
      `duplicate tool_timeout_sec in Codex MCP section for ${serverName}`,
    )
  }

  const rendered = `tool_timeout_sec = ${timeoutSeconds}`

  if (keyIndexes.length === 1) {
    lines[keyIndexes[0]] = rendered
  } else {
    lines.splice(end, 0, rendered)
  }

  return lines.join("\n") + (hadTrailingNewline ? "\n" : "")
}
