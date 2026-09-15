/*
 * Test-only filesystem preload for launcher-prerequisite regression tests.
 *
 * Simulates an exact launcher path (/bin/bash, /usr/bin/python3,
 * /usr/bin/bwrap) being missing, non-executable, or non-regular WITHOUT
 * touching the real filesystem. Activated only via explicit test env vars;
 * never consulted by production code.
 *
 * Protocol (test env only):
 *   LAUNCHER_PREREQ_FAIL_PATH=/bin/bash
 *   LAUNCHER_PREREQ_FAIL_KIND=missing|nonexec|directory
 *
 * Loaded with `node --import <this-file>` before the CLI under test so the
 * patched `node:fs` exports (propagated with syncBuiltinESMExports) are
 * visible to the already-imported `installer/path-security.mjs` bindings.
 */

import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"

const failPath = process.env.LAUNCHER_PREREQ_FAIL_PATH
const kind = process.env.LAUNCHER_PREREQ_FAIL_KIND || "missing"

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

if (failPath) {
  const origAccessSync = fs.accessSync.bind(fs)
  const origStatSync = fs.statSync.bind(fs)

  function patchedAccessSync(path, ...rest) {
    if (match(path) && kind !== "directory") {
      failAccess(path, rest)
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

    return origStatSync(path, ...rest)
  }

  fs.accessSync = patchedAccessSync
  fs.statSync = patchedStatSync
  syncBuiltinESMExports("node:fs", ["accessSync", "statSync"])
}
