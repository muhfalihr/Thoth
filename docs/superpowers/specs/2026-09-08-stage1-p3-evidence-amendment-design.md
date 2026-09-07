# Stage 1 p3 Evidence Amendment Design

**Status:** Approved
**Date:** 2026-09-08
**Scope:** Correct the effective classification of the existing Stage 1 activation parity sample `p3` and publish a sanitized checkpoint to GitHub Issue #5

## Context

The isolated activation parity sample `p3` ran once against the deployed acquisition release:

- image digest `sha256:9187c97f059b8fa55907aa481edc44c771f0ca060f87954c4c55d7ad0f1276af`;
- acquisition implementation commit `433f3938f8b0ca2468541972801a472a8cb9a256`.

Its Python workflow completed with valid local artifacts. The isolated Scout reference exited nonzero, produced no reference media, and left Scout-side artifact-integrity checks false. Under `docs/operations/stage1-parity-sampling.md`, a reference failure, missing Scout media, or any false Scout-side artifact check makes the comparison `evidence_incomparable`.

The existing restricted pairing row records `comparison_result` as `mismatch`. Rewriting that row would erase the originally recorded interpretation. Leaving it as the only machine-readable classification would keep the effective evidence wrong. The correction must therefore be append-only and independently auditable.

Issue #5 is the operator change record. It has no p3 checkpoint yet. After the restricted amendment is durable and verified, one sanitized comment must record the effective classification without exposing fixture data, metadata, filesystem paths, checksums, or logs.

## Decision

Append one classification-amendment record to the existing restricted JSONL file. Preserve every existing byte as an immutable prefix. The new record changes only the effective interpretation of p3; it does not alter the acquisition result, create a parity pass, or authorize another run.

The correction has two ordered commits of operational state:

1. append and verify the restricted amendment;
2. publish and verify the sanitized Issue #5 checkpoint.

If step 1 succeeds and step 2 fails, the restricted evidence remains corrected. It must not be rolled back or appended again. A later Issue-only retry requires separate authorization.

## Record model

Existing rows have no `record_type`; readers treat them as `sample` records. The appended row has this closed shape:

```json
{
  "schema_version": 1,
  "record_type": "classification_amendment",
  "amendment_id": "amend_<16-64 lowercase hex characters>",
  "target_sample_id": "p3",
  "target_record_sha256": "sha256:<64 lowercase hex characters>",
  "previous_comparison_result": "mismatch",
  "effective_comparison_result": "evidence_incomparable",
  "reason_codes": [
    "reference_failed",
    "reference_media_missing",
    "scout_artifact_integrity_failed"
  ],
  "authority": "docs/operations/stage1-parity-sampling.md#window-completion",
  "operator_approved": true,
  "recorded_by": "claude-executor",
  "recorded_at": "<RFC 3339 UTC timestamp>"
}
```

`target_record_sha256` is the SHA-256 digest of the exact UTF-8 bytes of the targeted original JSON line, excluding its terminal LF and excluding an optional preceding CR. It binds the amendment to the row actually reviewed without publishing the row contents.

`amendment_id` is deterministic:

```text
amend_ + first 32 lowercase hex characters of
SHA-256(target_record_sha256 + "\n" + effective_comparison_result + "\n" + comma-joined reason_codes)
```

The fixed field order shown above is used when serializing the new row. Serialization is compact UTF-8 JSON with `ensure_ascii=false`, separators `(',', ':')`, followed by exactly one LF.

## Validity and precedence

An amendment is valid only when all of these hold:

1. exactly one prior sample row has `sample_id == "p3"`;
2. that row's raw-line digest equals `target_record_sha256`;
3. its recorded `comparison_result` is `mismatch`;
4. its `observation_id` is null;
5. its evidence shows the Scout reference did not produce valid media and at least one Scout-side artifact-integrity check is false;
6. no earlier classification amendment targets the same sample or original-row digest;
7. every amendment field matches the closed shape and fixed values above;
8. `recorded_at` is a valid UTC timestamp ending in `Z`.

For readers that understand amendments, the latest valid amendment in file order supplies the effective classification. This design permits exactly one amendment for p3. A future correction to the amendment requires a new design; an executor must not create an unreviewed amendment chain.

