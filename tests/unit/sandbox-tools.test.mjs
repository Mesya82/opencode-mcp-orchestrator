import assert from "node:assert/strict"
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync, symlinkSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import {
  GIT_STATUS_TIMEOUT_MS,
  RUNNER_LOG_LIMIT_BYTES,
  SANDBOX_LOG_TIMEOUT_MS,
  SANDBOX_RUNNER_LOG_LIMIT_BYTES_DEFAULT,
  SANDBOX_RUNNER_LOG_LIMIT_BYTES_ENV,
  SANDBOX_RUNNER_LOG_LIMIT_BYTES_MAX,
  SANDBOX_RUNNER_LOG_LIMIT_BYTES_MIN,
  SANDBOX_RUN_RETENTION_COUNT_DEFAULT,
  SANDBOX_RUN_RETENTION_COUNT_ENV,
  SANDBOX_RUN_RETENTION_COUNT_MAX,
  SANDBOX_RUN_RETENTION_COUNT_MIN,
  SANDBOX_RUN_RETENTION_HOURS_DEFAULT,
  SANDBOX_RUN_RETENTION_HOURS_ENV,
  SANDBOX_RUN_RETENTION_HOURS_MAX,
  SANDBOX_RUN_RETENTION_HOURS_MIN,
  SANDBOX_SHELL_MAX_OUTPUT_BYTES_DEFAULT,
  SANDBOX_SHELL_MAX_OUTPUT_BYTES_ENV,
  SANDBOX_SHELL_MAX_OUTPUT_BYTES_MAX,
  SANDBOX_SHELL_MAX_OUTPUT_BYTES_MIN,
  SANDBOX_SHELL_TIMEOUT_MS_DEFAULT,
  SANDBOX_SHELL_TIMEOUT_MS_ENV,
  SANDBOX_SHELL_TIMEOUT_MS_MAX,
  SANDBOX_SHELL_TIMEOUT_MS_MIN,
  SANDBOX_RUNTIME_CONFIG_ENV,
  SANDBOX_TOOLCHAIN_DIRS_ENV,
  SANDBOX_RUN_INPUT_PROPERTY_NAMES,
  omitUnsupportedMuseFinalToolChoice,
  stripUnreplayableMuseReasoning,
  addAbsoluteWorktreeBind,
  addSandboxRuntimeBinds,
  addSandboxToolchainBinds,
  assertRunnerRootStat,
  baseSandboxArgs,
  buildSandboxRunArgv,
  ensureRunnerRoot,
  gitStatusSpawnOptions,
  isSpawnTimeout,
  parseSandboxToolchainEntries,
  pruneRunnerRuns,
  loadSandboxRuntimeConfig,
  resolveSandboxRuntimeCapabilities,
  resolveSandboxCwd,
  resolveRunnerLogLimitBytes,
  resolveRunnerRetentionCount,
  resolveRunnerRetentionHours,
  resolveRunnerRetentionMs,
  resolveSandboxLimits,
  resolveSandboxShellMaxOutputBytes,
  resolveSandboxShellTimeoutMs,
  resolveSandboxToolchainDirs,
  runnerOutputBindArgs,
  safeSystemPath,
  sandboxRuntimeConfigPath,
  sandboxLogSpawnOptions,
  sandboxPathWithToolchains,
  sandboxRunInputSchema,
  validateRunID,
} from "../../opencode/plugins/sandbox-tools/index.ts"

function museFinalRequest(overrides = {}) {
  const controller = new AbortController()
  const body = overrides.body ?? {
    model: "muse-spark-1.3-contributor-free",
    tools: [],
    tool_choice: "none",
    input: [{ role: "user", content: "finish" }],
  }
  const request = new Request(
    overrides.url ?? "https://console.example.test/v1/responses",
    {
      method: overrides.method ?? "POST",
      headers: {
        authorization: "Bearer secret-test-value",
        "content-type": overrides.contentType ?? "application/json",
        "x-test-header": "preserve-me",
      },
      body:
        overrides.rawBody ??
        JSON.stringify(body),
      signal: controller.signal,
    },
  )

  return {
    controller,
    input: {
      sessionID: "ses_test",
      agent: "opencode-orchestrator-worker",
      kind: "primary",
      model: {
        providerID: "opencode",
        id: "muse-spark-1.3-contributor-free",
      },
      request,
      ...overrides.input,
    },
  }
}

test("Muse final request omits unsupported none choice after tools are removed", async () => {
  const { controller, input } = museFinalRequest()
  const original = input.request

  assert.equal(
    await omitUnsupportedMuseFinalToolChoice(input),
    true,
  )
  assert.notEqual(input.request, original)
  assert.equal(original.bodyUsed, false)
  assert.equal(input.request.url, original.url)
  assert.equal(input.request.method, "POST")
  assert.equal(
    input.request.headers.get("authorization"),
    "Bearer secret-test-value",
  )
  assert.equal(
    input.request.headers.get("x-test-header"),
    "preserve-me",
  )

  assert.deepEqual(await input.request.clone().json(), {
    model: "muse-spark-1.3-contributor-free",
    tools: [],
    input: [{ role: "user", content: "finish" }],
  })

  assert.equal(input.request.signal.aborted, false)
  controller.abort()
  assert.equal(input.request.signal.aborted, true)
})

test("Muse final request also permits an omitted tools field", async () => {
  const { input } = museFinalRequest({
    body: {
      model: "muse-spark-1.3-contributor-free",
      tool_choice: "none",
    },
  })

  assert.equal(
    await omitUnsupportedMuseFinalToolChoice(input),
    true,
  )
  assert.deepEqual(await input.request.json(), {
    model: "muse-spark-1.3-contributor-free",
  })
})

