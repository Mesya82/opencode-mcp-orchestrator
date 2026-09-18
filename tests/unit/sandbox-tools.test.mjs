import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync, symlinkSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import sandboxPlugin, {
  GIT_STATUS_TIMEOUT_MS,
  RUNNER_ROOT,
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
  CONTAINER_RUN_INPUT_PROPERTY_NAMES,
  EXISTING_CONTAINER_RUNTIME_PATHS,
  buildContainerExecArgs,
  containerRunInputSchema,
  containerRuntimeEnv,
  readWorkerContainerCapability,
  runCancellableLoggedProcess,
  resolveContainerRunWorkdir,
  resolveSandboxLogSpawnResult,
  resolveExistingContainerRuntime,
  validateExistingContainerInspect,
  omitUnsupportedMuseFinalToolChoice,
  stripUnreplayableMuseReasoning,
  addAbsoluteWorktreeBind,
  addSandboxRuntimeBinds,
  addSandboxToolchainBinds,
  assertRunnerRootStat,
  baseSandboxArgs,
  buildSandboxRunArgv,
  ensureRunnerRoot,
  gitStatus,
  gitStatusSpawnOptions,
  isSpawnTimeout,
  parseSandboxToolchainEntries,
  pruneRunnerRuns,
  loadSandboxRuntimeConfig,
  resolveSandboxRuntimeCapabilities,
  resolveSandboxCwd,
  resolveGitStatusOutput,
  resolveSessionWorktree,
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

test("container_run schema cannot select or broaden the parent-selected container", () => {
  const schema = containerRunInputSchema()
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    ["argv", "timeout_seconds", "workdir"],
  )
  assert.deepEqual(
    [...CONTAINER_RUN_INPUT_PROPERTY_NAMES].sort(),
    ["argv", "timeout_seconds", "workdir"],
  )
  assert.equal(schema.additionalProperties, false)
  const serialized = JSON.stringify(schema)
  assert.ok(!serialized.includes('"container"'))
  assert.ok(!serialized.includes('"runtime"'))
  assert.ok(!serialized.includes('"network_access"'))
})

test("container exec argv keeps runtime options before the fixed container and command argv after it", () => {
  assert.deepEqual(
    buildContainerExecArgs(
      "dev-box",
      ["printf", "%s", "--privileged", "a b"],
      "/workspace",
    ),
    [
      "exec",
      "--workdir",
      "/workspace",
      "dev-box",
      "printf",
      "%s",
      "--privileged",
      "a b",
    ],
  )
})

test("existing-container admission rejects dangerous host capabilities", () => {
  assert.doesNotThrow(() =>
    validateExistingContainerInspect({
      State: { Running: true },
      HostConfig: { Privileged: false, PidMode: "" },
      Mounts: [
        {
          Type: "bind",
          Source: "/home/me/project",
          Destination: "/workspace",
          RW: true,
        },
      ],
    }),
  )

  assert.throws(
    () => validateExistingContainerInspect({
      State: { Running: true },
      HostConfig: { Privileged: true, PidMode: "" },
      Mounts: [],
    }),
    /privileged/,
  )

  assert.throws(
    () => validateExistingContainerInspect({
      State: { Running: true },
      HostConfig: { Privileged: false, PidMode: "" },
      Mounts: [{
        Type: "bind",
        Source: "/",
        Destination: "/host",
        RW: true,
      }],
    }),
    /host root/,
  )

  assert.throws(
    () => validateExistingContainerInspect({
      State: { Running: true },
      HostConfig: { Privileged: false, PidMode: "" },
      Mounts: [{
        Type: "bind",
        Source: "/run/podman/podman.sock",
        Destination: "/run/podman/podman.sock",
        RW: true,
      }],
    }),
    /runtime socket/,
  )
})

test("existing-container admission rejects ancestor runtime-socket mounts even read-only", () => {
  for (const candidate of [
    {
      Source: "/var/run",
      Destination: "/host-run",
      RW: true,
    },
    {
      Source: "/var/run",
      Destination: "/host-run-ro",
      RW: false,
    },
    {
      Source: "/run/user/1000",
      Destination: "/host-user-run",
      RW: true,
    },
    {
      Source: "/run/user/1000",
      Destination: "/host-user-run-ro",
      RW: false,
    },
  ]) {
    assert.throws(
      () => validateExistingContainerInspect({
        State: { Running: true },
        HostConfig: { Privileged: false, PidMode: "" },
        Mounts: [{
          Type: "bind",
          ...candidate,
        }],
      }),
      /runtime socket/,
    )
  }
})

