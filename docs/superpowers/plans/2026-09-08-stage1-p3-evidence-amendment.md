# Stage 1 p3 Evidence Amendment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this operational plan task-by-task. Do not dispatch evidence mutation to a subagent.

**Goal:** Append one auditable classification amendment for p3 to the restricted pairing record and publish one byte-verified sanitized checkpoint to GitHub Issue #5.

**Architecture:** Treat the existing pairing JSONL as an immutable event log. Bind the amendment to the exact original p3 line by digest, append it under an exclusive lock, verify prefix preservation and effective classification, then publish a fixed safe summary. The restricted mutation commits before the public checkpoint; neither step is rolled back or repeated automatically.

**Tech Stack:** WSL, Python standard library, JSONL, POSIX advisory locking, GitHub CLI

**Spec:** `docs/superpowers/specs/2026-09-08-stage1-p3-evidence-amendment-design.md`

## Global Constraints

- The original p3 line remains byte-identical.
- The effective result becomes `evidence_incomparable`, never `pass` or `mismatch`.
- Exactly one amendment may target p3.
- The amendment uses the deterministic ID and closed schema in the spec.
- Existing sample rows without `record_type` remain legacy `sample` records.
- The pairing record, backup, and temporary Issue body have exact mode 0600 under the existing restricted root.
- Terminal output contains safe booleans and counts only.
- The public comment contains no URL, post metadata, workflow/reference identifiers, paths, evidence hashes, provider details, or raw logs.
- The p3 acquisition identity remains digest `sha256:9187c97f059b8fa55907aa481edc44c771f0ca060f87954c4c55d7ad0f1276af` and commit `433f3938f8b0ca2468541972801a472a8cb9a256`; the newer published digest `sha256:c53e5f622fa85c5def2506a6a44df21e1babf6b3e88949a754594e88b0d5e4a3` is unrelated to p3.
- No parity retry, p4 sample, deployment, controlled fallback, or acceptance window is authorized.
- No repository file is modified during execution of this plan.

---

### Task 1: Establish a fail-closed read-only preflight

**Files:**

- Read: `/home/mfr/thoth-stage1-parity/pairing-record.jsonl`
- Read: `/home/mfr/thoth-stage1-parity/p3/`
- Read: GitHub Issue `muhfalihr/Thoth#5`

**Interfaces:**

- Consumes: the existing three-sample restricted pairing record and p3 evidence
- Produces: safe boolean preconditions; no mutation

- [ ] **Step 1: Enter one continuous WSL session and set restricted paths**

```bash
cd /mnt/c/Users/mfr/Documents/MyTools/CLIPPER
umask 077
export PAIRING_RECORD="$HOME/thoth-stage1-parity/pairing-record.jsonl"
export ISSUE_BODY_FILE="$HOME/thoth-stage1-parity/p3-issue5-comment.md"
```

Do not start Docker. Keeping one WSL session avoids waking and stopping the environment between commands.

- [ ] **Step 2: Verify repository and public checkpoint state**

```bash
git status --short
git rev-parse HEAD
gh run view 34147987948 --json conclusion,headSha
```

Require a clean worktree, successful CI head `78da6f56a284d1d4eb7a4b5ceccbdbb3d22ce301`, and the spec/plan commits present as ancestors. Query Issue #5 through `gh api` and print only:

```text
issue_accessible=true
p3_checkpoint_count=0
```

If any existing comment already records both p3 and `evidence_incomparable`, stop before mutation to prevent duplicate publication. Record whether its body is byte-equivalent to the reviewed body, but do not edit or replace it.

- [ ] **Step 3: Validate the restricted record without printing it**

Run a Python standard-library preflight that checks:

