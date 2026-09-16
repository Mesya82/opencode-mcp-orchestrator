import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  SANDBOX_ISOLATION_FLAGS,
  hasHostNetworkIsolation,
  hasNetworklessIsolation,
  normalizeSandboxNetworkAccess,
  sandboxIsolationArgv,
} from "../../config/sandbox-isolation.mjs"

import {
  SANDBOX_NETWORK_CA_DIR_CANDIDATES,
  SANDBOX_NETWORK_CA_FILE_CANDIDATES,
  buildBaseSandboxArgv,
  resolveSandboxNetworkMounts,
} from "../../config/sandbox-bubblewrap.mjs"

import sandboxPlugin, {
  baseSandboxArgs,
  buildSandboxRunArgv,
  sandboxRunInputSchema,
  SANDBOX_RUN_INPUT_PROPERTY_NAMES,
} from "../../opencode/plugins/sandbox-tools/index.ts"

import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = join(
  here,
  "../../opencode/plugins/sandbox-tools/index.ts",
)

function mountFlag(argv, source, target) {
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (argv[i + 1] === source && argv[i + 2] === target) return argv[i]
  }
  return undefined
}

function mountIndex(argv, source, target) {
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (argv[i + 1] === source && argv[i + 2] === target) return i
  }
  return -1
}

function setenvPairs(argv) {
  const out = new Map()
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (argv[i] === "--setenv") out.set(argv[i + 1], argv[i + 2])
  }
  return out
}

function fakeNetworkFs({
  files = new Set(),
  dirs = new Set(),
  realpath = (p) => p,
} = {}) {
  return {
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      if (p === "/etc/resolv.conf") return "nameserver 127.0.0.53\n"
      throw new Error("unexpected read")
    },
    realpathSync: realpath,
    statSync: (p) => {
      if (files.has(p) || (!dirs.has(p) && p.endsWith(".crt")) || p.endsWith(".pem")) {
        return { isFile: () => true, isDirectory: () => false }
      }
      return { isFile: () => false, isDirectory: () => true }
    },
    env: { HOME: "/home/tester" },
  }
}

const CA_FILE = "/etc/ssl/certs/ca-certificates.crt"
const CA_DIR = "/etc/ssl/certs"

function hostFs(extra = {}) {
  return fakeNetworkFs({
    files: new Set(["/etc/resolv.conf", "/etc/hosts", CA_FILE]),
    dirs: new Set([CA_DIR]),
    ...extra,
  })
}

test("omitted networkAccess stays byte-for-byte networkless", () => {
  assert.equal(normalizeSandboxNetworkAccess(undefined), "disabled")
  assert.deepEqual(sandboxIsolationArgv(), [...SANDBOX_ISOLATION_FLAGS])
  assert.deepEqual(sandboxIsolationArgv({}), [...SANDBOX_ISOLATION_FLAGS])
  assert.ok(sandboxIsolationArgv().includes("--unshare-net"))
})

test("invalid networkAccess throws before spawning", () => {
  for (const bad of [null, "HOST", "none", "", "host ", true, 1, {}]) {
    assert.throws(() => normalizeSandboxNetworkAccess(bad), /invalid networkAccess/)
    assert.throws(() => sandboxIsolationArgv({ networkAccess: bad }), /invalid networkAccess/)
    const wt = mkdtempSync(join(tmpdir(), "sandbox-net-"))
    assert.throws(
      () => buildBaseSandboxArgv(wt, "/workspace", { networkAccess: bad }),
      /invalid networkAccess/,
    )
  }
})

test("host isolation differs only by absence of --unshare-net", () => {
  const disabled = sandboxIsolationArgv({ networkAccess: "disabled" })
  const host = sandboxIsolationArgv({ networkAccess: "host" })
  assert.ok(disabled.includes("--unshare-net"))
  assert.ok(!host.includes("--unshare-net"))
  assert.deepEqual(host, disabled.filter((f) => f !== "--unshare-net"))
  assert.ok(host.includes("--unshare-pid"))
  assert.ok(host.includes("--unshare-ipc"))
  assert.ok(host.includes("--unshare-uts"))
  assert.ok(hasHostNetworkIsolation([...host, "--clearenv"]))
})