test("existing-container admission rejects remapped rootless Docker and containerd sockets", () => {
  for (const source of [
    "/run/user/1000/docker.sock",
    "/run/user/1000/docker/docker.sock",
    "/run/user/1000/containerd/containerd.sock",
    "/run/user/1000/containerd-rootless/api.sock",
  ]) {
    for (const writable of [false, true]) {
      assert.throws(
        () => validateExistingContainerInspect({
          State: { Running: true },
          HostConfig: { Privileged: false, PidMode: "" },
          Mounts: [{
            Type: "bind",
            Source: source,
            Destination: "/tmp/runtime-api",
            RW: writable,
          }],
        }),
        /runtime socket/,
      )
    }
  }
})

test("existing-container admission rejects writable mounts overlapping capability storage", () => {
  assert.throws(
    () => validateExistingContainerInspect({
      State: { Running: true },
      HostConfig: { Privileged: false, PidMode: "" },
      Mounts: [{
        Type: "bind",
        Source: "/tmp",
        Destination: "/host-tmp",
        RW: true,
      }],
    }),
    /worker capability storage/,
  )

  assert.doesNotThrow(
    () => validateExistingContainerInspect({
      State: { Running: true },
      HostConfig: { Privileged: false, PidMode: "" },
      Mounts: [{
        Type: "bind",
        Source: "/tmp",
        Destination: "/host-tmp",
        RW: false,
      }],
    }),
  )
})

test("existing-container admission fails closed on malformed security fields", () => {
  for (const bad of [
    {
      State: { Running: true },
      Mounts: [],
    },
    {
      State: { Running: true },
      HostConfig: {},
      Mounts: [],
    },
    {
      State: { Running: true },
      HostConfig: { Privileged: false, PidMode: "" },
    },
    {
      State: { Running: true },
      HostConfig: { Privileged: false, PidMode: "" },
      Mounts: [{}],
    },
    {
      State: { Running: true },
      HostConfig: { Privileged: false, PidMode: "" },
      Mounts: [{
        Type: "bind",
        Source: "/home/me/project",
        Destination: "/workspace",
        RW: "yes",
      }],
    },
  ]) {
    assert.throws(
      () => validateExistingContainerInspect(bad),
      /invalid existing container inspection/,
    )
  }
})

test("container cwd auto mode maps the canonical host worktree through inspected mounts", () => {
  const capability = {
    version: 1,
    container: "dev-box",
    workspaceAccess: "writable",
    containerCwd: "auto",
    networkAccess: "inherit",
    hostCwd: "/home/me/project/packages/app",
  }

  assert.equal(
    resolveContainerRunWorkdir(
      capability,
      undefined,
      {
        Mounts: [
          {
            Source: "/home/me",
            Destination: "/host-home",
            RW: true,
          },
          {
            Source: "/home/me/project",
            Destination: "/workspace",
            RW: true,
          },
        ],
      },
    ),
    "/workspace/packages/app",
  )
})

test("container cwd auto mode refuses same-named but unproven container directories", () => {
  const capability = {
    version: 1,
    container: "dev-box",
    workspaceAccess: "writable",
    containerCwd: "auto",
    networkAccess: "inherit",
    hostCwd: "/home/me/project",
  }

  assert.throws(
    () => resolveContainerRunWorkdir(
      capability,
      undefined,
      {
        Mounts: [{
          Source: "/different/source",
          Destination: "/home/me/project",
          RW: true,
        }],
      },
    ),
    /set execution\.container_cwd explicitly/,
  )

  assert.equal(
    resolveContainerRunWorkdir(
      capability,
      "/explicit/workspace",
      { Mounts: [] },
    ),
    "/explicit/workspace",
  )
})

