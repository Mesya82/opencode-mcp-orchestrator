import assert from "node:assert/strict"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import test from "node:test"

import {
  resolveExistingContainerRuntime,
  runManagedContainerProcess,
} from "../../opencode/plugins/sandbox-tools/index.ts"

const enabled =
  process.env.RUN_CONTAINER_LIFECYCLE_INTEGRATION === "1"
const podmanEnabled =
  process.env.RUN_ROOTLESS_PODMAN_INTEGRATION === "1"

function docker(args) {
  return spawnSync(
    "/usr/bin/docker",
    args,
    {
      encoding: "utf8",
      timeout: 60_000,
    },
  )
}

function assertDockerSupervisorPython(container) {
  const setup = docker([
    "exec",
    container,
    "/bin/sh",
    "-c",
    "command -v python3 >/dev/null 2>&1 || exit 1; [ -x /usr/bin/python3 ] || { mkdir -p /usr/bin && ln -sf \"$(command -v python3)\" /usr/bin/python3; }; test -x /usr/bin/python3",
  ])
  assert.equal(
    setup.status,
    0,
    setup.stderr || setup.stdout,
  )
}

test(
  "cancelled managed container command is gone before writer-safe return",
  { skip: !enabled },
  async () => {
    const root =
      mkdtempSync(
        join(tmpdir(), "container-lifecycle-integration-"),
      )
    const workspace =
      join(root, "workspace")
    const container =
      "opencode-lifecycle-" +
      process.pid +
      "-" +
      Date.now()

    try {
      spawnSync(
        "/usr/bin/mkdir",
        ["-p", workspace],
        { encoding: "utf8" },
      )

      const started =
        docker([
          "run",
          "-d",
          "--rm",
          "--name",
          container,
          "--init",
          "--volume",
          workspace + ":/workspace",
          "python:3.12-alpine",
          "sleep",
          "300",
        ])

      assert.equal(
        started.status,
        0,
        started.stderr || started.stdout,
      )

      const containerId =
        String(started.stdout).trim()

      assert.match(containerId, /^[0-9a-f]{64}$/)

      assertDockerSupervisorPython(container)

      const controller =
        new AbortController()
      const pidFile =
        join(workspace, "command.pid")
      const lateFile =
        join(workspace, "late.txt")

      const run =
        runManagedContainerProcess(
          "/usr/bin/docker",
          containerId,
          [
            "/bin/sh",
            "-c",
            "echo $$ > /workspace/command.pid; sleep 30; echo late > /workspace/late.txt",
          ],
          "/workspace",
          {
            logPath: join(root, "combined.log"),
            activityPath: join(root, "activity"),
            logLimitBytes: 1024 * 1024,
            timeoutMs: 30_000,
            signal: controller.signal,
          },
        )

      const deadline =
        Date.now() + 5_000

      while (
        !existsSync(pidFile) &&
        Date.now() < deadline
      ) {
        await new Promise(
          (resolve) => setTimeout(resolve, 25),
        )
      }

      assert.ok(
        existsSync(pidFile),
        "managed command never reached the held in-container process",
      )

      const pid =
        readFileSync(pidFile, "utf8").trim()

      assert.match(pid, /^[1-9][0-9]*$/)

      controller.abort()

      const result = await run

      assert.equal(result.aborted, true)
      assert.equal(result.terminationConfirmed, true)

      const probe =
        docker([
          "exec",
          container,
          "/bin/sh",
          "-c",
          'test ! -d "/proc/$1"',
          "sh",
          pid,
        ])

      assert.equal(
        probe.status,
        0,
        probe.stderr || probe.stdout,
      )

      await new Promise(
        (resolve) => setTimeout(resolve, 1200),
      )

      assert.equal(
        existsSync(lateFile),
        false,
        "cancelled command mutated the worktree after managed return",
      )
    } finally {
      docker([
        "rm",
        "-f",
        container,
      ])

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)


test(
  "persistent helper is reaped and a second verification command can run",
  { skip: !enabled },
  async () => {
    const root =
      mkdtempSync(
        join(tmpdir(), "container-helper-integration-"),
      )
    const workspace =
      join(root, "workspace")
    const container =
      "opencode-helper-" +
      process.pid +
      "-" +
      Date.now()

    try {
      spawnSync(
        "/usr/bin/mkdir",
        ["-p", workspace],
        { encoding: "utf8" },
      )

      const started =
        docker([
          "run",
          "-d",
          "--rm",
          "--name",
          container,
          "--init",
          "--volume",
          workspace + ":/workspace",
          "python:3.12-alpine",
          "sleep",
          "300",
        ])

      assert.equal(
        started.status,
        0,
        started.stderr || started.stdout,
      )

      const containerId =
        String(started.stdout).trim()

      assert.match(containerId, /^[0-9a-f]{64}$/)

      assertDockerSupervisorPython(container)

      const activityPath =
        join(root, "activity")
      const lateFile =
        join(workspace, "detached-late.txt")

      const first =
        await runManagedContainerProcess(
          "/usr/bin/docker",
          containerId,
          [
            "/bin/sh",
            "-c",
            "(setsid sh -c 'sleep 1; echo late > /workspace/detached-late.txt' </dev/null >/dev/null 2>&1 &)",
          ],
          "/workspace",
          {
            logPath: join(root, "first.log"),
            activityPath,
            logLimitBytes: 1024 * 1024,
            timeoutMs: 10_000,
          },
        )

      assert.equal(
        first.terminationConfirmed,
        true,
      )
      assert.equal(
        existsSync(activityPath),
        false,
        "activity marker must clear after owned helper cleanup",
      )

      await new Promise(
        (resolve) => setTimeout(resolve, 1500),
      )

      assert.equal(
        existsSync(lateFile),
        false,
        "owned detached helper survived long enough to mutate the worktree",
      )

      const second =
        await runManagedContainerProcess(
          "/usr/bin/docker",
          containerId,
          [
            "/bin/sh",
            "-c",
            "echo verified > /workspace/verified.txt",
          ],
          "/workspace",
          {
            logPath: join(root, "second.log"),
            activityPath,
            logLimitBytes: 1024 * 1024,
            timeoutMs: 10_000,
          },
        )

      assert.equal(second.exitCode, 0)
      assert.equal(
        second.terminationConfirmed,
        true,
      )

      assert.equal(
        existsSync(activityPath),
        false,
        "creator marker was not removed after authenticated completion",
      )
      assert.equal(
        readFileSync(
          join(workspace, "verified.txt"),
          "utf8",
        ).trim(),
        "verified",
      )
    } finally {
      docker([
        "rm",
        "-f",
        container,
      ])

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  "env-scrubbed detached child is reaped before success",
  { skip: !enabled },
  async () => {
    const root =
      mkdtempSync(
        join(tmpdir(), "container-scrub-integration-"),
      )
    const workspace =
      join(root, "workspace")
    const container =
      "opencode-scrub-" +
      process.pid +
      "-" +
      Date.now()

    try {
      spawnSync(
        "/usr/bin/mkdir",
        ["-p", workspace],
        { encoding: "utf8" },
      )

      const started =
        docker([
          "run",
          "-d",
          "--rm",
          "--name",
          container,
          "--init",
          "--volume",
          workspace + ":/workspace",
          "python:3.12-alpine",
          "sleep",
          "300",
        ])

      assert.equal(
        started.status,
        0,
        started.stderr || started.stdout,
      )

      const containerId =
        String(started.stdout).trim()

      assert.match(containerId, /^[0-9a-f]{64}$/)

      assertDockerSupervisorPython(container)

      const activityPath =
        join(root, "activity")
      const lateFile =
        join(workspace, "scrubbed-late.txt")

      const result =
        await runManagedContainerProcess(
          "/usr/bin/docker",
          containerId,
          [
            "/bin/sh",
            "-c",
            "(env -u SCRUB_ME setsid sh -c 'sleep 1; echo late > /workspace/scrubbed-late.txt' </dev/null >/dev/null 2>&1 &)",
          ],
          "/workspace",
          {
            logPath: join(root, "scrub.log"),
            activityPath,
            logLimitBytes: 1024 * 1024,
            timeoutMs: 15_000,
          },
        )

      assert.equal(
        result.terminationConfirmed,
        true,
      )
      assert.equal(
        existsSync(activityPath),
        false,
      )

      await new Promise(
        (resolve) => setTimeout(resolve, 1500),
      )

      assert.equal(
        existsSync(lateFile),
        false,
        "env-scrubbed detached child survived subreaper cleanup",
      )
    } finally {
      docker([
        "rm",
        "-f",
        container,
      ])

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  "pre-existing activity marker refuses without cross-kill",
  { skip: !enabled },
  async () => {
    const root =
      mkdtempSync(
        join(tmpdir(), "container-refuse-integration-"),
      )
    const activityPath =
      join(root, "activity")
    const marker =
      JSON.stringify({
        version: 1,
        container: "some-container",
        token:
          "opencode-" + "b".repeat(32),
      }) + "\n"

    try {
      writeFileSync(
        activityPath,
        marker,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      )

      await assert.rejects(
        () =>
          runManagedContainerProcess(
            "/usr/bin/docker",
            "some-container",
            ["echo", "must-not-run"],
            "/workspace",
            {
              logPath: join(root, "refused.log"),
              activityPath,
              logLimitBytes: 1024 * 1024,
              timeoutMs: 10_000,
            },
          ),
        /refused|quarantined/,
      )

      assert.equal(
        readFileSync(
          activityPath,
          "utf8",
        ),
        marker,
      )
    } finally {
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  "rootless Podman managed command completes the supervisor protocol",
  { skip: !podmanEnabled },
  async () => {
    assert.ok(
      existsSync("/usr/bin/podman"),
      "rootless Podman integration was enabled but /usr/bin/podman is missing",
    )

    const root =
      mkdtempSync(
        join(tmpdir(), "podman-managed-integration-"),
      )
    const container =
      "opencode-podman-managed-" +
      process.pid +
      "-" +
      Date.now()

    try {
      const started =
        spawnSync(
          "/usr/bin/podman",
          [
            "run",
            "-d",
            "--rm",
            "--name",
            container,
            "python:3.12-alpine",
            "sleep",
            "60",
          ],
          {
            encoding: "utf8",
            timeout: 60_000,
            env: process.env,
          },
        )

      assert.equal(
        started.status,
        0,
        started.stderr || started.stdout,
      )

      const containerId =
        String(started.stdout).trim()

      assert.match(containerId, /^[0-9a-f]{64}$/)

      const activityPath =
        join(root, "activity")

      const result =
        await runManagedContainerProcess(
          "/usr/bin/podman",
          containerId,
          [
            "/bin/sh",
            "-c",
            "echo podman-ok",
          ],
          "/",
          {
            logPath: join(root, "podman.log"),
            activityPath,
            logLimitBytes: 1024 * 1024,
            timeoutMs: 30_000,
          },
        )

      assert.equal(
        result.terminationConfirmed,
        true,
      )
      assert.equal(result.exitCode, 0)
      assert.equal(
        existsSync(activityPath),
        false,
      )
      assert.match(
        readFileSync(
          join(root, "podman.log"),
          "utf8",
        ),
        /podman-ok/,
      )
    } finally {
      spawnSync(
        "/usr/bin/podman",
        [
          "rm",
          "-f",
          container,
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: process.env,
        },
      )

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  "rootless Podman runtime resolution preserves required XDG environment",
  { skip: !podmanEnabled },
  () => {
    assert.ok(
      existsSync("/usr/bin/podman"),
      "rootless Podman integration was enabled but /usr/bin/podman is missing",
    )

    const container =
      "opencode-podman-" +
      process.pid +
      "-" +
      Date.now()

    const started =
      spawnSync(
        "/usr/bin/podman",
        [
          "run",
          "-d",
          "--rm",
          "--name",
          container,
          "python:3.12-alpine",
          "sleep",
          "60",
        ],
        {
          encoding: "utf8",
          timeout: 60_000,
          env: process.env,
        },
      )

    assert.equal(
      started.status,
      0,
      started.stderr || started.stdout,
    )

    try {
      const resolved =
        resolveExistingContainerRuntime(
          container,
          {
            runtimePaths: [
              "/usr/bin/podman",
            ],
            env: process.env,
          },
        )

      assert.equal(
        resolved.runtime,
        "/usr/bin/podman",
      )
    } finally {
      spawnSync(
        "/usr/bin/podman",
        [
          "rm",
          "-f",
          container,
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: process.env,
        },
      )
    }
  },
)


test(
  "rootless Podman service endpoint works through validated CONTAINER_HOST",
  { skip: !podmanEnabled },
  async () => {
    assert.ok(
      existsSync("/usr/bin/podman"),
      "rootless Podman integration was enabled but /usr/bin/podman is missing",
    )

    const root =
      mkdtempSync(
        join(tmpdir(), "podman-service-integration-"),
      )
    const socketPath =
      join(root, "podman.sock")
    const endpoint =
      "unix://" + socketPath
    const container =
      "opencode-podman-service-" +
      process.pid +
      "-" +
      Date.now()
    const service =
      spawn(
        "/usr/bin/podman",
        [
          "system",
          "service",
          "--time=0",
          endpoint,
        ],
        {
          stdio: ["ignore", "ignore", "pipe"],
          env: process.env,
        },
      )

    let serviceError = ""

    service.stderr?.on(
      "data",
      (chunk) => {
        serviceError += chunk.toString()
      },
    )

    try {
      const deadline =
        Date.now() + 10_000

      while (
        !existsSync(socketPath) &&
        Date.now() < deadline
      ) {
        await new Promise(
          (resolve) => setTimeout(resolve, 50),
        )
      }

      assert.ok(
        existsSync(socketPath),
        serviceError ||
          "Podman service socket was not created",
      )

      const remoteEnv = {
        ...process.env,
        CONTAINER_HOST: endpoint,
      }

      const started =
        spawnSync(
          "/usr/bin/podman",
          [
            "run",
            "-d",
            "--rm",
            "--name",
            container,
            "python:3.12-alpine",
            "sleep",
            "60",
          ],
          {
            encoding: "utf8",
            timeout: 60_000,
            env: remoteEnv,
          },
        )

      assert.equal(
        started.status,
        0,
        started.stderr || started.stdout,
      )

      const resolved =
        resolveExistingContainerRuntime(
          container,
          {
            runtimePaths: [
              "/usr/bin/podman",
            ],
            env: remoteEnv,
          },
        )

      assert.equal(
        resolved.runtime,
        "/usr/bin/podman",
      )
      assert.equal(
        resolved.env.CONTAINER_HOST,
        endpoint,
      )

      assert.throws(
        () => resolveExistingContainerRuntime(
          container,
          {
            runtimePaths: [
              "/usr/bin/podman",
            ],
            env: {
              ...remoteEnv,
              CONTAINER_HOST:
                "ssh://example.invalid/run/podman.sock",
            },
          },
        ),
        /CONTAINER_HOST/,
      )
    } finally {
      spawnSync(
        "/usr/bin/podman",
        [
          "rm",
          "-f",
          container,
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            CONTAINER_HOST: endpoint,
          },
        },
      )

      try {
        service.kill("SIGTERM")
      } catch {
        // Already exited.
      }

      await Promise.race([
        new Promise((resolve) => {
          service.once("close", resolve)
        }),
        new Promise((resolve) => {
          setTimeout(resolve, 2000)
        }),
      ])

      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