test("disabled base argv is networkless; host adds narrow mounts only", () => {
  const wt = mkdtempSync(join(tmpdir(), "sandbox-net-"))
  const disabled = buildBaseSandboxArgv(wt, "/workspace", {
    networkAccess: "disabled",
    existsSync: () => false,
  })
  assert.ok(hasNetworklessIsolation(disabled))
  assert.ok(!disabled.includes("/etc/resolv.conf"))

  const host = buildBaseSandboxArgv(wt, "/workspace", {
    networkAccess: "host",
    ...hostFs(),
  })
  assert.ok(!host.includes("--unshare-net"))
  assert.ok(hasHostNetworkIsolation(host))
  assert.equal(mountFlag(host, "/etc/resolv.conf", "/etc/resolv.conf"), "--ro-bind")
  assert.equal(mountFlag(host, "/etc/hosts", "/etc/hosts"), "--ro-bind")
  assert.equal(mountFlag(host, CA_FILE, CA_FILE), "--ro-bind")
  // No broad mounts.
  for (const src of ["/etc", "/etc/ssl", "/etc/ssl/private"]) {
    assert.equal(mountFlag(host, src, src), undefined)
  }
  // --clearenv retained, no proxy env.
  const env = setenvPairs(host)
  assert.ok(host.includes("--clearenv"))
  for (const key of [...env.keys()]) {
    assert.ok(!/proxy/i.test(key), key)
  }
  assert.ok(![...env.values()].join("\n").match(/proxy/i))
})

test("base argv forwards injected resolver reads in host mode", () => {
  const wt = mkdtempSync(join(tmpdir(), "sandbox-net-"))
  let resolverReads = 0
  const fs = hostFs()
  const argv = buildBaseSandboxArgv(wt, "/workspace", {
    networkAccess: "host",
    ...fs,
    readFileSync: (path) => {
      assert.equal(path, "/etc/resolv.conf")
      resolverReads += 1
      return "nameserver 192.0.2.53\n"
    },
  })

  assert.equal(resolverReads, 1)
  assert.equal(mountFlag(argv, "/etc/resolv.conf", "/etc/resolv.conf"), "--ro-bind")
})

test("host networking requires a validated resolver configuration", () => {
  assert.throws(
    () => resolveSandboxNetworkMounts(
      fakeNetworkFs({ files: new Set([CA_FILE]), dirs: new Set() }),
    ),
    /resolver configuration/,
  )

  for (const badContents of [
    "",
    "search example.test\n",
    "nameserver not-an-address\n",
  ]) {
    assert.throws(
      () => resolveSandboxNetworkMounts({
        ...hostFs(),
        readFileSync: () => badContents,
      }),
      /resolver configuration/,
    )
  }

  assert.throws(
    () => resolveSandboxNetworkMounts({
      ...hostFs(),
      readFileSync: () => { throw new Error("unreadable") },
    }),
    /resolver configuration/,
  )

  assert.throws(
    () => resolveSandboxNetworkMounts(
      fakeNetworkFs({
        files: new Set(["/etc/resolv.conf", CA_FILE]),
        dirs: new Set(),
        realpath: (p) =>
          p === "/etc/resolv.conf" ? "/home/tester/evil-resolv" : p,
      }),
    ),
    /resolver configuration/,
  )

  for (const unsafeTarget of ["/etc/shadow", "/run/secrets/resolver-token"]) {
    assert.throws(
      () => resolveSandboxNetworkMounts(
        fakeNetworkFs({
          files: new Set(["/etc/resolv.conf", unsafeTarget, CA_FILE]),
          dirs: new Set(),
          realpath: (p) => p === "/etc/resolv.conf" ? unsafeTarget : p,
        }),
      ),
      /resolver configuration/,
    )
  }

  const systemdMounts = resolveSandboxNetworkMounts(
    fakeNetworkFs({
      files: new Set([
        "/etc/resolv.conf",
        "/run/systemd/resolve/stub-resolv.conf",
        CA_FILE,
      ]),
      dirs: new Set(),
      realpath: (p) => p === "/etc/resolv.conf"
        ? "/run/systemd/resolve/stub-resolv.conf"
        : p,
    }),
  )
  assert.ok(systemdMounts.some((m) => m.source === "/etc/resolv.conf"))

  // No CA at all fails closed after resolver validation.
  assert.throws(
    () =>
      resolveSandboxNetworkMounts(
        fakeNetworkFs({ files: new Set(["/etc/resolv.conf"]), dirs: new Set() }),
      ),
    /CA trust source/,
  )

})