```python
assert record_path.is_file()
assert stat.S_IMODE(record_path.parent.stat().st_mode) == 0o700
assert stat.S_IMODE(record_path.stat().st_mode) == 0o600
assert raw_bytes.endswith(b"\n")
assert len([row for row in parsed_rows if row.get("record_type", "sample") == "sample"]) == 3
assert len([row for row in parsed_rows if row.get("record_type", "sample") == "sample" and row.get("sample_id") == "p3"]) == 1
assert p3["comparison_result"] == "mismatch"
assert p3.get("observation_id") is None
assert p3.get("scout_media_ref") is None
assert scout_integrity_incomplete
assert all(row.get("record_type") in (None, "classification_amendment") for row in parsed_rows)
sample_ids = [row["sample_id"] for row in parsed_rows if row.get("record_type") is None]
assert len(sample_ids) == len(set(sample_ids))
amendment_ids = [row["amendment_id"] for row in parsed_rows if row.get("record_type") == "classification_amendment"]
assert len(amendment_ids) == len(set(amendment_ids))
```

Use these exact parsing and predicate rules; they deliberately retain raw line bytes for the later binding digest:

```python
def parse_jsonl(raw: bytes) -> list[tuple[bytes, dict[str, object]]]:
    parsed: list[tuple[bytes, dict[str, object]]] = []
    for physical_line in raw.splitlines(keepends=True):
        assert physical_line.endswith(b"\n")
        json_bytes = physical_line[:-1]
        if json_bytes.endswith(b"\r"):
            json_bytes = json_bytes[:-1]
        assert json_bytes
        row = json.loads(json_bytes.decode("utf-8"))
        assert isinstance(row, dict)
        parsed.append((json_bytes, row))
    assert parsed
    return parsed


def boolean_leaves(value: object, path: tuple[str, ...] = ()):
    if isinstance(value, bool):
        yield path, value
    elif isinstance(value, dict):
        for key, child in value.items():
            assert isinstance(key, str)
            yield from boolean_leaves(child, (*path, key.lower()))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from boolean_leaves(child, (*path, str(index)))


scout_integrity_incomplete = any(
    value is False and any("scout" in segment for segment in path)
    for path, value in boolean_leaves(p3["artifact_checks"])
)
assert scout_integrity_incomplete
```

No blank JSONL lines, non-object rows, invalid UTF-8, unknown explicit `record_type`, duplicate sample IDs, or duplicate amendment IDs are accepted. The recursive artifact predicate considers only boolean leaves below `p3["artifact_checks"]` whose dotted key path contains `scout`; it prints no key path or value.

Resolve `p3["reference_id"]` privately after validating it against `^[a-z][a-z0-9-]{0,63}$`. Read that reference's `reference-attempt.json` below the p3 restricted directory and require:

```python
assert attempt["status"] == "complete"
assert isinstance(attempt["referenceExit"], int) and not isinstance(attempt["referenceExit"], bool)
assert attempt["referenceExit"] != 0
assert attempt["cleanupPassed"] is True
assert attempt["timedOut"] is False
assert attempt["interrupted"] is False
```

Do not print the reference identifier, attempt path, exit code, or raw attempt record. Detect amendments after calculating the deterministic identity defined in Task 2:

- zero amendments targeting p3 permits the transaction;
- one exact valid deterministic amendment means `amendment_already_present=true` and an immediate hard stop without creating a backup or posting to Issue #5;
- any invalid or different amendment targeting p3 is a precondition failure and an immediate hard stop.

A valid existing amendment has the exact ordered keys shown in the spec, exact fixed values and reason-code order, a deterministic ID matching the Task 2 calculation, and an RFC 3339 UTC `recorded_at` ending in `Z`. No additional field is accepted.

Print only:

```text
pairing_mode_0600=true
jsonl_valid=true
sample_row_count=3
p3_unique=true
p3_recorded_mismatch=true
p3_observation_absent=true
p3_reference_media_absent=true
p3_reference_failed=true
p3_scout_integrity_incomplete=true
existing_p3_amendment=false
```

Completion criterion: every safe predicate is true and no evidence/public state changed. Otherwise stop.

### Task 2: Append and verify the restricted amendment

**Files:**

- Modify append-only: `/home/mfr/thoth-stage1-parity/pairing-record.jsonl`
- Create: `/home/mfr/thoth-stage1-parity/pairing-record.jsonl.<YYYYMMDDTHHMMSSZ>.bak`

**Interfaces:**

