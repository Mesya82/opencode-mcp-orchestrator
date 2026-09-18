import assert from "node:assert/strict"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
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
          "alpine:3.20",
          "sleep",
          "300",
        ])

      assert.equal(
        started.status,
        0,
        started.stderr || started.stdout,
      )

      const controller =
        new AbortController()
      const pidFile =
        join(workspace, "command.pid")
      const lateFile =
        join(workspace, "late.txt")

      const run =
        runManagedContainerProcess(
          "/usr/bin/docker",
          container,
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
  "successful detached writer is detected and leaves managed execution unconfirmed",
  { skip: !enabled },
  async () => {
    const root =
      mkdtempSync(
        join(tmpdir(), "container-detached-integration-"),
      )
    const workspace =
      join(root, "workspace")
    const container =
      "opencode-detached-" +
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
          "alpine:3.20",
          "sleep",
          "300",
        ])

      assert.equal(
        started.status,
        0,
        started.stderr || started.stdout,
      )

      const activityPath =
        join(root, "activity")

      const result =
        await runManagedContainerProcess(
          "/usr/bin/docker",
          container,
          [
            "/bin/sh",
            "-c",
            "(setsid sh -c 'sleep 1; echo late > /workspace/detached-late.txt' </dev/null >/dev/null 2>&1 &)",
          ],
          "/workspace",
          {
            logPath: join(root, "combined.log"),
            activityPath,
            logLimitBytes: 1024 * 1024,
            timeoutMs: 10_000,
          },
        )

      assert.equal(
        result.terminationConfirmed,
        false,
      )
      assert.ok(
        existsSync(activityPath),
        "activity marker must remain when detached descendants are detected",
      )

      await new Promise(
        (resolve) => setTimeout(resolve, 1500),
      )

      assert.equal(
        existsSync(
          join(workspace, "detached-late.txt"),
        ),
        true,
        "fixture did not actually keep a detached writer alive",
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
          "alpine:3.20",
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