test("CA candidates canonicalized into private-key roots are rejected", () => {
  for (const privateTarget of [
    "/etc/ssl/private/evil.crt",
    "/etc/pki/private/evil.crt",
    "/etc/pki/tls/private/evil.crt",
  ]) {
    assert.throws(
      () => resolveSandboxNetworkMounts(
        fakeNetworkFs({
          files: new Set(["/etc/resolv.conf", CA_FILE, privateTarget]),
          dirs: new Set(),
          realpath: (p) => p === CA_FILE ? privateTarget : p,
        }),
      ),
      /CA trust source/,
      privateTarget,
    )
  }
})

test("symlink-backed CA file mounts canonically without lexical symlink bind", () => {
  const wt = mkdtempSync(join(tmpdir(), "sandbox-net-"))
  const bundle = "/etc/pki/tls/certs/ca-bundle.crt"
  const trustDir = "/etc/pki/tls/certs"
  const canonicalBundle = "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"
  const fs = fakeNetworkFs({
    files: new Set([
      "/etc/resolv.conf",
      bundle,
      canonicalBundle,
    ]),
    dirs: new Set([trustDir]),
    realpath: (path) => path === bundle ? canonicalBundle : path,
  })

  const mounts = resolveSandboxNetworkMounts(fs)
  // Lexical parent directory remains mounted.
  assert.ok(mounts.some((mount) => mount.source === trustDir && mount.target === trustDir))
  // Canonical trust file is mounted narrowly at its canonical destination.
  assert.ok(mounts.some((mount) => mount.source === canonicalBundle && mount.target === canonicalBundle))
  // No bind targets the lexical symlink destination.
  assert.ok(!mounts.some((mount) => mount.target === bundle))
  const dirIndex = mounts.findIndex((mount) => mount.target === trustDir)
  const canonicalIndex = mounts.findIndex((mount) => mount.target === canonicalBundle)
  assert.ok(dirIndex >= 0 && canonicalIndex >= 0)

  const argv = buildBaseSandboxArgv(wt, "/workspace", {
    networkAccess: "host",
    ...fs,
  })
  assert.equal(mountIndex(argv, bundle, bundle), -1)
  assert.ok(mountIndex(argv, trustDir, trustDir) >= 0)
  assert.ok(mountIndex(argv, canonicalBundle, canonicalBundle) >= 0)
  assert.equal(mountFlag(argv, canonicalBundle, canonicalBundle), "--ro-bind")
  // Existing Debian trust path remains supported via direct regular files.
  const debian = resolveSandboxNetworkMounts(hostFs())
  assert.ok(debian.some((m) => m.target === CA_FILE))
})

