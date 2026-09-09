# Stage 1 p5 Evidence Amendment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` task-by-task. Do not delegate restricted evidence access or mutation.

**Goal:** Append one cryptographically bound p5 classification amendment and publish one byte-verified sanitized checkpoint to GitHub Issue #5.

**Architecture:** Preserve the original p5 row, append a closed-schema amendment under an exclusive POSIX lock, verify amendment-aware resolution, then publish one fixed public summary from a restricted temporary file.

**Tech Stack:** WSL, Python standard library, POSIX permissions and locks, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-09-09-stage1-p5-evidence-amendment-design.md`

## Global constraints

- Original p5 remains byte-identical with recorded `pass`; effective p5 becomes `evidence_incomparable`.
- Reason order is `reference_timed_out`, `reference_exit_nonzero`, `activation_reference_gate_failed`.
- Pairing record, backup, and temporary Issue body use mode 0600.
- Every WSL `uv` command sets `UV_PROJECT_ENVIRONMENT="$HOME/.cache/thoth-stage1-parity-uv/venv"` and uses `--frozen`.
- Output contains safe booleans, counts, enums, and public release identity only.
- No live request, retry, deployment, controlled fallback, acceptance window, or repository mutation is authorized.

---

### Task 1: Prove the reviewed misclassification

**Files:**
- Read: `/home/mfr/thoth-stage1-parity/pairing-record.jsonl`
- Read by known path: p5 `reference-attempt.json`
- Read: GitHub Issue `muhfalihr/Thoth#5`

**Interfaces:**
- Consumes: five samples, p3 amendment, p5 attempt record
- Produces: safe precondition booleans; no mutation

- [ ] **Step 1: Verify repository and venv state**

Require branch `codex/stage1-container-ci`, a clean worktree, and `92fa633163e88a352aeac74f2912c339bee44b03` as an ancestor. Inspect later commits and require documentation-only planning drift.

Verify Windows `python/.venv` reports `win32` and Python 3.11.15; capture its `pyvenv.cfg` checksum privately. Verify `/home/mfr/.cache/thoth-stage1-parity-uv/venv` reports Linux Python 3.12.

- [ ] **Step 2: Verify Issue idempotency**

Query Issue #5 and print only:

```text
issue_accessible=true
p5_correction_checkpoint_count=0
```

Count comments containing both `p5` and `evidence_incomparable`. Any existing correction stops this combined operation before evidence mutation.

- [ ] **Step 3: Validate the pairing record privately**

Require parent mode 0700, record mode 0600, terminal LF, five sample rows with IDs p1–p5 exactly once, one valid p3 amendment, no p5 amendment, effective p3/p4 incomparable, and original p5 `observation_id=null` plus `comparison_result="pass"`.

Require all recorded Python and Scout artifact booleans and all nine field results true. Do not print a row, dereference its fixture pointer, or open reports, media, or logs.

- [ ] **Step 4: Validate the p5 lifecycle evidence**

Resolve the private reference ID from the p5 row in memory and run:

```bash
UV_PROJECT_ENVIRONMENT="$HOME/.cache/thoth-stage1-parity-uv/venv" \
uv run \
  --project /mnt/c/Users/mfr/Documents/MyTools/CLIPPER/python \
  --frozen \
  python -m thoth_control_plane.operations.stage1_parity_attempt_summary \
  --sample "$HOME/thoth-stage1-parity/p5" \
  --reference-id "$PRIVATE_REFERENCE_ID"
```

Require `attempt_present=true`, `attempt_complete=true`, `reference_exit_nonzero=true`, and `cleanup_passed=true`. Privately require exit 124 and `timed_out=true` from the closed attempt record. Print booleans only.

Completion criterion: p5 is exactly the reviewed lifecycle misclassification, and no amendment or public correction exists.

---

### Task 2: Append one classification amendment

**Files:**
- Modify append-only: `/home/mfr/thoth-stage1-parity/pairing-record.jsonl`
- Create: one timestamped mode-0600 sibling backup

**Interfaces:**
- Consumes: exact raw p5 line and verified lifecycle
- Produces: one deterministic p5 amendment

- [ ] **Step 1: Construct the amendment under lock**

Use one Python standard-library process. Compute the raw p5-line hash and deterministic ID exactly as the spec defines. Construct fields in the spec's fixed order with:

```python
reason_codes = [
    "reference_timed_out",
    "reference_exit_nonzero",
    "activation_reference_gate_failed",
]
```

Serialize compact UTF-8 with one terminal LF.

- [ ] **Step 2: Back up and append once**

