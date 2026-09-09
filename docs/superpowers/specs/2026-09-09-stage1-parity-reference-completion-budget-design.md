# Stage 1 Parity Reference Completion and Budget Design

## Status and authority

The operator approved this offline corrective design after the read-only p5
timeout diagnosis on 2026-09-09. The diagnosis confirmed that the parity
supervisor reached its 900-second deadline while Scout had not reached its
final summary; `build_footage` was the last observable stage. The p5 evidence
remains effectively `evidence_incomparable` and earns no parity credit.

This document authorizes design and planning only. Its executor prompt
authorizes the corresponding offline implementation and verification. Neither
document authorizes a live request, parity retry, evidence mutation, deployment,
Issue #5 mutation, controlled fallback, or acceptance-window activation.

References:

- [Implementation plan](../plans/2026-09-09-stage1-parity-reference-completion-budget.md)
- [Executor prompt](../../agent-prompts/stage1-parity-reference-completion-budget-executor.md)
- [Parity procedure](../../operations/stage1-parity-sampling.md)
- [Diagnostic preservation design](2026-09-08-stage1-parity-diagnostic-preservation-design.md)
- [p5 evidence amendment design](2026-09-09-stage1-p5-evidence-amendment-design.md)

## Problem

The isolated reference currently starts the general Scout `run` command. That
command resolves the main source and then continues through comments, topic
enrichment, `build_footage`, figure extraction, and full validation. The parity
comparison consumes only the resolved main source report and its media. Later
enrichment therefore adds latency and failure modes without adding parity
evidence.

The reference supervisor has a 15-minute overall deadline, while the pipeline
allows `trace_source` 30 minutes and `build_footage` 90 minutes. P5 resolved and
materialized its main source, entered `build_footage`, and was terminated by the
shorter outer deadline. A readable partial report is not proof that the Scout
child completed, so the lifecycle contract correctly prevented a parity pass.

Two defects must be corrected together:

1. The reference runs work beyond the evidence boundary it is meant to prove.
2. The outer deadline is shorter than the longest stage that remains inside the
   corrected reference boundary.

## Decision

### Dedicated source-reference completion mode

Add the internal Scout flag `--source-reference-only` to the existing `run`
command. Its parsed option is `sourceReferenceOnly: boolean`.

The mode follows the existing pipeline through:

1. input inspection and seed report creation;
2. required `trace_source` execution and main-source materialization;
3. the existing final summary function; and
4. normal process exit.

After the summary returns, the mode exits the pipeline before
`collect_comments`, `topic_dossier`, `build_footage`, external-footage
materialization, figure extraction, and full-pipeline validation. The isolated
parity supervisor always supplies this flag for a real reference. Normal Scout
`run` invocations remain unchanged.

`--source-reference-only` and `--use-input-as-main` are an invalid combination.
The parity contract evaluates Scout source discovery; accepting a preselected
main would bypass that behavior and make the evidence ambiguous. Parsing must
fail with a fixed safe code before acquisition begins.

The existing external parity validator remains the authority for report schema,
media containment, signature, byte count, checksum, and nine-field comparison.
An exit-zero source-reference child does not by itself grant parity credit.

### Shared budget contract

Create a small dependency-free module at
`scout/lib/parity_reference_contract.ts` containing:

```typescript
export const SOURCE_REFERENCE_TRACE_TIMEOUT_MS = 30 * 60_000;
export const SOURCE_REFERENCE_OVERHEAD_RESERVE_MS = 5 * 60_000;
export const SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS =
  SOURCE_REFERENCE_TRACE_TIMEOUT_MS + SOURCE_REFERENCE_OVERHEAD_RESERVE_MS;
```

`run_pipeline.ts` uses `SOURCE_REFERENCE_TRACE_TIMEOUT_MS` for the required
`trace_source` stage. This preserves its current 30-minute stage budget.
`parity_reference.ts` uses
`SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS` as its default supervised acquisition
deadline.

The 35-minute supervised acquisition deadline starts before browser readiness and
ends when the browser/reference race selects an outcome; cleanup and attempt
finalization continue after that outcome and remain mandatory before the
supervisor returns.

The five-minute reserve is pre-outcome headroom: isolated-browser readiness, seed
inspection, the summary, and scheduling variance around the retained source
stage. It does not bound or include owned-child teardown or attempt finalization.
The supervisor still owns the hard acquisition boundary and still returns 124 if
the child does not finish. Tests lock the arithmetic relationship so that
deadline cannot silently become shorter than the retained source-stage budget.

This design does not extend the supervisor to the old 90-minute footage budget:
footage generation is outside the corrected reference boundary.

### Lifecycle and diagnostic semantics

