import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const WRAPPER = path.join(ROOT, "tests", "e2e", "github-userns.sh");

function makeMockDir({ prior = "1", present = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "userns-mock-"));
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "value"), prior);
  fs.writeFileSync(path.join(state, "calls.log"), "");

  const sysctl = `#!/usr/bin/env bash
set -u
STATE="$MOCK_STATE_DIR/value"
LOG="$MOCK_STATE_DIR/calls.log"
echo "sysctl $*" >> "$LOG"
if test "$1" = "-n"; then
  if test "\${MOCK_SYSCTL_PRESENT:-1}" = "0"; then
    echo "sysctl: cannot stat /proc/sys/kernel/apparmor_restrict_unprivileged_userns: No such file or directory" >&2
    exit 1
  fi
  if test "\${MOCK_READ_ERROR:-0}" = "1"; then
    echo "sysctl: permission denied on key" >&2
    exit 1
  fi
  cat "$STATE"
  exit 0
elif test "$1" = "-w"; then
  echo "direct-sysctl-write-attempt" >> "$LOG"
  exit 1
else
  exit 1
fi
`;
  const sudo = `#!/usr/bin/env bash
set -u
STATE="$MOCK_STATE_DIR/value"
LOG="$MOCK_STATE_DIR/calls.log"
echo "sudo $*" >> "$LOG"
if test "$1" = "sysctl" && test "$2" = "-w"; then
  kv="$3"
  val="\${kv#*=}"
  if test "\${MOCK_PARTIAL_WRITE:-0}" = "1"; then
    printf '%s' "$val" > "$STATE"
    echo "mock partial write" >&2
    exit 1
  fi
  if test "\${MOCK_FAIL_WRITE:-0}" = "1" && test "$val" = "0"; then
    echo "mock write fail" >&2
    exit 1
  fi
  if test "\${MOCK_FAIL_RESTORE:-0}" = "1" && test "$val" = "\${MOCK_PRIOR:-__none__}"; then
    echo "mock restore fail" >&2
    exit 1
  fi
  if test "\${MOCK_BAD_RESTORE:-0}" = "1" && test "$val" = "\${MOCK_PRIOR:-__none__}"; then
    printf '%s' "0" > "$STATE"
    echo "$kv"
    exit 0
  fi
  printf '%s' "$val" > "$STATE"
  echo "$kv"
  exit 0
fi
echo "unexpected sudo invocation: $*" >&2
exit 1
`;
  fs.writeFileSync(path.join(bin, "sysctl"), sysctl, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sudo"), sudo, { mode: 0o755 });
  return { dir, bin, state };
}

function runWrapper(t, mock, command, { extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    PATH: `${mock.bin}:${process.env.PATH}`,
    MOCK_STATE_DIR: mock.state,
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    MOCK_SYSCTL_PRESENT: "1",
    MOCK_PRIOR: fs.readFileSync(path.join(mock.state, "value"), "utf8"),
    ...extraEnv,
  };
  const res = spawnSync("bash", [WRAPPER, ...command], { env, encoding: "utf8" });
  t.after(() => fs.rmSync(mock.dir, { recursive: true, force: true }));
  return res;
}

const readValue = (mock) => fs.readFileSync(path.join(mock.state, "value"), "utf8");
const readLog = (mock) => fs.readFileSync(path.join(mock.state, "calls.log"), "utf8");

test("command success restores exact prior value", (t) => {
  const mock = makeMockDir({ prior: "1" });
  const res = runWrapper(t, mock, ["bash", "-c", "exit 0"]);
  assert.equal(res.status, 0);
  assert.equal(readValue(mock), "1");
  const log = readLog(mock);
  assert.match(log, /sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/);
  assert.match(log, /sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=1/);
});

test("command failure status is preserved and prior is restored", (t) => {
  const mock = makeMockDir({ prior: "1" });
  const res = runWrapper(t, mock, ["bash", "-c", "exit 7"]);
  assert.equal(res.status, 7);
  assert.equal(readValue(mock), "1");
});

test("prior zero is restored exactly", (t) => {
  const mock = makeMockDir({ prior: "0" });
  const res = runWrapper(t, mock, ["bash", "-c", "exit 0"]);
  assert.equal(res.status, 0);
  assert.equal(readValue(mock), "0");
});

test("TERM restores prior value and reports signal exit", (t) => {
  const mock = makeMockDir({ prior: "1" });
  const res = runWrapper(t, mock, ["bash", "-c", 'kill -TERM "$PPID"']);
  assert.equal(res.status, 143);
  assert.equal(readValue(mock), "1");
});