Keep one `fcntl.LOCK_EX` descriptor open for the entire operation. Revalidate predicates under lock. Create the sibling backup with `O_WRONLY | O_CREAT | O_EXCL`, mode 0600; write all source bytes, `fsync`, and verify equality. Recheck the source, then append with exactly one `os.write` through an `O_WRONLY | O_APPEND` descriptor. Require a full write, `fsync` the file and directory, and never retry a short write.

- [ ] **Step 3: Verify effective state**

Require:

```text
backup_created=true
backup_byte_identical=true
original_prefix_preserved=true
rows_added=1
sample_row_count=5
amendment_count=2
original_p5_result=pass
effective_p5_result=evidence_incomparable
effective_p3_result=evidence_incomparable
effective_p4_result=evidence_incomparable
p5_counts_as_parity=false
```

On post-append failure, preserve both files and stop without truncating, rewriting, or appending again.

Completion criterion: exactly one durable amendment exists and every prior byte is preserved.

---

### Task 3: Publish the sanitized Issue #5 checkpoint

**Files:**
- Temporary: `/home/mfr/thoth-stage1-parity/p5-issue5-correction.md`
- External write: one Issue #5 comment

**Interfaces:**
- Consumes: verified p5 amendment
- Produces: one immutable public comment URL

- [ ] **Step 1: Write the reviewed body**

Write this exact body without echoing it and require mode 0600:

```text
Stage 1 activation parity p5 — lifecycle classification correction

Release: `ghcr.io/muhfalihr/thoth@sha256:4cb1d7c51c3a112359f3ebfbb43e70b07f39937d7ce2bded904a1645c1f2d45c`
Implementation: `92fa633163e88a352aeac74f2912c339bee44b03`

The isolated activation pair was executed once. Python completed through the Python-native acquisition path after internal CDN recovery. The isolated Scout reference produced valid report and media artifacts, and the offline comparison found all nine authoritative fields equal.

The Scout reference nevertheless timed out and exited nonzero. Under the activation-reference lifecycle contract, safe reason `reference_timeout_nonzero_exit` cannot be classified as a passing reference. Artifact comparability does not override unsuccessful lifecycle completion.

The original restricted p5 row remains unchanged with its recorded `pass` value. One append-only amendment now makes the effective classification `evidence_incomparable`.

Consequences:
- p5 earns no activation-parity or in-window parity credit.
- The activation parity gate remains unpassed.
- No retry or replacement sample was performed.
- No deployment, controlled fallback, or acceptance window was started.
- Restricted evidence remains outside Git and is not embedded in this comment.
```

Require exactly one `sha256:<64 hex>` token equal to the public acquisition digest. Require the commit and safe correction terms. Reject case-insensitive occurrences of `http://`, `https://`, `tiktok.com`, `/home/`, `/mnt/`, `workflow_id`, `observation_id`, `reference_id`, `amendment_id`, `target_record_sha256`, `api_key`, `authorization`, `browser.log`, `stderr`, `stdout`, `captcha`, `owner_handle`, or `post_id`.

- [ ] **Step 2: Post once and reconcile safely**

Re-query Issue #5 and require zero p5 correction comments, then call exactly once:

```bash
gh issue comment 5 --repo muhfalihr/Thoth \
  --body-file "$HOME/thoth-stage1-parity/p5-issue5-correction.md"
```

Never automatically retry. For an uncertain response, perform one read-only reconciliation query; exactly one byte-equivalent body is success, otherwise stop.

- [ ] **Step 3: Verify exact body**

Fetch by comment ID and compare byte-for-byte, allowing only GitHub removal of one terminal LF. Print the public URL and safe booleans. Remove the temporary body only after exact verification. Never edit or delete the comment.

Completion criterion: exactly one byte-equivalent sanitized checkpoint exists.

---

### Task 4: Verify containment and stop

**Files:**
- Verify: pairing record, backup, Issue comment, venv separation, Git worktree

**Interfaces:**
- Consumes: completed restricted and public checkpoints
- Produces: independent-review handoff

- [ ] **Step 1: Re-run safe checks**

Require five sample rows, two valid amendments, original p5 `pass`, effective p5/p3/p4 incomparable, p5 parity credit false, prefix preservation true, and Issue body exact.

- [ ] **Step 2: Verify untouched state**

Require unchanged clean Git state and byte-identical Windows `pyvenv.cfg`. Do not inspect Docker. Confirm no fixture, live workflow, observation, aggregate, or later gate was touched.

- [ ] **Step 3: Report in Indonesian and stop**

End with:

```text
p5 evidence correction recorded; effective result is evidence_incomparable; activation parity remains unpassed; no retry, deployment, controlled fallback, or acceptance window entered.
```

Completion criterion: both checkpoints are verified and no additional diagnosis or gate begins.