test("symlink-backed /etc/ssl/cert.pem mounts canonical source onto lexical path", () => {
  const wt = mkdtempSync(join(tmpdir(), "sandbox-net-"))
  const lexical = "/etc/ssl/cert.pem"
  const canonical = "/usr/share/ca-certificates/mozilla/DST_Root_CA_X3.crt"
  const fs = fakeNetworkFs({
    files: new Set(["/etc/resolv.conf", lexical]),
    dirs: new Set(["/etc/ssl/certs"]),
    realpath: (path) => path === lexical ? canonical : path,
  })

  const mounts = resolveSandboxNetworkMounts(fs)
  // Canonical regular-file source bound directly onto the lexical path.
  assert.ok(mounts.some((mount) => mount.source === canonical && mount.target === lexical))
  // No bind sourced from the lexical symlink and no lexical->lexical bind.
  assert.ok(!mounts.some((mount) => mount.source === lexical))
  assert.ok(!mounts.some((mount) => mount.source === "/etc/ssl" || mount.target === "/etc/ssl"))
  // No private-root or HOME-adjacent target.
  for (const mount of mounts) {
    assert.ok(!mount.target.startsWith("/etc/ssl/private"))
    assert.ok(!mount.target.startsWith("/home/"))
  }

  const argv = buildBaseSandboxArgv(wt, "/workspace", {
    networkAccess: "host",
    ...fs,
  })
  assert.equal(mountFlag(argv, canonical, lexical), "--ro-bind")
  assert.equal(mountFlag(argv, lexical, lexical), undefined)
  assert.equal(mountFlag(argv, canonical, canonical), undefined)
  assert.equal(mountFlag(argv, "/etc/ssl", "/etc/ssl"), undefined)
  assert.equal(mountFlag(argv, "/etc/ssl/private", "/etc/ssl/private"), undefined)
})

test("symlink-backed CA file with forbidden lexical source fails closed", () => {
  const lexical = "/etc/ssl/cert.pem"
  assert.throws(
    () => resolveSandboxNetworkMounts(
      fakeNetworkFs({
        files: new Set(["/etc/resolv.conf", lexical]),
        dirs: new Set(),
        realpath: (p) => p === lexical ? "/home/tester/evil-ca.crt" : p,
      }),
    ),
    /CA trust source/,
  )
})

test("Arch native extracted trust yields narrow usable mounts", () => {
  const bundle = "/etc/ca-certificates/extracted/tls-ca-bundle.pem"
  const cadir = "/etc/ca-certificates/extracted/cadir"
  const mounts = resolveSandboxNetworkMounts(
    fakeNetworkFs({
      files: new Set(["/etc/resolv.conf", bundle]),
      dirs: new Set([cadir]),
    }),
  )
  assert.ok(mounts.some((m) => m.source === bundle && m.target === bundle))
  assert.ok(mounts.some((m) => m.source === cadir && m.target === cadir))
  for (const m of mounts) {
    assert.ok(m.source !== "/etc" && m.target !== "/etc")
    assert.ok(m.source !== "/etc/ssl" && m.target !== "/etc/ssl")
  }
  // Arch /etc/ssl compatibility symlink resolves via the extracted source.
  const compat = "/etc/ssl/certs/ca-certificates.crt"
  const compatMounts = resolveSandboxNetworkMounts(
    fakeNetworkFs({
      files: new Set(["/etc/resolv.conf", compat, bundle]),
      dirs: new Set([cadir]),
      realpath: (p) => p === compat ? bundle : p,
    }),
  )
  assert.ok(compatMounts.some((m) => m.source === bundle && m.target === bundle))
  assert.ok(!compatMounts.some((m) => m.target === compat && m.source === compat))
})

