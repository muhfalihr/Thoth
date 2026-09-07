# Stage 1 Accelerated Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Replace the fixed TikTok Stage 1 readiness defaults with the approved 24-hour, 12-valid-run, two-parity accelerated acceptance policy while preserving every existing safety and operator gate.

**Architecture:** Keep `TikTokSoakPolicy` as the executable numeric source of truth and retain report schema version 1 because each report embeds its policy. Update boundary-focused evaluator tests first, then update active operator documentation to point at the superseding design. Historical specifications and archived evidence remain immutable.

**Tech Stack:** Python 3.12, Pydantic, pytest, Ruff, Markdown, Docker documentation only

**Spec:** `docs/superpowers/specs/2026-09-07-stage1-accelerated-acceptance-design.md`

## Global Constraints

- The fixed defaults are exactly 1 day, 12 valid completed runs, and 2 parity samples.
- Success/fallback/failure rates remain 0.95, 0.05, and 0.02.
- Observation and aggregate report schemas remain version 1 with no new fields.
- The activation parity pair remains pre-window evidence and does not count toward the two in-window samples.
- A new window requires separate controlled-fallback and operator approvals.
- Archived datasets must not be reclassified using the new defaults.
- The deployed acquisition digest remains `ghcr.io/muhfalihr/thoth@sha256:9187c97f059b8fa55907aa481edc44c771f0ca060f87954c4c55d7ad0f1276af` unless a later operator-approved deployment replaces it.
- This plan is offline only: no TikTok/provider request, evidence mutation, deployment, restart, push, or window activation.
- Commit messages are one concise subject line with no body, trailer, or attribution.

---

### Task 1: Lock the accelerated evaluator boundaries with RED tests

**Files:**

- Modify: `python/tests/operations/test_tiktok_soak.py`

**Interfaces:**

- Consumes: `TikTokSoakPolicy` and `evaluate_tiktok_soak` from `thoth_control_plane.operations.tiktok_soak`
- Produces: executable boundary expectations for the accelerated policy

- [ ] **Step 1: Change the fixed-default assertions**

Update the existing policy-default test to require:

```python
def test_policy_defaults_match_fixed_stage1_thresholds() -> None:
    policy = TikTokSoakPolicy()

    assert policy.minimum_window_days == 1
    assert policy.minimum_valid_completed_runs == 12
    assert policy.minimum_parity_samples == 2
    assert policy.minimum_python_native_success_rate == 0.95
    assert policy.maximum_legacy_fallback_rate == 0.05
    assert policy.maximum_terminal_failure_rate == 0.02
```

- [ ] **Step 2: Change the time-window fixtures and assertions**

Set the ready duration to 24 hours and update every assertion or boundary case that represents the fixed policy:

```python
_READY_WINDOW = timedelta(hours=24)
```

Required failing and passing cases:

```python
window_at(hours=23, minutes=59, seconds=59)  # insufficient_window
window_at(hours=24, minutes=0, seconds=0)    # window threshold passes
```

Keep tests whose purpose is rate-boundary evaluation at a sufficiently large denominator. Do not change 0.95/0.05/0.02 to make a 12-run mixed-route fixture pass.

- [ ] **Step 3: Change run-count and parity-count helpers at policy boundaries**

Use a 12-native-run dataset for count-boundary tests and default two passing parity observations:

```python
def parity_samples(count: int) -> list[TikTokSoakObservation]:
    return _dataset(["native"] * 12, parity_true=count)
```

Required cases:

```python
completed_runs(11)  # insufficient_valid_completed_runs
completed_runs(12)  # run-count threshold passes
parity_samples(1)   # insufficient_parity_samples
parity_samples(2)   # parity threshold passes
```

- [ ] **Step 4: Run focused tests and confirm RED for the intended reason**

Run:

```bash
cd python
uv run python -m pytest tests/operations/test_tiktok_soak.py -q
```

Expected: failures show the implementation still supplies `7`, `50`, and `5`; unrelated schema, cleanup, rate, or redaction tests must not fail.

Completion criterion: the accelerated boundary tests are present and fail only because production defaults still use the previous thresholds.

### Task 2: Implement the minimal policy-default change

**Files:**

- Modify: `python/src/thoth_control_plane/operations/tiktok_soak.py`
- Test: `python/tests/operations/test_tiktok_soak.py`

**Interfaces:**

- Consumes: existing `TikTokSoakPolicy` fields and evaluator behavior
- Produces: `TikTokSoakPolicy()` with accelerated defaults; no schema or API changes

- [ ] **Step 1: Change only the three numeric defaults**

Implement:

```python
class TikTokSoakPolicy(StrictModel):
    schema_version: Literal[1] = 1
    minimum_window_days: Annotated[int, Field(ge=1)] = 1
    minimum_valid_completed_runs: Annotated[int, Field(ge=1)] = 12
    minimum_parity_samples: Annotated[int, Field(ge=1)] = 2
    minimum_python_native_success_rate: Annotated[float, Field(ge=0, le=1)] = 0.95
    maximum_legacy_fallback_rate: Annotated[float, Field(ge=0, le=1)] = 0.05
    maximum_terminal_failure_rate: Annotated[float, Field(ge=0, le=1)] = 0.02
```

Do not add policy profiles, CLI overrides, observation fields, report fields, or migration code.

- [ ] **Step 2: Run the focused evaluator suite**

Run:

