# Stage 1 Parity Diagnostic Preservation and Safe Inspection

## Status and authority

The operator approved this corrective design after the p4 checkpoint and offline
p3/p4 diagnosis on 2026-09-08. The diagnosis established that both references
terminated in the required `trace_source` stage with clean teardown and no
reference media, but it did not establish a shared root cause. Existing p1-p4
evidence remains immutable.

This document specifies an offline implementation round. It does not authorize a
live request, p3/p4 retry, p5, push, publication, deployment, evidence amendment,
controlled fallback, acceptance-window activation, or soak collection.

References:

- [Implementation plan](../plans/2026-09-08-stage1-parity-diagnostic-preservation.md)
- [Executor prompt](../../agent-prompts/stage1-parity-diagnostic-preservation-executor.md)
- [Parity procedure](../../operations/stage1-parity-sampling.md)
- [p4 checkpoint and offline diagnosis prompt](../../agent-prompts/stage1-p4-checkpoint-offline-diagnosis-executor.md)
- GitHub Issue #5, comment `5579445019`

## Problem statement

The p3 and p4 reference attempts preserve lifecycle truth but not enough causal
truth. Their attempt records prove nonzero Scout exit and clean teardown. Their
reports prove that no Scout media was materialized. Their restricted logs locate
the terminal required stage at `trace_source`. They do not provide a safe,
structured cause that can be compared across fixtures.

The current TikTok profile-discovery helper catches every discovery exception and
returns an empty candidate list. A genuine empty profile and an exception therefore
become observationally identical. A later free-form message may mention a login or
empty grid, but broad keyword counts cannot prove authentication, provider failure,
quota, model compatibility, downloader failure, or CDP failure.

The p4 investigation also exposed a process defect: an ad hoc inventory command
printed a restricted filename. The value stayed out of Git and Issue #5, but the
procedure must make the safe path the easy path before another sample.

## Decision

Use one strict, structured diagnostic channel carried inside the reference's
already-restricted stderr stream.

Scout emits a line with a fixed prefix followed by a compact JSON object whose
keys and values come entirely from compile-time allowlists. The parity supervisor
parses only those prefixed lines, rejects unknown keys or values, and writes the
validated events into the finalized `reference-attempt.json`. It never copies a
free-form exception, URL, handle, caption, model name, provider name, path, HTTP
body, or identifier into the attempt record.

Add an offline Python summary command that reads the known attempt-record path and
prints only safe booleans, counts, and allowlisted enums. Operators use this command
instead of directory enumeration or raw-log display.

### Alternatives considered

| Alternative | Assessment |
| --- | --- |
| Parse free-form stderr after failure | Rejected. Message wording is unstable and copying it risks secret, URL, path, or identifier disclosure. |
| Add a fifth diagnostic artifact | Rejected for this round. It adds reservation, atomicity, permission, cleanup, and runbook obligations without improving the required result. |
| Strict diagnostic frames in existing restricted stderr | Selected. It crosses the Scout/supervisor process boundary, preserves current process behavior, and adds no new evidence lifecycle. |

## Safe diagnostic contract

Create `scout/lib/safe_runtime_diagnostic.ts` as the sole definition of the wire
contract.

```typescript
export const SAFE_DIAGNOSTIC_PREFIX = 'THOTH_DIAGNOSTIC ';

// A discriminated union of the three approved events, one member per row of the table
// below, not four independent field unions: a cross product would make combinations such
// as terminal/media_candidate_discovery type-legal even though no such event exists.
export type SafeRuntimeDiagnostic =
  | {
      schema_version: 1;
      kind: 'signal';
      stage: 'trace_source';
      category: 'media_candidate_discovery';
      code: 'profile_discovery_exception';
    }
  | { /* profile_discovery_empty, same signal shape */ }
  | {
      schema_version: 1;
      kind: 'terminal';
      stage: 'trace_source';
      category: 'unknown';
      code: 'required_stage_failed';
    };

export function formatSafeRuntimeDiagnostic(event: SafeRuntimeDiagnostic): string;
export function parseSafeRuntimeDiagnostics(text: string): {
  events: SafeRuntimeDiagnostic[];
  valid: boolean;
};
```

The formatter re-checks its argument at runtime rather than trusting the static type,
because a structurally typed variable, a cast, or a hostile `toJSON` all reach it
unchecked. It rejects a non-plain object, a missing or extra key, an invalid
`schema_version`, and any combination outside the table with a fixed `TypeError` that
does not echo the rejected value, and it serializes a canonical object it builds itself
rather than the caller's. An own key means any string or symbol key, so an extra symbol
key is an extra key; each value is read from its own data-property descriptor, which
rejects an accessor without invoking it, and any reflection failure — including from a
hostile Proxy trap — is a rejection rather than an escaping error.
Valid input returns one single-line frame.
The parser considers only lines beginning with the exact prefix. Every prefixed
line must be valid JSON with exactly five keys — `schema_version`, `kind`,
`stage`, `category`, and `code` — and a valid combination of the last four:

| kind | stage | category | code |
| --- | --- | --- | --- |
| `signal` | `trace_source` | `media_candidate_discovery` | `profile_discovery_exception` |
| `signal` | `trace_source` | `media_candidate_discovery` | `profile_discovery_empty` |
| `terminal` | `trace_source` | `unknown` | `required_stage_failed` |

