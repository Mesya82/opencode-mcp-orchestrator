#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
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

function parseArgs(argv) {
  const result = {
    payload: null,
    version: null,
    config: null,
    nonInteractive: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === "--payload") {
      result.payload = argv[++i]
      continue
    }

    if (arg === "--version") {
      result.version = argv[++i]
      continue
    }

    if (arg === "--config") {
      result.config = argv[++i]
      continue
    }

    if (arg === "--non-interactive") {
      result.nonInteractive = true
      continue
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`
Usage:
  setup.mjs --payload PATH --version VERSION [--config PATH] [--non-interactive]

Interactive installer for OpenCode MCP Orchestrator.
`)
      process.exit(0)
    }

    throw new Error(
      `unknown argument: ${arg}`,
    )
  }

  if (!result.payload) {
    throw new Error(
      "--payload is required",
    )
  }

  if (!result.version) {
    throw new Error(
      "--version is required",
    )
  }

  return result
}

function commandExists(name) {
  const result =
    spawnSync(
      "/usr/bin/env",
      [
        "bash",
        "-c",
        `command -v ${name}`,
      ],
      {
        encoding: "utf8",
        env: process.env,
      },
    )

  return (
    result.status === 0 &&
    result.stdout.trim() !== ""
  )
}

function runNodeScript(
  path,
  args = [],
  {
    interactive = false,
  } = {},
) {
  let ttyFd = null

  try {
    if (interactive) {
      ttyFd = openSync(
        "/dev/tty",
        "r",
      )
    }

    const result =
      spawnSync(
        process.execPath,
        [
          path,
          ...args,
        ],
        {
          env: process.env,

          stdio:
            interactive
              ? [
                  ttyFd,
                  "inherit",
                  "inherit",
                ]
              : "inherit",
        },
      )

    if (result.error) {
      throw result.error
    }

    if (result.status !== 0) {
      throw new Error(
        `installer component failed: ${path} (exit ${result.status})`
      )
    }
  } finally {
    if (ttyFd !== null) {
      closeSync(ttyFd)
    }
  }
}

function defaultConfigPath() {
  const home =
    process.env.HOME

  if (!home) {
    throw new Error(
      "HOME is not set",
    )
  }

  const configHome =
    process.env.XDG_CONFIG_HOME ||
    resolve(
      home,
      ".config",
    )

  return resolve(
    configHome,
    "opencode-mcp-orchestrator/config.json",
  )
}

function loadConfig(path) {
  if (!existsSync(path)) {
    throw new Error(
      `configuration missing after setup: ${path}`,
    )
  }

  return JSON.parse(
    readFileSync(
      path,
      "utf8",
    ),
  )
}

const args =
  parseArgs(
    process.argv.slice(2),
  )

/*
 * setup.mjs is bundled for releases. Runtime components sit beside it
 * inside libexec/.
 */
const component = (name) =>
  resolve(
    here,
    name,
  )

const requiredComponents = [
  "install-core.mjs",
  "install-opencode.mjs",
  "install-codex.mjs",
  "install-claude.mjs",
  "uninstall.mjs",
  "configure-models.mjs",
  "configure-integrations.mjs",
  "doctor.mjs",
]

for (const name of requiredComponents) {
  const path =
    component(name)

  if (!existsSync(path)) {
    throw new Error(
      `installer component missing: ${path}`,
    )
  }
}

console.log()
console.log(
  "OpenCode MCP Orchestrator",
)
console.log(
  `Version ${args.version}`,
)
console.log()

console.log(
  "Checking prerequisites..."
)

const prerequisites = [
  ["bubblewrap", "bwrap"],
  ["Git", "git"],
]

let prerequisiteFailure = false

const openCodeBinary =
  process.env.OPENCODE_BIN ||
  (
    commandExists("opencode")
      ? "opencode"
      : commandExists("opencode2")
        ? "opencode2"
        : null
  )

if (openCodeBinary) {
  console.log(
    `  ✓ OpenCode (${openCodeBinary})`,
  )
} else {
  console.log(
    "  ✗ OpenCode (opencode/opencode2 not found)",
  )

  prerequisiteFailure = true
}

