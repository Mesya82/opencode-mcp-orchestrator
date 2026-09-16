#!/usr/bin/env node
/*
 * tests/e2e/network-access.mjs
 *
 * Clean-container E2E proof of the real Bubblewrap network boundary for
 * delegated runner execution. Uses only the production shared builder
 * (config/sandbox-bubblewrap.mjs buildBaseSandboxArgv) to generate the
 * exact argv under test -- never a hand-written approximation.
 *
 * Proves, with endpoints bound to 127.0.0.1 outside Bubblewrap:
 *   1. numeric loopback HTTP: disabled mode cannot receive the marker,
 *      host mode receives the exact marker;
 *   2. DNS: a deterministic local UDP responder answers a dedicated test
 *      hostname with 127.0.0.1; an ordinary c-ares resolver lookup inside
 *      host mode resolves it, and the intended resolver config bind is
 *      shown byte-identical inside the sandbox;
 *   3. TLS: a local HTTPS endpoint serves an exact marker under a test CA
 *      that is trusted through the same narrowly mounted system CA bundle
 *      mechanism; ordinary verification inside host mode succeeds for the
 *      dedicated hostname with verification fully enabled
 *      (disabling verification is never permitted).
 *
 * Missing/unavailable Bubblewrap (or user namespaces) is a hard failure,
 * never a skip. No public Internet, external DNS, or external HTTPS is
 * used at any point. Strict timeouts and deterministic cleanup apply.
 *
 * Modes:
 *   node tests/e2e/network-access.mjs             full E2E (needs bwrap
 *                                                 0.12.0 + image PKI)
 *   node tests/e2e/network-access.mjs --self-test local logic check only:
 *                                                 ephemeral servers, temp
 *                                                 openssl PKI, no bwrap
 */

import { spawn, spawnSync } from "node:child_process"
import dgram from "node:dgram"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import http from "node:http"
import https from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const BWRAP_BIN = "/usr/bin/bwrap"
const BWRAP_VERSION_RE = /bubblewrap 0\.12\.0/

const TEST_HOSTNAME =
  process.env.E2E_TEST_HOSTNAME ?? "e2e-hostmode.test"
const TLS_CERT_PATH =
  process.env.E2E_TLS_CERT ?? "/e2e/certs/server.crt"
const TLS_KEY_PATH =
  process.env.E2E_TLS_KEY ?? "/e2e/certs/server.key"

const HTTP_MARKER = "RUNNER_NET_HTTP_LOOPBACK_OK_9f2c"
const TLS_MARKER = "RUNNER_NET_TLS_VERIFIED_OK_51be"

const CONNECT_TIMEOUT_S = 5
const CURL_MAX_TIME_S = 15
const SPAWN_TIMEOUT_MS = 25_000
const SERVER_START_TIMEOUT_MS = 10_000
const DNS_QUERY_TIMEOUT_MS = 5_000
const OVERALL_DEADLINE_MS = 240_000

const deadline = Date.now() + OVERALL_DEADLINE_MS

function checkDeadline(label) {
  if (Date.now() > deadline) {
    throw new Error(`overall E2E deadline exceeded before: ${label}`)
  }
}

function remainingMs() {
  return Math.max(1_000, deadline - Date.now())
}

/* ------------------------------------------------------------------ */
/* DNS wire codec (minimal, deterministic, stdlib only)                */
/* ------------------------------------------------------------------ */

function decodeDnsName(buf, offset) {
  const labels = []
  let pos = offset
  let jumped = false
  let consumed = 0
  let guard = 0
  while (true) {
    guard += 1
    if (guard > 64) throw new Error("dns name too complex")
    if (pos >= buf.length) throw new Error("dns name truncated")
    const len = buf[pos]
    if (len === 0) {
      if (!jumped) consumed = pos - offset + 1
      break
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error("dns pointer truncated")
      const target = ((len & 0x3f) << 8) | buf[pos + 1]
      if (!jumped) consumed = pos - offset + 2
      pos = target
      jumped = true
      continue
    }
    if ((len & 0xc0) !== 0) throw new Error("dns bad label bits")
    const start = pos + 1
    const end = start + len
    if (end > buf.length) throw new Error("dns label truncated")
    labels.push(buf.subarray(start, end).toString("latin1"))
    pos = end
    if (!jumped) consumed = pos - offset
  }
  return { name: labels.join("."), next: offset + consumed }
}