test("writable auto mapping rejects a read-only workspace mount", () => {
  assert.throws(
    () => resolveContainerRunWorkdir(
      {
        version: 1,
        container: "dev-box",
        workspaceAccess: "writable",
        containerCwd: "auto",
        networkAccess: "inherit",
        hostCwd: "/home/me/project",
      },
      undefined,
      {
        Mounts: [{
          Source: "/home/me/project",
          Destination: "/workspace",
          RW: false,
        }],
      },
    ),
    /read-only container mount/,
  )
})

test("existing-container runtime preserves validated local Unix endpoint and required rootless paths only", () => {
  assert.deepEqual(
    containerRuntimeEnv({
      HOME: "/home/tester",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_CONFIG_HOME: "/home/tester/.config",
      XDG_DATA_HOME: "/home/tester/.local/share",
      XDG_CACHE_HOME: "/home/tester/.cache",
      CONTAINERS_STORAGE_CONF: "/home/tester/.config/containers/storage.conf",
      DOCKER_HOST: "unix:///tmp/attacker.sock",
      CONTAINER_HOST: "unix:///run/user/1000/podman/podman.sock",
      AWS_SECRET_ACCESS_KEY: "secret",
    }),
    {
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_CONFIG_HOME: "/home/tester/.config",
      XDG_DATA_HOME: "/home/tester/.local/share",
      XDG_CACHE_HOME: "/home/tester/.cache",
      CONTAINERS_STORAGE_CONF: "/home/tester/.config/containers/storage.conf",
      CONTAINER_HOST: "unix:///run/user/1000/podman/podman.sock",
    },
  )

  assert.throws(
    () => containerRuntimeEnv({
      HOME: "relative/home",
    }),
    /invalid HOME/,
  )

  for (const value of [
    "ssh://host/run/podman.sock",
    "tcp://127.0.0.1:8080",
    "unix://relative.sock",
    "unix:///tmp/../run/podman.sock",
    "unix:///tmp/socket%2Esock",
  ]) {
    assert.throws(
      () => containerRuntimeEnv({
        CONTAINER_HOST: value,
      }),
      /CONTAINER_HOST/,
      value,
    )
  }
})

test("runtime resolution is fixed by host admission rather than model input", () => {
  const calls = []
  const resolved = resolveExistingContainerRuntime("dev-box", {
    runtimePaths: ["/usr/bin/podman", "/usr/bin/docker"],
    existsSync: (path) => path === "/usr/bin/podman",
    env: {
      HOME: "/home/tester",
      XDG_RUNTIME_DIR: "/run/user/1000",
      CONTAINER_HOST: "unix:///run/user/1000/podman/podman.sock",
    },
    spawnSync: (command, argv, options) => {
      calls.push([command, argv, options])
      return {
        status: 0,
        stdout: JSON.stringify([{
          State: { Running: true },
          HostConfig: { Privileged: false, PidMode: "" },
          Mounts: [],
        }]),
        stderr: "",
      }
    },
  })

  assert.equal(resolved.runtime, "/usr/bin/podman")
  assert.equal(calls.length, 1)
  assert.deepEqual(
    calls[0].slice(0, 2),
    ["/usr/bin/podman", ["inspect", "dev-box"]],
  )
  assert.deepEqual(
    calls[0][2].env,
    {
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
      XDG_RUNTIME_DIR: "/run/user/1000",
      CONTAINER_HOST: "unix:///run/user/1000/podman/podman.sock",
    },
  )
  assert.deepEqual(
    resolved.env,
    calls[0][2].env,
  )
  assert.ok(EXISTING_CONTAINER_RUNTIME_PATHS.includes("/usr/bin/podman"))
})

test("worker container capability is session-bound and validates stored state", () => {
  const cap = readWorkerContainerCapability("ses_test", {
    root: "/tmp/test-cap-root",
    readFileSync: (path, encoding) => {
      assert.equal(path, "/tmp/test-cap-root/ses_test.json")
      assert.equal(encoding, "utf8")
      return JSON.stringify({
        version: 1,
        container: "dev-box",
        workspaceAccess: "writable",
        containerCwd: "auto",
        networkAccess: "inherit",
        hostCwd: "/home/me/project",
      })
    },
  })

  assert.equal(cap.container, "dev-box")
  assert.equal(cap.networkAccess, "inherit")
  assert.throws(
    () => readWorkerContainerCapability("bad/session", {
      root: "/tmp/test-cap-root",
      readFileSync: () => "{}",
    }),
    /session id/,
  )
})

