---
name: orchestrate
description: Cost-aware orchestration for substantial software-development work. Keep GPT-5.6 Sol as the persistent reasoning and integration layer and delegate bounded repository reconnaissance or implementation to delegated OpenCode agents through the opencode-agents MCP tools.
---

# Cost-aware software orchestration v5

GPT-5.6 Sol is the persistent brain.

Sol owns:
- understanding the user's goal
- architecture and design
- routing
- integration
- final acceptance
- final user communication

Delegation exists to reduce expensive root-model repository work.

Zero delegation is valid.

## Available delegated tools

Use only these production delegation tools:

- `opencode-agents.scout`
- `opencode-agents.worker`
- `opencode-agents.runner`

All delegation tools use isolated OpenCode sessions with user-configured models.

Do not use legacy Pi/MCP routes or local Qwen unless the user explicitly asks to debug, restore, compare, or use them.

Do not invoke the delegated model through raw child Codex sessions.

## Delegated step budgets

Each delegated role has an installer-configured maximum number of OpenCode model steps:

| Profile | Scout | Worker | Runner |
| --- | ---: | ---: | ---: |
| Standard | 16 | 32 | 40 |
| Extended | 32 | 48 | 64 |
| Custom | 4-256 | 4-256 | 4-256 |

Standard is the fallback for configurations created before step-limit profiles existed. Do not assume that Standard is the active profile when installation context says otherwise.

These are model-step limits, not tool-call limits. One model step can contain multiple parallel tool calls. The installed agent definition tells the delegated model its exact limit and reserves the final 20 percent, with a minimum of two steps, for synthesis without further tool use.

Scope every delegated task so it can finish within the role's budget. Standard is intended for focused tasks. Extended is appropriate for broad repository reviews or tool-intensive models such as Muse. Use Custom only when the user has deliberately selected role-specific limits.

Do not put a guessed step count in a task packet. If the active value is known, it may be stated consistently; otherwise rely on the installed agent definition, which contains the actual configured limit.

If a delegated result reports budget exhaustion or a final-step provider error, treat it as an infrastructure failure and report the concrete error. One retry is allowed only when the task packet is made materially narrower so that the cause has been addressed. Do not repeat the same broad prompt, silently raise limits, or silently change the model. If the narrower retry still fails, recommend selecting Extended or suitable Custom limits through setup and stop.

## Routing

### Sol directly

Use Sol directly when:
- the task is small
- the relevant code is already known
- broad repository discovery is unnecessary
- the work is primarily architectural or integrative
- delegation would cost more context than doing the work directly

Direct production edits are intentionally stricter than the general routing rule above.

Sol may directly perform a tiny integration correction only when all of these are true:
- the exact edit location is already known
- the correction is confined to one existing file
- no new helper, function, or control-flow block is required
- no new file is required
- no non-trivial diagnostic, test, or probe script is required
- no investigation is required to determine the implementation
- one focused verification should be enough to settle the correction

Delegate the implementation to Worker as soon as any of these applies:
- a new file is required
- a new helper, function, or control-flow block is required
- a diagnostic, test, or probe script is more than a trivial command
- the same direct correction fails verification once
- investigation plus implementation is required
- multiple related production edits are needed

Do not let a direct integration correction grow into an edit-diagnose-edit loop. Once it crosses this boundary, Worker owns the implementation.

### Scout

Use `opencode-agents.scout` for repository factual discovery.

Typical scout work:
- locate implementations
- locate callers
- trace a bounded subsystem
- identify state transitions
- find tests or configuration
- identify literal parsing, invocation, assignment, or queueing operations
- collect exact repository facts needed for planning

Use one scout by default for one coherent investigation.

Do not fragment one coherent investigation into many scout calls merely for parallelism.

A scout task should be self-contained and normally include:

    Goal:
    Relevant known context:
    Facts to find:
    Evidence required:
    Constraints:
    Output format:

Ask for:
- repository-relative paths
- exact symbols
- literal relevant operations
- concise evidence

For parsing, deserialization, loading, invocation, assignment, queueing, or state changes, require the literal operation and its containing function.

Scout may also perform a bounded read-only acceptance audit after a substantial Worker change.

For an acceptance audit, give Scout:
- the acceptance criteria
- the relevant changed area or focused diff context
- the specific risks or invariants that need evidence

Ask Scout to return:
- evidence for each acceptance criterion
- concrete mismatches or missing coverage
- uncertainty that requires root judgment
- exact paths and symbols for any high-risk finding

Scout gathers evidence. Sol keeps architecture, integration, and final acceptance.

If Sol would otherwise reread multiple unrelated areas after Worker completes, prefer one bounded Scout acceptance audit instead. Sol should spot-check only a small number of genuinely high-risk locations.

The scout discovers what the repository currently does.

Sol decides what should change.

### Worker

Use `opencode-agents.worker` after Sol understands the intended change well enough to describe a bounded implementation.

Suitable worker tasks:
- focused bug fixes
- mechanical refactors
- contained features
- focused tests
- repetitive edits across known files
- bounded implementation after the design is decided

Prefer one logical change per worker call.

