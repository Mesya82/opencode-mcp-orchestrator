import { Plugin } from "@opencode/plugin"
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs"
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { spawnSync } from "node:child_process"

const SHELL_MAX_OUTPUT = 30000
const SHELL_TIMEOUT_MS = 120000

const RUNNER_ROOT = "/tmp/opencode-runner-runs"
const RUNNER_RETENTION_MS = 24 * 60 * 60 * 1000
const RUNNER_MAX_RUNS = 20
const RUNNER_LOG_LIMIT_BYTES = 128 * 1024 * 1024

const RUNNER_DEFAULT_TIMEOUT_SECONDS = 900
const RUNNER_MAX_TIMEOUT_SECONDS = 3600

function truncate(value: string, max = SHELL_MAX_OUTPUT): string {
  if (value.length <= max) return value
  return value.slice(0, max) + "\n...[output truncated]..."
}

function roBindIfExists(argv: string[], source: string, target = source) {
  if (existsSync(source)) {
    argv.push("--ro-bind", source, target)
  }
}

function addAbsoluteWorktreeBind(
  argv: string[],
  worktree: string,
) {
  /*
   * Some repository-local tools embed the repository's original absolute
   * pathname in shebangs, generated launchers, caches, metadata, etc.
   *
   * Expose ONLY the active worktree at that same absolute path inside the
   * sandbox. Do not expose the containing host directories.
   *
   * Example:
   *
   *   host worktree:
   *     /home/user/projects/foo
   *
   *   sandbox:
   *     /workspace
   *     /home/user/projects/foo
   *
   * Both mount points reference the same worktree.
   */
  if (!isAbsolute(worktree)) {
    throw new Error(
      `worktree must be absolute: ${worktree}`,
    )
  }

  if (
    worktree === "/" ||
    worktree === "/home" ||
    worktree === "/tmp"
  ) {
    throw new Error(
      `refusing unsafe worktree root: ${worktree}`,
    )
  }

  /*
   * Never overlay one of the sandbox's system mount trees.
   */
  const first =
    worktree.split("/").filter(Boolean)[0] ?? ""

  const forbiddenRoots = new Set([
    "usr",
    "bin",
    "sbin",
    "lib",
    "lib64",
    "etc",
    "proc",
    "dev",
    "workspace",
  ])

  if (forbiddenRoots.has(first)) {
    throw new Error(
      `unsupported worktree location: ${worktree}`,
    )
  }

  /*
   * Refuse accidentally exposing an entire user HOME.
   */
  const home = process.env.HOME

  if (
    home &&
    realpathSync(home) === worktree
  ) {
    throw new Error(
      "refusing to mount the entire host HOME as a worktree",
    )
  }

  /*
   * Construct only empty destination directories inside the sandbox.
   * These are NOT host-directory mounts.
   */
  const parts =
    worktree.split("/").filter(Boolean)

  let current = ""

  for (const part of parts) {
    current += "/" + part

    /*
     * /home already exists as a synthetic empty directory.
     * /tmp already exists as a private tmpfs.
     */
    if (
      current === "/home" ||
      current === "/tmp"
    ) {
      continue
    }

    argv.push(
      "--dir",
      current,
    )
  }

  /*
   * Mount exactly the worktree, and nothing above it.
   */
  argv.push(
    "--bind",
    worktree,
    worktree,
  )
}

function safeSystemPath(): string {
  const inherited = (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .filter(
      (p) =>
        p === "/bin" ||
        p === "/sbin" ||
        p.startsWith("/usr/"),
    )

  return [...new Set([
    ...inherited,
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ])].join(":")
}

function resolveSandboxCwd(worktree: string, requested?: string): string {
  if (!requested || requested === ".") {
    return "/workspace"
  }

  const target = realpathSync(resolve(worktree, requested))
  const rel = relative(worktree, target)

  if (
    rel === ".." ||
    rel.startsWith(".." + sep) ||
    isAbsolute(rel)
  ) {
    throw new Error(`cwd escapes worktree: ${requested}`)
  }

  return rel === ""
    ? "/workspace"
    : "/workspace/" + rel.split(sep).join("/")
}

function baseSandboxArgs(
  worktree: string,
  sandboxCwd: string,
): string[] {
  const argv: string[] = [
    "/usr/bin/bwrap",

    "--die-with-parent",
    "--new-session",

    "--unshare-net",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",

    "--ro-bind", "/usr", "/usr",

    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",

    "--proc", "/proc",
    "--dev", "/dev",

    "--tmpfs", "/tmp",

    "--dir", "/home",
    "--dir", "/home/sandbox",

    "--dir", "/etc",

    "--bind", worktree, "/workspace",
  ]

  /*
   * Also expose this same worktree at its original absolute host pathname.
   * This keeps repository-local absolute paths valid without exposing the
   * rest of the host filesystem.
   */
  addAbsoluteWorktreeBind(
    argv,
    worktree,
  )

  const gitMetadata = `${worktree}/.git`

  if (existsSync(gitMetadata)) {
    /*
     * The worktree is visible through two paths, therefore Git metadata
     * must be overlaid read-only through both paths as well.
     */
    argv.push(
      "--ro-bind",
      gitMetadata,
      "/workspace/.git",

      "--ro-bind",
      gitMetadata,
      `${worktree}/.git`,
    )
  }

  for (const path of [
    "/etc/ld.so.cache",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
    "/etc/localtime",
    "/etc/gitconfig",
  ]) {
    roBindIfExists(argv, path)
  }

  argv.push(
    "--clearenv",

    "--setenv", "HOME", "/home/sandbox",
    "--setenv", "PATH", safeSystemPath(),
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "LC_ALL", "C.UTF-8",
    "--setenv", "PYTHONPYCACHEPREFIX", "/tmp/pycache",

    "--chdir", sandboxCwd,
  )

  return argv
}

function readTail(path: string, maxBytes = 7000): string {
  if (!existsSync(path)) return ""

  const size = statSync(path).size
  const start = Math.max(0, size - maxBytes)
  const length = size - start

  const fd = openSync(path, "r")

  try {
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, start)
    return buffer.toString("utf8")
  } finally {
    closeSync(fd)
  }
}