function normalizeDnsName(name) {
  return name.toLowerCase().replace(/\.$/, "")
}

function buildDnsResponse(query, { rcode, addresses }) {
  if (query.length < 12) throw new Error("dns query too short")
  const reqFlags = query.readUInt16BE(2)
  const qdcount = query.readUInt16BE(4)
  if (qdcount < 1) throw new Error("dns query without questions")
  let pos = 12
  for (let q = 0; q < qdcount; q += 1) {
    const decoded = decodeDnsName(query, pos)
    if (decoded.next + 4 > query.length) {
      throw new Error("dns question truncated")
    }
    pos = decoded.next + 4
  }
  const question = query.subarray(12, pos)
  const flags = 0x8000 | (reqFlags & 0x0100) | 0x0080 | (rcode & 0x000f)
  const header = Buffer.alloc(12)
  query.subarray(0, 2).copy(header, 0)
  header.writeUInt16BE(flags, 2)
  header.writeUInt16BE(qdcount, 4)
  header.writeUInt16BE(addresses.length, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)
  const parts = [header, question]
  for (const ip of addresses) {
    const octets = ip.split(".").map(Number)
    if (
      octets.length !== 4 ||
      octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)
    ) {
      throw new Error(`invalid IPv4 answer: ${ip}`)
    }
    const answer = Buffer.alloc(16)
    answer.writeUInt16BE(0xc00c, 0)
    answer.writeUInt16BE(1, 2)
    answer.writeUInt16BE(1, 4)
    answer.writeUInt32BE(5, 6)
    answer.writeUInt16BE(4, 10)
    answer[12] = octets[0]
    answer[13] = octets[1]
    answer[14] = octets[2]
    answer[15] = octets[3]
    parts.push(answer)
  }
  return Buffer.concat(parts)
}

function parseDnsQuestion(query) {
  if (query.length < 12) throw new Error("dns query too short")
  const decoded = decodeDnsName(query, 12)
  if (decoded.next + 4 > query.length) {
    throw new Error("dns question truncated")
  }
  return {
    name: normalizeDnsName(decoded.name),
    qtype: query.readUInt16BE(decoded.next),
  }
}

/* ------------------------------------------------------------------ */
/* Production builder loading (real generated argv only)               */
/* ------------------------------------------------------------------ */

async function loadProductionBuilder() {
  const candidates = [
    "/e2e/config/sandbox-bubblewrap.mjs",
    join(
      fileURLToPath(new URL(".", import.meta.url)),
      "..",
      "..",
      "config",
      "sandbox-bubblewrap.mjs",
    ),
  ]
  const errors = []
  for (const spec of candidates) {
    try {
      const mod = await import(spec)
      if (
        typeof mod.buildBaseSandboxArgv === "function" &&
        mod.SANDBOX_BWRAP_BIN === BWRAP_BIN
      ) {
        console.log(`production builder: ${spec}`)
        return mod
      }
      errors.push(`${spec}: missing production exports`)
    } catch (error) {
      errors.push(`${spec}: ${error?.message ?? String(error)}`)
    }
  }
  throw new Error(
    [
      "cannot load production bubblewrap builder " +
        "(config/sandbox-bubblewrap.mjs buildBaseSandboxArgv); " +
        "refusing mock argv.",
      ...errors.map((e) => `  - ${e}`),
    ].join("\n"),
  )
}

/* ------------------------------------------------------------------ */
/* Process helpers with strict timeouts                                */
/* ------------------------------------------------------------------ */

const liveChildren = new Set()