test("async logged process aborts promptly without blocking concurrent execution", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "container-run-abort-"),
  )

  try {
    const controller = new AbortController()
    const longRun = runCancellableLoggedProcess(
      process.execPath,
      [
        "-e",
        "setInterval(() => {}, 1000)",
      ],
      {
        logPath: join(dir, "long.log"),
        logLimitBytes: 4096,
        timeoutMs: 5000,
        signal: controller.signal,
      },
    )

    const quickRun = runCancellableLoggedProcess(
      process.execPath,
      [
        "-e",
        'process.stdout.write("quick")',
      ],
      {
        logPath: join(dir, "quick.log"),
        logLimitBytes: 4096,
        timeoutMs: 1000,
      },
    )

    const quickResult = await Promise.race([
      quickRun,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(
            new Error("concurrent execution was blocked"),
          ),
          1000,
        )
      }),
    ])

    assert.equal(quickResult.exitCode, 0)
    assert.equal(quickResult.timedOut, false)

    controller.abort()

    const result = await Promise.race([
      longRun,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(
            new Error("cancellable process did not terminate promptly"),
          ),
          1000,
        )
      }),
    ])

    assert.equal(result.aborted, true)
    assert.equal(result.timedOut, false)
    assert.ok(result.elapsedMs < 1000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("async logged process truncates persisted output without changing successful exit", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "container-run-log-cap-"),
  )

  try {
    const logPath = join(dir, "combined.log")
    const result = await runCancellableLoggedProcess(
      process.execPath,
      [
        "-e",
        'process.stdout.write("x".repeat(64 * 1024))',
      ],
      {
        logPath,
        logLimitBytes: 1024,
        timeoutMs: 5000,
      },
    )

    assert.equal(result.exitCode, 0)
    assert.equal(result.timedOut, false)
    assert.equal(result.aborted, false)
    assert.equal(result.truncated, true)
    assert.equal(statSync(logPath).size, 1024)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("streamed log write failure is contained and terminates the child", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "container-run-log-write-failure-"),
  )

  try {
    const result = await runCancellableLoggedProcess(
      process.execPath,
      [
        "-e",
        'process.stdout.write("trigger"); setInterval(() => {}, 1000)',
      ],
      {
        logPath: join(dir, "combined.log"),
        logLimitBytes: 4096,
        timeoutMs: 5000,
        writeFn: () => {
          const error = new Error("disk full")
          error.code = "ENOSPC"
          throw error
        },
      },
    )

    assert.ok(result.logError)
    assert.match(result.logError.message, /disk full/)
    assert.equal(result.timedOut, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("sandbox_log reports ENOBUFS and signal as truncated failure", () => {
  const summary =
    resolveSandboxLogSpawnResult({
      status: null,
      signal: "SIGTERM",
      error: { code: "ENOBUFS" },
      stdout: "partial output",
    })

  assert.equal(summary.exitCode, 1)
  assert.equal(summary.timedOut, false)
  assert.equal(summary.failed, true)
  assert.equal(summary.truncated, true)
  assert.equal(summary.output, "partial output")
})

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
    // Deterministic even when the denied root is missing inside a sandbox:
    // inject an existing-directory canonicalization so the broad-root
    // rejection itself is exercised rather than a missing-path error.
    assert.throws(
      () =>
        resolveSandboxToolchainDirs(denied, {
          home: join(tmpdir(), "toolchain-broad-home-xyz"),
          realpathSync: (entry) => entry,
          statSync: () => ({ isDirectory: () => true }),
        }),
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

test("resolveSessionWorktree returns distinct canonical roots per session", async (t) => {
  const dirA = mkdtempSync(join(tmpdir(), "sandbox-ses-a-"))
  const dirB = mkdtempSync(join(tmpdir(), "sandbox-ses-b-"))
  t.after(() => {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  })
  const seen = []
  const get = async ({ sessionID }) => {
    seen.push(sessionID)
    return { location: { directory: sessionID === "ses-a" ? dirA : dirB } }
  }

  assert.equal(await resolveSessionWorktree({ sessionID: "ses-a" }, get), dirA)
  assert.equal(await resolveSessionWorktree({ sessionID: "ses-b" }, get), dirB)
  assert.deepEqual(seen, ["ses-a", "ses-b"])
})

test("resolveSessionWorktree accepts bare and data-wrapped session responses", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-ses-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(
    await resolveSessionWorktree({ sessionID: "s1" }, async () => ({ location: { directory: dir } })),
    dir,
  )
  assert.equal(
    await resolveSessionWorktree({ sessionID: "s1" }, async () => ({ data: { location: { directory: dir } } })),
    dir,
  )
})

test("resolveSessionWorktree fails closed without leaking absolute paths", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-ses-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const missing = join(tmpdir(), "sandbox-ses-missing-xyz")
  const file = join(dir, "plain")
  writeFileSync(file, "x\n")

  const cases = [
    { context: {}, get: async () => ({ location: { directory: dir } }), match: /unavailable|lookup|directory|worktree/ },
    { context: { sessionID: "" }, get: async () => ({ location: { directory: dir } }), match: /unavailable/ },
    { context: { sessionID: "s" }, get: async () => { throw new Error("boom") }, match: /lookup failed/ },
    { context: { sessionID: "s" }, get: async () => ({}), match: /no directory/ },
    { context: { sessionID: "s" }, get: async () => ({ location: {} }), match: /no directory/ },
    { context: { sessionID: "s" }, get: async () => ({ location: { directory: missing } }), match: /unavailable/ },
    { context: { sessionID: "s" }, get: async () => ({ location: { directory: file } }), match: /not a directory/ },
  ]

  for (const { context, get, match } of cases) {
    await assert.rejects(() => resolveSessionWorktree(context, get), match)
    try {
      await resolveSessionWorktree(context, get)
      assert.fail("expected to throw")
    } catch (error) {
      assert.doesNotMatch(error.message, /ENOENT/)
      assert.doesNotMatch(error.message, /boom/)
      for (const secret of [missing, file]) {
        assert.ok(!error.message.includes(secret), `leaked ${secret}`)
      }
    }
  }
})

test("resolveSessionWorktree does not cache session moves", async (t) => {
  const dirA = mkdtempSync(join(tmpdir(), "sandbox-ses-move-a-"))
  const dirB = mkdtempSync(join(tmpdir(), "sandbox-ses-move-b-"))
  t.after(() => {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  })
  let current = dirA
  const get = async () => ({ location: { directory: current } })

  assert.equal(await resolveSessionWorktree({ sessionID: "s" }, get), dirA)
  current = dirB
  assert.equal(await resolveSessionWorktree({ sessionID: "s" }, get), dirB)
})

test("filesystem tool sources resolve per-session worktree from context", () => {
  const source = readFileSync(pluginPath, "utf8")
  for (const name of ["sandbox_shell", "sandbox_run", "sandbox_run_ro"]) {
    assert.ok(source.includes(`name: "${name}"`), name)
  }
  assert.ok(source.includes("resolveSessionWorktree"))
  assert.ok(source.includes("context.sessionID") || source.includes("sessionID"))
  assert.ok(source.includes("execute: async (input, context)"))
  assert.ok(!source.includes("const worktree = realpathSync(configuredRoot)"))
})

test("sandbox_shell resolves and mounts each executing session worktree", async (t) => {
  const dirA = mkdtempSync(join(tmpdir(), "sandbox-execute-a-"))
  const dirB = mkdtempSync(join(tmpdir(), "sandbox-execute-b-"))
  const registered = new Map()
  const spawned = []
  const previousBun = globalThis.Bun

  for (const directory of [dirA, dirB]) {
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: directory,
      encoding: "utf8",
    })
    assert.equal(initialized.status, 0, initialized.stderr)
  }

  t.after(() => {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
    globalThis.Bun = previousBun
  })

  globalThis.Bun = {
    spawn(argv) {
      spawned.push(argv)
      if (argv.includes("/runner-output") && argv.includes(dirB)) {
        writeFileSync(join(dirB, "runner-change.txt"), "changed\n")
      }
      return {
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        exited: Promise.resolve(0),
        kill() {},
      }
    },
  }

  await sandboxPlugin.setup({
    session: {
      async hook() {},
      async get({ sessionID }) {
        return {
          location: {
            directory: sessionID === "ses-a" ? dirA : dirB,
          },
        }
      },
    },
    tool: {
      async transform(callback) {
        callback({
          add(info) {
            registered.set(info.name, info)
          },
        })
      },
    },
  })

  const shell = registered.get("sandbox_shell")
  assert.ok(shell)

  const resultA = await shell.execute(
    { command: "true" },
    { sessionID: "ses-a" },
  )
  const resultB = await shell.execute(
    { command: "true" },
    { sessionID: "ses-b" },
  )

  assert.equal(mountFlag(spawned[0], dirA, "/workspace"), "--bind")
  assert.equal(mountFlag(spawned[1], dirB, "/workspace"), "--bind")
  assert.ok(!spawned[0].includes(dirB))
  assert.ok(!spawned[1].includes(dirA))
  assert.match(resultA.content, new RegExp(`sandbox_root=${dirA}`))
  assert.match(resultB.content, new RegExp(`sandbox_root=${dirB}`))

  const runnerReadOnly = registered.get("sandbox_run_ro")
  const runnerWritable = registered.get("sandbox_run")
  assert.ok(runnerReadOnly)
  assert.ok(runnerWritable)

  const runnerA = await runnerReadOnly.execute(
    { command: "true" },
    { sessionID: "ses-a" },
  )
  const runnerB = await runnerWritable.execute(
    { command: "true" },
    { sessionID: "ses-b" },
  )

  assert.equal(mountFlag(spawned[2], dirA, "/workspace"), "--ro-bind")
  assert.equal(mountFlag(spawned[3], dirB, "/workspace"), "--bind")
  assert.match(runnerA.content, /worktree_status_changed=false/)
  assert.match(runnerB.content, /worktree_status_changed=true/)
  assert.match(runnerB.content, /runner-change\.txt/)

  for (const result of [runnerA, runnerB]) {
    const runID = result.content.match(/^run_id=(.+)$/m)?.[1]
    if (runID) {
      rmSync(join(RUNNER_ROOT, runID), {
        recursive: true,
        force: true,
      })
    }
  }
})