- Consumes: validated p3 sample row and operator authorization embodied by the executor prompt
- Produces: one valid `classification_amendment` row and byte-identical backup

- [ ] **Step 1: Execute one locked transaction**

Use one Python standard-library process. Its implementation must follow this exact sequence:

```python
fd = os.open(record_path, os.O_RDONLY)
fcntl.flock(fd, fcntl.LOCK_EX)
size = os.fstat(fd).st_size
before = os.pread(fd, size, 0)
assert len(before) == size

# Re-run every Task 1 record and attempt predicate while holding the lock.
# Hash the raw p3 line bytes with CR/LF excluded.
target_record_sha256 = "sha256:" + hashlib.sha256(p3_raw_line).hexdigest()
reason_codes = [
    "reference_failed",
    "reference_media_missing",
    "scout_artifact_integrity_failed",
]
effective_result = "evidence_incomparable"
identity_source = (
    target_record_sha256
    + "\n"
    + effective_result
    + "\n"
    + ",".join(reason_codes)
)
amendment_id = "amend_" + hashlib.sha256(
    identity_source.encode("utf-8")
).hexdigest()[:32]

amendment = {
    "schema_version": 1,
    "record_type": "classification_amendment",
    "amendment_id": amendment_id,
    "target_sample_id": "p3",
    "target_record_sha256": target_record_sha256,
    "previous_comparison_result": "mismatch",
    "effective_comparison_result": "evidence_incomparable",
    "reason_codes": reason_codes,
    "authority": "docs/operations/stage1-parity-sampling.md#window-completion",
    "operator_approved": True,
    "recorded_by": "claude-executor",
    "recorded_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
}
encoded = (
    json.dumps(amendment, ensure_ascii=False, separators=(",", ":")) + "\n"
).encode("utf-8")
```

Create the backup with `O_WRONLY | O_CREAT | O_EXCL` and mode 0600, write all `before` bytes, `fsync`, close, and verify it is byte-identical. Re-read the locked source with `os.pread` and require it still equals `before`. Open the source separately with `O_WRONLY | O_APPEND`, perform exactly one `os.write(encoded)`, and require the returned byte count equals `len(encoded)`; never retry a short write. `fsync` and close the append descriptor, then `fsync` the containing directory before releasing the lock. Keep the original lock descriptor open for that entire sequence.

- [ ] **Step 2: Verify prefix preservation and effective resolution**

Reopen the pairing file and prove:

```python
assert after.startswith(before)
assert len(after.splitlines()) == len(before.splitlines()) + 1
assert after[len(before):] == encoded
assert backup.read_bytes() == before
assert stat.S_IMODE(backup.stat().st_mode) == 0o600
assert stat.S_IMODE(record_path.stat().st_mode) == 0o600
assert exactly_one_valid_amendment_targets_p3
assert effective_p3_result == "evidence_incomparable"
```

The original p3 row must still parse with `comparison_result == "mismatch"`; the amendment supplies the effective result. Do not rewrite that row.

Print only:

```text
backup_created=true
backup_byte_identical=true
original_prefix_preserved=true
rows_added=1
amendment_count=1
effective_p3_result=evidence_incomparable
p3_counts_as_parity=false
```

Completion criterion: the append is durable, exactly one line was added, every original byte is preserved, and the effective resolver excludes p3. On any post-append failure, stop without truncating or appending again.

### Task 3: Publish and verify the sanitized Issue #5 checkpoint

**Files:**

- Create temporarily: `/home/mfr/thoth-stage1-parity/p3-issue5-comment.md`
- External write: one new comment on `muhfalihr/Thoth#5`

**Interfaces:**

- Consumes: successfully verified amendment
- Produces: one immutable public checkpoint comment URL

- [ ] **Step 1: Write the exact safe body with mode 0600**

Use this body verbatim:

