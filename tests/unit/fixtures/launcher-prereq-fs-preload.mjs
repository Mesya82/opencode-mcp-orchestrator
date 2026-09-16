/*
 * Test-only filesystem preload for launcher-prerequisite regression tests.
 *
 * Simulates an exact launcher path (/usr/bin/bash, /usr/bin/python3,
 * /usr/bin/bwrap, /usr/bin/git) being missing, non-executable, or non-regular WITHOUT
 * touching the real filesystem. Activated only via explicit test env vars;
 * never consulted by production code.
 *
 * Protocol (test env only):
 *   LAUNCHER_PREREQ_FAIL_PATH=/usr/bin/bash
 *   LAUNCHER_PREREQ_FAIL_KIND=missing|nonexec|directory
 *
 * Loaded with `node --import <this-file>` before the CLI under test so the
 * patched `node:fs` exports (propagated with syncBuiltinESMExports) are
 * visible to the already-imported `installer/path-security.mjs` bindings.
 */

import childProcess from "node:child_process"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"

const failPath = process.env.LAUNCHER_PREREQ_FAIL_PATH
const kind = process.env.LAUNCHER_PREREQ_FAIL_KIND || "missing"

// Hermetic baseline: every exact launcher prerequisite is treated as a
// valid executable file regardless of the host (absent/old /usr/bin/bwrap
// must not leak in). Only the selected failPath stays invalid.
const BASELINE_PATHS = new Set([
  "/usr/bin/bash",
  "/usr/bin/python3",
  "/usr/bin/bwrap",
  "/usr/bin/git",
])

function isBaseline(path) {
  return typeof path === "string" && BASELINE_PATHS.has(path)
}

function match(path) {
  return typeof path === "string" && path === failPath
}

function failAccess(path, args) {
  if (kind === "missing") {
    const error = new Error(`ENOENT: no such file or directory, access '${path}'`)
    error.code = "ENOENT"
    throw error
  }

  // Non-executable: access check fails closed.
  const error = new Error(`EACCES: permission denied, access '${path}'`)
  error.code = "EACCES"
  throw error
}

// Always installed: baseline hermetic mock plus the selected failure.
{
  const origAccessSync = fs.accessSync.bind(fs)
  const origStatSync = fs.statSync.bind(fs)

  function patchedAccessSync(path, ...rest) {
    if (match(path) && kind !== "directory") {
      failAccess(path, rest)
    }

    // Baseline: exact prerequisites always pass the executable-access
    // check unless they are the selected failure.
    if (isBaseline(path)) {
      return undefined
    }

    return origAccessSync(path, ...rest)
  }

  function patchedStatSync(path, ...rest) {
    if (match(path)) {
      if (kind === "missing") {
        const error = new Error(`ENOENT: no such file or directory, stat '${path}'`)
        error.code = "ENOENT"
        throw error
      }

      if (kind === "directory") {
        return {
          isFile: () => false,
          isDirectory: () => true,
          size: 4096,
        }
      }

      // nonexec: regular file metadata; the access check above fails.
      return {
        isFile: () => true,
        isDirectory: () => false,
        size: 1024,
      }
    }

    // Baseline: exact prerequisites always look like regular files unless
    // they are the selected failure.
    if (isBaseline(path)) {
      return {
        isFile: () => true,
        isDirectory: () => false,
        size: 1024,
      }
    }

    return origStatSync(path, ...rest)
  }

  fs.accessSync = patchedAccessSync
  fs.statSync = patchedStatSync
  syncBuiltinESMExports("node:fs", ["accessSync", "statSync"])
}

/*
 * Deterministic Bubblewrap version mock (test-only).
 *
 * Protocol (test env only):
 *   LAUNCHER_PREREQ_BWRAP_VERSION=<stdout for /usr/bin/bwrap --version>
 *   LAUNCHER_PREREQ_BWRAP_ERROR=none|spawn|timeout|signal|nonzero|throw
 *
 * Mocks only the exact `/usr/bin/bwrap --version` child_process.spawnSync
 * call so tests never assume a secure host Bubblewrap. Every other spawn
 * delegates to the real implementation.
 */
const bwrapMockActive =
  process.env.LAUNCHER_PREREQ_BWRAP_VERSION !== undefined ||
  process.env.LAUNCHER_PREREQ_BWRAP_ERROR !== undefined

if (bwrapMockActive) {
  const mockOutput = process.env.LAUNCHER_PREREQ_BWRAP_VERSION ?? "bubblewrap 0.12.0\n"
  const mockError = process.env.LAUNCHER_PREREQ_BWRAP_ERROR ?? "none"
  const origSpawnSync = childProcess.spawnSync.bind(childProcess)

  function isBwrapVersionCall(command, args) {
    return (
      command === "/usr/bin/bwrap" &&
      Array.isArray(args) &&
      args.length === 1 &&
      args[0] === "--version"
    )
  }

  function patchedSpawnSync(command, args, ...rest) {
    if (isBwrapVersionCall(command, args)) {
      if (mockError === "timeout") {
        const error = new Error("spawnSync ETIMEDOUT")
        error.code = "ETIMEDOUT"
        return { error, stdout: "", stderr: "", status: null, signal: null }
      }

      if (mockError === "spawn") {
        const error = new Error("spawnSync ENOENT")
        error.code = "ENOENT"
        return { error, stdout: "", stderr: "", status: null, signal: null }
      }

      if (mockError === "signal") {
        return { error: undefined, stdout: "", stderr: "", status: null, signal: "SIGKILL" }
      }

      if (mockError === "nonzero") {
        return { error: undefined, stdout: mockOutput, stderr: "", status: 1, signal: null }
      }

      if (mockError === "throw") {
        throw new Error("spawnSync boom")
      }

      return {
        error: undefined,
        stdout: mockOutput,
        stderr: "",
        status: 0,
        signal: null,
      }
    }

    return origSpawnSync(command, args, ...rest)
  }

  childProcess.spawnSync = patchedSpawnSync
  syncBuiltinESMExports("node:child_process", ["spawnSync"])
}