test("gitStatus fails closed on spawn error, signal, and nonzero exit", () => {
  const gitWorktree = mkdtempSync(join(tmpdir(), "gitstatus-fail-"))
  mkdirSync(join(gitWorktree, ".git"), { recursive: true })
  try {
    const lstatYes = () => ({})
    const spawnFail = () => ({ error: new Error("spawn ENOENT") })
    assert.throws(
      () => gitStatus(gitWorktree, { lstatSync: lstatYes, spawnSync: spawnFail }),
      /failed to start/,
    )
    assert.throws(
      () => gitStatus(gitWorktree, {
        lstatSync: lstatYes,
        spawnSync: () => ({ error: { code: "ETIMEDOUT" }, status: null, signal: null }),
      }),
      new RegExp(`timed out after ${GIT_STATUS_TIMEOUT_MS}ms`),
    )
    assert.throws(
      () => gitStatus(gitWorktree, {
        lstatSync: lstatYes,
        spawnSync: () => ({ status: 128, signal: null, stdout: "" }),
      }),
      /exit 128/,
    )
    assert.throws(
      () => gitStatus(gitWorktree, {
        lstatSync: lstatYes,
        spawnSync: () => ({ status: null, signal: "SIGKILL", stdout: "" }),
      }),
      /signal/,
    )
    assert.throws(
      () => gitStatus(gitWorktree, {
        lstatSync: lstatYes,
        spawnSync: () => ({ status: 0, signal: null, stdout: undefined }),
      }),
      /unusable output/,
    )
    assert.throws(
      () => gitStatus(gitWorktree, {
        lstatSync: lstatYes,
        spawnSync: () => { throw new Error("spawn threw synchronously") },
      }),
      /failed to start/,
    )
    assert.equal(
      gitStatus(gitWorktree, {
        lstatSync: lstatYes,
        spawnSync: () => ({ status: 0, signal: null, stdout: " M file.txt\n" }),
      }),
      " M file.txt\n",
    )
    // Intentional non-Git workspaces stay supported without spawning git.
    assert.equal(
      gitStatus(gitWorktree, {
        lstatSync: () => { throw Object.assign(new Error("no such file"), { code: "ENOENT" }) },
        spawnSync: () => { throw new Error("must not spawn") },
      }),
      "",
    )
    // EACCES inspecting .git metadata must fail closed with a fixed
    // bounded message (no unbounded error.message interpolation).
    {
      let thrown = null
      try {
        gitStatus(gitWorktree, {
          lstatSync: () => { throw Object.assign(new Error("permission denied EACCES-secret-leak"), { code: "EACCES" }) },
          spawnSync: () => { throw new Error("must not spawn") },
        })
      } catch (error) {
        thrown = error
      }
      assert.ok(thrown, "must throw")
      assert.match(thrown.message, /unable to inspect git metadata/)
      assert.ok(!thrown.message.includes("EACCES-secret-leak"), "must not interpolate error text")
      assert.ok(!thrown.message.includes("EACCES"), "must use fixed bounded message")
      // Unknown inspection failure also uses the fixed bounded message.
      assert.throws(
        () => gitStatus(gitWorktree, {
          lstatSync: () => { throw Object.assign(new Error("weird-custom-xyz"), { code: "WEIRD" }) },
          spawnSync: () => { throw new Error("must not spawn") },
        }),
        (error) => {
          assert.match(error.message, /unable to inspect git metadata/)
          assert.ok(!error.message.includes("weird-custom-xyz"))
          return true
        },
      )
    }
    // Dangling .git symlink: lstat succeeds so git must run and a git
    // failure must surface rather than returning empty.
    assert.throws(
      () => gitStatus(gitWorktree, {
        lstatSync: lstatYes,
        spawnSync: () => ({ status: 128, signal: null, stdout: "" }),
      }),
      /exit 128/,
    )
  } finally {
    rmSync(gitWorktree, { recursive: true, force: true })
  }
})

