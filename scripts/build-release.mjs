import {
  cpSync,
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
  build,
} from "esbuild"

const root =
  resolve(
    dirname(
      new URL(
        import.meta.url,
      ).pathname,
    ),
    "..",
  )

const dist =
  resolve(
    root,
    "dist",
  )

rmSync(
  dist,
  {
    recursive: true,
    force: true,
  },
)

mkdirSync(
  resolve(
    dist,
    "libexec",
  ),
  {
    recursive: true,
  },
)

mkdirSync(
  resolve(
    dist,
    "opencode/agents",
  ),
  {
    recursive: true,
  },
)

mkdirSync(
  resolve(
    dist,
    "opencode/plugins/sandbox-tools",
  ),
  {
    recursive: true,
  },
)

mkdirSync(
  resolve(
    dist,
    "skills/orchestrate",
  ),
  {
    recursive: true,
  },
)

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  treeShaking: true,
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",

  /*
   * Some otherwise bundleable Node dependencies still contain dynamic
   * CommonJS require() calls for Node built-ins such as "stream".
   *
   * Native ESM has no global require. Supplying createRequire() keeps
   * those dependency paths functional while still shipping one
   * self-contained ESM file with no runtime node_modules dependency.
   */
  banner: {
    js:
      'import { createRequire as __orchestratorCreateRequire } from "node:module"; const require = __orchestratorCreateRequire(import.meta.url);',
  },
}

console.log()
console.log(
  "Bundling MCP server...",
)

await build({
  ...common,

  entryPoints: [
    resolve(
      root,
      "bridge/server.mjs",
    ),
  ],

  outfile:
    resolve(
      dist,
      "libexec/mcp-server.mjs",
    ),
})

console.log()
console.log(
  "Bundling interactive configurator...",
)

await build({
  ...common,

  entryPoints: [
    resolve(
      root,
      "scripts/configure-models.mjs",
    ),
  ],

  outfile:
    resolve(
      dist,
      "libexec/configure-models.mjs",
    ),
})

console.log()
console.log(
  "Bundling integration configurator...",
)

await build({
  ...common,

  entryPoints: [
    resolve(
      root,
      "scripts/configure-integrations.mjs",
    ),
  ],

  outfile:
    resolve(
      dist,
      "libexec/configure-integrations.mjs",
    ),
})

console.log()
console.log(
  "Bundling installer components...",
)

const installers = [
  ["installer/setup.mjs", "libexec/setup.mjs"],
  ["installer/install.mjs", "libexec/install-core.mjs"],
  ["installer/install-opencode.mjs", "libexec/install-opencode.mjs"],
  ["installer/install-codex.mjs", "libexec/install-codex.mjs"],
  ["installer/install-claude.mjs", "libexec/install-claude.mjs"],
  ["installer/doctor.mjs", "libexec/doctor.mjs"],
  ["installer/uninstall.mjs", "libexec/uninstall.mjs"],
]

for (const [source, destination] of installers) {
  await build({
    ...common,

    entryPoints: [
      resolve(
        root,
        source,
      ),
    ],

    outfile:
      resolve(
        dist,
        destination,
      ),
  })
}

console.log()
console.log(
  "Bundling OpenCode sandbox plugin...",
)

/*
 * OpenCode currently discovers this plugin as index.ts.
 *
 * The output contains ordinary bundled JavaScript; keeping the .ts
 * filename preserves the already-proven plugin discovery convention.
 */
await build({
  ...common,

  entryPoints: [
    resolve(
      root,
      "opencode/plugins/sandbox-tools/index.ts",
    ),
  ],

  outfile:
    resolve(
      dist,
      "opencode/plugins/sandbox-tools/index.ts",
    ),
})

console.log()
console.log(
  "Copying static agent definitions...",
)

for (
  const role
  of [
    "scout",
    "worker",
    "runner",
  ]
) {
  const name =
    `opencode-orchestrator-${role}.md`

  cpSync(
    resolve(
      root,
      "opencode/agents",
      name,
    ),

    resolve(
      dist,
      "opencode/agents",
      name,
    ),
  )
}

console.log(
  "Copying orchestration skill...",
)

cpSync(
  resolve(
    root,
    "skills/orchestrate/SKILL.md",
  ),

  resolve(
    dist,
    "skills/orchestrate/SKILL.md",
  ),
)

const pkg =
  JSON.parse(
    readFileSync(
      resolve(
        root,
        "package.json",
      ),
      "utf8",
    ),
  )

const manifest = {
  name:
    "opencode-mcp-orchestrator",

  version:
    pkg.version,

  formatVersion:
    1,

  runtime: {
    node:
      ">=20",

    platform:
      "linux",
  },

  tools: [
    "scout",
    "worker",
    "runner",
  ],

  files: {
    mcpServer:
      "libexec/mcp-server.mjs",

    configurator:
      "libexec/configure-models.mjs",

    integrationsConfigurator:
      "libexec/configure-integrations.mjs",

    setup:
      "libexec/setup.mjs",

    plugin:
      "opencode/plugins/sandbox-tools/index.ts",

    agents:
      "opencode/agents",

    skill:
      "skills/orchestrate/SKILL.md",
  },
}

writeFileSync(
  resolve(
    dist,
    "manifest.json",
  ),

  JSON.stringify(
    manifest,
    null,
    2,
  ) + "\n",
)

console.log()
console.log(
  "RELEASE_BUILD_COMPLETE",
)