test("Muse final request compatibility rewrite fails closed", async () => {
  const cases = [
    {
      name: "ordinary agent",
      input: { agent: "ordinary-agent" },
    },
    {
      name: "other provider",
      input: {
        model: {
          providerID: "other",
          id: "muse-spark-1.3-contributor-free",
        },
      },
    },
    {
      name: "other model",
      input: {
        model: {
          providerID: "opencode",
          id: "different-model",
        },
      },
    },
    {
      name: "auxiliary request",
      input: { kind: "compaction" },
    },
    {
      name: "tools still present",
      body: {
        tools: [{ type: "function", name: "read" }],
        tool_choice: "none",
      },
    },
    {
      name: "automatic choice",
      body: { tools: [], tool_choice: "auto" },
    },
    {
      name: "unknown tools shape",
      body: { tools: null, tool_choice: "none" },
    },
    {
      name: "non-JSON content type",
      contentType: "text/plain",
    },
    {
      name: "malformed JSON",
      rawBody: "{not-json",
    },
  ]

  for (const candidate of cases) {
    const { input } = museFinalRequest(candidate)
    const original = input.request

    assert.equal(
      await omitUnsupportedMuseFinalToolChoice(input),
      false,
      candidate.name,
    )
    assert.equal(input.request, original, candidate.name)
    assert.equal(original.bodyUsed, false, candidate.name)
  }
})

test("Muse orchestrator contexts drop unreplayable reasoning only", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "hidden",
          encrypted: "opaque-provider-state",
        },
        { type: "text", text: "visible" },
        { type: "tool-call", id: "call_1", name: "read", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "call_1",
          name: "read",
          result: { type: "text", value: "result" },
        },
      ],
    },
  ]

  assert.equal(
    stripUnreplayableMuseReasoning({
      agent: "opencode-orchestrator-worker",
      model: {
        providerID: "opencode",
        id: "muse-spark-1.3-contributor-free",
      },
      messages,
    }),
    1,
  )

  assert.deepEqual(
    messages[0].content.map((part) => part.type),
    ["text", "tool-call"],
  )
  assert.equal(messages[1].content[0].type, "tool-result")

  for (const input of [
    {
      agent: "ordinary-user-agent",
      model: { providerID: "opencode", id: "muse-spark-1.3-contributor-free" },
    },
    {
      agent: "opencode-orchestrator-worker",
      model: { providerID: "other", id: "muse-spark-1.3-contributor-free" },
    },
    {
      agent: "opencode-orchestrator-worker",
      model: { providerID: "opencode", id: "different-model" },
    },
  ]) {
    const untouched = [{
      role: "assistant",
      content: [{ type: "reasoning", text: "keep" }],
    }]

    assert.equal(
      stripUnreplayableMuseReasoning({ ...input, messages: untouched }),
      0,
    )
    assert.equal(untouched[0].content.length, 1)
  }
})

function fakeStat(overrides = {}) {
  return {
    isSymbolicLink: () => false,
    isDirectory: () => true,
    uid: 1000,
    ...overrides,
  }
}

test("synchronous spawn options carry finite timeouts", () => {
  for (const options of [
    gitStatusSpawnOptions(),
    sandboxLogSpawnOptions(),
  ]) {
    assert.equal(typeof options.timeout, "number")
    assert.ok(Number.isFinite(options.timeout))
    assert.ok(options.timeout > 0)
  }

  assert.equal(GIT_STATUS_TIMEOUT_MS, 15000)
  assert.equal(SANDBOX_LOG_TIMEOUT_MS, 15000)
  assert.equal(
    gitStatusSpawnOptions().timeout,
    GIT_STATUS_TIMEOUT_MS,
  )
  assert.equal(
    sandboxLogSpawnOptions().timeout,
    SANDBOX_LOG_TIMEOUT_MS,
  )
})

test("timeout is distinct from ordinary nonzero exit", () => {
  assert.equal(
    isSpawnTimeout({
      error: { code: "ETIMEDOUT" },
    }),
    true,
  )

  assert.equal(
    isSpawnTimeout({
      error: new Error("spawnSync timed out"),
    }),
    true,
  )

  // Ordinary nonzero exit carries no spawn error.
  assert.equal(
    isSpawnTimeout({ status: 1, signal: null }),
    false,
  )

  // Successful execution carries no spawn error.
  assert.equal(
    isSpawnTimeout({ status: 0, signal: null }),
    false,
  )

  assert.equal(isSpawnTimeout(null), false)
  assert.equal(isSpawnTimeout(undefined), false)
})

test("unsafe runner roots fail closed", () => {
  assert.throws(
    () =>
      assertRunnerRootStat(
        fakeStat({ isSymbolicLink: () => true }),
        1000,
        "/tmp/opencode-runner-runs",
      ),
    /symlink runner root/,
  )

  assert.throws(
    () =>
      assertRunnerRootStat(
        fakeStat({ isDirectory: () => false }),
        1000,
        "/tmp/opencode-runner-runs",
      ),
    /not a directory/,
  )

  assert.throws(
    () =>
      assertRunnerRootStat(fakeStat({ uid: 999 }), 1000,
        "/tmp/opencode-runner-runs"),
    /not owned by current user/,
  )

  assert.doesNotThrow(() =>
    assertRunnerRootStat(fakeStat(), 1000,
      "/tmp/opencode-runner-runs"),
  )

  // Ownership enforcement is skipped only where ownership is unavailable.
  assert.doesNotThrow(() =>
    assertRunnerRootStat(
      { isSymbolicLink: () => false, isDirectory: () => true },
      1000,
      "/tmp/opencode-runner-runs",
    ),
  )
})

