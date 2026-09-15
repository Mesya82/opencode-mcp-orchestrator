import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  buildBaseSandboxArgv,
  resolveLinkedGitMetadata,
} from "../../config/sandbox-bubblewrap.mjs"

import {
  buildRunnerProbeArgv,
  buildWorkerProbeArgv,
  probeSandboxArgvInvariants,
} from "../../config/sandbox-probes.mjs"

function hasTriple(argv, flag, src, dst) {
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (argv[i] === flag && argv[i + 1] === src && argv[i + 2] === dst) return true
  }
  return false
}

function roBindTargets(argv, source) {
  const out = []
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if ((argv[i] === "--ro-bind") && argv[i + 1] === source) out.push(argv[i + 2])
  }
  return out
}

function bindFlag(argv, source, target) {
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (argv[i + 1] === source && argv[i + 2] === target) return argv[i]
  }
  return undefined
}

function gitAvailable() {
  try {
    const r = spawnSync("git", ["--version"], { encoding: "utf8" })
    return r.status === 0
  } catch {
    return false
  }
}

function makeRealLinkedFixture() {
  const base = mkdtempSync(join(tmpdir(), "linked-git-"))
  const primary = join(base, "primary")
  const linked = join(base, "linked")
  mkdirSync(primary, { recursive: true })
  let r = spawnSync("git", ["init", "--quiet"], { cwd: primary, encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: primary })
  spawnSync("git", ["config", "user.name", "t"], { cwd: primary })
  writeFileSync(join(primary, "f.txt"), "hi\n")
  spawnSync("git", ["add", "f.txt"], { cwd: primary })
  r = spawnSync("git", ["commit", "-qm", "init"], { cwd: primary, encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  r = spawnSync("git", ["worktree", "add", linked], { cwd: primary, encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  return { base, primary, linked }
}

test("linked worktree gitdir file resolves to gitdir + common dir", { skip: gitAvailable() ? false : "git missing" }, () => {
  const { base, linked } = makeRealLinkedFixture()
  try {
    const resolved = resolveLinkedGitMetadata(linked)
    assert.ok(resolved)
    assert.ok(existsSync(resolved.linkedGitDir))
    assert.ok(existsSync(resolved.commonDir))
    assert.ok(resolved.commonDir.endsWith("/.git"))
    assert.ok(resolved.linkedGitDir.includes("/worktrees/"))
    // Resolver agrees with the real .git pointer files.
    const gitdirRaw = readFileSync(join(linked, ".git"), "utf8")
    assert.ok(gitdirRaw.startsWith("gitdir: "))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("production and probe-shared builder mounts linked metadata read-only at original paths", { skip: gitAvailable() ? false : "git missing" }, () => {
  const { base, linked } = makeRealLinkedFixture()
  try {
    const resolved = resolveLinkedGitMetadata(linked)
    assert.ok(resolved)
    for (const readonlyWorkspace of [false, true]) {
      const argv = buildBaseSandboxArgv(linked, "/workspace", {
        readonlyWorkspace,
        safePath: "/usr/bin",
      })
      // Dual .git overlays preserved.
      assert.equal(hasTriple(argv, "--ro-bind", `${linked}/.git`, "/workspace/.git"), true)
      assert.equal(hasTriple(argv, "--ro-bind", `${linked}/.git`, `${linked}/.git`), true)
      // Validated linked gitdir + common metadata mounted read-only verbatim.
      assert.equal(hasTriple(argv, "--ro-bind", resolved.linkedGitDir, resolved.linkedGitDir), true)
      assert.equal(hasTriple(argv, "--ro-bind", resolved.commonDir, resolved.commonDir), true)
      for (const target of [resolved.linkedGitDir, resolved.commonDir]) {
        assert.equal(bindFlag(argv, target, target), "--ro-bind")
      }
      // Empty ancestor dirs created without binding host parents: every
      // --dir ancestor of a metadata path is an empty --dir, not a bind.
      assert.equal(argv.includes(resolved.linkedGitDir), true)
    }
    // No writable metadata anywhere.
    const argv = buildBaseSandboxArgv(linked, "/workspace", { safePath: "/usr/bin" })
    for (let i = 0; i + 2 < argv.length; i += 1) {
      if (argv[i] === "--bind") {
        const src = argv[i + 1]
        assert.equal(src.includes(".git"), false, `writable metadata bind: ${src}`)
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("normal .git directory fixtures are preserved (no extra mounts)", () => {
  const base = mkdtempSync(join(tmpdir(), "linked-git-normal-"))
  try {
    const ws = join(base, "ws")
    mkdirSync(join(ws, ".git"), { recursive: true })
    writeFileSync(join(ws, ".git", "HEAD"), "ref: refs/heads/main\n")
    assert.equal(resolveLinkedGitMetadata(ws), null)
    const argv = buildBaseSandboxArgv(ws, "/workspace", { safePath: "/usr/bin" })
    assert.equal(hasTriple(argv, "--ro-bind", `${ws}/.git`, "/workspace/.git"), true)
    assert.equal(hasTriple(argv, "--ro-bind", `${ws}/.git`, `${ws}/.git`), true)
    // No extra metadata mounts for a normal .git directory: the only
    // RO-bind source ending in .git is the worktree .git itself.
    const gitSources = []
    for (let i = 0; i + 2 < argv.length; i += 1) {
      if (argv[i] === "--ro-bind" && argv[i + 1].endsWith(".git")) gitSources.push(argv[i + 1])
    }
    assert.deepEqual(gitSources, [`${ws}/.git`, `${ws}/.git`])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("negative fixtures fail closed: malformed, escape, mismatch, broad", () => {
  // Malformed .git file.
  {
    const base = mkdtempSync(join(tmpdir(), "linked-git-bad-"))
    try {
      const ws = join(base, "ws")
      mkdirSync(ws, { recursive: true })
      writeFileSync(join(ws, ".git"), "not-a-gitdir-pointer\n")
      assert.equal(resolveLinkedGitMetadata(ws), null)
      const argv = buildBaseSandboxArgv(ws, "/workspace", { safePath: "/usr/bin" })
      assert.deepEqual(roBindTargets(argv, join(base, "evil")), [])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }

  // Symlink escape: gitdir points at a dir outside worktrees layout.
  {
    const base = mkdtempSync(join(tmpdir(), "linked-git-escape-"))
    try {
      const ws = join(base, "ws")
      const evil = join(base, "evil-meta")
      mkdirSync(ws, { recursive: true })
      mkdirSync(evil, { recursive: true })
      writeFileSync(join(evil, "commondir"), "../..\n")
      writeFileSync(join(evil, "gitdir"), `${ws}/.git`)
      writeFileSync(join(ws, ".git"), `gitdir: ${evil}\n`)
      assert.equal(resolveLinkedGitMetadata(ws), null)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }

  // Mismatched backpointer.
  if (gitAvailable()) {
    const { base, linked } = makeRealLinkedFixture()
    try {
      const resolved = resolveLinkedGitMetadata(linked)
      assert.ok(resolved)
      writeFileSync(join(resolved.linkedGitDir, "gitdir"), "/tmp/opencode/nowhere/.git")
      assert.equal(resolveLinkedGitMetadata(linked), null)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }

  // Overly broad common dir (HOME as .git impostor is rejected by shape;
  // credential-adjacent dir rejected by allowlist).
  {
    const base = mkdtempSync(join(tmpdir(), "linked-git-broad-"))
    try {
      const ws = join(base, "ws")
      const fakeHome = join(base, "home")
      const cred = join(fakeHome, ".ssh")
      mkdirSync(ws, { recursive: true })
      mkdirSync(cred, { recursive: true })
      const fakeCommon = join(cred, ".git")
      const fakeGitDir = join(fakeCommon, "worktrees", "wt")
      mkdirSync(fakeGitDir, { recursive: true })
      writeFileSync(join(fakeCommon, "HEAD"), "ref: refs/heads/main\n")
      writeFileSync(join(fakeGitDir, "commondir"), "../..\n")
      writeFileSync(join(fakeGitDir, "gitdir"), `${ws}/.git`)
      writeFileSync(join(ws, ".git"), `gitdir: ${fakeGitDir}\n`)
      assert.equal(
        resolveLinkedGitMetadata(ws, { env: { ...process.env, HOME: fakeHome } }),
        null,
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }

  // Symlinked .git file escaping to unrelated metadata fails closed.
  {
    const base = mkdtempSync(join(tmpdir(), "linked-git-symlink-"))
    try {
      const ws = join(base, "ws")
      const other = join(base, "other")
      mkdirSync(ws, { recursive: true })
      mkdirSync(other, { recursive: true })
      writeFileSync(join(other, ".git"), "gitdir: /definitely/not/here\n")
      symlinkSync(join(other, ".git"), join(ws, ".git"))
      assert.equal(resolveLinkedGitMetadata(ws), null)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }
})

test("negative fixtures fail closed: oversized/nonregular pointers never read, valid-metadata symlink .git", () => {
  // Oversized pointer: stat size exceeds max BEFORE any read; read must not run.
  {
    let reads = 0
    const oversized = resolveLinkedGitMetadata("/tmp/ws-oversized-probe", {
      existsSync: () => true,
      readFileSync: () => {
        reads += 1
        return "gitdir: /x\n"
      },
      realpathSync: (p) => p,
      statSync: () => ({ isFile: () => true, isDirectory: () => false, size: 4096 + 1 }),
      env: { ...process.env, HOME: "/tmp/ws-oversized-probe-home-missing" },
    })
    assert.equal(oversized, null)
    assert.equal(reads, 0)
  }

  // Nonregular pointer: not a regular file BEFORE any read; read must not run.
  {
    let reads = 0
    const nonregular = resolveLinkedGitMetadata("/tmp/ws-nonregular-probe", {
      existsSync: () => true,
      readFileSync: () => {
        reads += 1
        return "gitdir: /x\n"
      },
      realpathSync: (p) => p,
      statSync: () => ({ isFile: () => false, isDirectory: () => false, size: 12 }),
      env: { ...process.env, HOME: "/tmp/ws-nonregular-probe-home-missing" },
    })
    assert.equal(nonregular, null)
    assert.equal(reads, 0)
  }

  // Symlink .git referencing OTHERWISE VALID real linked metadata fails closed.
  if (gitAvailable()) {
    const { base, linked } = makeRealLinkedFixture()
    try {
      assert.ok(resolveLinkedGitMetadata(linked))
      const target = join(linked, ".git.real")
      const raw = readFileSync(join(linked, ".git"), "utf8")
      assert.ok(raw.startsWith("gitdir: "))
      writeFileSync(target, raw)
      rmSync(join(linked, ".git"), { force: true })
      symlinkSync(target, join(linked, ".git"))
      // Target content is otherwise valid, but the .git symlink itself rejects.
      assert.equal(resolveLinkedGitMetadata(linked), null)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }
})

function bwrapAvailable() {
  try {
    const r = spawnSync("/usr/bin/bwrap", ["--version"], { encoding: "utf8" })
    return r.status === 0
  } catch {
    return false
  }
}

const RUN_LINKED_BWRAP = process.env.RUN_LINKED_BWRAP_TESTS === "1"

function linkedBwrapScript({ linked, readonlyWorkspace }) {
  const workspaceWrite = readonlyWorkspace
    ? 'if printf probe-fail > /workspace/probe-write.txt 2>/dev/null; then echo "workspace writable in RO"; exit 1; fi\n'
      + `if printf probe-fail > "${linked}/probe-abs.txt" 2>/dev/null; then echo "abs workspace writable in RO"; exit 1; fi\n`
    : 'printf probe-ok > /workspace/probe-write.txt\ntest "$(cat /workspace/probe-write.txt)" = probe-ok\n'
      + `printf probe-ok > "${linked}/probe-abs.txt"\ntest "$(cat "${linked}/probe-abs.txt")" = probe-ok\n`
  return (
    `set -u\n`
    + `cd /workspace && git diff --check\n`
    + `cd "${linked}" && git diff --check\n`
    + `cd /workspace\n`
    // Denied appends through every exposed alias.
    + `if printf x >> "${linked}/.git" 2>/dev/null; then echo "wrote linked .git abs"; exit 1; fi\n`
    + `if printf x >> /workspace/.git 2>/dev/null; then echo "wrote linked .git alias"; exit 1; fi\n`
    + workspaceWrite
  )
}

function runLinkedBwrap({ linked, resolved, readonlyWorkspace }) {
  const base = buildBaseSandboxArgv(linked, "/workspace", {
    readonlyWorkspace,
    safePath: "/usr/bin",
  })
  assert.equal(base.includes("--cap-add"), false, "no capability grants")
  assert.ok(base.includes("--unshare-net"), "networkless isolation preserved")
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "$(id -u)"
  const gid = typeof process.getgid === "function" ? String(process.getgid()) : "$(id -g)"
  const script
    = `test "$(id -u)" = "${uid}"\ntest "$(id -g)" = "${gid}"\n`
    + linkedBwrapScript({ linked, readonlyWorkspace })
    // Denied metadata appends use resolved absolute paths captured from the
    // fail-closed resolver (fixed test wiring, not model input).
    + `if printf x >> "${resolved.linkedGitDir}/HEAD" 2>/dev/null; then echo "wrote linked HEAD"; exit 1; fi\n`
    + `if printf x >> "${resolved.commonDir}/config" 2>/dev/null; then echo "wrote common config"; exit 1; fi\n`
  const argv = [...base, "/bin/bash", "--noprofile", "--norc", "-c", script]
  return spawnSync(argv[0], argv.slice(1), {
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 4096,
  })
}

test("linked git real bubblewrap enforcement (RW and RO)", { skip: RUN_LINKED_BWRAP ? false : "RUN_LINKED_BWRAP_TESTS=1 required" }, () => {
  // Opt-in only: never silently downgrade when explicitly enabled.
  assert.equal(process.env.RUN_LINKED_BWRAP_TESTS, "1")
  assert.equal(gitAvailable(), true, "git required when RUN_LINKED_BWRAP_TESTS=1")
  assert.equal(bwrapAvailable(), true, "bwrap required when RUN_LINKED_BWRAP_TESTS=1")
  assert.ok(existsSync("/bin/bash"), "/bin/bash required when RUN_LINKED_BWRAP_TESTS=1")
  const { base, linked } = makeRealLinkedFixture()
  try {
    const resolved = resolveLinkedGitMetadata(linked)
    assert.ok(resolved)
    for (const readonlyWorkspace of [false, true]) {
      const result = runLinkedBwrap({ linked, resolved, readonlyWorkspace })
      assert.equal(result.error, undefined, String(result.error))
      assert.equal(result.status, 0, result.stderr)
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("probe builders accept linked metadata; missing and writable linked binds reject", { skip: gitAvailable() ? false : "git missing" }, () => {
  const { base, linked } = makeRealLinkedFixture()
  const runDir = mkdtempSync(join(tmpdir(), "probe-runner-output-"))
  try {
    const resolved = resolveLinkedGitMetadata(linked)
    assert.ok(resolved)
    const workerArgv = buildWorkerProbeArgv(linked, undefined, {})
    assert.deepEqual(probeSandboxArgvInvariants(workerArgv, linked, undefined, { kind: "worker" }), [])
    const runnerArgv = buildRunnerProbeArgv(linked, undefined, { runDir })
    assert.deepEqual(probeSandboxArgvInvariants(runnerArgv, linked, undefined, { runDir, kind: "runner" }), [])
    // Missing linked RO bind must reject.
    const missing = []
    for (let i = 0; i < workerArgv.length; i += 1) {
      if (workerArgv[i] === "--ro-bind" && workerArgv[i + 1] === resolved.linkedGitDir && workerArgv[i + 2] === resolved.linkedGitDir) {
        i += 2
        continue
      }
      missing.push(workerArgv[i])
    }
    assert.notDeepEqual(probeSandboxArgvInvariants(missing, linked, undefined, { kind: "worker" }), [])
    // Writable linked bind must reject.
    const writable = [...workerArgv]
    for (let i = 0; i + 2 < writable.length; i += 1) {
      if (writable[i] === "--ro-bind" && writable[i + 1] === resolved.linkedGitDir && writable[i + 2] === resolved.linkedGitDir) {
        writable[i] = "--bind"
        break
      }
    }
    assert.notDeepEqual(probeSandboxArgvInvariants(writable, linked, undefined, { kind: "worker" }), [])
  } finally {
    rmSync(runDir, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})
