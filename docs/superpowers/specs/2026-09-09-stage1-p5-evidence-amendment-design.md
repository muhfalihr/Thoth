# Stage 1 p5 Evidence Amendment Design

**Status:** Approved
**Date:** 2026-09-09
**Scope:** Correct the effective classification of activation parity sample `p5` and publish one sanitized checkpoint to GitHub Issue #5

## Context

Sample `p5` ran once against image `ghcr.io/muhfalihr/thoth@sha256:4cb1d7c51c3a112359f3ebfbb43e70b07f39937d7ce2bded904a1645c1f2d45c`, built from `92fa633163e88a352aeac74f2912c339bee44b03`.

Python completed through its CDN recovery route with valid artifacts. Scout produced valid report and media artifacts, and all nine offline comparison fields matched. Scout nevertheless recorded `reference_exit_code=124`, `reference_exit_nonzero=true`, and `timed_out=true`. Its attempt record finalized and cleanup passed.

The original p5 pairing row records `comparison_result="pass"`. This is not a valid activation-gate interpretation. The procedure in `docs/agent-prompts/stage1-p4-isolated-parity-executor.md` classifies a nonzero or timed-out reference as `evidence_incomparable`, never `pass` or `mismatch`. Comparable artifacts do not turn an unsuccessful reference lifecycle into a passing reference.

The original row is immutable. One append-only amendment supplies the effective classification.

## Amendment record

The amendment has this closed shape and field order:

```json
{
  "schema_version": 1,
  "record_type": "classification_amendment",
  "amendment_id": "amend_<32 lowercase hex characters>",
  "target_sample_id": "p5",
  "target_record_sha256": "sha256:<64 lowercase hex characters>",
  "previous_comparison_result": "pass",
  "effective_comparison_result": "evidence_incomparable",
  "reason_codes": [
    "reference_timed_out",
    "reference_exit_nonzero",
    "activation_reference_gate_failed"
  ],
  "authority": "docs/agent-prompts/stage1-p4-isolated-parity-executor.md:95-105",
  "operator_approved": true,
  "recorded_by": "claude-executor",
  "recorded_at": "<RFC 3339 UTC timestamp>"
}
```

`target_record_sha256` hashes the exact UTF-8 bytes of the original p5 JSON line without its terminal LF and an optional preceding CR.

`amendment_id` is deterministic:

```text
amend_ + first 32 lowercase hex characters of
SHA-256(target_record_sha256 + "\n" + effective_comparison_result + "\n" + comma-joined reason_codes)
```

Serialize compact UTF-8 JSON with `ensure_ascii=false`, separators `(',', ':')`, and one terminal LF.

## Validity and precedence

The amendment is valid only when:

1. Five original sample rows exist, `p1` through `p5` exactly once each.
2. One existing valid amendment targets p3 and no amendment targets p5.
3. The original p5 row has `observation_id=null` and `comparison_result="pass"`.
4. Its Python and Scout artifact checks and all nine field results are true.
5. Its preserved Scout attempt is complete but has nonzero exit 124 and `timed_out=true`.
6. Scout cleanup passed; containment success does not override lifecycle failure.
7. The raw p5 line digest equals `target_record_sha256`.
8. Every field matches the closed schema and `recorded_at` is UTC ending in `Z`.

Amendment-aware readers use the latest valid amendment in file order. This design permits exactly one p5 amendment. Afterwards the original row still says `pass`, while effective p5 is `evidence_incomparable`. P3 and p4 remain effectively incomparable. P5 earns no activation or in-window parity credit, the activation gate remains unpassed, and the acceptance window remains unopened.

## Append transaction

Use one Python standard-library process in one WSL session:

1. acquire an exclusive advisory lock;
2. read and validate the complete pairing file without printing rows;
3. calculate the file and raw p5-line digests;
4. construct the deterministic amendment;
5. create one timestamped mode-0600 sibling backup with exclusive creation;
6. write and `fsync` the backup and verify byte equality;
7. recheck the locked source;
8. append with exactly one `os.write` on an `O_APPEND` descriptor;
9. `fsync` the record and containing directory;
10. prove prefix preservation, row counts, amendment validity, and effective results before releasing the lock.

A short write is a hard failure and is never retried. A post-append verification failure preserves both files and never truncates, rewrites, or appends again.

## Idempotency

- An exact valid p5 amendment already present causes a no-write stop.
- A different or invalid p5 amendment causes a fail-closed stop.
- Unexpected permissions, record shape, source digest, or lifecycle evidence cause no mutation.
- An existing p5 correction checkpoint prevents duplicate publication.
- If amendment succeeds but Issue publication fails, preserve the amendment; Issue-only recovery requires new authorization.

## Public checkpoint

After restricted verification, publish exactly one comment to `muhfalihr/Thoth#5`. It may state the sample ID, public digest and commit, Python success, valid and matching artifacts, safe reason `reference_timeout_nonzero_exit`, effective `evidence_incomparable`, original-row preservation, zero parity credit, and untouched later gates.

It must not include fixture data, post metadata, private identifiers, paths, filenames, evidence hashes, byte counts, provider details, raw diagnostics, logs, or exceptions.

Write the reviewed body to a mode-0600 restricted temporary file, validate an allow-list and deny-list, post once with `--body-file`, fetch by comment ID, and compare byte-for-byte. Never automatically retry an uncertain POST. Remove the temporary body only after exact verification.

## Operational boundaries

This task authorizes no live request, parity retry, replacement fixture, second comparison, Docker command, deployment, environment change, observation or aggregate mutation, controlled fallback, acceptance window, S3 export, rollback, cutover, repository mutation, or Issue edit/deletion.

Do not dereference the fixture pointer or open raw reports and logs. Every WSL `uv` command uses `UV_PROJECT_ENVIRONMENT="$HOME/.cache/thoth-stage1-parity-uv/venv"`; the Windows repository venv remains byte-identical.

## Acceptance criteria

Completion requires one mode-0600 byte-identical backup, one valid p5 amendment, five unchanged sample rows, exactly two amendments, effective p5 `evidence_incomparable`, p3/p4 unchanged, no p5 parity credit, one sanitized byte-verified Issue comment, no restricted disclosure, and no other state change or later gate.
