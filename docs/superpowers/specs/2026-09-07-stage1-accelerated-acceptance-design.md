# Stage 1 Accelerated Acceptance Design

**Status:** Approved
**Date:** 2026-09-07
**Scope:** TikTok Stage 1 Python acquisition cutover only

## Context

The original Stage 1 operational soak requires a seven-day observation window, 50 valid completed runs, and five evidence-backed parity samples. That policy is deliberately conservative, but it is disproportionate for the approved local Docker Stage 1 environment and delays a reversible Python-default decision.

This design replaces those three thresholds with an accelerated acceptance policy. It does not weaken release identity, artifact integrity, cleanup, fallback, rollback, or human-approval gates. It also does not authorize removal of the TypeScript Scout implementation.

## Decision

The fixed Stage 1 policy becomes:

| Requirement | Previous | Accelerated |
| --- | ---: | ---: |
| Minimum valid-completed window | 7 days | 1 day (24 hours) |
| Minimum valid completed runs | 50 | 12 |
| Minimum evidence-backed parity samples | 5 | 2 |
| Minimum Python-native success rate | 0.95 | 0.95 |
| Maximum legacy-fallback rate | 0.05 | 0.05 |
| Maximum terminal-failure rate | 0.02 | 0.02 |

The 24-hour duration is measured between the earliest and latest included valid-completed observations. Container uptime, deployment time, an operator-declared timestamp, and non-completed observations do not extend the measured window.

With only 12 valid completed runs, the unchanged rate thresholds effectively require every included valid-completed run to be Python-native: one legacy fallback would be 8.33 percent and exceed the five-percent ceiling. A terminal failure also remains disqualifying at this sample size. The aggregate report must expose the actual counts and rates; no rounding may turn a violation into a pass.

## Applicability and precedence

This design supersedes only the three numeric Stage 1 readiness defaults in `docs/superpowers/specs/2026-09-02-python-tiktok-stage1-cutover-design.md`.

It applies only to a new acceptance dataset opened after:

1. the deployed digest, implementation commit, and provider configuration are recorded;
2. one separately approved isolated activation parity pair passes;
3. one separately approved controlled fallback exercise passes; and
4. the operator explicitly authorizes the new acceptance window.

Archived datasets and aggregate reports retain the policy under which they were created. They must not be re-evaluated with the accelerated defaults and presented as evidence for the new release. The operator change record must identify both the acquisition implementation commit and the evaluator commit used for the new report.

The already approved activation parity pair is pre-window gate evidence. It cannot be copied into or counted by the acceptance dataset. The two required acceptance parity samples are new workflows collected after the window is opened. Each uses a distinct approved, public, first-party TikTok post and follows `docs/operations/stage1-parity-sampling.md`.

## Gate sequence

```text
deploy one pinned acquisition digest
    -> isolated activation parity pair
    -> controlled fallback exercise
    -> explicit operator approval to open the window
    -> new isolated acceptance dataset
    -> 12 valid completed runs spanning at least 24 hours
    -> 2 in-window evidence-backed parity samples
    -> aggregate evaluator ready
    -> restart-recovery check
    -> rollback drill
    -> human cutover decision
```

Every arrow is a checkpoint. Approval for one live gate does not authorize the next gate. A failed gate is retained as evidence and stops the sequence; it is not retried or replaced without new operator authorization.

## Evaluator contract

`TikTokSoakPolicy` remains the single executable source for numeric readiness defaults. Its schema remains version 1 because the report already embeds the complete policy values used during evaluation. No observation or report field is added.

The default values change to:

```python
minimum_window_days = 1
minimum_valid_completed_runs = 12
minimum_parity_samples = 2
```

All existing rules remain unchanged:

- duplicate observation and workflow identifiers invalidate the dataset;
- only valid completed routes define the measured window and denominator;
- `artifact_validated` and `parity_passed` retain separate meanings;
- cleanup failures are zero-tolerance across completed and non-completed observations;
- invalid input and operator cancellation do not count as valid completion;
- blocker ordering remains deterministic;
- the evaluator remains pure and uses its supplied generation timestamp;
- aggregate reports remain free of URLs, captions, paths, raw diagnostics, and per-run identifiers.

The restart-recovery check, controlled fallback activation gate, rollback drill, and human decision remain operator evidence outside the observation schema. The aggregate evaluator being `ready` is necessary but not sufficient for cutover.

## Operational evidence

The new dataset must be created separately from every archived window. Its change record binds:

- deployed acquisition digest and implementation commit;
- evaluator commit and the embedded accelerated policy;
- provider configuration reference without secret values;
- window start authorization and UTC timestamp;
- restricted observation and pairing-record locations;
- controlled fallback, restart-recovery, and rollback evidence references;
- final human decision.

Evidence remains outside Git. Only the aggregate report may be attached to the change record. Raw observation JSONL, pairing records, fixture URLs, provider material, reports, media, and diagnostics remain restricted.

## Cutover and retirement boundary

Passing accelerated acceptance may authorize Python as the default TikTok acquisition path. The legacy Scout path remains available as a bounded rollback mechanism until a separate operator decision.

This design does not authorize:

- Python-only mode;
- disabling the legacy fallback adapter;
- deleting Scout TypeScript code or Bun dependencies;
- changing other platform adapters;
- starting Stage 2 or Task 10 retirement work.

Those actions require their own specification, implementation plan, verification, and operator approval.

## Documentation requirements

Active operator documentation must describe the accelerated values and gate order consistently:

- `docs/python-control-plane.md`
- `docs/operations/stage1-local-docker.md`
- `docs/operations/stage1-parity-sampling.md`
- `docs/python-scout-migration-roadmap.md`

Historical specifications remain unchanged. Active documentation must link to this superseding design rather than silently rewriting historical decisions.

## Acceptance criteria

The corrective implementation is complete when:

1. `TikTokSoakPolicy()` defaults are exactly 1 day, 12 valid completed runs, and 2 parity samples.
2. Boundary tests fail at 23:59:59, 11 valid completed runs, and 1 parity sample.
3. Boundary tests pass at 24:00:00, 12 valid completed runs, and 2 parity samples when every other rule passes.
4. Existing rate, cleanup, redaction, uniqueness, and deterministic-order tests remain green.
5. Active documentation consistently separates the pre-window activation parity pair from the two in-window parity samples.
6. Active documentation states that evaluator readiness does not authorize cutover by itself.
7. No live request, deployment, evidence mutation, window activation, or push occurs during the corrective implementation.

