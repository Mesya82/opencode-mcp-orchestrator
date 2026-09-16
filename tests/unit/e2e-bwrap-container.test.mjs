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

test("e2e Containerfile builds deterministic TLS trust for the dedicated hostname", () => {
  const src = read("tests/e2e/Containerfile")
  assert.match(src, /openssl/)
  assert.match(src, /E2E_TEST_HOSTNAME=e2e-hostmode\.test/)
  assert.match(src, /\/e2e\/certs\/server\.crt/)
  assert.match(src, /\/e2e\/certs\/server\.key/)
  assert.match(src, /subjectAltName=DNS:/)
  assert.match(src, /basicConstraints=critical,CA:true/)
  assert.match(src, /extendedKeyUsage=serverAuth/)
  assert.match(src, /update-ca-certificates/)
  assert.match(src, /openssl verify/)
  assert.match(
    src,
    /tests\/e2e\/network-access\.mjs/,
  )
  assert.match(src, /\/e2e\/network-access\.mjs/)
})

test("dedicated e2e container proves the real-bwrap network boundary without skips", () => {
  const src = read("tests/e2e/network-run.sh")
  const launcher = read("tests/e2e/local.sh")
  assert.match(src, /\/e2e\/network-access\.mjs/)
  assert.match(src, /RUNNER_NETWORK_ACCESS_E2E_OK/)
  assert.match(src, /RUNNER_NETWORK_ACCESS_E2E_STAGE_OK/)
  assert.match(src, /LOOPBACK_HTTP_HOST_OK/)
  assert.match(src, /LOOPBACK_HTTP_DISABLED_DENY_OK/)
  assert.match(src, /DNS_RESOLVER_HOST_OK/)
  assert.match(src, /TLS_VERIFIED_HOST_OK/)
  assert.match(src, /test "\$NETWORK_STATUS" -eq 0/)
  assert.match(launcher, /--dns 127\.0\.0\.1/)
  assert.match(launcher, /\/e2e\/network-run\.sh/)
  assert.doesNotMatch(src, /--privileged/)
  assert.doesNotMatch(src, /--cap-add/)
})

test("network-access harness uses production argv and strict boundaries", () => {
  const src = read("tests/e2e/network-access.mjs")
  assert.match(src, /buildBaseSandboxArgv/)
  assert.match(src, /sandbox-bubblewrap\.mjs/)
  assert.match(src, /refusing mock argv/)
  assert.match(src, /RUNNER_NETWORK_ACCESS_E2E_OK/)
  assert.match(src, /LOOPBACK_HTTP_DISABLED_DENY_OK/)
  assert.match(src, /DNS_RESOLVER_HOST_OK/)
  assert.match(src, /TLS_VERIFIED_HOST_OK/)
  assert.match(src, /RESOLVER_CONFIG_MOUNT_OK/)
  assert.match(src, /127\.0\.0\.1/)
  assert.match(src, /resolve4/)
  assert.match(src, /mounted \/etc\/resolv\.conf/)
  assert.match(src, /--resolve/)
  assert.match(src, /--unshare-net/)
  assert.match(src, /Failing, never skipping/)
  assert.doesNotMatch(src, /--insecure/)
  assert.doesNotMatch(src, /\s-k[\s,]/)
  assert.match(src, /finally/)
})
