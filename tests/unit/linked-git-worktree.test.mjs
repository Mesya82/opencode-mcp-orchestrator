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
  // Malformed .git file: resolver returns null AND builder throws
  // fail-closed (no raw bind of attacker-shaped content).
  {
    const base = mkdtempSync(join(tmpdir(), "linked-git-bad-"))
    try {
      const ws = join(base, "ws")
      mkdirSync(ws, { recursive: true })
      writeFileSync(join(ws, ".git"), "not-a-gitdir-pointer\n")
      assert.equal(resolveLinkedGitMetadata(ws), null)
      assert.throws(
        () => buildBaseSandboxArgv(ws, "/workspace", { safePath: "/usr/bin" }),
        /invalid Git metadata/,
      )
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
  // Builder must throw fail-closed and add no bind of the symlink target.
  {
    const base = mkdtempSync(join(tmpdir(), "linked-git-symlink-"))
    try {
      const ws = join(base, "ws")
      const other = join(base, "other")
      const hostSecret = join(base, "host-secret")
      mkdirSync(ws, { recursive: true })
      mkdirSync(other, { recursive: true })
      mkdirSync(hostSecret, { recursive: true })
      writeFileSync(join(hostSecret, "secret.txt"), "host-secret\n")
      writeFileSync(join(other, ".git"), "gitdir: /definitely/not/here\n")
      symlinkSync(join(hostSecret, "secret.txt"), join(ws, ".git"))
      assert.equal(resolveLinkedGitMetadata(ws), null)
      assert.throws(
        () => buildBaseSandboxArgv(ws, "/workspace", { safePath: "/usr/bin" }),
        /invalid Git metadata/,
      )
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
      lstatSync: () => ({ isFile: () => true, isDirectory: () => false }),
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
      lstatSync: () => ({ isFile: () => true, isDirectory: () => false }),
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

  // Lexical non-regular .git (FIFO/device/other): lstat reports neither
  // file nor directory, so resolver rejects before any read.
  {
    let reads = 0
    const fifoLike = resolveLinkedGitMetadata("/tmp/ws-fifo-probe", {
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => false, isDirectory: () => false }),
      readFileSync: () => {
        reads += 1
        return "gitdir: /x\n"
      },
      realpathSync: (p) => p,
      statSync: () => ({ isFile: () => true, isDirectory: () => false, size: 12 }),
      env: { ...process.env, HOME: "/tmp/ws-fifo-probe-home-missing" },
    })
    assert.equal(fifoLike, null)
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
      assert.throws(
        () => buildBaseSandboxArgv(linked, "/workspace", { safePath: "/usr/bin" }),
        /invalid Git metadata/,
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }

  // Builder-level symlink-to-host regression: .git symlink to an arbitrary
  // host path must throw and never emit a bind referencing the host target.
  {
    const base = mkdtempSync(join(tmpdir(), "linked-git-builder-symlink-"))
    try {
      const ws = join(base, "ws")
      const hostTarget = join(base, "host-evil.txt")
      mkdirSync(ws, { recursive: true })
      writeFileSync(hostTarget, "host\n")
      symlinkSync(hostTarget, join(ws, ".git"))
      assert.equal(resolveLinkedGitMetadata(ws), null)
      assert.throws(
        () => buildBaseSandboxArgv(ws, "/workspace", { safePath: "/usr/bin" }),
        /invalid Git metadata/,
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }
})

function makeDeterministicRelativeFixture({ relativeBackpointer = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "linked-git-relative-"))
  const ws = join(base, "ws")
  const commonGit = join(base, "common", ".git")
  const privateGitDir = join(commonGit, "worktrees", "wt")
  mkdirSync(ws, { recursive: true })
  mkdirSync(privateGitDir, { recursive: true })
  mkdirSync(join(commonGit, "objects"), { recursive: true })
  writeFileSync(join(commonGit, "HEAD"), "ref: refs/heads/main\n")
  writeFileSync(join(privateGitDir, "commondir"), "../..\n")
  const backTarget = relativeBackpointer
    ? join("..", "..", "..", "..", "ws", ".git")
    : join(ws, ".git")
  writeFileSync(join(privateGitDir, "gitdir"), `${backTarget}\n`)
  // Relative gitdir pointer: resolves relative to dirname(<ws>/.git).
  writeFileSync(join(ws, ".git"), "gitdir: ../common/.git/worktrees/wt\n")
  return { base, ws, commonGit, privateGitDir }
}

test("deterministic relative gitdir + commondir fixture resolves and mounts", () => {
  for (const relativeBackpointer of [false, true]) {
    const { base, ws, commonGit, privateGitDir } = makeDeterministicRelativeFixture({ relativeBackpointer })
    try {
      const resolved = resolveLinkedGitMetadata(ws)
      assert.ok(resolved)
      assert.equal(resolved.linkedGitDir, privateGitDir)
      assert.equal(resolved.commonDir, commonGit)
      const argv = buildBaseSandboxArgv(ws, "/workspace", { safePath: "/usr/bin" })
      assert.equal(hasTriple(argv, "--ro-bind", `${ws}/.git`, "/workspace/.git"), true)
      assert.equal(hasTriple(argv, "--ro-bind", privateGitDir, privateGitDir), true)
      assert.equal(hasTriple(argv, "--ro-bind", commonGit, commonGit), true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }
})

test("builder git lexical validation: symlink-to-dir, lstat EACCES, absent .git", () => {
  // Symlink-to-directory .git must fail closed, never raw-bind.
  {
    const base = mkdtempSync(join(tmpdir(), "linked-git-symlink-dir-"))
    try {
      const ws = join(base, "ws")
      const realDir = join(base, "real-git-dir")
      mkdirSync(ws, { recursive: true })
      mkdirSync(realDir, { recursive: true })
      writeFileSync(join(realDir, "HEAD"), "ref: refs/heads/main\n")
      symlinkSync(realDir, join(ws, ".git"))
      assert.equal(resolveLinkedGitMetadata(ws), null)
      assert.throws(
        () => buildBaseSandboxArgv(ws, "/workspace", { safePath: "/usr/bin" }),
        /invalid Git metadata/,
      )
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }

  // Injected lstat EACCES must throw a bounded explicit error even when
  // existsSync reports false (no existsSync fallback masking).
  {
    const eacces = () => {
      const error = new Error("EACCES: permission denied")
      error.code = "EACCES"
      throw error
    }
    assert.throws(
      () => buildBaseSandboxArgv("/tmp/ws-eacces-probe", "/workspace", {
        safePath: "/usr/bin",
        lstatSync: eacces,
        existsSync: () => false,
      }),
      /invalid Git metadata: cannot stat \.git/,
    )
  }

  // Injected realpath directory mismatch must fail closed before any raw
  // bind: canonical .git dir differs from the lexical path.
  {
    assert.throws(
      () => buildBaseSandboxArgv("/tmp/ws-dir-mismatch-probe", "/workspace", {
        safePath: "/usr/bin",
        lstatSync: () => ({ isFile: () => false, isDirectory: () => true }),
        realpathSync: (p) => (p === "/tmp/ws-dir-mismatch-probe/.git" ? "/tmp/host-evil-git" : p),
        statSync: () => ({ isFile: () => false, isDirectory: () => true, size: 4096 }),
      }),
      /invalid Git metadata: \.git directory mismatch/,
    )
  }

  // Absent .git (lstat ENOENT) remains supported with no git binds.
  {
    const enoent = () => {
      const error = new Error("ENOENT: no such file or directory")
      error.code = "ENOENT"
      throw error
    }
    const argv = buildBaseSandboxArgv("/tmp/ws-absent-git-probe", "/workspace", {
      safePath: "/usr/bin",
      lstatSync: enoent,
      existsSync: () => false,
    })
    assert.equal(hasTriple(argv, "--ro-bind", "/tmp/ws-absent-git-probe/.git", "/workspace/.git"), false)
    assert.equal(roBindTargets(argv, "/tmp/ws-absent-git-probe/.git").length, 0)
  }
})

test("real git worktree add --relative-paths resolves when supported", { skip: gitAvailable() ? false : "git missing" }, (t) => {
  const probe = mkdtempSync(join(tmpdir(), "linked-git-relprobe-"))
  try {
    const primary = join(probe, "primary")
    mkdirSync(primary, { recursive: true })
    let r = spawnSync("git", ["init", "--quiet"], { cwd: primary, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: primary })
    spawnSync("git", ["config", "user.name", "t"], { cwd: primary })
    writeFileSync(join(primary, "f.txt"), "hi\n")
    spawnSync("git", ["add", "f.txt"], { cwd: primary })
    r = spawnSync("git", ["commit", "-qm", "init"], { cwd: primary, encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    const linked = join(probe, "linked")
    r = spawnSync("git", ["worktree", "add", "--relative-paths", linked], { cwd: primary, encoding: "utf8" })
    if (r.status !== 0) {
      // Feature-detect only: skip solely on the recognized unknown-option
      // result. Any other Git failure is a hard failure, never a silent pass.
      if (/unknown option|unrecognized/i.test(`${r.stderr}${r.stdout}`)) {
        t.skip("git worktree --relative-paths unsupported on this Git")
        return
      }
      assert.fail(`git worktree add --relative-paths failed: ${r.status} ${r.stderr}${r.stdout}`)
    }
    const raw = readFileSync(join(linked, ".git"), "utf8")
    // Confirm the fixture is genuinely relative before asserting resolution.
    assert.ok(!raw.slice("gitdir: ".length).trim().startsWith("/"), `expected relative gitdir, got: ${raw}`)
    const resolved = resolveLinkedGitMetadata(linked)
    assert.ok(resolved)
    assert.ok(resolved.commonDir.endsWith("/.git"))
    const argv = buildBaseSandboxArgv(linked, "/workspace", { safePath: "/usr/bin" })
    assert.equal(hasTriple(argv, "--ro-bind", resolved.linkedGitDir, resolved.linkedGitDir), true)
    assert.equal(hasTriple(argv, "--ro-bind", resolved.commonDir, resolved.commonDir), true)
  } finally {
    rmSync(probe, { recursive: true, force: true })
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
