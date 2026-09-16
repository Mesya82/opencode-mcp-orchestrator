import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildRunnerProbeArgv,
  buildWorkerProbeArgv,
} from "../../config/sandbox-probes.mjs";

function shellText(argv) {
  const i = argv.indexOf("-c");
  assert.ok(i !== -1 && typeof argv[i + 1] === "string");
  return argv[i + 1];
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "probe-git-checks-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/probe\n");
  return dir;
}

const ALIAS_CHECK = "{ if printf x >> .git/HEAD 2>/dev/null; then exit 1; fi; }";
const ABS_CHECK = '{ if printf x >> "$0/.git/HEAD" 2>/dev/null; then exit 1; fi; }';

test("probe git checks are not masked by || true", () => {
  for (const argv of [
    buildWorkerProbeArgv("/tmp/ws-probe-git"),
    buildRunnerProbeArgv("/tmp/ws-probe-git"),
  ]) {
    const script = shellText(argv);
    assert.ok(!script.includes("|| true"));
    assert.ok(!script.includes("exit 1 || true"));
    assert.ok(script.includes(ALIAS_CHECK));
    assert.ok(script.includes(ABS_CHECK));
  }
});

test("writable git metadata forces nonzero status", () => {
  const dir = makeFixture();
  try {
    for (const check of [ALIAS_CHECK, ABS_CHECK]) {
      const r = spawnSync("/bin/sh", ["-c", check, dir], { cwd: dir });
      assert.notEqual(r.status, 0, `writable metadata must fail: ${check}`);
    }
    // Full worker command against the controlled fixture (writes stay inside
    // the temp dir via cwd/$0) must also fail on writable .git/HEAD.
    const worker = shellText(buildWorkerProbeArgv("/tmp/ws-probe-git"));
    const full = spawnSync("/bin/sh", ["-c", worker, dir], { cwd: dir });
    assert.notEqual(full.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