test("runner log cap is preserved", () => {
  assert.equal(
    RUNNER_LOG_LIMIT_BYTES,
    128 * 1024 * 1024,
  )
  assert.equal(
    RUNNER_LOG_LIMIT_BYTES,
    SANDBOX_RUNNER_LOG_LIMIT_BYTES_DEFAULT,
  )
})

const SANDBOX_LIMIT_SPECS = [
  {
    env: SANDBOX_SHELL_TIMEOUT_MS_ENV,
    resolve: resolveSandboxShellTimeoutMs,
    def: SANDBOX_SHELL_TIMEOUT_MS_DEFAULT,
    min: SANDBOX_SHELL_TIMEOUT_MS_MIN,
    max: SANDBOX_SHELL_TIMEOUT_MS_MAX,
  },
  {
    env: SANDBOX_SHELL_MAX_OUTPUT_BYTES_ENV,
    resolve: resolveSandboxShellMaxOutputBytes,
    def: SANDBOX_SHELL_MAX_OUTPUT_BYTES_DEFAULT,
    min: SANDBOX_SHELL_MAX_OUTPUT_BYTES_MIN,
    max: SANDBOX_SHELL_MAX_OUTPUT_BYTES_MAX,
  },
  {
    env: SANDBOX_RUNNER_LOG_LIMIT_BYTES_ENV,
    resolve: resolveRunnerLogLimitBytes,
    def: SANDBOX_RUNNER_LOG_LIMIT_BYTES_DEFAULT,
    min: SANDBOX_RUNNER_LOG_LIMIT_BYTES_MIN,
    max: SANDBOX_RUNNER_LOG_LIMIT_BYTES_MAX,
  },
  {
    env: SANDBOX_RUN_RETENTION_HOURS_ENV,
    resolve: resolveRunnerRetentionHours,
    def: SANDBOX_RUN_RETENTION_HOURS_DEFAULT,
    min: SANDBOX_RUN_RETENTION_HOURS_MIN,
    max: SANDBOX_RUN_RETENTION_HOURS_MAX,
  },
  {
    env: SANDBOX_RUN_RETENTION_COUNT_ENV,
    resolve: resolveRunnerRetentionCount,
    def: SANDBOX_RUN_RETENTION_COUNT_DEFAULT,
    min: SANDBOX_RUN_RETENTION_COUNT_MIN,
    max: SANDBOX_RUN_RETENTION_COUNT_MAX,
  },
]