test("SUSE bundle and openssl store yield narrow mounts without broad /var", () => {
  const bundle = "/var/lib/ca-certificates/ca-bundle.pem"
  const store = "/var/lib/ca-certificates/openssl"
  const mounts = resolveSandboxNetworkMounts(
    fakeNetworkFs({
      files: new Set(["/etc/resolv.conf", bundle]),
      dirs: new Set([store]),
    }),
  )
  assert.ok(mounts.some((m) => m.source === bundle && m.target === bundle))
  assert.ok(mounts.some((m) => m.source === store && m.target === store))
  for (const m of mounts) {
    assert.ok(m.source !== "/var" && m.target !== "/var")
    assert.ok(m.source !== "/var/lib" && m.target !== "/var/lib")
    assert.ok(!m.target.startsWith("/var/lib/ca-certificates/private"))
  }
  const wt = mkdtempSync(join(tmpdir(), "sandbox-net-"))
  const argv = buildBaseSandboxArgv(wt, "/workspace", {
    networkAccess: "host",
    ...fakeNetworkFs({
      files: new Set(["/etc/resolv.conf", "/etc/hosts", bundle]),
      dirs: new Set([store]),
    }),
  })
  assert.equal(mountFlag(argv, bundle, bundle), "--ro-bind")
  assert.equal(mountFlag(argv, store, store), "--ro-bind")
  assert.equal(mountFlag(argv, "/var", "/var"), undefined)
  assert.equal(mountFlag(argv, "/var/lib", "/var/lib"), undefined)
})

test("compatibility-dir-only with uncovered symlink targets fails closed", () => {
  assert.throws(
    () => resolveSandboxNetworkMounts(
      fakeNetworkFs({
        files: new Set(["/etc/resolv.conf"]),
        dirs: new Set(["/etc/ssl/certs"]),
        realpath: (p) =>
          p === "/etc/ssl/certs"
            ? "/etc/pki/ca-trust/extracted/pem/tls-compat-only"
            : p,
      }),
    ),
    /CA trust source/,
  )
})

test("no proxy or host env leaks into argv", () => {
  const wt = mkdtempSync(join(tmpdir(), "sandbox-net-"))
  process.env.HTTP_PROXY = "http://proxy.example:8080"
  process.env.HTTPS_PROXY = "http://proxy.example:8080"
  try {
    const argv = buildBaseSandboxArgv(wt, "/workspace", {
      networkAccess: "host",
      ...hostFs(),
      env: { ...process.env, HOME: "/home/tester" },
    })
    assert.ok(!argv.some((a) => /proxy/i.test(a) && a.includes("proxy.example")))
  } finally {
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
  }
})

test("four execution tools exist with identical model-visible schema", () => {
  const source = readFileSync(pluginPath, "utf8")
  for (const name of [
    "sandbox_run",
    "sandbox_run_ro",
    "sandbox_run_network",
    "sandbox_run_network_ro",
  ]) {
    assert.ok(source.includes(`name: "${name}"`), name)
  }
  // Static binding pairs.
  assert.ok(source.includes('networkAccess: "host"'))
  const schema = sandboxRunInputSchema()
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "command",
    "cwd",
    "timeout_seconds",
  ])
  assert.deepEqual([...SANDBOX_RUN_INPUT_PROPERTY_NAMES].sort(), [
    "command",
    "cwd",
    "timeout_seconds",
  ])
  assert.equal(schema.additionalProperties, false)
  assert.ok(!source.includes("network_access"))
  assert.ok(!JSON.stringify(schema).includes("network"))
})

test("plugin registers four tools; shell stays disabled", async () => {
  const registered = new Map()
  await sandboxPlugin.setup({
    session: { async hook() {} },
    tool: {
      async transform(cb) {
        cb({ add: (info) => registered.set(info.name, info) })
      },
    },
  })
  for (const name of [
    "sandbox_run",
    "sandbox_run_ro",
    "sandbox_run_network",
    "sandbox_run_network_ro",
    "sandbox_shell",
    "sandbox_log",
  ]) {
    assert.ok(registered.has(name), name)
  }
  assert.deepEqual(
    registered.get("sandbox_run_network").input,
    registered.get("sandbox_run").input,
  )
  assert.deepEqual(
    registered.get("sandbox_run_network_ro").input,
    registered.get("sandbox_run_ro").input,
  )
  assert.match(
    registered.get("sandbox_log").description,
    /sandbox_run\*/,
  )
  const src = readFileSync(pluginPath, "utf8")
  // sandbox_shell construction must not select host networking.
  const shellIdx = src.indexOf('name: "sandbox_shell"')
  const nextTool = src.indexOf('name: "sandbox_run"', shellIdx)
  assert.ok(!src.slice(shellIdx, nextTool).includes('"host"'))
})

