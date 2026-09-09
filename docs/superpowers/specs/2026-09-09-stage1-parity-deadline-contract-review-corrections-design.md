# Stage 1 Parity Deadline Contract Review Corrections Design

## Status and authority

The operator approved this offline corrective design after independent review of the Stage 1 parity
reference completion and budget implementation on 2026-09-09. The implementation at
`22ac41aabcb2e2ed1bceeec611e2c14118fa8803` remains the behavioral baseline.

This design authorizes documentation, test-typing, and audit-trail corrections only. It does not
authorize a live request, parity retry, evidence mutation, deployment, GitHub Issue #5 mutation,
controlled fallback, acceptance-window activation, push, publication, or pull request.

References:

- [Original completion-budget design](2026-09-09-stage1-parity-reference-completion-budget-design.md)
- [Corrective implementation plan](../plans/2026-09-09-stage1-parity-deadline-contract-review-corrections.md)
- [Executor prompt](../../agent-prompts/stage1-parity-deadline-contract-review-corrections-executor.md)
- [Parity procedure](../../operations/stage1-parity-sampling.md)

## Review findings

Independent review found three gaps:

1. The documentation calls 35 minutes an overall deadline whose five-minute reserve covers attempt
   finalization and two-child teardown. The implementation clears that timer once the browser or
   reference child produces an outcome, before teardown and attempt finalization begin.
2. The new source-boundary test casts its dependency fixture through `unknown` to
   `RunPipelineDeps`, despite the implementation plan explicitly requiring typed fixtures without
   casts.
3. `BLUEPRINT.md` contains the new 2026-09-09 checkpoint near the top, but its final chronological
   update entry still ends at 2026-09-08.

The first item is a wording mismatch, not evidence that cleanup should be interrupted. The existing
lifecycle deliberately reaps both owned children and finalizes the attempt record before returning a
verdict. That fail-closed behavior must remain authoritative.

## Corrected deadline contract

The production behavior remains unchanged:

- `SOURCE_REFERENCE_TRACE_TIMEOUT_MS` remains 30 minutes.
- `SOURCE_REFERENCE_OVERHEAD_RESERVE_MS` remains 5 minutes.
- `SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS` remains their exact 35-minute sum.
- The 35-minute timer bounds the supervised acquisition phase: isolated-browser startup and
  readiness, seed inspection and write, `trace_source`, the normal summary, and the reference
  child's exit outcome.
- Once an outcome is selected, the acquisition timer is cleared. Owned-child teardown and attempt
  finalization then run to completion outside that timer. They are mandatory post-outcome work, not
  optional work that a deadline may skip.
- Teardown remains bounded by the existing SIGTERM/SIGKILL grace behavior for each owned child.
  Cleanup failure continues to outrank success, interruption, and timeout.
- Attempt finalization remains awaited. A finalization failure continues to return the existing
  unexpected-failure exit code.

The five-minute reserve supplies headroom before the child outcome for browser readiness, seed work,
summary, and scheduling variance around the retained 30-minute source-stage budget. Documentation
must not claim that this reserve caps or includes post-outcome teardown or attempt finalization.

No executable statement in `runReference`, command construction, pipeline stage ordering, timeout
value, exit-code precedence, diagnostic handling, or evidence handling changes in this round.

## Test-typing correction

The source-reference dependency fixture in
`scout/pipeline/run_pipeline_acquisition.test.ts` must be assigned directly to a
`RunPipelineDeps`-typed variable and passed without `as unknown`, `as any`, or an optional-field
workaround. This restores compiler enforcement that the fixture implements the complete dependency
contract.

Existing source-reference assertions remain unchanged: the call order is context creation, seed
inspection, seed write, `trace_source`, and summary; every later stage remains a hard test failure.

## Documentation and audit trail

The original completion-budget design, shared-contract comments, supervisor comments, contract-test
wording, and parity runbook must use the corrected child-run deadline terminology consistently.

`BLUEPRINT.md` must:

1. keep p5 classified as `evidence_incomparable` with no parity credit;
2. clarify the acquisition-deadline versus mandatory post-outcome cleanup boundary in the existing
   2026-09-09 checkpoint; and
3. append a final chronological `Update: 2026-09-09` entry describing this review correction without
   claiming publication, deployment, a live pass, or an open acceptance window.

## Verification

The corrective must pass:

- the focused pipeline acquisition test;
- focused parity-reference runtime and contract tests;
- the complete Scout runtime suite;
- the complete Scout acquisition suite;
- TypeScript typecheck;
- the complete Python deployment suite;
- Ruff check and format check;
- `git diff --check`;
- the repository-required CUDA build.

A Docker image rebuild and container harness rerun are not required because this round changes no
executable production statement or image dependency. If review finds that executable behavior must
change, stop and return for a new operator decision instead of expanding this design.

## Acceptance criteria

| ID | Criterion |
| --- | --- |
| AC1 | Every contract document describes 35 minutes as the supervised acquisition/child-run deadline, not a cap on teardown or attempt finalization. |
| AC2 | The 30-minute, 5-minute, and derived 35-minute constants and runtime behavior remain unchanged. |
| AC3 | Cleanup, exit precedence, diagnostics, and atomic attempt finalization remain unchanged. |
| AC4 | The source-boundary test fixture is checked directly as `RunPipelineDeps` with no weakening cast. |
| AC5 | `BLUEPRINT.md` ends with a truthful 2026-09-09 audit entry and does not grant p5 parity credit. |
| AC6 | All required offline verification passes and the worktree is clean. |
| AC7 | Every new commit has one concise subject line, no body, no trailer, and no Claude/Anthropic attribution. |
| AC8 | No operational or network hard stop is crossed. |

## Hard stops

- No fixture, provider environment, secret, raw parity log, report, media, observation, aggregate,
  backup, or S3 evidence may be read or changed.
- No TikTok, CDN, provider, browser-live, Scout-live, Python acquisition, Temporal, or control-plane
  request may be made.
- No p5 retry, replacement sample, parity comparison, evidence amendment, or observation update may
  be performed.
- No Docker deployment, Compose deployment operation, registry login, image publication, GHCR pull,
  service restart, controlled fallback, rollback, cutover, or acceptance-window operation may be
  performed.
- GitHub Issue #5 must not be queried or mutated.
- No push, pull request, tag, or release may be created.