function withSandboxLimitEnv(values, fn) {
  const saved = new Map()
  const keys = new Set([
    SANDBOX_SHELL_TIMEOUT_MS_ENV,
    SANDBOX_SHELL_MAX_OUTPUT_BYTES_ENV,
    SANDBOX_RUNNER_LOG_LIMIT_BYTES_ENV,
    SANDBOX_RUN_RETENTION_HOURS_ENV,
    SANDBOX_RUN_RETENTION_COUNT_ENV,
    ...Object.keys(values ?? {}),
  ])
  for (const key of keys) {
    saved.set(key, process.env[key])
  }
  try {
    for (const key of [
      SANDBOX_SHELL_TIMEOUT_MS_ENV,
      SANDBOX_SHELL_MAX_OUTPUT_BYTES_ENV,
      SANDBOX_RUNNER_LOG_LIMIT_BYTES_ENV,
      SANDBOX_RUN_RETENTION_HOURS_ENV,
      SANDBOX_RUN_RETENTION_COUNT_ENV,
    ]) {
      delete process.env[key]
    }
    for (const [key, value] of Object.entries(values ?? {})) {
      process.env[key] = value
    }
    return fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

test("sandbox resource limits default when unset without module reload", () => {
  withSandboxLimitEnv({}, () => {
    assert.equal(
      resolveSandboxShellTimeoutMs(),
      120000,
    )
    assert.equal(
      resolveSandboxShellMaxOutputBytes(),
      30000,
    )
    assert.equal(
      resolveRunnerLogLimitBytes(),
      134217728,
    )
    assert.equal(resolveRunnerRetentionHours(), 24)
    assert.equal(resolveRunnerRetentionCount(), 20)
    assert.equal(
      resolveRunnerRetentionMs(),
      24 * 60 * 60 * 1000,
    )
    const limits = resolveSandboxLimits()
    assert.deepEqual(limits, {
      shellTimeoutMs: 120000,
      shellMaxOutputBytes: 30000,
      runnerLogLimitBytes: 134217728,
      runnerRetentionHours: 24,
      runnerRetentionCount: 20,
      runnerRetentionMs: 24 * 60 * 60 * 1000,
    })
  })
})

test("sandbox resource limits accept configured boundary values", () => {
  for (const spec of SANDBOX_LIMIT_SPECS) {
    withSandboxLimitEnv(
      { [spec.env]: String(spec.min) },
      () => {
        assert.equal(spec.resolve(), spec.min)
      },
    )
    withSandboxLimitEnv(
      { [spec.env]: String(spec.max) },
      () => {
        assert.equal(spec.resolve(), spec.max)
      },
    )
    const mid = Math.floor((spec.min + spec.max) / 2)
    withSandboxLimitEnv(
      { [spec.env]: `  ${mid}  ` },
      () => {
        assert.equal(spec.resolve(), mid)
      },
    )
  }

  withSandboxLimitEnv(
    { [SANDBOX_SHELL_TIMEOUT_MS_ENV]: "5000" },
    () => {
      assert.equal(
        resolveSandboxLimits().shellTimeoutMs,
        5000,
      )
    },
  )
})

test("sandbox resource limits reject invalid values fail closed", () => {
  for (const spec of SANDBOX_LIMIT_SPECS) {
    const bad = [
      "",
      "   ",
      "abc",
      "12.5",
      "1e3",
      "0x10",
      "12a",
      "--5",
      String(spec.min - 1),
      String(spec.max + 1),
    ]
    for (const value of bad) {
      withSandboxLimitEnv(
        { [spec.env]: value },
        () => {
          assert.throws(
            () => spec.resolve(),
            new RegExp(spec.env),
            `${spec.env}=${value}`,
          )
          assert.throws(
            () => resolveSandboxLimits(),
            new RegExp(spec.env),
            `${spec.env}=${value}`,
          )
        },
      )
    }
  }
})

test("sandbox resource limit errors name only the variable", () => {
  withSandboxLimitEnv(
    { [SANDBOX_SHELL_TIMEOUT_MS_ENV]: "not-an-int" },
    () => {
      try {
        resolveSandboxShellTimeoutMs()
        assert.fail("expected to throw")
      } catch (error) {
        assert.match(
          error.message,
          new RegExp(SANDBOX_SHELL_TIMEOUT_MS_ENV),
        )
        assert.doesNotMatch(
          error.message,
          /not-an-int/,
        )
      }
    },
  )
})

test("buildSandboxRunArgv uses configured runner log cap", () => {
  const worktree = mkdtempSync(join(tmpdir(), "sandbox-cap-"))
  withSandboxLimitEnv({}, () => {
    const argv = withCleanToolchainEnv(() =>
      buildSandboxRunArgv(
        worktree,
        "/workspace",
        join(worktree, "run-1"),
        "true",
      ),
    )
    assert.equal(
      argv[argv.length - 1],
      String(134217728),
    )
  })
  withSandboxLimitEnv(
    { [SANDBOX_RUNNER_LOG_LIMIT_BYTES_ENV]: "2097152" },
    () => {
      const argv = withCleanToolchainEnv(() =>
        buildSandboxRunArgv(
          worktree,
          "/workspace",
          join(worktree, "run-1"),
          "true",
        ),
      )
      assert.equal(argv[argv.length - 1], "2097152")
      const explicit = withCleanToolchainEnv(() =>
        buildSandboxRunArgv(
          worktree,
          "/workspace",
          join(worktree, "run-1"),
          "true",
          { logLimitBytes: 4194304 },
        ),
      )
      assert.equal(
        explicit[explicit.length - 1],
        "4194304",
      )
    },
  )
})

test("toolchain entries trim and ignore empty entries", () => {
  assert.deepEqual(
    parseSandboxToolchainEntries("", delimiter),
    [],
  )
  assert.deepEqual(
    parseSandboxToolchainEntries(undefined, delimiter),
    [],
  )
  assert.deepEqual(
    parseSandboxToolchainEntries(
      `  ${delimiter}  ${delimiter} `,
      delimiter,
    ),
    [],
  )
  assert.deepEqual(
    parseSandboxToolchainEntries(
      `  /a${delimiter}${delimiter} /b  `,
      delimiter,
    ),
    ["/a", "/b"],
  )
})

test("unset toolchain setting resolves to no directories", () => {
  const saved = process.env[SANDBOX_TOOLCHAIN_DIRS_ENV]
  delete process.env[SANDBOX_TOOLCHAIN_DIRS_ENV]
  try {
    assert.deepEqual(
      resolveSandboxToolchainDirs(),
      [],
    )
    assert.deepEqual(
      resolveSandboxToolchainDirs(""),
      [],
    )
    assert.deepEqual(
      resolveSandboxToolchainDirs("   "),
      [],
    )
  } finally {
    if (saved === undefined) {
      delete process.env[SANDBOX_TOOLCHAIN_DIRS_ENV]
    } else {
      process.env[SANDBOX_TOOLCHAIN_DIRS_ENV] =
        saved
    }
  }
})

test("valid toolchain directories get read-only binds and PATH entries", () => {
  const root = mkdtempSync(join(tmpdir(), "toolchain-"))
  const dirA = join(root, "a")
  const dirB = join(root, "b")
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })

  const resolved = resolveSandboxToolchainDirs(
    `${dirA}${delimiter}${dirB}`,
  )
  assert.equal(resolved.length, 2)
  assert.ok(resolved[0].endsWith("/a"))
  assert.ok(resolved[1].endsWith("/b"))

  const argv = []
  addSandboxToolchainBinds(argv, resolved)
  assert.deepEqual(argv, [
    "--ro-bind",
    resolved[0],
    resolved[0],
    "--ro-bind",
    resolved[1],
    resolved[1],
  ])

  const base = "/usr/local/bin:/usr/bin:/bin"
  assert.equal(
    sandboxPathWithToolchains(base, []),
    base,
  )
  assert.equal(
    sandboxPathWithToolchains(base, resolved),
    `${base}:${resolved.join(":")}`,
  )
})

test("toolchain symlink canonicalizes to the same directory", () => {
  const root = mkdtempSync(join(tmpdir(), "toolchain-link-"))
  const target = join(root, "real")
  mkdirSync(target, { recursive: true })
  const link = join(root, "link")
  symlinkSync(target, link)

  const resolved = resolveSandboxToolchainDirs(link)
  assert.deepEqual(resolved, [target])
})