function runCommand(bin, args, { timeoutMs = SPAWN_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] })
    liveChildren.add(child)
    let stdout = ""
    let stderr = ""
    let timedOut = false
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (c) => {
      stdout += c
    })
    child.stderr.on("data", (c) => {
      stderr += c
    })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill("SIGKILL")
      } catch {
        // Already exited.
      }
    }, Math.min(timeoutMs, remainingMs()))
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      liveChildren.delete(child)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      liveChildren.delete(child)
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}\nspawn error: ${error.message}`,
        timedOut,
      })
    })
  })
}

function hasBind(argv, source, target) {
  for (let i = 0; i + 2 < argv.length; i += 1) {
    if (
      argv[i] === "--ro-bind" &&
      argv[i + 1] === source &&
      argv[i + 2] === target
    ) {
      return true
    }
  }
  return false
}

function discoverSandboxNode() {
  const candidates = []
  if (
    typeof process.execPath === "string" &&
    process.execPath.startsWith("/usr/")
  ) {
    candidates.push(process.execPath)
  }
  candidates.push("/usr/local/bin/node", "/usr/bin/node")
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      const canonical = realpathSync(candidate)
      if (canonical === "/usr" || canonical.startsWith("/usr/")) {
        return candidate
      }
    } catch {
      // Try next candidate.
    }
  }
  throw new Error(
    "no usable Node binary under /usr for the in-sandbox DNS probe " +
      "(need the mounted /usr tree, e.g. /usr/local/bin/node); failing, never skipping.",
  )
}

/* ------------------------------------------------------------------ */
/* Endpoint servers (outside Bubblewrap, 127.0.0.1 only)               */
/* ------------------------------------------------------------------ */

function listenWithTimeout(server, port, host) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `server failed to listen on ${host}:${port} within ${SERVER_START_TIMEOUT_MS}ms`,
        ),
      )
    }, SERVER_START_TIMEOUT_MS)
    server.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    server.listen(port, host, () => {
      clearTimeout(timer)
      resolve(server.address())
    })
  })
}

async function startHttpServer(marker) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/marker") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end(`${marker}\n`)
      return
    }
    res.writeHead(404, { "content-type": "text/plain" })
    res.end("not found\n")
  })
  server.timeout = 8_000
  const address = await listenWithTimeout(
    server,
    Number(process.env.E2E_NET_HTTP_PORT ?? 0),
    "127.0.0.1",
  )
  return { server, port: address.port }
}

async function startHttpsServer({ key, cert, marker }) {
  const server = https.createServer({ key, cert }, (req, res) => {
    if (req.method === "GET" && req.url === "/marker") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end(`${marker}\n`)
      return
    }
    res.writeHead(404, { "content-type": "text/plain" })
    res.end("not found\n")
  })
  server.timeout = 8_000
  const address = await listenWithTimeout(
    server,
    Number(process.env.E2E_NET_TLS_PORT ?? 0),
    "127.0.0.1",
  )
  return { server, port: address.port }
}

async function startDnsServer(hostname, { port = 0 } = {}) {
  const wanted = normalizeDnsName(hostname)
  const socket = dgram.createSocket("udp4")
  const queries = []
  socket.on("message", (msg, rinfo) => {
    try {
      const question = parseDnsQuestion(msg)
      queries.push(question)
      if (process.env.E2E_NET_DEBUG === "1") {
        console.log(`DNS query: ${question.name} type=${question.qtype}`)
      }
      const match = question.qtype === 1 && question.name === wanted
      const response = buildDnsResponse(msg, {
        rcode: match ? 0 : 3,
        addresses: match ? ["127.0.0.1"] : [],
      })
      socket.send(response, rinfo.port, rinfo.address)
    } catch (error) {
      if (process.env.E2E_NET_DEBUG === "1") {
        console.log(`DNS responder ignoring malformed query: ${error?.message}`)
      }
      // Malformed query: deterministic silence (client times out loudly).
    }
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `DNS responder failed to bind 127.0.0.1 within ${SERVER_START_TIMEOUT_MS}ms`,
        ),
      )
    }, SERVER_START_TIMEOUT_MS)
    socket.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.bind(
      Number(process.env.E2E_NET_DNS_PORT ?? port),
      "127.0.0.1",
      () => {
        clearTimeout(timer)
        resolve()
      },
    )
  })
  return { socket, port: socket.address().port, queries }
}

/* ------------------------------------------------------------------ */
/* In-sandbox DNS probe (ordinary c-ares resolver lookup)              */
/* ------------------------------------------------------------------ */

const DNS_PROBE_SOURCE = `import { resolve4 } from "node:dns/promises"
const host = process.argv[2]
if (!host) {
  console.error("usage: dns-probe.mjs <hostname>")
  process.exit(2)
}
let addresses
try {
  addresses = await resolve4(host, { ttl: false })
} catch (error) {
  console.error(\`DNS lookup failed for \${host}: \${error.message}\`)
  process.exit(1)
}
if (addresses.length !== 1 || addresses[0] !== "127.0.0.1") {
  console.error(\`unexpected DNS answer for \${host}: \${JSON.stringify(addresses)}\`)
  process.exit(1)
}
console.log(\`DNS_RESOLVED \${host}=\${addresses[0]}\`)
`

const DNS_SELF_TEST_PROBE_SOURCE = `import { Resolver } from "node:dns/promises"
const [host, server] = process.argv.slice(2)
const resolver = new Resolver({ timeout: ${DNS_QUERY_TIMEOUT_MS}, tries: 1 })
resolver.setServers([server])
const addresses = await resolver.resolve4(host)
if (addresses.length !== 1 || addresses[0] !== "127.0.0.1") process.exit(1)
console.log(\`DNS_RESOLVED \${host}=\${addresses[0]}\`)
`

/* ------------------------------------------------------------------ */
/* Self-test PKI (local logic check only; container image preinstalls) */
/* ------------------------------------------------------------------ */

function generateSelfTestPki(dir, hostname) {
  const keyPath = join(dir, "test-ca.key")
  const caPath = join(dir, "test-ca.crt")
  const serverKeyPath = join(dir, "server.key")
  const csrPath = join(dir, "server.csr")
  const sanPath = join(dir, "server-san.ext")
  const certPath = join(dir, "server.crt")
  writeFileSync(
    join(dir, "openssl-min.cnf"),
    "[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = e2e-selftest\n",
  )
  const cnfArgs = ["-config", join(dir, "openssl-min.cnf")]
  let step = spawnSync(
    "openssl",
    [
      "req",
      ...cnfArgs,
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "2",
      "-nodes",
      "-addext",
      "basicConstraints=critical,CA:true",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      keyPath,
      "-out",
      caPath,
      "-subj",
      "/CN=e2e-selftest-ca",
    ],
    { timeout: 30_000, encoding: "utf8" },
  )
  if (step.status !== 0) {
    throw new Error(`self-test CA generation failed: ${step.stderr}`)
  }
  step = spawnSync(
    "openssl",
    [
      "req",
      ...cnfArgs,
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      serverKeyPath,
      "-out",
      csrPath,
      "-subj",
      `/CN=${hostname}`,
    ],
    { timeout: 30_000, encoding: "utf8" },
  )
  if (step.status !== 0) {
    throw new Error(`self-test server key generation failed: ${step.stderr}`)
  }
  writeFileSync(
    sanPath,
    `subjectAltName=DNS:${hostname}\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n`,
  )
  step = spawnSync(
    "openssl",
    [
      "x509",
      "-req",
      "-sha256",
      "-days",
      "2",
      "-in",
      csrPath,
      "-CA",
      caPath,
      "-CAkey",
      keyPath,
      "-CAcreateserial",
      "-extfile",
      sanPath,
      "-out",
      certPath,
    ],
    { timeout: 30_000, encoding: "utf8" },
  )
  if (step.status !== 0) {
    throw new Error(`self-test server cert signing failed: ${step.stderr}`)
  }
  return { caPath, certPath, keyPath: serverKeyPath }
}

/* ------------------------------------------------------------------ */
/* Fedora/RHEL CA symlink-layout regression (real bwrap 0.12.0)        */
/* ------------------------------------------------------------------ */

async function runCaSymlinkLayoutRegression(hostArgv, disabledArgv) {
  const lexical = "/etc/pki/tls/certs/ca-bundle.crt"
  const trustDir = "/etc/pki/tls/certs"
  const canonical = "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"
  if (realpathSync(lexical) !== canonical) {
    throw new Error(`unexpected Fedora/RHEL CA fixture target for ${lexical}`)
  }
  if (!hasBind(hostArgv, trustDir, trustDir)) {
    throw new Error("production argv omitted the Fedora/RHEL lexical CA directory bind")
  }
  if (!hasBind(hostArgv, canonical, canonical)) {
    throw new Error("production argv omitted the canonical Fedora/RHEL trust-file bind")
  }
  if (hasBind(hostArgv, lexical, lexical)) {
    throw new Error("production argv still binds onto the lexical CA symlink")
  }
  if (hasBind(disabledArgv, lexical, lexical)) {
    throw new Error("disabled production argv unexpectedly binds the lexical CA symlink")
  }
  console.log("CA_SYMLINK_NO_LEXICAL_BIND_OK")

  const expected = readFileSync(canonical, "utf8")
  const probe = await runCommand(hostArgv[0], [
    ...hostArgv.slice(1),
    "/bin/cat", lexical,
  ])
  if (probe.code !== 0 || probe.stdout !== expected) {
    throw new Error(
      "Fedora/RHEL CA symlink layout did not resolve through production argv " +
        "inside real Bubblewrap 0.12.0 " +
        `(exit=${probe.code} timedOut=${probe.timedOut} ` +
        `stdout=${JSON.stringify(probe.stdout.slice(0, 200))} ` +
        `stderr=${probe.stderr.trim().slice(0, 500)}).`,
    )
  }
  console.log("CA_SYMLINK_LAYOUT_HOST_OK")
}

/* ------------------------------------------------------------------ */
/* Full E2E                                                            */
/* ------------------------------------------------------------------ */

async function runFullE2e() {
  if (!existsSync(BWRAP_BIN)) {
    throw new Error(
      `${BWRAP_BIN} is missing; Bubblewrap/user namespaces are required. ` +
        "Failing, never skipping.",
    )
  }
  const version = spawnSync(BWRAP_BIN, ["--version"], {
    timeout: 10_000,
    encoding: "utf8",
  })
  if (version.status !== 0 || !BWRAP_VERSION_RE.test(version.stdout ?? "")) {
    throw new Error(
      `expected bubblewrap 0.12.0 at ${BWRAP_BIN}, got: ` +
        `${JSON.stringify(version.stdout ?? "")} ` +
        `${JSON.stringify(version.stderr ?? "")}. Failing, never skipping.`,
    )
  }
  console.log(`Bubblewrap: ${(version.stdout ?? "").trim()}`)

  for (const path of ["/usr/bin/curl", "/usr/bin/cat", "/usr/bin/true"]) {
    if (!existsSync(path)) {
      throw new Error(
        `required in-sandbox client tool missing on host: ${path}. Failing.`,
      )
    }
  }
  const sandboxNode = discoverSandboxNode()
  console.log(`in-sandbox node: ${sandboxNode}`)

  let tlsKey
  let tlsCert
  try {
    tlsKey = readFileSync(TLS_KEY_PATH)
    tlsCert = readFileSync(TLS_CERT_PATH)
  } catch {
    throw new Error(
      `TLS PKI missing (${TLS_CERT_PATH}, ${TLS_KEY_PATH}); the clean-container ` +
        "image preinstalls the dedicated CA/server cert. Failing, never skipping.",
    )
  }

  const builder = await loadProductionBuilder()

  const worktree = mkdtempSync(join(tmpdir(), "e2e-net-wt-"))
  console.log(`sandbox worktree: ${worktree}`)
  writeFileSync(join(worktree, "dns-probe.mjs"), DNS_PROBE_SOURCE)

  const servers = []
  try {
    checkDeadline("endpoint startup")
    const httpEndpoint = await startHttpServer(HTTP_MARKER)
    servers.push(httpEndpoint.server)
    console.log(`HTTP endpoint: 127.0.0.1:${httpEndpoint.port}`)
    const dnsEndpoint = await startDnsServer(TEST_HOSTNAME, { port: 53 })
    servers.push({
      close: (cb) => dnsEndpoint.socket.close(cb),
    })
    console.log(`DNS endpoint: 127.0.0.1:${dnsEndpoint.port}`)
    const httpsEndpoint = await startHttpsServer({
      key: tlsKey,
      cert: tlsCert,
      marker: TLS_MARKER,
    })
    servers.push(httpsEndpoint.server)
    console.log(`HTTPS endpoint: 127.0.0.1:${httpsEndpoint.port}`)

    checkDeadline("production argv generation")
    const disabledArgv = builder.buildBaseSandboxArgv(worktree, "/workspace", {
      networkAccess: "disabled",
    })
    const hostArgv = builder.buildBaseSandboxArgv(worktree, "/workspace", {
      networkAccess: "host",
    })

    if (disabledArgv[0] !== BWRAP_BIN || hostArgv[0] !== BWRAP_BIN) {
      throw new Error("production argv does not invoke /usr/bin/bwrap")
    }
    if (!disabledArgv.includes("--unshare-net")) {
      throw new Error("disabled production argv lost --unshare-net")
    }
    if (hostArgv.includes("--unshare-net")) {
      throw new Error("host production argv unexpectedly keeps --unshare-net")
    }
    for (const path of ["/etc/resolv.conf", "/etc/hosts"]) {
      if (hasBind(disabledArgv, path, path)) {
        throw new Error(`disabled argv unexpectedly mounts ${path}`)
      }
      if (!hasBind(hostArgv, path, path)) {
        throw new Error(
          `host production argv is missing the narrow resolver bind for ${path}; ` +
            "intended resolver config is not mounted.",
        )
      }
    }
    console.log("production argv isolation/mount shape OK")

    checkDeadline("bwrap userns preflight")
    const preflight = await runCommand(hostArgv[0], [
      ...hostArgv.slice(1),
      "/usr/bin/true",
    ])
    if (preflight.code !== 0 || preflight.timedOut) {
      throw new Error(
        "Bubblewrap/user namespaces are unavailable in this container " +
          `(exit=${preflight.code} timedOut=${preflight.timedOut} ` +
          `stderr=${preflight.stderr.trim().slice(0, 500)}). Failing, never skipping.`,
      )
    }
    console.log("BWRAP_USERNS_PREFLIGHT_OK")

    const httpUrl = (port) => `http://127.0.0.1:${port}/marker`
    const curlBase = [
      "--connect-timeout",
      String(CONNECT_TIMEOUT_S),
      "--max-time",
      String(CURL_MAX_TIME_S),
      "-fsS",
    ]

    checkDeadline("numeric loopback HTTP via host argv")
    const httpHost = await runCommand(hostArgv[0], [
      ...hostArgv.slice(1),
      "/usr/bin/curl",
      ...curlBase,
      httpUrl(httpEndpoint.port),
    ])
    if (httpHost.code !== 0 || httpHost.stdout.trim() !== HTTP_MARKER) {
      throw new Error(
        `host numeric loopback HTTP did not return the exact marker ` +
          `(exit=${httpHost.code} timedOut=${httpHost.timedOut} ` +
          `stdout=${JSON.stringify(httpHost.stdout.trim().slice(0, 200))} ` +
          `stderr=${httpHost.stderr.trim().slice(0, 500)}).`,
      )
    }
    console.log("LOOPBACK_HTTP_HOST_OK")

    checkDeadline("numeric loopback HTTP via disabled argv")
    const httpDisabled = await runCommand(disabledArgv[0], [
      ...disabledArgv.slice(1),
      "/usr/bin/curl",
      ...curlBase,
      httpUrl(httpEndpoint.port),
    ])
    if (
      httpDisabled.code === 0 &&
      httpDisabled.stdout.trim() === HTTP_MARKER
    ) {
      throw new Error(
        "network isolation breach: disabled sandbox received the HTTP marker.",
      )
    }
    if (httpDisabled.code === 0) {
      throw new Error(
        `disabled sandbox curl unexpectedly succeeded: ` +
          `stdout=${JSON.stringify(httpDisabled.stdout.trim().slice(0, 200))}`,
      )
    }
    if (httpDisabled.stdout.includes(HTTP_MARKER)) {
      throw new Error("disabled sandbox output leaked the HTTP marker.")
    }
    console.log("LOOPBACK_HTTP_DISABLED_DENY_OK")

    checkDeadline("resolver config mount proof")
    const hostResolv = readFileSync("/etc/resolv.conf", "utf8")
    if (!/^nameserver\s+127\.0\.0\.1\s*$/m.test(hostResolv)) {
      throw new Error(
        "deterministic network E2E requires /etc/resolv.conf to select " +
          "the local DNS responder at 127.0.0.1",
      )
    }
    const sandboxResolv = await runCommand(hostArgv[0], [
      ...hostArgv.slice(1),
      "/usr/bin/cat",
      "/etc/resolv.conf",
    ])
    if (sandboxResolv.code !== 0) {
      throw new Error(
        `cannot read /etc/resolv.conf inside host sandbox: ${sandboxResolv.stderr.trim().slice(0, 500)}`,
      )
    }
    if (sandboxResolv.stdout !== hostResolv) {
      throw new Error(
        "intended resolver config is not what the sandbox uses: " +
          "in-sandbox /etc/resolv.conf differs from host /etc/resolv.conf.",
      )
    }
    console.log("RESOLVER_CONFIG_MOUNT_OK")

    checkDeadline("ordinary DNS lookup inside host sandbox")
    const dnsProbe = await runCommand(hostArgv[0], [
      ...hostArgv.slice(1),
      sandboxNode,
      "/workspace/dns-probe.mjs",
      TEST_HOSTNAME,
    ])
    if (
      dnsProbe.code !== 0 ||
      !dnsProbe.stdout.includes(`DNS_RESOLVED ${TEST_HOSTNAME}=127.0.0.1`)
    ) {
      throw new Error(
        `ordinary resolver lookup inside host mode did not resolve ` +
          `${TEST_HOSTNAME} to 127.0.0.1 through mounted /etc/resolv.conf ` +
          `(exit=${dnsProbe.code} timedOut=${dnsProbe.timedOut} ` +
          `stdout=${dnsProbe.stdout.trim().slice(0, 300)} ` +
          `stderr=${dnsProbe.stderr.trim().slice(0, 500)}).`,
      )
    }
    if (dnsEndpoint.queries.length < 1) {
      throw new Error("local DNS responder saw no query from the sandbox.")
    }
    console.log("DNS_RESOLVER_HOST_OK")

    checkDeadline("verified HTTPS inside host sandbox")
    const tlsProbe = await runCommand(hostArgv[0], [
      ...hostArgv.slice(1),
      "/usr/bin/curl",
      ...curlBase,
      "--resolve",
      `${TEST_HOSTNAME}:${httpsEndpoint.port}:127.0.0.1`,
      `https://${TEST_HOSTNAME}:${httpsEndpoint.port}/marker`,
    ])
    if (tlsProbe.code !== 0 || tlsProbe.stdout.trim() !== TLS_MARKER) {
      throw new Error(
        "ordinary certificate verification inside host mode did not succeed " +
          `for ${TEST_HOSTNAME} with the exact marker ` +
          `(exit=${tlsProbe.code} timedOut=${tlsProbe.timedOut} ` +
          `stdout=${JSON.stringify(tlsProbe.stdout.trim().slice(0, 200))} ` +
          `stderr=${tlsProbe.stderr.trim().slice(0, 800)}). ` +
          "Verification must stay fully enabled; no fallback is permitted.",
      )
    }
    console.log("TLS_VERIFIED_HOST_OK")

    checkDeadline("verified HTTPS via disabled argv")
    const tlsDisabled = await runCommand(disabledArgv[0], [
      ...disabledArgv.slice(1),
      "/usr/bin/curl",
      ...curlBase,
      "--resolve",
      `${TEST_HOSTNAME}:${httpsEndpoint.port}:127.0.0.1`,
      `https://${TEST_HOSTNAME}:${httpsEndpoint.port}/marker`,
    ])
    if (
      tlsDisabled.code === 0 &&
      tlsDisabled.stdout.trim() === TLS_MARKER
    ) {
      throw new Error(
        "network isolation breach: disabled sandbox received the TLS marker.",
      )
    }
    if (tlsDisabled.code === 0) {
      throw new Error(
        "disabled sandbox TLS curl unexpectedly succeeded without network.",
      )
    }
    console.log("TLS_DISABLED_DENY_OK")

    checkDeadline("Fedora/RHEL CA symlink layout inside real bwrap")
    await runCaSymlinkLayoutRegression(hostArgv, disabledArgv)

    console.log("RUNNER_NETWORK_ACCESS_E2E_OK")
  } finally {
    for (const child of [...liveChildren]) {
      try {
        child.kill("SIGKILL")
      } catch {
        // Already exited.
      }
    }
    liveChildren.clear()
    for (const server of servers.reverse()) {
      try {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3_000)
          timer.unref?.()
          server.close(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      } catch {
        // Best-effort cleanup.
      }
    }
    try {
      rmSync(worktree, { recursive: true, force: true })
    } catch {
      // Disposable container temp; best effort.
    }
  }
}

/* ------------------------------------------------------------------ */
/* Self-test (no bwrap, no container; exercises real server/probe code) */
/* ------------------------------------------------------------------ */

async function runSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), "e2e-net-selftest-"))
  const servers = []
  try {
    const { caPath, certPath, keyPath } = generateSelfTestPki(
      scratch,
      TEST_HOSTNAME,
    )
    console.log("self-test PKI generated (temporary, openssl)")

    const httpEndpoint = await startHttpServer(HTTP_MARKER)
    servers.push(httpEndpoint.server)
    const dnsEndpoint = await startDnsServer(TEST_HOSTNAME)
    servers.push({ close: (cb) => dnsEndpoint.socket.close(cb) })
    const httpsEndpoint = await startHttpsServer({
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
      marker: TLS_MARKER,
    })
    servers.push(httpsEndpoint.server)

    writeFileSync(join(scratch, "dns-probe.mjs"), DNS_SELF_TEST_PROBE_SOURCE)

    const dnsLocal = await runCommand(process.execPath, [
      join(scratch, "dns-probe.mjs"),
      TEST_HOSTNAME,
      `127.0.0.1:${dnsEndpoint.port}`,
    ])
    if (
      dnsLocal.code !== 0 ||
      !dnsLocal.stdout.includes(`DNS_RESOLVED ${TEST_HOSTNAME}=127.0.0.1`)
    ) {
      throw new Error(
        `self-test DNS probe failed: ${dnsLocal.stdout.trim()} ${dnsLocal.stderr.trim()}`,
      )
    }
    console.log("SELF_TEST_DNS_OK")

    const curl = (args) =>
      runCommand("curl", args, { timeoutMs: 30_000 })
    const httpRes = await curl([
      "--connect-timeout",
      String(CONNECT_TIMEOUT_S),
      "--max-time",
      String(CURL_MAX_TIME_S),
      "-fsS",
      `http://127.0.0.1:${httpEndpoint.port}/marker`,
    ])
    if (httpRes.code !== 0 || httpRes.stdout.trim() !== HTTP_MARKER) {
      throw new Error(`self-test HTTP failed: ${httpRes.stderr}`)
    }
    console.log("SELF_TEST_HTTP_OK")

    const tlsRes = await curl([
      "--connect-timeout",
      String(CONNECT_TIMEOUT_S),
      "--max-time",
      String(CURL_MAX_TIME_S),
      "-fsS",
      "--cacert",
      caPath,
      "--resolve",
      `${TEST_HOSTNAME}:${httpsEndpoint.port}:127.0.0.1`,
      `https://${TEST_HOSTNAME}:${httpsEndpoint.port}/marker`,
    ])
    if (tlsRes.code !== 0 || tlsRes.stdout.trim() !== TLS_MARKER) {
      throw new Error(
        `self-test TLS (full verification against temp CA) failed: ${tlsRes.stderr}`,
      )
    }
    console.log("SELF_TEST_TLS_OK")
    console.log("SELF_TEST_OK")
  } finally {
    for (const child of [...liveChildren]) {
      try {
        child.kill("SIGKILL")
      } catch {
        // Already exited.
      }
    }
    liveChildren.clear()
    for (const server of servers.reverse()) {
      try {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 3_000)
          timer.unref?.()
          server.close(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      } catch {
        // Best effort.
      }
    }
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }
}

const mode = process.argv[2] ?? ""
if (mode === "--help" || mode === "-h") {
  console.log(
    "usage: network-access.mjs [--self-test]\n" +
      "  default: full clean-container E2E through production Bubblewrap argv\n" +
      "  --self-test: local endpoint/probe logic check without bwrap",
  )
  process.exit(0)
}

try {
  if (mode === "--self-test") {
    await runSelfTest()
  } else if (mode === "") {
    await runFullE2e()
  } else {
    throw new Error(`unknown argument: ${mode} (see --help)`)
  }
} catch (error) {
  console.error("")
  console.error(`ERROR: ${error?.message ?? String(error)}`)
  process.exitCode = 1
}