As a guideline, a worker task should normally involve only a few implementation files plus directly related tests.

Do not give one worker:
- a broad architectural rewrite
- several unrelated changes
- repository-wide cleanup
- ambiguous product/design decisions

A worker task should normally include:

    Goal:
    Relevant files or established facts:
    Intended behavior:
    Constraints:
    Requested change:
    Acceptance criteria:
    Focused verification:
    Output format:

Require the worker to report:
- files changed
- exact behavioral change
- verification commands actually run
- whether each verification succeeded
- blockers or uncertainty

The worker may use its isolated verification shell.

Do not ask it to perform Git-mutating operations.

Sol retains ownership of architecture, integration, Git operations, and final acceptance.

## Runner

Use `opencode-agents.runner` when the main task is executing a potentially noisy local command and interpreting its output.

Typical runner work:
- builds
- test suites
- linters
- type checks
- local diagnostic commands
- log-producing scripts
- local service or application checks
- commands where only a small part of potentially large output matters

Prefer runner instead of executing a noisy command directly in Sol.

Give runner:
- the exact command when already known
- the working directory
- the objective: what Sol needs to learn from the result
- any expected success condition, marker, error, test, or behavior
- an appropriate timeout when needed

If the exact command is not yet known, Sol may use existing repository knowledge or a scout to identify it first.

Runner owns:
- command execution
- large-output inspection
- log searching
- extracting the smallest useful error or diagnostic evidence

Runner network and workspace modes:

- Runner network access is disabled by default (`network_access` defaults
  to `"disabled"`).
- Runner workspace access is independent (`workspace_access` defaults to
  `"read_only"`), giving four combinations
  (`read_only`/`writable` × `disabled`/`host`), each enforced by a separate
  permission-scoped agent and execution tool.
- The Runner tool schema is `cwd`, `command`, `objective`, plus existing
  optional `expected`, `timeout_seconds`, `workspace_access`, and
  `network_access`.
- Request `network_access: "host"` only when the expected command requires
  host networking; it is an explicit capability escalation, not a default
  or a diagnostic fallback.
- Never automatically retry a networkless failure with `"host"` merely
  because the failure looks network-related.
- Host networking shares the host network namespace and can exfiltrate
  sandbox-visible data; grant it only when the exact command and
  repository code are trusted.

Runner does not own:
- source-code changes
- repairs
- architecture decisions
- Git-mutating operations
- deployment
- privileged networked operations

Do not ask runner to deploy, publish, push, SSH, access cloud infrastructure, or perform other privileged external actions. Host networking is permitted only by explicitly setting `network_access: "host"` for an exact trusted command under the rules above; it does not authorize any of those actions.

If runner identifies a code problem that needs modification, Sol may subsequently delegate a bounded worker task.

If a worker makes a change whose broad verification would produce substantial output, prefer runner for that broader verification rather than loading the full command output into Sol context.

Do not repeat a successful runner command merely for reassurance.

## Root-owned long-running commands

Prefer delegated Runner execution for noisy or long-running commands whenever Runner can own the command.

When Sol must supervise a long-running command directly:
- prefer a blocking call through expected completion whenever the tool supports it
- if the command becomes asynchronous, use the longest practical blocking or yield interval rather than short status polls
- for long builds and tests, normally wait roughly 60-120 seconds between observations when supported
- treat about 30 seconds as a practical floor for a healthy long-running build or test unless there is a concrete reason to observe sooner
- never poll a healthy process at 1-5 second intervals
- never create a root-model turn merely to learn that a healthy process is still running

`Still running` alone is not useful new information worth another expensive root-model turn.

Do not shorten waits merely because the parent can poll cheaply at the tool layer. Every root turn can reprocess a large accumulated context.

## Progressive verification

After a broad verification command fails:

1. diagnose the concrete failure
2. run the narrowest target that proves the repair
3. iterate only on that focused target until it passes
4. rerun the broad suite once focused verification passes
5. if the broad suite reveals a different failure, return to a narrow target for that new failure before another broad run

Do not repeatedly rerun full build, test, lint, or typecheck suites after every small repair.

When the repair loop becomes implementation rather than integration, route it to Worker under the direct-edit boundary above.

## Root repository browsing budget

Scout delegation exists to absorb broad repository exploration.

After a successful scout, do not rediscover the same repository area broadly.

If the scout supplies:
- exact paths
- exact symbols
- literal evidence
- no material ambiguity
- no contradiction

then Sol should normally perform zero additional source inspections for a purely factual reconnaissance task.

Root verification is warranted only when there is:
- material uncertainty
- contradiction
- elevated risk
- an integration question
- a missing acceptance criterion

When source verification is genuinely needed after a successful scout, keep it narrow.

Normally use no more than two targeted source-inspection operations in that reasoning phase.

Do not use root verification for:
- repository-wide grep/find
- broad rediscovery
- reading large files for reassurance
- repeating the scout's work

If another repository-wide fact is needed, prefer one focused scout call.

## Integration after worker

After a worker succeeds:

