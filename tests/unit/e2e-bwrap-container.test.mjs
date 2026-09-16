import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const read = (rel) => readFileSync(join(ROOT, rel), "utf8")

test("e2e Containerfile pins upstream bubblewrap 0.12.0 source build", () => {
  const src = read("tests/e2e/Containerfile")
  assert.match(src, /FROM node:24-bookworm/)
  assert.match(
    src,
    /https:\/\/github\.com\/containers\/bubblewrap\/releases\/download\/v0\.12\.0\/bubblewrap-0\.12\.0\.tar\.xz/,
  )
  assert.match(
    src,
    /9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314/,
  )
  assert.match(src, /sha256sum -c/)
  assert.match(src, /COPY --from=bwrap-build \/bwrap-out\/usr\/bin\/bwrap \/usr\/bin\/bwrap/)
  assert.match(src, /test "\$\(\/usr\/bin\/bwrap --version\)" = "bubblewrap 0\.12\.0"/)
  assert.doesNotMatch(src, /^\s*bubblewrap[\s\\]/m)
  assert.match(src, /libcap2/)
  assert.match(src, /--prefix=\/usr/)
  assert.match(src, /-Dman=disabled/)
  assert.match(src, /-Dselinux=disabled/)
  assert.match(src, /-Dtests=false/)
  assert.match(src, /-Dbash_completion=disabled/)
  assert.match(src, /-Dzsh_completion=disabled/)
  assert.doesNotMatch(src, /setuid/)
  assert.match(src, /config\/sandbox-bubblewrap\.mjs/)
  assert.match(src, /config\/sandbox-isolation\.mjs/)
  assert.match(src, /config\/sandbox-probes\.mjs/)
  assert.match(src, /config\/sandbox-runtime\.mjs/)
  assert.match(src, /installer\/path-security\.mjs/)
  assert.match(src, /tests\/unit\/linked-git-worktree\.test\.mjs/)
  assert.doesNotMatch(src, /config\.local/)
})

test("e2e run.sh verifies bwrap 0.12.0 and mandates real linked bwrap", () => {
  const src = read("tests/e2e/run.sh")
  assert.match(src, /BWRAP_0_12_0_OK/)
  assert.match(
    src,
    /test "\$BWRAP_VERSION" = "bubblewrap 0\.12\.0"/,
  )
  assert.match(src, /NESTED_BWRAP_NETLESS_OK/)
  assert.match(src, /RUN_LINKED_BWRAP_TESTS=1/)
  assert.match(src, /linked-git-worktree\.test\.mjs/)
  assert.match(src, /LINKED_WORKTREE_BWRAP_E2E_OK/)
  assert.match(src, /linked git real bubblewrap enforcement/)
  assert.match(src, /deterministic relative gitdir/)
  assert.doesNotMatch(src, /--privileged/)
  assert.doesNotMatch(src, /--cap-add/)
  assert.doesNotMatch(src, /--no-sandbox/)
})

test("e2e local.sh keeps opt-in off host and stays unprivileged", () => {
  const src = read("tests/e2e/local.sh")
  assert.doesNotMatch(src, /RUN_LINKED_BWRAP_TESTS/)
  assert.doesNotMatch(src, /--privileged/)
  assert.doesNotMatch(src, /cap-add/i)
})