Unknown keys, missing keys, duplicate semantic events, invalid combinations, more
than 32 frames, or a diagnostic input larger than 1 MiB produce `valid: false` and
an empty event list. Ordinary non-prefixed stderr is ignored. The parser never
returns rejected text.

## Scout emission points

`findOriginalTiktokCandidates` becomes an exported, directly testable function
with an optional diagnostic sink. It retains its current candidate behavior:

- A thrown profile-discovery operation emits
  `signal/trace_source/media_candidate_discovery/profile_discovery_exception`
  and still returns an empty list.
- A successful operation with no items emits
  `signal/trace_source/media_candidate_discovery/profile_discovery_empty` and
  still returns an empty list.
- A non-empty result emits no failure signal.

The required-stage wrapper emits
`terminal/trace_source/unknown/required_stage_failed` immediately before it
rethrows a `trace_source` failure. It does not infer that an earlier discovery
signal caused the terminal failure. This distinction preserves the
observation-versus-inference boundary found during the p3/p4 review.

Production uses a sink that writes the formatted frame to stderr. Tests inject a
collector. No raw exception reaches the structured frame.

## Attempt-record integration

Keep the pending reservation unchanged. On finalization, the parity supervisor
reads at most 1 MiB from the known restricted stderr file, parses safe frames, and
adds these fields to a complete attempt record:

```json
{
  "diagnostics_valid": true,
  "diagnostic_events": []
}
```

`diagnostic_events` contains only validated `SafeRuntimeDiagnostic` values. A
prefixed malformed frame, size-limit violation, or read failure yields
`diagnostics_valid: false` and an empty array. A clean run with no frames yields
`diagnostics_valid: true` and an empty array. These fields are additive; existing
p1-p4 records are neither migrated nor amended, and their absence means
`diagnostic_contract=legacy` to the summary tool.

Lifecycle result and diagnostic result remain separate. Diagnostics cannot change
the reference exit code, cleanup verdict, artifact validity, or parity verdict.

## Safe offline summary

Create `stage1_parity_attempt_summary.py` under the existing operations package.
It accepts `--sample` and `--reference-id`, validates the identifier with
`^[a-z][a-z0-9-]{0,63}$`, resolves the one expected attempt path beneath the sample,
and reads only that file. It never walks the directory and never opens raw logs,
reports, fixtures, or media.

It emits one compact JSON object containing only:

```json
{
  "attempt_present": true,
  "attempt_complete": true,
  "reference_exit_nonzero": true,
  "cleanup_passed": true,
  "diagnostic_contract": "current",
  "diagnostics_valid": true,
  "diagnostic_event_count": 2,
  "terminal_stage": "trace_source",
  "terminal_category": "unknown",
  "media_candidate_discovery_signal": true
}
```

Missing, unreadable, pending, legacy, or invalid evidence produces fixed safe
values and a nonzero command exit where appropriate. The command never echoes an
argument, filesystem exception, path, filename, raw record value, or raw log.

## Output containment

The parity runbook must direct all routine attempt inspection through the summary
command. Manual investigation remains exceptional and must use known allowlisted
paths, in-memory parsing, and count-only output. `find`, `tree`, recursive listing,
raw `ls`, and raw log display are explicitly outside the routine procedure.

Tests place URL, path, post-ID, credential, and filename canaries in sibling files,
free-form record fields, and malformed diagnostic frames. None may appear in stdout
or stderr from the summary command or the supervisor's structured attempt fields.

## Compatibility and boundaries

- No acquisition routing, fallback ordering, downloader selection, provider
  configuration, browser topology, or cleanup behavior changes.
- TikTok profile discovery preserves its existing return behavior; this round adds
  observation, not an acquisition policy change.
- The attempt schema change is additive and legacy-aware.
- p3 and p4 stay immutable and retain `evidence_incomparable` with zero parity
  credit.
- No diagnostic event is sufficient to claim a root cause. The terminal event and
  preceding signals are facts for later review.

## Acceptance criteria

| ID | Required evidence |
| --- | --- |
| AC1 | Strict formatter/parser tests reject unknown keys, values, combinations, duplicates, oversized input, and secret/path canaries without returning rejected text. |
| AC2 | Profile discovery exception and empty-result branches emit distinct safe signals while preserving existing empty-list behavior; a non-empty result emits none. |
| AC3 | A required `trace_source` failure emits a terminal event and rethrows unchanged; no earlier signal is promoted to root cause. |
| AC4 | Complete attempt records atomically contain only validated diagnostic events plus `diagnostics_valid`; pending and legacy semantics remain intact. |
| AC5 | The offline summary reads only the known attempt file and emits the specified safe shape; canaries in other evidence never appear. |
| AC6 | Runtime, acquisition, deployment, type, formatting, CUDA build, candidate-image build, and offline parity smoke gates pass without a live request. |
| AC7 | Runbook and BLUEPRINT describe the diagnostic contract, legacy behavior, output containment, and the separate authorization required for p5. |

## Non-goals and hard stops

No p3/p4 evidence rewrite, retroactive diagnosis, fixture access, TikTok/CDN/provider
request, browser acquisition, parity retry, p5, Temporal operation, issue mutation,
push, publication, deployment, controlled fallback, acceptance-window activation,
observation mutation, S3 operation, rollback, cutover, Python-only default, Scout
removal, or Task 10.