test("toolchain dangerous, missing, relative, and non-directory entries fail closed", () => {
  const home = process.env.HOME

  if (home) {
    assert.throws(
      () => resolveSandboxToolchainDirs(home),
      /broad/,
    )
  }

  for (const denied of [
    "/",
    "/home",
    "/tmp",
    "/usr",
    "/etc",
    "/proc",
    "/dev",
    "/opt",
    "/var",
    "/mnt",
    "/proc/1",
    "/sys/kernel",
    "/etc/ssl",
  ]) {
    assert.throws(
      () => resolveSandboxToolchainDirs(denied),
      /broad/,
      denied,
    )
  }

  assert.throws(
    () => resolveSandboxToolchainDirs("relative/bin"),
    /absolute/,
  )
  assert.throws(
    () =>
      resolveSandboxToolchainDirs(
        join(tmpdir(), "missing-toolchain-dir-xyz"),
      ),
    /does not exist/,
  )

  const root = mkdtempSync(join(tmpdir(), "toolchain-file-"))
  const file = join(root, "tool")
  writeFileSync(file, "x\n")
  assert.throws(
    () => resolveSandboxToolchainDirs(file),
    /not a directory/,
  )
})

test("toolchain duplicates fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "toolchain-dup-"))
  const dirA = join(root, "a")
  mkdirSync(dirA, { recursive: true })
  const link = join(root, "link")
  symlinkSync(dirA, link)

  assert.throws(
    () =>
      resolveSandboxToolchainDirs(
        `${dirA}${delimiter}${dirA}`,
      ),
    /duplicate/,
  )
  assert.throws(
    () =>
      resolveSandboxToolchainDirs(
        `${dirA}${delimiter}${link}`,
      ),
    /duplicate/,
  )
})