Legacy readers continue to see the original sample row. Operator evaluation must therefore resolve amendments before using pairing evidence. The p3 sample remains excluded from all activation and in-window parity counts regardless of reader capability.

## Append transaction

The executor performs the mutation from one continuous WSL session using Python standard-library operations only:

1. acquire an exclusive advisory lock on the pairing file;
2. read the complete file as bytes;
3. validate permissions, JSONL structure, and the p3 predicates without printing restricted values;
4. calculate the original file digest and targeted line digest;
5. create a timestamped mode-0600 backup in the same restricted directory;
6. verify the backup is byte-identical;
7. recheck the source file digest while holding the lock;
8. append the serialized amendment with one `os.write` on an `O_APPEND` descriptor;
9. call `fsync` on the file and containing directory;
10. reopen and validate the full JSONL file;
11. prove the new file begins with the exact pre-append bytes and contains exactly one additional line;
12. prove the effective p3 classification is `evidence_incomparable`.

The executor prints booleans and safe counts only. It never prints any existing row, URL, caption, checksum, path stored inside a row, raw diagnostic, or secret.

## Idempotency and failure handling

Before appending, the executor checks for the deterministic `amendment_id` and for any amendment targeting p3.

- If the exact valid amendment already exists, it performs no append and reports `amendment_already_present=true`.
- If a different amendment targets p3, it stops without mutation.
- If the file differs from the reviewed precondition, it stops without mutation.
- If backup or prefix verification fails, it stops and retains all files for review.
- If the append succeeds but later verification fails, it does not truncate or rewrite the file. It stops and reports the exact safe failure stage.

No command retries the parity sample, re-runs the reference, repairs artifacts, or changes the original row.

## Public checkpoint contract

After the restricted amendment verifies successfully, publish exactly one comment to `muhfalihr/Thoth#5`. The body may contain:

- sample identifier `p3`;
- the full deployed acquisition digest and implementation commit;
- Python workflow terminal success and Python-native route with internal CDN recovery, without workflow ID;
- isolated Scout reference terminal failure with safe reason code `media_unavailable`;
- the facts that no reference media existed and Scout integrity was incomplete;
- effective classification `evidence_incomparable`;
- confirmation that the original row was preserved and an append-only amendment was added;
- confirmation that p3 is not a parity pass and counts toward no parity requirement;
- confirmation that no retry, controlled fallback, deployment, or acceptance window occurred.

The body must not contain:

- fixture URL or fixture reference;
- workflow, observation, or reference identifiers other than `p3`;
- captions, owner handles, post IDs, normalized field values, filenames, or filesystem paths;
- checksums other than the public OCI digest;
- provider names, keys, responses, quotas, or raw HTTP status details;
- stdout, stderr, browser logs, stack traces, or raw exception text.

Write the exact body to a mode-0600 temporary file, post it with `gh issue comment 5 --body-file`, capture the returned comment URL, then read that comment through `gh api` and verify its body is byte-identical. Delete the temporary body file only after verification. Do not edit or delete an existing Issue comment.

## Operational boundaries

This amendment does not authorize:

- a p3 retry or p4 sample;
- a replacement fixture;
- cookie, browser-profile, or authentication seeding;
- TikTok or provider access;
- controlled fallback;
- deployment, restart, pull, or use of the newly published `c53e5f…` image;
- acceptance-window activation;
- observation or aggregate-report mutation;
- S3 export, rollback drill, Python-only mode, or Scout removal.

The deployed release remains the p3 acquisition identity. The newer published digest `sha256:c53e5f622fa85c5def2506a6a44df21e1babf6b3e88949a754594e88b0d5e4a3` is not retroactively attached to p3.

## Acceptance criteria

The operation is complete only when:

1. the pre-amendment pairing file and p3 target satisfy every predicate;
2. a mode-0600 byte-identical backup exists;
3. all pre-existing bytes remain unchanged as the amended file prefix;
4. exactly one valid deterministic amendment line is present;
5. effective classification resolves to `evidence_incomparable`;
6. p3 remains excluded from every parity count;
7. one sanitized Issue #5 comment exists and matches the reviewed body exactly;
8. no restricted value appears in terminal output or the Issue comment;
9. no repository, deployment, workflow, fixture, observation, or other evidence is changed;
10. the executor stops for independent review without entering another live gate.