Existing supervisor semantics remain unchanged:

- an exit-zero Scout child plus clean browser teardown records a completed
  lifecycle;
- deadline expiry records `timedOut=true` and returns 124 after bounded teardown;
- an operator signal remains distinct from a deadline;
- cleanup failure continues to outrank success, interruption, and timeout;
- the attempt record remains reserved before browser start and atomically
  finalized after both children are reaped;
- safe runtime diagnostics remain advisory and cannot change lifecycle or parity
  classification.

Calling the existing summary function before the source-only return provides a
fixed completion marker in restricted stdout. The durable completion authority
is still the finalized attempt record and child exit status, not that marker.

### Failure behavior

- A seed or `trace_source` failure retains the existing nonzero Scout behavior
  and safe diagnostic emission.
- A `trace_source` timeout occurs before the supervisor deadline and remains a
  Scout failure rather than being misreported as successful completion.
- If the source-reference child remains alive past the 35-minute supervised
  acquisition deadline, the supervisor still terminates it, records the timeout,
  reaps both children, finalizes the attempt record, and returns 124.
- A report or media file written before a failure remains non-creditable until
  lifecycle and external artifact gates both pass.
- No automatic retry is introduced.

## Alternatives considered

### Raise the supervisor above the complete general pipeline

Rejected. A safe outer budget would have to account for the 90-minute footage
stage plus every other stage. Parity would remain slow and exposed to unrelated
enrichment failures.

### Keep 15 minutes and shorten `trace_source`

Rejected. The 30-minute source budget was established from observed source
resolution behavior. An arbitrary lower limit would trade the p5 failure for
false source timeouts.

### Treat a valid report and media as completion

Rejected. P5 demonstrates that artifacts can exist while the Scout process is
still running. Artifact integrity cannot override lifecycle failure.

### Add automatic retry or resume

Rejected. Parity samples are explicitly one-shot evidence. Retry policy is an
operator decision and outside this corrective scope.

## Code and documentation impact

Expected implementation files:

- Create `scout/lib/parity_reference_contract.ts`.
- Modify `scout/pipeline/run_pipeline.ts`.
- Modify `scout/pipeline/run_pipeline_acquisition.test.ts`.
- Modify `scout/runtime/parity_reference.ts`.
- Modify `scout/runtime/parity_reference.test.ts`.
- Create `scout/runtime/parity_reference_contract.test.ts`.
- Modify `python/tests/deployment/test_container_contract.py` only for static
  image-contract assertions that cannot be expressed in the TypeScript tests.
- Modify `docs/operations/stage1-parity-sampling.md`.
- Modify `BLUEPRINT.md`.

No production acquisition adapter, downloader choice, provider configuration,
Compose deployment service, Temporal workflow, comparison schema, pairing
record, or observation schema changes.

## Acceptance criteria

| ID | Required evidence |
| --- | --- |
| AC1 | Parser tests prove `--source-reference-only` is explicit, defaults false, and conflicts with `--use-input-as-main` before acquisition. |
| AC2 | Pipeline tests prove source-reference mode executes seed, required `trace_source`, and summary, then invokes none of the later enrichment or validation stages. |
| AC3 | Normal `run` tests prove the existing full pipeline ordering remains unchanged. |
| AC4 | Supervisor command-construction tests prove every real reference passes `--source-reference-only`; offline smoke keeps its synthetic child. |
| AC5 | Budget tests prove the source-stage budget is 30 minutes, reserve is 5 minutes, and supervisor deadline is their 35-minute sum. |
| AC6 | Deadline, interruption, browser-death, cleanup-failure, pending-record, and atomic-finalization tests retain their current results. |
| AC7 | TypeScript runtime, acquisition, and typecheck gates pass; relevant Python deployment contract tests pass. |
| AC8 | A local Linux/amd64 candidate image passes the existing CDP and parity offline smoke harnesses without any public-site or provider request. |
| AC9 | Runbook and BLUEPRINT state that reference completion stops after the source boundary and that exit zero plus artifact validation are both required. |

## Non-goals and hard stops

The corrective round must not:

- access TikTok, a CDN, a provider, a fixture, a secret, or a live browser target;
- retry p5, create p6, rerun comparison, or mutate restricted evidence;
- query or mutate Temporal, observations, aggregate reports, S3, or Issue #5;
- inspect, restart, recreate, or otherwise touch the deployed stack;
- deploy, publish, push, open an acceptance window, or run controlled fallback;
- change acquisition routing, fallback policy, downloader selection, provider
  roles, parity thresholds, or the effective p5 classification;
- seed authentication, change the default Python mode, remove Scout, perform
  rollback/cutover, or begin Task 10.
