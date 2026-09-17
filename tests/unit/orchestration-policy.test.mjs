import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const here = join(fileURLToPath(import.meta.url), "..")
const repoRoot = resolve(here, "..", "..")

const skill = readFileSync(
  join(repoRoot, "skills", "orchestrate", "SKILL.md"),
  "utf8",
)

const policyDoc = readFileSync(
  join(repoRoot, "docs", "root-orchestration-policy.md"),
  "utf8",
)

function assertContainsAll(text, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(
      text.includes(fragment),
      `${label} must contain: ${fragment}`,
    )
  }
}

test("root-owned long-command policy forbids high-frequency status churn", () => {
  const required = [
    "## Root-owned long-running commands",
    "60-120 seconds",
    "30 seconds",
    "1-5 second intervals",
    "`Still running` alone is not useful new information",
  ]

  assertContainsAll(skill, required, "orchestration skill")

  assertContainsAll(
    policyDoc,
    [
      "## Long-running root-owned commands",
      "60-120 seconds",
      "30 seconds",
      "1-5 second intervals",
      "`Still running` alone is not useful new information",
    ],
    "root orchestration policy doc",
  )
})

test("progressive verification requires a focused repair target before another broad run", () => {
  const required = [
    "## Progressive verification",
    "run the narrowest target that proves the repair",
    "iterate only on that focused target until it passes",
    "rerun the broad suite once focused verification passes",
    "return to a narrow target for that new failure before another broad run",
  ]

  assertContainsAll(skill, required, "orchestration skill")
  assertContainsAll(policyDoc, required, "root orchestration policy doc")
})

test("deterministic infrastructure failures are remembered by effective execution path", () => {
  const required = [
    "execution route + canonical workspace + relevant capability/environment failure",
    "Do not retry the same effective path unchanged",
    "Changing only the requested command does not justify a retry",
    "the execution route or domain changed",
  ]

  assertContainsAll(skill, required, "orchestration skill")

  assertContainsAll(
    policyDoc,
    [
      "execution route + canonical workspace + relevant capability/environment failure",
      "Do not retry the same effective path unchanged",
      "Changing only the requested command is not a meaningful change",
      "execution route/domain",
    ],
    "root orchestration policy doc",
  )
})

test("direct root production edits have a mechanical tiny-fix boundary", () => {
  const required = [
    "Sol may directly perform a tiny integration correction only when all of these are true",
    "the correction is confined to one existing file",
    "no new helper, function, or control-flow block is required",
    "no new file is required",
    "the same direct correction fails verification once",
    "investigation plus implementation is required",
    "multiple related production edits are needed",
  ]

  assertContainsAll(skill, required, "orchestration skill")

  assertContainsAll(
    policyDoc,
    [
      "## Mechanical tiny-direct-fix boundary",
      "the correction is confined to one existing file",
      "no new helper/function/control-flow block is required",
      "no new file is required",
      "the direct correction fails focused verification once",
      "investigation plus implementation is required",
      "multiple related production edits are needed",
    ],
    "root orchestration policy doc",
  )
})

test("substantial Worker changes prefer a bounded Scout acceptance audit", () => {
  const required = [
    "bounded read-only acceptance audit",
    "evidence for each acceptance criterion",
    "Scout gathers evidence. Sol keeps architecture, integration, and final acceptance.",
    "prefer one bounded Scout acceptance audit instead",
  ]

  assertContainsAll(skill, required, "orchestration skill")

  assertContainsAll(
    policyDoc,
    [
      "## Post-Worker acceptance audit",
      "bounded read-only Scout acceptance audit",
      "evidence for each acceptance criterion",
      "The root retains architecture, integration, and final acceptance.",
    ],
    "root orchestration policy doc",
  )
})

test("delegation payloads are treated as data and constructed JSON-safely", () => {
  const required = [
    "## Delegation task construction",
    "Treat arbitrary Scout, Worker, and Runner task text as data",
    "use one JSON-safe construction pattern",
    "preserve backticks, `${...}`, quotes, backslashes, and arbitrary multiline text unchanged",
    "never paste a long arbitrary task payload directly inside a JavaScript template literal",
  ]

  assertContainsAll(skill, required, "orchestration skill")

  assertContainsAll(
    policyDoc,
    [
      "## Safe delegation payload construction",
      "Treat arbitrary Scout/Worker/Runner task text as data",
      "use one JSON-safe serialization pattern",
      "backticks, `${...}`, quotes, backslashes, or arbitrary multiline content must survive unchanged",
    ],
    "root orchestration policy doc",
  )
})

test("policy documentation does not claim a new bridge capability boundary", () => {
  assertContainsAll(
    policyDoc,
    [
      "it is not a new runtime capability boundary",
      "cannot mechanically stop a parent client",
      "tests protect the shipped policy from accidental regression",
      "live/manual orchestration scenarios",
    ],
    "root orchestration policy doc",
  )
})