```markdown
Stage 1 activation parity p3 — evidence classification correction

Release: `ghcr.io/muhfalihr/thoth@sha256:9187c97f059b8fa55907aa481edc44c771f0ca060f87954c4c55d7ad0f1276af`
Implementation: `433f3938f8b0ca2468541972801a472a8cb9a256`

The isolated activation pair was executed once. Python completed through the Python-native acquisition path after internal CDN recovery. The isolated Scout reference failed with safe reason `media_unavailable`, produced no reference media, and did not satisfy Scout artifact integrity.

The original restricted pairing row recorded `mismatch` and remains unchanged. An append-only amendment now makes the effective classification `evidence_incomparable` under the parity runbook.

Consequences:

- p3 is not a parity pass and counts toward no parity requirement.
- No retry or replacement sample was performed.
- No controlled fallback, deployment, or acceptance window was started.
- Restricted evidence remains outside Git and is not embedded in this comment.
```

Validate before posting that the body contains the full p3 acquisition digest and commit, contains `evidence_incomparable`, and contains none of these case-insensitive tokens:

```text
http://
https://
tiktok.com
/home/
/mnt/
workflow_id
observation_id
reference_id
api_key
authorization
browser.log
stderr
stdout
```

Find every string matching `sha256:[0-9a-fA-F]{64}`. Require exactly one match and require it to equal the full approved acquisition digest. Reject any other `sha256:` token, including the p3 target-record hash and the newer `c53e5f...` digest. Write the file with Python standard-library calls, require exact mode 0600, and do not echo its body.

- [ ] **Step 2: Post once**

Immediately before posting, query Issue #5 again and require zero comments containing both `p3` and `evidence_incomparable`. Then run:

```bash
gh issue comment 5 --repo muhfalihr/Thoth --body-file "$ISSUE_BODY_FILE"
```

Do not automatically retry the POST. If the command response is uncertain, perform one read-only Issue query: exactly one byte-identical body means success; zero or multiple matches means stop for operator review.

- [ ] **Step 3: Verify the public body exactly**

Capture the created comment ID/URL, read that exact comment with `gh api`, and compare its UTF-8 body byte-for-byte with the local body excluding only a single terminal LF normalization if GitHub removed it. Print only:

```text
issue_comment_created=true
issue_comment_count_for_p3=1
issue_body_exact=true
issue_comment_url=<public URL>
```

Delete the temporary body file only after exact verification. Do not edit or delete the comment.

Completion criterion: exactly one safe p3 correction comment exists and is byte-equivalent to the reviewed body.

### Task 4: Final containment and handoff

**Files:**

- Verify: restricted pairing record and backup
- Verify: Git worktree
- Verify: Issue #5 comment

**Interfaces:**

- Consumes: completed restricted and public checkpoints
- Produces: independent-review handoff; no later gate

- [ ] **Step 1: Re-run safe effective-state checks**

Verify without printing restricted values:

```text
pairing_jsonl_valid=true
original_row_count=3
amendment_count=1
original_prefix_preserved=true
effective_p3_result=evidence_incomparable
p3_counts_as_parity=false
issue_body_exact=true
```

- [ ] **Step 2: Verify untouched systems**

```bash
git status --short
git rev-parse HEAD
```

Require a clean worktree and unchanged repository HEAD. Do not inspect Docker or WSL services. Check the executor's action ledger for this run; never inspect or print shell history because it can contain fixture or secret material. The ledger must contain no TikTok/provider request, workflow, deployment, evidence rewrite, observation mutation, or retry.

- [ ] **Step 3: Report and stop**

Return an Indonesian report with:

- repository baseline/final identity and clean status;
- preflight booleans and original safe row count;
- backup-created, exact-mode, and byte-identical booleans without its path or digest;
- amendment-count and validity booleans without amendment ID or target hash;
- prefix, added-row, and effective-result checks;
- public Issue comment ID/URL and exact-body boolean;
- explicit confirmation original p3 row still says `mismatch` while the effective append-only result is `evidence_incomparable`;
- explicit confirmation p3 counts toward no parity requirement;
- every action not performed;
- final handoff: `p3 evidence correction recorded and ready for independent review; no parity retry, deployment, controlled fallback, or acceptance window was entered.`

Completion criterion: the two checkpoints are verified and the executor stops without progressing to diagnosis or another operational gate.