test("sandbox runtime config is reloaded from the configured path", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-runtime-config-"))
  const path = join(dir, "config.json")
  const env = {
    HOME: "/home/tester",
    [SANDBOX_RUNTIME_CONFIG_ENV]: path,
  }

  try {
    assert.equal(sandboxRuntimeConfigPath(env), path)

    writeFileSync(path, JSON.stringify({
      sandboxRuntime: {
        trustedRoots: [{
          root: "/opt/runtime-one",
          pathEntries: ["bin"],
        }],
      },
    }))

    assert.equal(
      loadSandboxRuntimeConfig({ env }).trustedRoots[0].root,
      "/opt/runtime-one",
    )

    writeFileSync(path, JSON.stringify({
      sandboxRuntime: {
        trustedRoots: [{
          root: "/opt/runtime-two",
          pathEntries: ["tools"],
        }],
      },
    }))

    assert.equal(
      loadSandboxRuntimeConfig({ env }).trustedRoots[0].root,
      "/opt/runtime-two",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("sandbox runtime config cannot be loaded from a writable worktree", () => {
  const worktree = mkdtempSync(join(tmpdir(), "sandbox-runtime-config-wt-"))
  const path = join(worktree, "config.json")
  writeFileSync(path, JSON.stringify({
    sandboxRuntime: { trustedRoots: [] },
  }))

  try {
    assert.throws(
      () => loadSandboxRuntimeConfig({
        env: {
          HOME: "/home/tester",
          [SANDBOX_RUNTIME_CONFIG_ENV]: path,
        },
        worktree,
      }),
      /invalid sandbox runtime configuration/,
    )
  } finally {
    rmSync(worktree, { recursive: true, force: true })
  }
})

test("sandbox runtime capabilities resolve contained roots, paths, and environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-runtime-"))
  const root = join(dir, "installation")
  const bin = join(root, "bin")
  const home = join(dir, "home")
  mkdirSync(bin, { recursive: true })
  mkdirSync(home)

  try {
    const capabilities = resolveSandboxRuntimeCapabilities({
      config: {
        trustedRoots: [{
          root,
          pathEntries: ["bin"],
          environment: { RUNTIME_HOME: "." },
        }],
      },
      env: { HOME: home },
    })

    assert.deepEqual(capabilities, {
      mountRoots: [root],
      pathEntries: [bin],
      environment: { RUNTIME_HOME: root },
    })

    const outside = join(dir, "outside")
    mkdirSync(outside)
    symlinkSync(outside, join(root, "escape"))

    assert.throws(
      () => resolveSandboxRuntimeCapabilities({
        config: {
          trustedRoots: [{
            root,
            pathEntries: ["escape"],
            environment: {},
          }],
        },
        env: { HOME: home },
      }),
      /escapes its root/,
    )

    const credentials = join(home, ".ssh")
    mkdirSync(credentials)

    assert.throws(
      () => resolveSandboxRuntimeCapabilities({
        config: {
          trustedRoots: [{
            root: credentials,
            pathEntries: ["."],
            environment: {},
          }],
        },
        env: { HOME: home },
      }),
      /broad sandbox runtime root/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("sandbox runtime binds create only destination parents and read-only roots", () => {
  const argv = ["--dir", "/home"]

  addSandboxRuntimeBinds(
    argv,
    ["/home/tester/toolchains/runtime"],
  )

  assert.deepEqual(argv, [
    "--dir", "/home",
    "--dir", "/home/tester",
    "--dir", "/home/tester/toolchains",
    "--ro-bind",
    "/home/tester/toolchains/runtime",
    "/home/tester/toolchains/runtime",
  ])
})

test("safe system PATH canonicalizes inherited aliases into the mounted usr tree", () => {
  const canonical = new Map([
    ["/run/fnm/bin", "/usr/local/share/fnm/runtime/bin"],
    ["/home/tester/bin", "/home/tester/bin"],
    ["/usr/local/bin", "/usr/local/bin"],
    ["/usr/bin", "/usr/bin"],
  ])

  assert.equal(
    safeSystemPath({
      path: "/run/fnm/bin:/home/tester/bin:/usr/bin",
      realpathSync: (path) => canonical.get(path),
      statSync: () => ({ isDirectory: () => true }),
    }),
    "/usr/local/share/fnm/runtime/bin:/usr/bin:/usr/local/bin",
  )
})

test("base sandbox args apply runtime roots without model-controlled input", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-runtime-base-"))
  const worktree = join(dir, "worktree")
  const root = join(dir, "runtime")
  const bin = join(root, "bin")
  const configPath = join(dir, "config.json")
  mkdirSync(worktree)
  mkdirSync(bin, { recursive: true })
  writeFileSync(configPath, JSON.stringify({
    sandboxRuntime: {
      trustedRoots: [{
        root,
        pathEntries: ["bin"],
        environment: { RUNTIME_HOME: "." },
      }],
    },
  }))

  const savedConfig = process.env[SANDBOX_RUNTIME_CONFIG_ENV]
  const savedToolchains = process.env[SANDBOX_TOOLCHAIN_DIRS_ENV]

  process.env[SANDBOX_RUNTIME_CONFIG_ENV] = configPath
  delete process.env[SANDBOX_TOOLCHAIN_DIRS_ENV]

  try {
    const argv = baseSandboxArgs(worktree, "/workspace")
    const pathIndex = argv.findIndex(
      (value, index) => value === "--setenv" && argv[index + 1] === "PATH",
    )
    const environmentIndex = argv.findIndex(
      (value, index) => value === "--setenv" && argv[index + 1] === "RUNTIME_HOME",
    )

    assert.equal(mountFlag(argv, root, root), "--ro-bind")
    assert.ok(argv[pathIndex + 2].split(delimiter).includes(bin))
    assert.equal(argv[environmentIndex + 2], root)
  } finally {
    if (savedConfig === undefined) {
      delete process.env[SANDBOX_RUNTIME_CONFIG_ENV]
    } else {
      process.env[SANDBOX_RUNTIME_CONFIG_ENV] = savedConfig
    }

    if (savedToolchains === undefined) {
      delete process.env[SANDBOX_TOOLCHAIN_DIRS_ENV]
    } else {
      process.env[SANDBOX_TOOLCHAIN_DIRS_ENV] = savedToolchains
    }

    rmSync(dir, { recursive: true, force: true })
  }
})

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = join(
  here,
  "../../opencode/plugins/sandbox-tools/index.ts",
)
const runnerPath = join(
  here,
  "../../opencode/agents/opencode-orchestrator-runner.md",
)
const runnerWritablePath = join(
  here,
  "../../opencode/agents/opencode-orchestrator-runner-writable.md",
)

function withCleanToolchainEnv(fn) {
  const saved = process.env[SANDBOX_TOOLCHAIN_DIRS_ENV]
  delete process.env[SANDBOX_TOOLCHAIN_DIRS_ENV]
  try {
    return fn()
  } finally {
    if (saved === undefined) {
      delete process.env[SANDBOX_TOOLCHAIN_DIRS_ENV]
    } else {
      process.env[SANDBOX_TOOLCHAIN_DIRS_ENV] = saved
    }
  }
}

function mountFlag(argv, source, target) {
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (argv[i + 1] === source && argv[i + 2] === target) {
      return argv[i]
    }
  }
  return undefined
}

function allowsAgentAction(doc, action) {
  const re = new RegExp(
    `- action: ${action}\\s*\n\\s*resource:.*\n\\s*effect: allow`,
  )
  return re.test(doc)
}

function deniesAgentAction(doc, action) {
  const re = new RegExp(
    `- action: ${action}\\s*\n\\s*resource:.*\n\\s*effect: deny`,
  )
  return re.test(doc)
}

test("writable sandbox_run uses --bind for both workspace aliases", () => {
  const worktree = mkdtempSync(join(tmpdir(), "sandbox-wt-"))
  const argv = withCleanToolchainEnv(() =>
    baseSandboxArgs(worktree, "/workspace"),
  )

  assert.equal(
    mountFlag(argv, worktree, "/workspace"),
    "--bind",
  )
  assert.equal(
    mountFlag(argv, worktree, worktree),
    "--bind",
  )

  // /tmp stays writable via tmpfs and /runner-output stays a writable bind.
  assert.ok(argv.includes("--tmpfs"))
  assert.ok(argv.includes("/tmp"))
  const probeRunDir = join(tmpdir(), "run-probe")
  assert.deepEqual(runnerOutputBindArgs(probeRunDir), [
    "--bind",
    probeRunDir,
    "/runner-output",
  ])

  const runArgv = withCleanToolchainEnv(() =>
    buildSandboxRunArgv(
      worktree,
      "/workspace",
      join(worktree, "run-1"),
      "true",
    ),
  )
  assert.equal(
    mountFlag(runArgv, worktree, "/workspace"),
    "--bind",
  )
  assert.equal(
    mountFlag(runArgv, worktree, worktree),
    "--bind",
  )
  assert.equal(
    mountFlag(
      runArgv,
      join(worktree, "run-1"),
      "/runner-output",
    ),
    "--bind",
  )
})

test("read-only sandbox_run_ro uses --ro-bind for both workspace aliases", () => {
  const worktree = mkdtempSync(join(tmpdir(), "sandbox-wt-"))
  const argv = withCleanToolchainEnv(() =>
    baseSandboxArgs(worktree, "/workspace", {
      readonlyWorkspace: true,
    }),
  )

  assert.equal(
    mountFlag(argv, worktree, "/workspace"),
    "--ro-bind",
  )
  assert.equal(
    mountFlag(argv, worktree, worktree),
    "--ro-bind",
  )

  // /tmp stays writable via tmpfs and /runner-output stays a writable bind.
  assert.ok(argv.includes("--tmpfs"))
  assert.ok(argv.includes("/tmp"))

  const runDir = join(worktree, "run-1")
  const runArgv = withCleanToolchainEnv(() =>
    buildSandboxRunArgv(
      worktree,
      "/workspace",
      runDir,
      "true",
      { readonlyWorkspace: true },
    ),
  )
  assert.equal(
    mountFlag(runArgv, worktree, "/workspace"),
    "--ro-bind",
  )
  assert.equal(
    mountFlag(runArgv, worktree, worktree),
    "--ro-bind",
  )
  assert.equal(
    mountFlag(runArgv, runDir, "/runner-output"),
    "--bind",
  )
})

test("sandbox_run inputs expose no mount-control flag", () => {
  const schema = sandboxRunInputSchema()
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    ["command", "cwd", "timeout_seconds"],
  )
  assert.deepEqual(
    [...SANDBOX_RUN_INPUT_PROPERTY_NAMES].sort(),
    ["command", "cwd", "timeout_seconds"],
  )
  assert.equal(schema.additionalProperties, false)

  const source = readFileSync(pluginPath, "utf8")
  assert.ok(source.includes('name: "sandbox_run_ro"'))
  assert.ok(source.includes("{ readonlyWorkspace: true }"))
  assert.ok(source.includes("{ readonlyWorkspace: false }"))
})

test("runner permission documents enforce read-only versus writable", () => {
  const runner = readFileSync(runnerPath, "utf8")
  const writable = readFileSync(
    runnerWritablePath,
    "utf8",
  )

  assert.equal(allowsAgentAction(runner, "sandbox_run_ro"), true)
  assert.equal(allowsAgentAction(runner, "sandbox_log"), true)
  assert.equal(allowsAgentAction(runner, "sandbox_run"), false)
  assert.equal(deniesAgentAction(runner, "sandbox_run"), true)
  assert.equal(allowsAgentAction(runner, "sandbox_shell"), false)
  assert.equal(deniesAgentAction(runner, "sandbox_shell"), true)
  assert.match(runner, /sandbox_run_ro/)
  assert.match(runner, /read-only repository workspace/)

  assert.equal(allowsAgentAction(writable, "sandbox_run"), true)
  assert.equal(allowsAgentAction(writable, "sandbox_log"), true)
  assert.equal(deniesAgentAction(writable, "sandbox_run_ro"), true)
  assert.match(writable, /may modify/)
})

test("resolveSandboxCwd preserves valid paths", () => {
  const worktree = mkdtempSync(join(tmpdir(), "sandbox-cwd-"))
  mkdirSync(join(worktree, "sub"), { recursive: true })

  assert.equal(resolveSandboxCwd(worktree, undefined), "/workspace")
  assert.equal(resolveSandboxCwd(worktree, "."), "/workspace")
  assert.equal(resolveSandboxCwd(worktree, "sub"), "/workspace/sub")
  assert.equal(
    resolveSandboxCwd(worktree, "sub/../sub"),
    "/workspace/sub",
  )
})

test("resolveSandboxCwd rejects traversal with bounded error", () => {
  const worktree = mkdtempSync(join(tmpdir(), "sandbox-cwd-"))
  mkdirSync(join(worktree, "sub"), { recursive: true })

  for (const requested of ["..", "../outside", "sub/../../.."]) {
    assert.throws(
      () => resolveSandboxCwd(worktree, requested),
      /escapes worktree/,
      requested,
    )
    try {
      resolveSandboxCwd(worktree, requested)
      assert.fail("expected to throw")
    } catch (error) {
      assert.match(error.message, /escapes worktree/)
      assert.match(error.message, new RegExp(requested.replace(/\./g, "\\.")))
      assert.doesNotMatch(error.message, new RegExp(worktree.replace(/[/-]/g, (c) => `\\${c}`)))
      assert.doesNotMatch(error.message, /ENOENT/)
    }
  }
})

test("resolveSandboxCwd rejects symlink escape with bounded error", () => {
  const worktree = mkdtempSync(join(tmpdir(), "sandbox-cwd-"))
  const outside = mkdtempSync(join(tmpdir(), "sandbox-outside-"))
  mkdirSync(join(outside, "inner"), { recursive: true })
  symlinkSync(outside, join(worktree, "link"))

  for (const requested of ["link", "link/inner"]) {
    assert.throws(
      () => resolveSandboxCwd(worktree, requested),
      /escapes worktree/,
      requested,
    )
    try {
      resolveSandboxCwd(worktree, requested)
      assert.fail("expected to throw")
    } catch (error) {
      assert.doesNotMatch(error.message, /ENOENT/)
      assert.doesNotMatch(error.message, new RegExp(outside.replace(/[/-]/g, (c) => `\\${c}`)))
    }
  }
})

test("resolveSandboxCwd reports missing path and file with bounded errors", () => {
  const worktree = mkdtempSync(join(tmpdir(), "sandbox-cwd-"))
  writeFileSync(join(worktree, "plain"), "x\n")

  assert.throws(
    () => resolveSandboxCwd(worktree, "no-such-dir"),
    /does not exist|invalid cwd/,
  )
  try {
    resolveSandboxCwd(worktree, "no-such-dir")
    assert.fail("expected to throw")
  } catch (error) {
    assert.match(error.message, /no-such-dir/)
    assert.doesNotMatch(error.message, /ENOENT/)
    assert.doesNotMatch(error.message, new RegExp(worktree.replace(/[/-]/g, (c) => `\\${c}`)))
  }

  assert.throws(
    () => resolveSandboxCwd(worktree, "plain"),
    /not a directory/,
  )
  try {
    resolveSandboxCwd(worktree, "plain")
    assert.fail("expected to throw")
  } catch (error) {
    assert.match(error.message, /plain/)
    assert.doesNotMatch(error.message, new RegExp(worktree.replace(/[/-]/g, (c) => `\\${c}`)))
  }
})

test("validateRunID rejects traversal and missing with stable errors", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-runs-"))
  ensureRunnerRoot(root)

  for (const bad of ["../evil", "evil", "run-../../etc", "run-bad/id"]) {
    assert.throws(() => validateRunID(bad, root), /invalid run_id/, bad)
  }

  assert.throws(
    () => validateRunID("run-missing-xyz", root),
    /unknown run_id|invalid run_id/,
  )
  try {
    validateRunID("run-missing-xyz", root)
    assert.fail("expected to throw")
  } catch (error) {
    assert.match(error.message, /run-missing-xyz|unknown run_id|invalid run_id/)
    assert.doesNotMatch(error.message, /ENOENT/)
  }

  const good = join(root, "run-good1")
  mkdirSync(good, { recursive: true })
  const validated = validateRunID("run-good1", root)
  assert.ok(validated.endsWith("run-good1"))
})

