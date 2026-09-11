#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"

import {
  dirname,
  resolve,
} from "node:path"

import {
  fileURLToPath,
} from "node:url"

import {
  spawnSync,
} from "node:child_process"

const here =
  dirname(
    fileURLToPath(
      import.meta.url,
    ),
  )

const root =
  resolve(
    here,
    "..",
  )

function parseArgs(argv) {
  const result = {
    version: null,
    repository:
      process.env.GITHUB_REPOSITORY ||
      "Mesya82/opencode-mcp-orchestrator",
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === "--version") {
      result.version = argv[++i]
      continue
    }

    if (arg === "--repository") {
      result.repository = argv[++i]
      continue
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage:
  package-release.mjs --version VERSION [--repository OWNER/REPO]
`)
      process.exit(0)
    }

    throw new Error(
      `unknown argument: ${arg}`,
    )
  }

  if (!result.version) {
    throw new Error(
      "--version is required",
    )
  }

  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(
      result.version,
    )
  ) {
    throw new Error(
      `invalid release version: ${result.version}`,
    )
  }

  return result
}

function run(command, args, options = {}) {
  const result =
    spawnSync(
      command,
      args,
      {
        encoding: "utf8",
        stdio: "inherit",
        ...options,
      },
    )

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${result.status}`,
    )
  }
}

const args =
  parseArgs(
    process.argv.slice(2),
  )

const version =
  args.version

const dist =
  resolve(
    root,
    "dist",
  )

if (!existsSync(
  resolve(
    dist,
    "manifest.json",
  ),
)) {
  throw new Error(
    "dist/ is missing; run npm run build first",
  )
}

const release =
  resolve(
    root,
    "release",
  )

const staging =
  resolve(
    release,
    ".staging",
  )

const directoryName =
  `opencode-mcp-orchestrator-${version}`

const payload =
  resolve(
    staging,
    directoryName,
  )

const archiveName =
  `${directoryName}.tar.gz`

const archive =
  resolve(
    release,
    archiveName,
  )

rmSync(
  staging,
  {
    recursive: true,
    force: true,
  },
)

mkdirSync(
  payload,
  {
    recursive: true,
  },
)

cpSync(
  dist,
  payload,
  {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  },
)

/*
 * Release metadata belongs to the release artifact, not to the mutable
 * development dist directory.
 */
const manifestPath =
  resolve(
    payload,
    "manifest.json",
  )

const manifest =
  JSON.parse(
    readFileSync(
      manifestPath,
      "utf8",
    ),
  )

manifest.version =
  version

writeFileSync(
  manifestPath,
  JSON.stringify(
    manifest,
    null,
    2,
  ) + "\n",
)

/*
 * Manual/offline installation entrypoint.
 *
 * A remote bootstrap installer will eventually download this archive,
 * verify it, extract it, and invoke this exact script.
 */
const installScript =
`#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd -P)"
VERSION="${version}"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is required but was not found in PATH." >&2
  exit 1
fi

exec node \\
  "$ROOT/libexec/setup.mjs" \\
  --payload "$ROOT" \\
  --version "$VERSION" \\
  "$@"
`

const installPath =
  resolve(
    payload,
    "install.sh",
  )

writeFileSync(
  installPath,
  installScript,
)

chmodSync(
  installPath,
  0o755,
)

/*
 * Ship the public documentation with the archive when present.
 */
for (const name of [
  "README.md",
  "LICENSE",
  "SECURITY.md",
]) {
  const source =
    resolve(
      root,
      name,
    )

  if (existsSync(source)) {
    cpSync(
      source,
      resolve(
        payload,
        name,
      ),
    )
  }
}

/*
 * Refuse to package accidental development/runtime state.
 */
const forbidden = [
  "node_modules",
  "config.local.json",
  ".env",
]

function scanForbidden(path) {
  const result =
    spawnSync(
      "find",
      [
        path,
        "-print",
      ],
      {
        encoding: "utf8",
      },
    )

  if (result.status !== 0) {
    throw new Error(
      "failed to inspect staged release",
    )
  }

  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue

    for (const token of forbidden) {
      if (
        line === token ||
        line.includes(`/${token}`) ||
        line.endsWith(`/${token}`)
      ) {
        throw new Error(
          `forbidden release content: ${line}`,
        )
      }
    }
  }
}

scanForbidden(payload)

rmSync(
  archive,
  {
    force: true,
  },
)

console.log()
console.log(
  `Creating ${archiveName}...`,
)

run(
  "tar",
  [
    "-czf",
    archive,
    "-C",
    staging,
    directoryName,
  ],
)

const checksumFile =
  resolve(
    release,
    "SHA256SUMS",
  )

const checksumResult =
  spawnSync(
    "sha256sum",
    [
      archiveName,
    ],
    {
      cwd: release,
      encoding: "utf8",
    },
  )

if (checksumResult.status !== 0) {
  throw new Error(
    "sha256sum failed",
  )
}

writeFileSync(
  checksumFile,
  checksumResult.stdout,
)

const bootstrapScript =
  resolve(
    release,
    "install.sh",
  )

run(
  process.execPath,
  [
    resolve(
      root,
      "scripts/render-bootstrap.mjs",
    ),

    "--repository",
    args.repository,

    "--output",
    bootstrapScript,
  ],
)

rmSync(
  staging,
  {
    recursive: true,
    force: true,
  },
)

console.log()
console.log(
  `Archive:   ${archive}`,
)

console.log(
  `Checksums: ${checksumFile}`,
)

console.log(
  `Bootstrap: ${bootstrapScript}`,
)

console.log()
console.log(
  "RELEASE_PACKAGE_COMPLETE",
)