for (
  const [label, command]
  of prerequisites
) {
  if (commandExists(command)) {
    console.log(
      `  ✓ ${label}`,
    )
  } else {
    console.log(
      `  ✗ ${label} (${command} not found)`,
    )

    prerequisiteFailure = true
  }
}

if (process.platform !== "linux") {
  console.log(
    `  ✗ Linux required (detected ${process.platform})`,
  )

  prerequisiteFailure = true
} else {
  console.log(
    "  ✓ Linux",
  )
}

if (prerequisiteFailure) {
  throw new Error(
    "required prerequisites are missing",
  )
}

const configPath =
  args.config ||
  defaultConfigPath()

const dataHome =
  process.env.XDG_DATA_HOME ||
  resolve(
    process.env.HOME,
    ".local/share",
  )

const appData =
  resolve(
    dataHome,
    "opencode-mcp-orchestrator",
  )

const replacingExistingInstallation =
  existsSync(appData)

if (replacingExistingInstallation) {
  console.log()
  console.log(
    "Existing installation detected.",
  )

  console.log(
    "Removing existing installation while preserving configuration...",
  )

  console.log()

  runNodeScript(
    component(
      "uninstall.mjs",
    ),
    [
      "--for-update",
    ],
  )
}

console.log()
console.log(
  "Installing core payload...",
)

runNodeScript(
  component(
    "install-core.mjs",
  ),
  [
    "--payload",
    resolve(args.payload),

    "--version",
    args.version,
  ],
)

console.log()
console.log(
  "Installing OpenCode backend..."
)

runNodeScript(
  component(
    "install-opencode.mjs",
  ),
  [
    "--payload",
    resolve(args.payload),
  ],
)

if (!args.nonInteractive) {
  console.log()
  console.log(
    "Configure delegated models",
  )
  console.log()

  runNodeScript(
    component(
      "configure-models.mjs",
    ),
    [
      "--config",
      configPath,
    ],
    {
      interactive: true,
    },
  )

  console.log()
  console.log(
    "Configure parent-agent integrations",
  )
  console.log()

  runNodeScript(
    component(
      "configure-integrations.mjs",
    ),
    [
      "--config",
      configPath,
    ],
    {
      interactive: true,
    },
  )
}

const config =
  loadConfig(
    configPath,
  )

for (const role of ["scout", "worker", "runner"]) {
  if (
    typeof config.models?.[role] !== "string" ||
    !config.models[role].includes("/")
  ) {
    throw new Error(
      `model is not configured for role "${role}"`
    )
  }
}

if (
  !Array.isArray(config.integrations) ||
  config.integrations.length === 0
) {
  throw new Error(
    "no parent-agent integrations are configured"
  )
}

const integrations =
  new Set(
    config.integrations ?? [],
  )

console.log()
console.log(
  "Installing selected integrations..."
)

if (integrations.has("codex")) {
  console.log()
  console.log(
    "Codex",
  )

  runNodeScript(
    component(
      "install-codex.mjs",
    ),
    [
      "--payload",
      resolve(args.payload),
    ],
  )
}

if (integrations.has("claude")) {
  console.log()
  console.log(
    "Claude Code",
  )

  runNodeScript(
    component(
      "install-claude.mjs",
    ),
    [
      "--payload",
      resolve(args.payload),
    ],
  )
}

console.log()
console.log(
  "Running installation doctor...",
)
console.log()

runNodeScript(
  component(
    "doctor.mjs",
  ),
  [
    "--config",
    configPath,
  ],
)

console.log()
console.log(
  "Installation complete.",
)

console.log()
console.log(
  `Configuration: ${configPath}`,
)

console.log()
console.log(
  "Models:",
)

for (
  const role
  of [
    "scout",
    "worker",
    "runner",
  ]
) {
  console.log(
    `  ${role.padEnd(7)} ${config.models?.[role] ?? "<not configured>"}`,
  )
}

console.log()
console.log(
  "Integrations:",
)

for (const integration of integrations) {
  console.log(
    `  ✓ ${integration}`,
  )
}

console.log()
console.log(
  "SETUP_COMPLETE",
)