```bash
cd python
uv run python -m pytest tests/operations/test_tiktok_soak.py -q
```

Expected: all tests pass.

- [ ] **Step 3: Inspect the diff for accidental policy changes**

Run:

```bash
git diff -- python/src/thoth_control_plane/operations/tiktok_soak.py python/tests/operations/test_tiktok_soak.py
```

Expected: only the three defaults, fixed-policy fixtures, descriptions, and threshold assertions change. Rate, cleanup, redaction, uniqueness, and blocker logic remain untouched.

- [ ] **Step 4: Commit the evaluator change**

```bash
git add python/src/thoth_control_plane/operations/tiktok_soak.py python/tests/operations/test_tiktok_soak.py
git commit -m "feat: accelerate stage1 acceptance thresholds"
```

Completion criterion: focused tests pass and the commit contains no unrelated behavior.

### Task 3: Align active operational documentation

**Files:**

- Modify: `docs/python-control-plane.md`
- Modify: `docs/operations/stage1-local-docker.md`
- Modify: `docs/operations/stage1-parity-sampling.md`
- Modify: `docs/python-scout-migration-roadmap.md`
- Reference: `docs/superpowers/specs/2026-09-07-stage1-accelerated-acceptance-design.md`

**Interfaces:**

- Consumes: the accelerated policy and existing Stage 1 gate sequence
- Produces: one consistent operator path from activation gates through human cutover

- [ ] **Step 1: Update the control-plane policy reference**

In `docs/python-control-plane.md`:

- replace active `7 days / 168 hours / 50 / 5` instructions with `24 hours / 12 / 2`;
- retain the existing success, fallback, failure, cleanup, and human-approval rules;
- link the superseding accelerated-acceptance design;
- state that archived reports retain their embedded original policy.

- [ ] **Step 2: Update the local Docker activation sequence**

In `docs/operations/stage1-local-docker.md`:

- keep the isolated activation parity and controlled fallback as separately approved pre-window gates;
- state that the activation parity pair is not one of the two in-window parity samples;
- require explicit operator approval before creating the accelerated dataset;
- add the 24-hour, 12-run, two-parity completion target;
- retain restart-recovery, rollback, and human approval as external gates.

- [ ] **Step 3: Update parity sampling completion language**

In `docs/operations/stage1-parity-sampling.md`:

- require two separately identified in-window parity samples;
- require distinct approved, public, first-party TikTok posts;
- replace seven-day/fifty-run scheduling text with 24-hour/twelve-run guidance;
- preserve all containment, artifact, no-retry, authentication-stop, and restricted-evidence rules.

- [ ] **Step 4: Update the migration roadmap status**

In `docs/python-scout-migration-roadmap.md`, identify accelerated acceptance as the active Stage 1 cutover policy and link its design and plan. Do not mark Python-only or legacy retirement complete.

- [ ] **Step 5: Scan active documentation for stale thresholds**

Run:

```bash
rg -n "168 hours|7 days|seven-day|50 valid|fifty valid|five parity|five separately" \
  docs/python-control-plane.md \
  docs/operations/stage1-local-docker.md \
  docs/operations/stage1-parity-sampling.md \
  docs/python-scout-migration-roadmap.md
```

Expected: no active-policy statement still presents the previous thresholds. Historical references may describe the superseded policy only when clearly labelled historical.

- [ ] **Step 6: Commit the documentation update**

```bash
git add docs/python-control-plane.md docs/operations/stage1-local-docker.md docs/operations/stage1-parity-sampling.md docs/python-scout-migration-roadmap.md
git commit -m "docs: document accelerated stage1 acceptance"
```

Completion criterion: all active operator documents state the same thresholds, evidence boundary, and gate order.

### Task 4: Run the offline release-policy verification

**Files:**

- Verify: all files modified by Tasks 1-3

**Interfaces:**

- Consumes: completed evaluator and documentation changes
- Produces: reviewable offline evidence and a clean handoff before push

- [ ] **Step 1: Run Python tests**

```bash
uv run --project python python -m pytest python/tests/operations/test_tiktok_soak.py -q
uv run --project python python -m pytest python/tests -q
```

Expected: zero failures. Existing environment-specific skips must be reported exactly.

- [ ] **Step 2: Run Ruff checks**

```bash
uv run --project python ruff check python
uv run --project python ruff format --check python
```

Expected: both commands exit zero.

- [ ] **Step 3: Run repository integrity checks**

```bash
git diff --check
git status --short
git log --oneline -5
```

Expected: no whitespace errors; only intentionally uncommitted operator-owned files, if any, remain. Do not absorb unrelated changes.

- [ ] **Step 4: Verify scope and hard stops**

Confirm from command history and final state:

- no Docker service was restarted or recreated;
- no TikTok or provider request ran;
- no observation, pairing record, aggregate report, or restricted evidence changed;
- no soak or acceptance window was opened;
- no push or image publication occurred.

- [ ] **Step 5: Stop for independent review**

Return a concise Indonesian report containing:

- baseline and final commits;
- files changed per commit;
- RED and GREEN focused-test evidence;
- full Python and Ruff results;
- exact accelerated defaults;
- confirmation unchanged rate and safety gates;
- documentation consistency scan;
- hard-stop confirmation;
- any limitations or skipped tests;
- next checkpoint: independent review before push.

Completion criterion: the corrective implementation is committed locally, verified offline, and no later operational gate has been entered.