test("read failure is not treated as an absent key", (t) => {
  const mock = makeMockDir();
  const marker = path.join(mock.dir, "ran.marker");
  const res = runWrapper(t, mock, ["touch", marker], {
    extraEnv: { MOCK_READ_ERROR: "1" },
  });
  assert.notEqual(res.status, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.doesNotMatch(readLog(mock), /sudo/);
});

test("restoration verification mismatch fails", (t) => {
  const mock = makeMockDir({ prior: "1" });
  const res = runWrapper(t, mock, ["bash", "-c", "exit 0"], {
    extraEnv: { MOCK_BAD_RESTORE: "1" },
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /restore verification failed/);
});

test("restoration failure exits nonzero", (t) => {
  const mock = makeMockDir({ prior: "1" });
  const res = runWrapper(t, mock, ["bash", "-c", "exit 0"], {
    extraEnv: { MOCK_FAIL_RESTORE: "1" },
  });
  assert.notEqual(res.status, 0);
  // Restore failed: value remains the mutated 0.
  assert.equal(readValue(mock), "0");
});

test("write failure after partial mutation still restores and fails", (t) => {
  const mock = makeMockDir({ prior: "1" });
  const res = runWrapper(t, mock, ["bash", "-c", "exit 0"], {
    extraEnv: { MOCK_PARTIAL_WRITE: "1" },
  });
  assert.notEqual(res.status, 0);
  const log = readLog(mock);
  // Both the failed write and the EXIT-trap restore were attempted.
  assert.equal(log.match(/sudo sysctl -w/g)?.length ?? 0, 2);
});

test("invalid prior value refuses before mutation", (t) => {
  const mock = makeMockDir({ prior: "banana" });
  const marker = path.join(mock.dir, "ran.marker");
  const res = runWrapper(t, mock, ["bash", "-c", `touch "${marker}"; exit 0`]);
  assert.notEqual(res.status, 0);
  assert.equal(fs.existsSync(marker), false);
  const log = readLog(mock);
  assert.doesNotMatch(log, /sudo sysctl -w/);
});

test("refuses outside github-hosted boundary before any sysctl write", (t) => {
  for (const extraEnv of [
    { GITHUB_ACTIONS: "", RUNNER_ENVIRONMENT: "github-hosted" },
    { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" },
    { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "" },
  ]) {
    const mock = makeMockDir({ prior: "1" });
    const marker = path.join(mock.dir, "ran.marker");
    const env = {
      ...process.env,
      PATH: `${mock.bin}:${process.env.PATH}`,
      MOCK_STATE_DIR: mock.state,
      ...extraEnv,
    };
    const res = spawnSync("bash", [WRAPPER, "bash", "-c", `touch "${marker}"; exit 0`], {
      env,
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0, JSON.stringify(extraEnv));
    assert.equal(fs.existsSync(marker), false, JSON.stringify(extraEnv));
    assert.equal(readLog(mock), "", JSON.stringify(extraEnv));
    fs.rmSync(mock.dir, { recursive: true, force: true });
  }
});

test("absent sysctl key runs original command unchanged without skip", (t) => {
  const mock = makeMockDir({ prior: "1" });
  const marker = path.join(mock.dir, "ran.marker");
  const res = runWrapper(t, mock, ["bash", "-c", `touch "${marker}"; exit 0`], {
    extraEnv: { MOCK_SYSCTL_PRESENT: "0" },
  });
  assert.equal(res.status, 0);
  assert.equal(fs.existsSync(marker), true);
  const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  assert.match(combined, /absent/);
  assert.doesNotMatch(readLog(mock), /sudo/);
});

test("workflows wrap the entire E2E command with the wrapper", () => {
  const e2e = fs.readFileSync(path.join(ROOT, ".github", "workflows", "e2e.yml"), "utf8");
  const release = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(e2e, /bash tests\/e2e\/github-userns\.sh\s+npm run test:e2e/);
  assert.match(release, /bash tests\/e2e\/github-userns\.sh\s+npm run test:e2e/);
});

test("wrapper uses strict mode, early EXIT trap, and no persistent edits", () => {
  const src = fs.readFileSync(WRAPPER, "utf8");
  assert.match(src, /set -Eeuo pipefail/);
  const trapIdx = src.indexOf("trap restore_userns EXIT");
  const writeIdx = src.indexOf('"${SYSCTL_KEY}=0"');
  assert.ok(trapIdx !== -1 && writeIdx !== -1 && trapIdx < writeIdx);
  assert.doesNotMatch(src, /tee\s+\/etc\/sysctl/);
  assert.doesNotMatch(src, />\s*\/etc\/sysctl/);
  assert.match(src, /GITHUB_ACTIONS/);
  assert.match(src, /RUNNER_ENVIRONMENT/);
});

test("docker launcher remains unprivileged", () => {
  const local = fs.readFileSync(path.join(ROOT, "tests", "e2e", "local.sh"), "utf8");
  assert.doesNotMatch(local, /--privileged/);
  assert.doesNotMatch(local, /cap-add/i);
  assert.doesNotMatch(local, /userns.*host|host.*userns/i);
  const inner = fs.readFileSync(path.join(ROOT, "tests", "e2e", "run.sh"), "utf8");
  assert.match(inner, /--unshare-net/);
});