test("validateRunID rejects symlinked and file run entries", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-runs-"))
  ensureRunnerRoot(root)
  const outside = mkdtempSync(join(tmpdir(), "sandbox-outside-"))
  symlinkSync(outside, join(root, "run-link"))

  assert.throws(
    () => validateRunID("run-link", root),
    /escapes|invalid|unknown/,
  )
  try {
    validateRunID("run-link", root)
    assert.fail("expected to throw")
  } catch (error) {
    assert.doesNotMatch(error.message, /ENOENT/)
  }

  writeFileSync(join(root, "run-file1"), "x\n")
  assert.throws(() => validateRunID("run-file1", root), /invalid run_id/)
})

test("addAbsoluteWorktreeBind tolerates unavailable HOME realpath", () => {
  const savedHome = process.env.HOME
  process.env.HOME = join(tmpdir(), "missing-home-dir-xyz-sandbox")
  try {
    const worktree = mkdtempSync(join(tmpdir(), "sandbox-wt-"))
    const argv = []
    assert.doesNotThrow(() =>
      addAbsoluteWorktreeBind(argv, worktree),
    )
    assert.ok(argv.includes(worktree))
  } finally {
    if (savedHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = savedHome
    }
  }
})

test("addAbsoluteWorktreeBind still refuses forbidden roots without HOME", () => {
  const savedHome = process.env.HOME
  process.env.HOME = join(tmpdir(), "missing-home-dir-xyz-sandbox")
  try {
    assert.throws(
      () => addAbsoluteWorktreeBind([], "/etc"),
      /unsafe|unsupported/,
    )
    assert.throws(
      () => addAbsoluteWorktreeBind([], "/usr/bin"),
      /unsupported/,
    )
  } finally {
    if (savedHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = savedHome
    }
  }
})

