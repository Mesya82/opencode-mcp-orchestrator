import assert from "node:assert/strict"
import test from "node:test"

import {
  discoverStructuredModelCatalog,
  STRUCTURED_CATALOG_ATTEMPTS,
} from "../../scripts/structured-model-catalog.mjs"

function response({
  status = 0,
  stdout = "",
  error,
} = {}) {
  return {
    result: {
      status,
      ...(error ? { error } : {}),
    },
    stdout,
    stderr: "",
  }
}

test("structured model discovery retries and succeeds after a transient failure", () => {
  const responses = [
    response({ status: 1 }),
    response({ stdout: '{"data":"usable"}' }),
  ]
  const delays = []
  let calls = 0

  const discovered =
    discoverStructuredModelCatalog({
      run: () => responses[calls++],
      parse: (stdout) =>
        stdout.includes("usable")
          ? [
              {
                reference: "provider/model",
                variants: ["variant-a"],
              },
            ]
          : null,
      isTimeout: () => false,
      sleep: (milliseconds) => delays.push(milliseconds),
    })

  assert.equal(calls, 2)
  assert.deepEqual(delays, [500])
  assert.equal(discovered.attempts, 2)
  assert.equal(discovered.fallbackReason, null)
  assert.deepEqual(
    discovered.entries,
    [
      {
        reference: "provider/model",
        variants: ["variant-a"],
      },
    ],
  )
})

test("structured model discovery falls back when stable V2 returns an empty catalog", () => {
  const delays = []
  let calls = 0
  let parseCalls = 0

  const discovered =
    discoverStructuredModelCatalog({
      run: () => {
        calls++
        return response({ stdout: '{"data":[]}' })
      },
      parse: () => {
        parseCalls++
        throw new Error("empty stable V2 catalog must be handled before parsing")
      },
      isTimeout: () => false,
      sleep: (milliseconds) => delays.push(milliseconds),
    })

  assert.equal(calls, STRUCTURED_CATALOG_ATTEMPTS)
  assert.equal(parseCalls, 0)
  assert.deepEqual(delays, [500, 1000])
  assert.equal(discovered.entries, null)
  assert.equal(discovered.attempts, STRUCTURED_CATALOG_ATTEMPTS)
  assert.match(
    discovered.fallbackReason,
    /structured OpenCode \/api\/model discovery failed after 3 attempts: returned unusable structured model metadata/,
  )
})

test("structured model discovery explains fallback after retries are exhausted", () => {
  const delays = []
  let calls = 0

  const discovered =
    discoverStructuredModelCatalog({
      run: () => {
        calls++
        return response({ status: 23 })
      },
      parse: () => null,
      isTimeout: () => false,
      sleep: (milliseconds) => delays.push(milliseconds),
    })

  assert.equal(calls, STRUCTURED_CATALOG_ATTEMPTS)
  assert.deepEqual(delays, [500, 1000])
  assert.equal(discovered.entries, null)
  assert.equal(discovered.attempts, STRUCTURED_CATALOG_ATTEMPTS)
  assert.match(
    discovered.fallbackReason,
    /structured OpenCode \/api\/model discovery failed after 3 attempts: exited with status 23/,
  )
})

test("structured model discovery reports timeout as the fallback reason", () => {
  const discovered =
    discoverStructuredModelCatalog({
      run: () => response(),
      parse: () => null,
      isTimeout: () => true,
      sleep: () => {},
    })

  assert.match(
    discovered.fallbackReason,
    /failed after 3 attempts: request timed out/,
  )
})