function pruneRunnerRuns() {
  mkdirSync(RUNNER_ROOT, {
    recursive: true,
    mode: 0o700,
  })

  const now = Date.now()

  const entries = readdirSync(RUNNER_ROOT)
    .map((name) => {
      const path = join(RUNNER_ROOT, name)

      try {
        return {
          name,
          path,
          mtime: statSync(path).mtimeMs,
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.mtime - a.mtime)

  entries.forEach((entry: any, index) => {
    if (
      now - entry.mtime > RUNNER_RETENTION_MS ||
      index >= RUNNER_MAX_RUNS
    ) {
      try {
        rmSync(entry.path, {
          recursive: true,
          force: true,
        })
      } catch {
        // Best-effort cleanup only.
      }
    }
  })
}

function gitStatus(worktree: string): string {
  if (!existsSync(join(worktree, ".git"))) return ""

  const result = spawnSync(
    "/usr/bin/git",
    [
      "-C",
      worktree,
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
    ],
    {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  )

  return result.stdout ?? ""
}

function statusDelta(before: string, after: string): string[] {
  const a = new Set(
    before.split("\n").filter(Boolean),
  )
  const b = new Set(
    after.split("\n").filter(Boolean),
  )

  const delta: string[] = []

  for (const line of b) {
    if (!a.has(line)) delta.push("+ " + line)
  }

  for (const line of a) {
    if (!b.has(line)) delta.push("- " + line)
  }

  return delta
}

function validateRunID(runID: string): string {
  if (!/^run-[A-Za-z0-9._-]+$/.test(runID)) {
    throw new Error("invalid run_id")
  }

  const dir = join(RUNNER_ROOT, runID)
  const realRoot = realpathSync(RUNNER_ROOT)
  const realDir = realpathSync(dir)

  const rel = relative(realRoot, realDir)

  if (
    rel === ".." ||
    rel.startsWith(".." + sep) ||
    isAbsolute(rel)
  ) {
    throw new Error("run_id escapes runner storage")
  }

  return realDir
}

const CAPTURE_SCRIPT = String.raw`
import subprocess
import sys

command = sys.argv[1]
limit = int(sys.argv[2])

process = subprocess.Popen(
    ["/bin/bash", "--noprofile", "--norc", "-c", command],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)

written = 0
truncated = False

with open("/runner-output/combined.log", "wb", buffering=0) as log:
    while True:
        chunk = process.stdout.read(65536)
        if not chunk:
            break

        if written < limit:
            keep = chunk[: max(0, limit - written)]
            if keep:
                log.write(keep)
                written += len(keep)

            if len(keep) != len(chunk):
                truncated = True
        else:
            truncated = True

return_code = process.wait()

if return_code < 0:
    normalized = 128 + (-return_code)
else:
    normalized = return_code

with open("/runner-output/exit_code", "w", encoding="utf-8") as f:
    f.write(str(normalized))

if truncated:
    with open("/runner-output/truncated", "w", encoding="utf-8") as f:
        f.write("1")

sys.exit(normalized if 0 <= normalized <= 255 else 1)
`

export default Plugin.define({
  id: "local.sandbox-tools",

  async setup(ctx) {
    const configuredRoot =
      ctx.location.project?.canonical ||
      ctx.location.project?.directory ||
      ctx.location.directory

    const worktree = realpathSync(configuredRoot)

    pruneRunnerRuns()

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "sandbox_shell",

        description:
          "Run a focused verification command in an isolated Linux sandbox. " +
          "Workspace is writable, Git metadata is read-only, network is disabled, " +
          "host HOME and provider credentials are unavailable.",

        input: {
          type: "object",
          properties: {
            command: {
              type: "string",
              minLength: 1,
            },
          },
          required: ["command"],
          additionalProperties: false,
        },

        options: {
          codemode: false,
        },

        execute: async (input) => {
          const { command } = input as {
            command: string
          }

          const argv = baseSandboxArgs(
            worktree,
            "/workspace",
          )

          argv.push(
            "/bin/bash",
            "--noprofile",
            "--norc",
            "-c",
            command,
          )

          const proc = Bun.spawn(argv, {
            stdout: "pipe",
            stderr: "pipe",
            env: {
              PATH: "/usr/bin:/bin",
            },
          })

          let timedOut = false

          const timer = setTimeout(() => {
            timedOut = true

            try {
              proc.kill("SIGKILL")
            } catch {
              // Already exited.
            }
          }, SHELL_TIMEOUT_MS)

          const [stdout, stderr, exitCode] =
            await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ])

          clearTimeout(timer)

          return {
            content: [
              `exit_code=${exitCode}`,
              `timed_out=${timedOut}`,
              `sandbox_root=${worktree}`,
              stdout
                ? `stdout:\n${truncate(stdout)}`
                : "stdout:",
              stderr
                ? `stderr:\n${truncate(stderr)}`
                : "stderr:",
            ].join("\n"),
          }
        },
      })

      editor.add({
        name: "sandbox_run",

        description:
          "Run one potentially noisy local command in a hard sandbox. " +
          "Full combined stdout/stderr is persisted outside model context for later inspection with sandbox_log. " +
          "Workspace is writable, Git metadata is read-only, network is disabled, host HOME and credentials are unavailable.",

        input: {
          type: "object",
          properties: {
            command: {
              type: "string",
              minLength: 1,
              description:
                "Exact command to execute",
            },

            cwd: {
              type: "string",
              description:
                "Optional working directory relative to the repository root",
            },

            timeout_seconds: {
              type: "integer",
              minimum: 1,
              maximum: RUNNER_MAX_TIMEOUT_SECONDS,
              description:
                "Maximum runtime in seconds",
            },
          },

          required: ["command"],
          additionalProperties: false,
        },

        options: {
          codemode: false,
        },

        execute: async (input) => {
          pruneRunnerRuns()

          const {
            command,
            cwd,
            timeout_seconds,
          } = input as {
            command: string
            cwd?: string
            timeout_seconds?: number
          }

          const timeoutSeconds = Math.max(
            1,
            Math.min(
              timeout_seconds ??
                RUNNER_DEFAULT_TIMEOUT_SECONDS,
              RUNNER_MAX_TIMEOUT_SECONDS,
            ),
          )

          const sandboxCwd =
            resolveSandboxCwd(worktree, cwd)

          mkdirSync(RUNNER_ROOT, {
            recursive: true,
            mode: 0o700,
          })

          const runDir = mkdtempSync(
            join(RUNNER_ROOT, "run-"),
          )

          const runID = basename(runDir)
          const combinedLog =
            join(runDir, "combined.log")

          const beforeStatus =
            gitStatus(worktree)

          const argv = baseSandboxArgs(
            worktree,
            sandboxCwd,
          )

          argv.push(
            "--bind", runDir, "/runner-output",

            "/usr/bin/python3",
            "-c",
            CAPTURE_SCRIPT,
            command,
            String(RUNNER_LOG_LIMIT_BYTES),
          )

          const started = Date.now()

          const proc = Bun.spawn(argv, {
            stdout: "ignore",
            stderr: "pipe",
            env: {
              PATH: "/usr/bin:/bin",
            },
          })

          let timedOut = false

          const timer = setTimeout(() => {
            timedOut = true

            try {
              proc.kill("SIGKILL")
            } catch {
              // Already exited.
            }
          }, timeoutSeconds * 1000)

          const [launcherStderr, launcherExitCode] =
            await Promise.all([
              new Response(proc.stderr).text(),
              proc.exited,
            ])

          clearTimeout(timer)

          const elapsedMs =
            Date.now() - started

          let exitCode = launcherExitCode

          const exitCodePath =
            join(runDir, "exit_code")

          if (existsSync(exitCodePath)) {
            const parsed = Number(
              readFileSync(
                exitCodePath,
                "utf8",
              ).trim(),
            )

            if (Number.isFinite(parsed)) {
              exitCode = parsed
            }
          }

          const afterStatus =
            gitStatus(worktree)

          const delta =
            statusDelta(
              beforeStatus,
              afterStatus,
            )

          const bytes =
            existsSync(combinedLog)
              ? statSync(combinedLog).size
              : 0

          const truncated =
            existsSync(join(runDir, "truncated"))

          const tail =
            readTail(combinedLog, 7000)

          return {
            content: [
              `run_id=${runID}`,
              `exit_code=${exitCode}`,
              `timed_out=${timedOut}`,
              `elapsed_ms=${elapsedMs}`,
              `log_bytes=${bytes}`,
              `log_truncated=${truncated}`,
              `worktree_status_changed=${delta.length > 0}`,
              delta.length > 0
                ? "worktree_status_delta:\n" +
                  truncate(
                    delta.slice(0, 30).join("\n"),
                    6000,
                  )
                : "worktree_status_delta:",
              launcherStderr
                ? "launcher_stderr:\n" +
                  truncate(
                    launcherStderr,
                    5000,
                  )
                : "launcher_stderr:",
              tail
                ? "log_tail:\n" + tail
                : "log_tail:",
              "",
              "Use sandbox_log with this run_id to search or inspect the persisted full log.",
            ].join("\n"),
          }
        },
      })

      editor.add({
        name: "sandbox_log",

        description:
          "Inspect the persisted output of a previous sandbox_run without loading the whole log into model context. " +
          "Supports grep, tail, head, and bounded line ranges.",

        input: {
          type: "object",

          properties: {
            run_id: {
              type: "string",
              minLength: 1,
            },

            mode: {
              type: "string",
              enum: [
                "grep",
                "tail",
                "head",
                "range",
              ],
            },

            pattern: {
              type: "string",
              description:
                "Regex for grep mode",
            },

            lines: {
              type: "integer",
              minimum: 1,
              maximum: 500,
              description:
                "Number of lines for head/tail",
            },

            start_line: {
              type: "integer",
              minimum: 1,
            },

            end_line: {
              type: "integer",
              minimum: 1,
            },

            context: {
              type: "integer",
              minimum: 0,
              maximum: 20,
              description:
                "Context lines around grep matches",
            },

            max_matches: {
              type: "integer",
              minimum: 1,
              maximum: 100,
            },

            case_sensitive: {
              type: "boolean",
            },
          },

          required: [
            "run_id",
            "mode",
          ],

          additionalProperties: false,
        },

        options: {
          codemode: false,
        },

        execute: async (input) => {
          const {
            run_id,
            mode,
            pattern,
            lines,
            start_line,
            end_line,
            context,
            max_matches,
            case_sensitive,
          } = input as {
            run_id: string
            mode: string
            pattern?: string
            lines?: number
            start_line?: number
            end_line?: number
            context?: number
            max_matches?: number
            case_sensitive?: boolean
          }

          const runDir =
            validateRunID(run_id)

          const logPath =
            join(runDir, "combined.log")

          if (!existsSync(logPath)) {
            throw new Error(
              `log missing for ${run_id}`,
            )
          }

          let command: string
          let args: string[]

          if (mode === "grep") {
            if (!pattern) {
              throw new Error(
                "pattern is required for grep mode",
              )
            }

            command = "/usr/bin/rg"
            args = [
              "--no-heading",
              "--line-number",
              "--color",
              "never",
              "-m",
              String(max_matches ?? 30),
              "-C",
              String(context ?? 2),
            ]

            if (!case_sensitive) {
              args.push("-i")
            }

            args.push(
              "--",
              pattern,
              logPath,
            )
          } else if (mode === "tail") {
            command = "/usr/bin/tail"
            args = [
              "-n",
              String(lines ?? 80),
              logPath,
            ]
          } else if (mode === "head") {
            command = "/usr/bin/head"
            args = [
              "-n",
              String(lines ?? 80),
              logPath,
            ]
          } else if (mode === "range") {
            if (!start_line || !end_line) {
              throw new Error(
                "start_line and end_line are required for range mode",
              )
            }

            if (end_line < start_line) {
              throw new Error(
                "end_line must be >= start_line",
              )
            }

            if (
              end_line - start_line > 500
            ) {
              throw new Error(
                "range may contain at most 501 lines",
              )
            }

            command = "/usr/bin/sed"
            args = [
              "-n",
              `${start_line},${end_line}p`,
              logPath,
            ]
          } else {
            throw new Error(
              `unsupported mode: ${mode}`,
            )
          }

          const result = spawnSync(
            command,
            args,
            {
              encoding: "utf8",
              maxBuffer: 2 * 1024 * 1024,
            },
          )

          const output =
            result.stdout ?? ""

          return {
            content: [
              `run_id=${run_id}`,
              `mode=${mode}`,
              `tool_exit_code=${result.status ?? 0}`,
              output
                ? "result:\n" +
                  truncate(output, 30000)
                : "result:",
            ].join("\n"),
          }
        },
      })
    })
  },
})