test("ensureRunnerRoot creates missing roots with 0700", () => {
  const parent = mkdtempSync(join(tmpdir(), "sandbox-root-"))
  const target = join(parent, "runs")
  assert.equal(existsSync(target), false)

  ensureRunnerRoot(target)
  assert.equal(statSync(target).isDirectory(), true)
  assert.equal(statSync(target).mode & 0o777, 0o700)

  chmodSync(target, 0o755)
  ensureRunnerRoot(target)
  assert.equal(statSync(target).mode & 0o777, 0o700)
  assert.equal(lstatSync(target).isSymbolicLink(), false)
})

test("pruneRunnerRuns enforces age and count", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-prune-"))
  ensureRunnerRoot(root)

  const oldDir = join(root, "run-old")
  const freshDir = join(root, "run-fresh")
  mkdirSync(oldDir, { recursive: true })
  mkdirSync(freshDir, { recursive: true })
  const ancient = (Date.now() - 4 * 60 * 60 * 1000) / 1000
  utimesSync(oldDir, ancient, ancient)
  pruneRunnerRuns({ retentionMs: 60 * 60 * 1000, maxRuns: 10, root })
  assert.equal(existsSync(oldDir), false)
  assert.equal(existsSync(freshDir), true)

  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  ensureRunnerRoot(root)
  const names = ["run-a", "run-b", "run-c"]
  const base = Date.now() / 1000
  for (let i = 0; i < names.length; i += 1) {
    mkdirSync(join(root, names[i]), { recursive: true })
    utimesSync(join(root, names[i]), base + i, base + i)
  }
  pruneRunnerRuns({ retentionMs: 24 * 60 * 60 * 1000, maxRuns: 2, root })
  assert.equal(existsSync(join(root, "run-c")), true)
  assert.equal(existsSync(join(root, "run-b")), true)
  assert.equal(existsSync(join(root, "run-a")), false)
})
