#!/usr/bin/env node

import {
  chmodSync,
  readFileSync,
  writeFileSync,
} from "node:fs"

import {
  resolve,
} from "node:path"

function parseArgs(argv) {
  const result = {
    repository: null,
    output: null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === "--repository") {
      result.repository = argv[++i]
      continue
    }

    if (arg === "--output") {
      result.output = argv[++i]
      continue
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage:
  render-bootstrap.mjs --repository OWNER/REPO --output PATH
`)
      process.exit(0)
    }

    throw new Error(`unknown argument: ${arg}`)
  }

  if (
    !result.repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
      result.repository,
    )
  ) {
    throw new Error(
      "--repository must be OWNER/REPO",
    )
  }

  if (!result.output) {
    throw new Error(
      "--output is required",
    )
  }

  return result
}

const args =
  parseArgs(
    process.argv.slice(2),
  )

const root =
  process.cwd()

const template =
  readFileSync(
    resolve(
      root,
      "bootstrap/install.sh.in",
    ),
    "utf8",
  )

const rendered =
  template.replaceAll(
    "@@REPOSITORY@@",
    args.repository,
  )

if (
  rendered.includes(
    "@@REPOSITORY@@",
  )
) {
  throw new Error(
    "unresolved repository placeholder",
  )
}

const output =
  resolve(args.output)

writeFileSync(
  output,
  rendered,
)

chmodSync(
  output,
  0o755,
)

console.log(
  `BOOTSTRAP_RENDERED ${output}`,
)
