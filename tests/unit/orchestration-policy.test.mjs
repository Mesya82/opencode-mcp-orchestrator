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
  const contract = [
    {
      skill: "Prefer delegated Runner execution for noisy or long-running commands whenever Runner can own the command.",
      policy: "Prefer Runner whenever a delegated role can own a noisy or long-running command.",
    },
    {
      skill: "prefer a blocking call through expected completion whenever the tool supports it",
      policy: "prefer one blocking call through expected completion when supported",
    },
    {
      skill: "if the command becomes asynchronous, use the longest practical blocking or yield interval rather than short status polls",
      policy: "if the process becomes asynchronous, use the longest practical blocking/yield interval",
    },
    {
      skill: "for long builds and tests, normally wait roughly 60-120 seconds between observations when supported",
      policy: "for long builds/tests, normally wait roughly 60-120 seconds between observations",
    },
    {
      skill: "treat about 30 seconds as a practical floor for a healthy long-running build or test unless there is a concrete reason to observe sooner",
      policy: "treat about 30 seconds as a practical floor for a healthy long-running build/test unless there is a concrete reason to observe sooner",
    },
    {
      skill: "never poll a healthy process at 1-5 second intervals",
      policy: "never poll a healthy process at 1-5 second intervals",
    },
    {
      skill: "never create a root-model turn merely to learn that a healthy process is still running",
      policy: "never create a root turn merely to learn that the process is still running",
    },
    {
      skill: "`Still running` alone is not useful new information worth another expensive root-model turn.",
      policy: "`Still running` alone is not useful new information worth another root-model turn.",
    },
    {
      skill: "Do not shorten waits merely because the parent can poll cheaply at the tool layer.",
      policy: "A tool-layer poll may look cheap while still causing the parent model to reprocess a large accumulated context.",
    },
  ]

  assertContainsAll(
    skill,
    [
      "## Root-owned long-running commands",
      ...contract.map(({ skill }) => skill),
    ],
    "orchestration skill",
  )

  assertContainsAll(
    policyDoc,
    [
      "## Long-running root-owned commands",
      ...contract.map(({ policy }) => policy),
    ],
    "root orchestration policy doc",
  )
})

test("progressive verification requires a focused repair target before another broad run", () => {
  const required = [
    "## Progressive verification",
    "diagnose the concrete failure",
    "run the narrowest target that proves the repair",
    "iterate only on that focused target until it passes",
    "rerun the broad suite once focused verification passes",
    "if the broad suite reveals a different failure, return to a narrow target for that new failure before another broad run",
  ]

  assertContainsAll(
    skill,
    [
      ...required,
      "Do not repeatedly rerun full build, test, lint, or typecheck suites after every small repair.",
      "When the repair loop becomes implementation rather than integration, route it to Worker under the direct-edit boundary above.",
    ],
    "orchestration skill",
  )

  assertContainsAll(
    policyDoc,
    [
      ...required,
      "Do not repeatedly rerun full build/test/lint/typecheck suites after every small repair.",
    ],
    "root orchestration policy doc",
  )
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
  const allowClauses = [
    {
      skill: "the exact edit location is already known",
      policy: "the exact edit location is already known",
    },
    {
      skill: "the correction is confined to one existing file",
      policy: "the correction is confined to one existing file",
    },
    {
      skill: "no new helper, function, or control-flow block is required",
      policy: "no new helper/function/control-flow block is required",
    },
    {
      skill: "no new file is required",
      policy: "no new file is required",
    },
    {
      skill: "no non-trivial diagnostic, test, or probe script is required",
      policy: "no non-trivial diagnostic/test/probe script is required",
    },
    {
      skill: "no investigation is required to determine the implementation",
      policy: "no investigation is required to determine the implementation",
    },
    {
      skill: "one focused verification should be enough to settle the correction",
      policy: "one focused verification should be enough to settle the correction",
    },
  ]

  const escalationClauses = [
    {
      skill: "a new file is required",
      policy: "a new file is required",
    },
    {
      skill: "a new helper, function, or control-flow block is required",
      policy: "a new helper/function/control-flow block is required",
    },
    {
      skill: "a diagnostic, test, or probe script is more than a trivial command",
      policy: "a diagnostic/test/probe script is more than a trivial command",
    },
    {
      skill: "the same direct correction fails verification once",
      policy: "the same direct correction fails verification once",
    },
    {
      skill: "investigation plus implementation is required",
      policy: "investigation plus implementation is required",
    },
    {
      skill: "multiple related production edits are needed",
      policy: "multiple related production edits are needed",
    },
  ]

  assertContainsAll(
    skill,
    [
      "Sol may directly perform a tiny integration correction only when all of these are true",
      ...allowClauses.map(({ skill }) => skill),
      "Delegate the implementation to Worker as soon as any of these applies",
      ...escalationClauses.map(({ skill }) => skill),
    ],
    "orchestration skill",
  )

  assertContainsAll(
    policyDoc,
    [
      "## Mechanical tiny-direct-fix boundary",
      "A root-owned production edit is allowed only for a tiny integration correction where all of these are true",
      ...allowClauses.map(({ policy }) => policy),
      "Delegate to Worker as soon as any of these applies",
      ...escalationClauses.map(({ policy }) => policy),
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
  const contract = [
    {
      skill: "Treat arbitrary Scout, Worker, and Runner task text as data, never as trusted JavaScript or template-literal source.",
      policy: "Treat arbitrary Scout/Worker/Runner task text as data, not JavaScript/template-literal source.",
    },
    {
      skill: "Prefer native structured MCP/tool arguments whenever they are available.",
      policy: "Prefer native structured MCP/tool arguments.",
    },
    {
      skill: "use one JSON-safe construction pattern for arbitrary task text",
      policy: "use one JSON-safe serialization pattern",
    },
    {
      skill: "serialize task text as data rather than interpolating it directly into quoted or template-literal source",
      policy: "keep arbitrary task text out of direct quoted/template interpolation",
    },
    {
      skill: "preserve backticks, `${...}`, quotes, backslashes, and arbitrary multiline text unchanged",
      policy: "Task text containing backticks, `${...}`, quotes, backslashes, or arbitrary multiline content must survive unchanged.",
    },
    {
      skill: "never paste a long arbitrary task payload directly inside a JavaScript template literal",
      policy: "Do not invent ad hoc escaping rules for each delegation call.",
    },
    {
      skill: "Do not hand-build escaping rules ad hoc for each delegation call.",
      policy: "The immediate requirement is to make unsafe construction explicitly forbidden by the orchestration policy.",
    },
  ]

  assertContainsAll(
    skill,
    [
      "## Delegation task construction",
      ...contract.map(({ skill }) => skill),
    ],
    "orchestration skill",
  )

  assertContainsAll(
    policyDoc,
    [
      "## Safe delegation payload construction",
      ...contract.map(({ policy }) => policy),
      "This issue does not require a new runtime helper unless a reusable repository-owned wrapper seam is identified.",
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