test("gitStatus runs git on a dangling .git symlink instead of returning empty", () => {
  const worktree = mkdtempSync(join(tmpdir(), "gitstatus-dangling-"))
  try {
    symlinkSync(
      join(worktree, "missing-target-xyz"),
      join(worktree, ".git"),
    )
    // Real lstat succeeds on the dangling link, so the injected failing
    // git proves gitStatus delegates to git rather than short-circuiting.
    assert.throws(
      () => gitStatus(worktree, {
        spawnSync: () => ({ status: 128, signal: null, stdout: "" }),
      }),
      /exit 128/,
    )
  } finally {
    rmSync(worktree, { recursive: true, force: true })
  }
})

test("gitStatus treats broken git metadata as failure, not unchanged", () => {
  const broken = mkdtempSync(join(tmpdir(), "gitstatus-broken-"))
  try {
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: broken,
      encoding: "utf8",
    })
    assert.equal(initialized.status, 0, initialized.stderr)
    // Corrupt the metadata so real git exits nonzero (bad HEAD revision).
    writeFileSync(join(broken, ".git", "HEAD"), "garbage-not-a-ref!!!\n")
    assert.throws(() => gitStatus(broken), /failed|terminated|unusable|timed out/)
  } finally {
    rmSync(broken, { recursive: true, force: true })
  }
})

test("resolveGitStatusOutput preserves timeout errors and rejects bad shapes", () => {
  assert.throws(
    () => resolveGitStatusOutput({ error: { code: "ETIMEDOUT" } }),
    new RegExp(`timed out after ${GIT_STATUS_TIMEOUT_MS}ms`),
  )
  assert.throws(() => resolveGitStatusOutput({ error: new Error("x") }), /failed to start/)
  assert.throws(() => resolveGitStatusOutput({ status: 1, signal: null, stdout: "" }), /exit 1/)
  assert.throws(() => resolveGitStatusOutput({ status: 0, signal: null, stdout: 42 }), /unusable output/)
  assert.equal(resolveGitStatusOutput({ status: 0, signal: null, stdout: "" }), "")
})
