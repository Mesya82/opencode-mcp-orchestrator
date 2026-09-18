# Root orchestration policy

This document records the policy contract introduced by issue #11 for keeping the expensive root model focused on architecture, routing, integration, and final acceptance rather than repetitive execution mechanics.

The policy is intentionally stronger than a style preference, but it is not a new runtime capability boundary. The orchestrator bridge cannot mechanically stop a parent client from polling its own process, rereading files directly, running its own shell commands, or editing code. Repository tests protect the shipped policy from accidental regression; live/manual orchestration scenarios are still needed to validate parent-model behavior.

## Long-running root-owned commands

Prefer Runner whenever a delegated role can own a noisy or long-running command.

When the root must supervise a long-running command directly:

- prefer one blocking call through expected completion when supported;
- if the process becomes asynchronous, use the longest practical blocking/yield interval;
- for long builds/tests, normally wait roughly 60-120 seconds between observations;
- treat about 30 seconds as a practical floor for a healthy long-running build/test unless there is a concrete reason to observe sooner;
- never poll a healthy process at 1-5 second intervals;
- never create a root turn merely to learn that the process is still running.

`Still running` alone is not useful new information worth another root-model turn. A tool-layer poll may look cheap while still causing the parent model to reprocess a large accumulated context.

## Progressive verification

After a broad verification command fails:

1. diagnose the concrete failure;
2. run the narrowest target that proves the repair;
3. iterate only on that focused target until it passes;
4. rerun the broad suite once focused verification passes;
5. if the broad suite reveals a different failure, return to a narrow target for that new failure before another broad run.

Do not repeatedly rerun full build/test/lint/typecheck suites after every small repair.

## Deterministic execution-path failure memory

Within one root turn/session, remember deterministic execution failures by the effective combination:

```text
execution route + canonical workspace + relevant capability/environment failure
```

Do not retry the same effective path unchanged after a deterministic infrastructure/capability failure.

Examples include:

- a mandatory Git precheck rejecting an unusable or non-Git workspace before the requested command runs;
- a missing execution capability;
- a missing required toolchain/environment;
- an execution-domain mismatch that fails before the requested command can meaningfully run.

Changing only the requested command is not a meaningful change when the known failure occurs before command execution.

A retry becomes valid when the relevant cause changes, for example the workspace, execution route/domain, access mode/capability, environment/toolchain, or the identified failure itself. Clearly transient failures still follow the existing transient retry policy.

## Mechanical tiny-direct-fix boundary

A root-owned production edit is allowed only for a tiny integration correction where all of these are true:

- the exact edit location is already known;
- the correction is confined to one existing file;
- no new helper/function/control-flow block is required;
- no new file is required;
- no non-trivial diagnostic/test/probe script is required;
- no investigation is required to determine the implementation;
- one focused verification should be enough to settle the correction.

Delegate to Worker as soon as any of these applies:

- a new file is required;
- a new helper/function/control-flow block is required;
- a diagnostic/test/probe script is more than a trivial command;
- the same direct correction fails verification once;
- investigation plus implementation is required;
- multiple related production edits are needed.

The boundary is intended to prevent an apparently tiny integration fix from expanding into a root-owned edit/diagnose/edit loop.

## Post-Worker acceptance audit

After a substantial Worker change, prefer one bounded read-only Scout acceptance audit over broad root rereading.

Give Scout the acceptance criteria plus the relevant changed area or focused diff context. Ask for:

- evidence for each acceptance criterion;
- concrete mismatches or missing coverage;
- uncertainty that requires root judgment;
- exact paths/symbols for high-risk findings.

Scout gathers evidence. The root retains architecture, integration, and final acceptance.

The root may spot-check a small number of genuinely high-risk locations. If it would otherwise inspect multiple unrelated areas, delegate the broad evidence gathering instead.

## Safe delegation payload construction

Treat arbitrary Scout/Worker/Runner task text as data, not JavaScript/template-literal source.

Prefer native structured MCP/tool arguments. If a Codex JavaScript wrapper must be constructed, use one JSON-safe serialization pattern and keep arbitrary task text out of direct quoted/template interpolation.

Task text containing backticks, `${...}`, quotes, backslashes, or arbitrary multiline content must survive unchanged. Do not invent ad hoc escaping rules for each delegation call.

This issue does not require a new runtime helper unless a reusable repository-owned wrapper seam is identified. The immediate requirement is to make unsafe construction explicitly forbidden by the orchestration policy.

## Regression strategy

Repository-level unit tests should assert that the shipped orchestration skill and this document retain the mandatory policy contracts above. These tests protect the policy text from accidental removal; they do not prove that an external parent client can be mechanically constrained by the bridge.

Where practical, live/manual orchestration scenarios should cover:

- a long-running root-owned command without rapid polling turns;
- no unchanged retry after a deterministic Runner infrastructure failure;
- Worker routing when a direct correction crosses the mechanical boundary;
- a Scout acceptance audit instead of broad post-Worker root rereading;
- focused repair verification before another broad suite run.

Runtime execution-domain improvements such as existing-container Worker/Runner support and non-Git Runner semantics remain separate follow-up work.