test("existing default builders remain networkless (equivalence)", () => {
  const wt = mkdtempSync(join(tmpdir(), "sandbox-net-"))
  const base = baseSandboxArgs(wt, "/workspace")
  assert.ok(hasNetworklessIsolation(base))
  const run = buildSandboxRunArgv(wt, "/workspace", join(wt, "run-1"), "true")
  assert.ok(hasNetworklessIsolation(run))
})

test("threading is per-invocation without global state", () => {
  const wt = mkdtempSync(join(tmpdir(), "sandbox-net-"))
  const a = buildBaseSandboxArgv(wt, "/workspace", {
    networkAccess: "host",
    ...hostFs(),
  })
  const b = buildBaseSandboxArgv(wt, "/workspace", { existsSync: () => false })
  assert.ok(!a.includes("--unshare-net"))
  assert.ok(b.includes("--unshare-net"))
  const c = buildBaseSandboxArgv(wt, "/workspace", { existsSync: () => false })
  assert.deepEqual(b, c)
})

function readAgentFile(name) {
  return readFileSync(join(here, "../../opencode/agents", name), "utf8")
}

function allowedTools(source) {
  const out = []
  const re = /- action: (\S+)\s*\n\s*resource: "[^"]*"\s*\n\s*effect: allow/g
  let match
  while ((match = re.exec(source)) !== null) {
    out.push(match[1])
  }
  return out
}

function deniedTools(source) {
  const out = []
  const re = /- action: (\S+)\s*\n\s*resource: "[^"]*"\s*\n\s*effect: deny/g
  let match
  while ((match = re.exec(source)) !== null) {
    out.push(match[1])
  }
  return out
}

const RUNNER_AGENT_MATRIX = [
  ["opencode-orchestrator-runner.md", "sandbox_run_ro"],
  ["opencode-orchestrator-runner-writable.md", "sandbox_run"],
  ["opencode-orchestrator-runner-network.md", "sandbox_run_network_ro"],
  ["opencode-orchestrator-runner-writable-network.md", "sandbox_run_network"],
]

const ALL_EXECUTION_TOOLS = [
  "sandbox_run",
  "sandbox_run_ro",
  "sandbox_run_network",
  "sandbox_run_network_ro",
]

test("each runner agent exposes exactly one execution tool plus sandbox_log", () => {
  for (const [file, expected] of RUNNER_AGENT_MATRIX) {
    const source = readAgentFile(file)
    const allowed = allowedTools(source)
    const denied = deniedTools(source)
    const executionAllowed = allowed.filter((tool) =>
      ALL_EXECUTION_TOOLS.includes(tool),
    )
    assert.deepEqual(executionAllowed, [expected], file)
    assert.ok(allowed.includes("sandbox_log"), file)
    for (const tool of ALL_EXECUTION_TOOLS.filter((t) => t !== expected)) {
      assert.ok(denied.includes(tool), `${file} must deny ${tool}`)
    }
    assert.ok(denied.includes("sandbox_shell"), `${file} must deny sandbox_shell`)
    assert.ok(source.includes(`Use ${expected} for the requested command.`), file)
  }
})

test("runner agent permission matrices retain read/glob/grep and git protections", () => {
  for (const [file] of RUNNER_AGENT_MATRIX) {
    const source = readAgentFile(file)
    const allowed = allowedTools(source)
    assert.ok(allowed.includes("read"), file)
    assert.ok(allowed.includes("glob"), file)
    assert.ok(allowed.includes("grep"), file)
    assert.ok(source.includes('resource: ".git"'), file)
    assert.ok(source.includes('resource: ".git/*"'), file)
  }
})