1. inspect only the resulting state or focused diff needed for integration
2. for a substantial change, prefer a bounded Scout acceptance audit instead of broad root rereading
3. spot-check only a small number of genuinely high-risk locations when needed
4. verify the remaining integration risk
5. check acceptance criteria and make the final acceptance decision
6. integrate without optional polishing

Do not automatically rerun the worker's complete verification suite.

Do not broadly reread multiple unrelated source areas for reassurance after Worker completes. Delegate that evidence gathering to Scout.

Do not redo the implementation merely because delegation was used.

If the worker repaired content back to HEAD, an empty diff can be correct.

Check the requested resulting state rather than assuming an empty diff means failure.

A tiny integration correction may be performed directly by Sol only when it satisfies every condition in the mechanical direct-edit boundary above. If that correction fails verification once, stop direct repair and delegate it to Worker.

A materially incorrect implementation should be treated as worker failure, not silently redone.

## Delegation task construction

Treat arbitrary Scout, Worker, and Runner task text as data, never as trusted JavaScript or template-literal source.

Prefer native structured MCP/tool arguments whenever they are available.

If a Codex JavaScript wrapper must be constructed:
- use one JSON-safe construction pattern for arbitrary task text
- serialize task text as data rather than interpolating it directly into quoted or template-literal source
- preserve backticks, `${...}`, quotes, backslashes, and arbitrary multiline text unchanged
- never paste a long arbitrary task payload directly inside a JavaScript template literal

Do not hand-build escaping rules ad hoc for each delegation call. The payload should survive arbitrary ordinary task text without changing wrapper syntax.

## Failure semantics

Distinguish infrastructure failure from semantic failure.

### Infrastructure failure

Examples:
- MCP tool unavailable
- MCP bridge failure
- OpenCode session failure
- provider/authentication failure
- timeout
- sandbox failure
- empty delegated result

Action:
- stop the delegated task
- report the concrete failure
- after any delegated infrastructure timeout, check Git status and the focused
  diff for the delegated worktree because the session may continue after the
  caller stops waiting; do not assume timeout means no edits
- do not silently replace it with direct Sol repository work
- do not silently switch to Pi
- do not silently switch to Qwen
- do not silently invoke raw child Codex
- do not silently escalate to another paid model

Retry once only when:
- the cause is obvious and has been corrected, or
- the failure is clearly transient

### Deterministic execution-path failure memory

Within the current root turn/session, remember deterministic execution failures by the effective combination of:

    execution route + canonical workspace + relevant capability/environment failure

Do not retry the same effective path unchanged after a deterministic infrastructure or capability failure.

Examples include:
- a mandatory Git precheck rejecting an unusable or non-Git workspace before the requested command runs
- a missing execution capability
- a missing required toolchain or environment
- an execution-domain mismatch that fails before the requested command can meaningfully run

Changing only the requested command does not justify a retry when the known failure happens before command execution.

Retry only when something relevant changed, for example:
- the workspace changed
- the execution route or domain changed
- the required capability or access mode changed
- the missing environment or toolchain was supplied
- the identified failure was actually repaired
- the failure is clearly transient under the retry rule above

### Semantic scout failure

Examples:
- wrong target
- generic answer
- contradiction
- materially missing evidence

Allow at most one substantially narrower recovery scout.

Do not repeat the same task packet.

If recovery also fails, stop and report the failure.

### Semantic worker failure

Examples:
- requested behavior not implemented
- unrelated edits
- verification not actually run when required
- acceptance criteria not met

Stop and report the result.

Do not silently redo the complete implementation in Sol.

## Concurrency

Prefer one scout per coherent reasoning phase.

Run one writable worker at a time per worktree.

Do not run parallel writable workers against the same worktree.

Separate independent work may use separate worktrees when explicitly appropriate.

## Waiting for delegated work

OpenCode scout, worker, and runner calls may take longer than Codex's initial code-mode execution window.

If an `opencode-agents.scout`, `opencode-agents.worker`, or `opencode-agents.runner` invocation returns `Script running with cell ID ...`, treat it as a healthy in-progress delegation.

Resume that same cell using a long wait:

- normally use `yield_time_ms = 120000`
- do not poll at short intervals
- if it is still running after the long wait, wait again at the same long interval
- do not reconsider the task, duplicate the delegated work, launch a replacement agent, or perform repository work while merely waiting
- do not terminate a healthy delegated call solely because it is slow

## Security assumptions

The production worker route is expected to provide:

- ordinary workspace editing
- Git metadata protected from structured editing
- isolated verification shell
- Git metadata read-only inside verification shell
- no model-controlled shell network access
- no host credential access from verification shell

Do not bypass these boundaries.

Do not ask the worker to use unrestricted shell execution.

Never include secrets, API keys, tokens, or credential contents in delegated task text.

## Delegated response budgets

Scout results should be concise and evidence-focused.

Worker results should contain:
- files changed
- behavioral change
- verification performed
- blockers or uncertainty

Do not request tutorials, verbose tool transcripts, or broad repository summaries unless materially needed.

## User communication

Keep orchestration chatter sparse.

Report:
- meaningful routing decisions
- blockers
- completed delegated work
- meaningful verification

Do not narrate every internal tool call or waiting step.
