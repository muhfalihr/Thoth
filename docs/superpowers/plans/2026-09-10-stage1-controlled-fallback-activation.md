# Stage 1 Controlled Fallback Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an offline-verified, fail-closed operator harness for one deterministic controlled
legacy fallback activation exercise against an explicitly authorized deployed digest.

**Architecture:** A Python operation owns preflight, Docker orchestration, safe result
classification, atomic evidence, and cleanup. A small Compose overlay defines the one-shot
production supervisor container, while a separate internal-network Docker harness proves the
orchestration without TikTok or provider access. Existing parity artifact helpers are deepened into
a reusable one-sided Scout artifact validator.

**Tech Stack:** Python 3.12+, Pydantic, Typer, Docker Compose, Bun/TypeScript Scout runtime, pytest.

**Spec:**
`docs/superpowers/specs/2026-09-10-stage1-controlled-fallback-activation-design.md`

## Global Constraints

- Implementation and verification are offline only; no TikTok, CDN, or model-provider request.
- Docker is the only container runtime. Do not add or use Podman support.
- Do not read `/home/mfr/thoth-stage1-fallback/f1/url.txt`, any p1-p6 fixture, or the provider file.
- Do not inspect or mutate restricted parity/fallback evidence during implementation.
- Do not pull, restart, recreate, or otherwise change the deployed Stage 1 stack.
- Preserve `.env.stage1.local`, deployed digest `sha256:0bc3d00c...d2400d6e`, worker mode,
  persistent volumes, observations, S3, and Issue #5.
- Do not run the live CLI subcommand added by this plan.
- Safe console output contains fixed field names, booleans, counts, and status codes only.
- Commits contain one concise subject line and no body or `Co-Authored-By` trailer.
- Stop after offline verification and local commits. Push, live `f1`, evidence mutation, controlled
  fallback execution, and acceptance-window activation require later operator authorization.

---

### Task 1: Extract reusable Scout artifact integrity validation

**Files:**
- Modify: `python/src/thoth_control_plane/operations/tiktok_parity.py`
- Modify: `python/tests/operations/test_tiktok_parity.py`

**Interfaces:**
- Produces: `ScoutArtifactMeasurement(report_checksum: str, media_checksum: str, media_bytes: int)`.
- Produces: `measure_scout_reference_artifact(report_path: Path, artifact_root: Path, *,
  recorded_root: str = DEFAULT_SCOUT_RECORDED_ROOT) -> ScoutArtifactMeasurement`.
- Produces: `validate_scout_reference_artifact(report_path: Path, artifact_root: Path,
  expected: ScoutArtifactMeasurement, *, recorded_root: str = DEFAULT_SCOUT_RECORDED_ROOT)
  -> ArtifactIntegrity`.
- Preserves: `compare_parity_sample()` behavior and all existing parity output.

- [ ] **Step 1: Write focused failing tests for one-sided measurement and validation**

Add tests that construct a minimal Scout report plus MP4-like media beneath `tmp_path`, call the
two new functions, and assert:

```python
measurement = measure_scout_reference_artifact(report, artifact_root)
integrity = validate_scout_reference_artifact(report, artifact_root, measurement)
assert integrity.passed is True
```

Add separate cases for report escape, symlinked media escape, missing media, invalid `ftyp`, media
below `MINIMUM_MEDIA_BYTES`, changed bytes, and changed report. Assert only fixed safe exceptions or
boolean fields; never assert a path or checksum in rendered output.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```powershell
cd python
uv run python -m pytest tests/operations/test_tiktok_parity.py -q
```

Expected: failure because `ScoutArtifactMeasurement`, `measure_scout_reference_artifact`, and
`validate_scout_reference_artifact` do not exist.

- [ ] **Step 3: Implement the minimal reusable boundary**

Make the existing private Scout report parser return the contained media path without exposing it.
Measure report/media with `file_checksum()` and `Path.stat().st_size`. Validation must resolve the
media again from the report, call the existing `_validate_integrity()`, and compare against the
provided measurement. Preserve Pydantic report validation and symlink-safe containment.

Do not add a second Scout schema parser or duplicate MP4/signature rules.

- [ ] **Step 4: Run focused and parity regression tests**

Run:

```powershell
uv run python -m pytest tests/operations/test_tiktok_parity.py tests/live/test_tiktok_acquisition_live.py -q
```

Expected: PASS; live-marked tests remain deselected/skipped by repository configuration and no
network call occurs.

- [ ] **Step 5: Commit Task 1**

```powershell
git add python/src/thoth_control_plane/operations/tiktok_parity.py python/tests/operations/test_tiktok_parity.py
git commit -m "refactor: expose Scout artifact validation"
```

---

### Task 2: Implement fail-closed inputs and append-only evidence

**Files:**
- Create: `python/src/thoth_control_plane/operations/stage1_controlled_fallback.py`
- Create: `python/tests/deployment/test_stage1_controlled_fallback.py`

**Interfaces:**
- Produces: `GATE_ID = "f1"`, `ATTEMPT_NAME`, `PRIVATE_INTEGRITY_NAME`, and `INDEX_NAME` constants.
- Produces: `check_controlled_fallback_inputs(image: str, sample: Path, provider: Path, *,
  repository_root: Path, data_root: Path, parity_root: Path) -> None`.
- Produces: frozen models `ControlledFallbackFacts`, `ControlledFallbackAttempt`, and
  `PrivateArtifactIntegrity` with exactly the spec fields.
- Produces: `reserve_attempt(sample: Path, *, digest: str, acquisition_revision: str,
  harness_revision: str, occurred_at: datetime) -> None`.
- Produces: `classify_attempt(facts: ControlledFallbackFacts) -> Literal["passed", "failed",
  "inconclusive"]`.
- Produces: `finalize_attempt(sample: Path, facts: ControlledFallbackFacts,
  integrity: PrivateArtifactIntegrity) -> ControlledFallbackAttempt`.
- Produces: `append_index(root: Path, attempt: ControlledFallbackAttempt) -> None`.

- [ ] **Step 1: Write RED preflight tests**

Cover exact digest format; absolute sample outside repository, deployment root, and parity root;
gate directory/name `f1`; directory mode `0700`; regular mode-`0600` `url.txt`; canonical TikTok
post URL; byte-distinct comparison with every existing `p*/url.txt`; no symlink anywhere; provider
preflight reuse; absent attempt/private-integrity files; and absent `f1` sample/amendment row in the
index. On Windows, mark POSIX-mode/symlink cases consistently with existing deployment tests and
run them again on WSL ext4 later.

Every error message must be selected from a fixed value-free set.

- [ ] **Step 2: Write RED evidence lifecycle and verdict tests**

Test exclusive pending reservation, mode `0600`, refusal to overwrite, temporary-file plus
`os.replace()` finalization, exact safe JSON keys, private integrity separation, one-line append,
duplicate sample refusal, and amendment-aware index scanning.

Use a parametrized precedence matrix proving:

```text
cleanup/teardown failure > health/restart/target failure > artifact failure > supervisor status
```

Assert `temporary_target_observed=false` does not fail an otherwise complete pass. Assert an
unrecoverable terminal-status loss classifies `inconclusive` and never `passed`.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```powershell
cd python
uv run python -m pytest tests/deployment/test_stage1_controlled_fallback.py -q
```

Expected: import failure because the operation module does not exist.

- [ ] **Step 4: Implement preflight, models, reservation, finalization, and append**

Reuse `IMAGE_PATTERN`, `Stage1PreflightError`, `canonicalize_tiktok_post_url`,
`check_stage1_provider_file`, and the repository's existing amendment-aware JSONL parsing pattern.
Read parity fixtures only during a future authorized preflight; tests use synthetic files. Compare
fixture bytes with `hmac.compare_digest()` and emit only `fixture_distinct=true/false`.

Use exclusive creation for the pending record, `os.open(..., 0o600)` for private files, `fsync()`
before replace/append, and no permissive default umask assumptions. The attempt model rejects extra
fields so raw diagnostics cannot be added accidentally.

- [ ] **Step 5: Run focused tests on Windows and WSL ext4**

Run Windows:

```powershell
uv run python -m pytest tests/deployment/test_stage1_controlled_fallback.py -q
```

Run Linux without touching the repository venv:

```bash
cd /mnt/c/Users/mfr/Documents/MyTools/CLIPPER
UV_PROJECT_ENVIRONMENT="$HOME/.cache/thoth-stage1-parity-uv/venv" \
  uv run --project python python -m pytest \
  python/tests/deployment/test_stage1_controlled_fallback.py -q
```

Expected: all tests pass; Linux-only mode/symlink cases execute rather than skip.

- [ ] **Step 6: Commit Task 2**

```powershell
git add python/src/thoth_control_plane/operations/stage1_controlled_fallback.py python/tests/deployment/test_stage1_controlled_fallback.py
git commit -m "feat: add controlled fallback evidence contract"
```

---

### Task 3: Add deterministic Docker orchestration and guarded CLI

**Files:**
- Create: `python/src/thoth_control_plane/operations/stage1_controlled_fallback_runner.py`
- Modify: `python/src/thoth_control_plane/cli.py`
- Modify: `python/tests/deployment/test_stage1_controlled_fallback.py`
- Modify: `python/tests/test_cli.py`

**Interfaces:**
- Produces: `CommandResult(returncode: int, stdout: bytes, stderr: bytes)`.
- Produces: `CommandExecutor` protocol with `run(argv: Sequence[str], *, env: Mapping[str, str],
  timeout: float | None = None) -> CommandResult` and a bounded detached-container wait method.
- Produces: `ControlledFallbackRunConfig` containing only repository/sample/provider paths, exact
  digest/revisions, Compose files, and time budgets.
- Produces: `ControlledFallbackRunner.preflight() -> None` and
  `ControlledFallbackRunner.run_once() -> ControlledFallbackAttempt`.
- Produces CLI commands `stage1-controlled-fallback-preflight` and
  `stage1-controlled-fallback-run`.

- [ ] **Step 1: Write RED command-boundary tests with a fake executor**

The fake executor records argv/environment and returns synthetic Docker JSON. Test that preflight:

- invokes only allowlisted `docker compose config --quiet`, `config --images`, `ps`, and
  `docker inspect` commands;
- verifies all three THOTH roles use the configured digest and OCI revision;
- requires API/CDP/Temporal/PostgreSQL health, worker running, zero active Temporal workflows,
  worker mode, UID `10001`, provider-ready booleans, and zero published CDP bindings; and
- rejects a dirty deployment baseline before reservation.

Assert no captured argv/environment/output contains synthetic URL, provider secret, target ID, or
WebSocket canaries.

- [ ] **Step 2: Write RED one-shot lifecycle tests**

Drive `run_once()` through success, child nonzero, timeout, signal, target mismatch, health loss,
restart drift, log-copy failure, container-removal failure, and executor exception. Assert this
order:

1. reserve pending attempt;
2. create a no-network, non-privileged staging helper from the exact digest;
3. create `reference-input/url` as `10001:10001` mode `0400` beneath mode `0500`;
4. start exactly one detached gate service;
5. poll private CDP through the deployed worker without printing discovery values;
6. wait once for terminal status;
7. capture logs directly into mode-`0600` files;
8. measure and revalidate the Scout artifact;
9. remove gate container and staged fixture;
10. verify postconditions;
11. finalize the attempt and append the index.

All exception/cancellation branches must execute steps 7-10 within bounded cleanup. Cleanup failure
must override a child zero status.

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```powershell
cd python
uv run python -m pytest \
  tests/deployment/test_stage1_controlled_fallback.py tests/test_cli.py -q
```

Expected: failure because the runner and CLI commands do not exist.

- [ ] **Step 4: Implement the command executor and orchestrator**

Use `subprocess` with argument arrays and `shell=False`. Give every Docker call a fixed timeout.
Parse `docker inspect` JSON in memory. The CDP probe may hold target IDs/URLs only in memory to
compare baseline/final identity; render booleans and counts only. Never write probe payloads.

The staging helper command must use the pinned image with `--network none`, `--user 0:0`, no
provider env, and only the sample bind mount. It performs fixed `install/chown/chmod` operations and
exits before the live container starts. It is not privileged and receives no Docker socket.

The production container command comes only from the Compose overlay. The runner supplies path and
digest variables but never the fixture value. Treat authorization as consumed immediately after
Docker reports the gate container created/started.

- [ ] **Step 5: Implement guarded CLI commands**

`stage1-controlled-fallback-preflight` performs input/deployment checks and prints fixed booleans.
`stage1-controlled-fallback-run` requires literal `--gate-id f1` and calls `run_once()`. Its final
console output is only:

```text
controlled_fallback_completed=true|false
verdict=passed|failed|inconclusive
```

The CLI never prints a Docker error, child output, fixture value, evidence path, container ID, or
provider value. Do not call the live command during this implementation round.

- [ ] **Step 6: Run focused tests and CLI help only**

Run:

```powershell
uv run python -m pytest \
  tests/deployment/test_stage1_controlled_fallback.py tests/test_cli.py -q
uv run thoth-control operations stage1-controlled-fallback-preflight --help
uv run thoth-control operations stage1-controlled-fallback-run --help
```

Expected: tests and help exit zero. Do not supply real arguments to either command.

- [ ] **Step 7: Commit Task 3**

```powershell
git add python/src/thoth_control_plane/operations/stage1_controlled_fallback_runner.py python/src/thoth_control_plane/cli.py python/tests/deployment/test_stage1_controlled_fallback.py python/tests/test_cli.py
git commit -m "feat: orchestrate controlled fallback gate"
```

---

### Task 4: Define production Compose overlay and offline Docker proof

**Files:**
- Create: `compose.stage1.controlled-fallback.yml`
- Create: `compose.stage1.controlled-fallback-smoke.yml`
- Create: `docker/test-controlled-fallback-offline.sh`
- Modify: `python/tests/deployment/test_container_contract.py`
- Modify: `.github/workflows/container-image.yml`

**Interfaces:**
- Production service name: `controlled-fallback`.
- Required variables: `THOTH_CONTROLLED_FALLBACK_IMAGE`,
  `THOTH_CONTROLLED_FALLBACK_SAMPLE_DIR`, and `THOTH_STAGE1_PROVIDER_ENV_FILE`.
- Fixed CDP endpoint: `http://legacy-cdp:18800`.
- Fixed mounted paths: `/run/controlled-fallback/url` and
  `/run/controlled-fallback/output`.

- [ ] **Step 1: Write RED static container-contract tests**

Assert the production overlay:

- pins the service image through the dedicated digest variable;
- runs as `10001:10001`, `restart: "no"`, and joins only `stage1-private`;
- has no `ports`, `privileged`, capabilities, Docker socket, deployment artifact root, browser
  profile, or persistent volume;
- mounts the staged fixture read-only and output directory writable with
  `create_host_path: false`;
- attaches the existing provider file and fixes `THOTH_CDP` to the private service;
- reads the fixture inside the container and invokes
  `bun scout/runtime/legacy_fallback.ts --url ... --out ...` exactly once; and
- never contains a real URL or credential.

Assert the smoke overlay uses an internal test-owned network and the existing
`legacy_fallback.ts --offline-smoke` path.

- [ ] **Step 2: Run the contract test and confirm RED**

Run:

```powershell
cd python
uv run python -m pytest tests/deployment/test_container_contract.py -q
```

Expected: failure because the overlays and harness do not exist.

- [ ] **Step 3: Implement the production and smoke overlays**

The production command is a fixed `/bin/sh -c` script that reads only
`/run/controlled-fallback/url` and expands the value solely inside the container process:

```sh
exec bun scout/runtime/legacy_fallback.ts \
  --url "$(cat /run/controlled-fallback/url)" \
  --out /run/controlled-fallback/output/source-report.json
```

The URL therefore stays out of host shell history, Compose argv, Docker create requests, and
container configuration, while remaining visible in the inner Bun process argv as documented.

- [ ] **Step 4: Implement the offline Docker harness**

Follow ownership/teardown patterns in `docker/test-cdp-offline.sh`. Use a unique project name,
`mktemp -d`, internal network, trap-based bounded teardown, and the published/candidate image passed
as the only argument. Exercise success, injected child failure, and cleanup. Emit only fixed
booleans:

```text
preflight_contract=true
temporary_target_observed=true
health_target_preserved=true
success_target_removed=true
failure_target_removed=true
teardown_leaves_nothing=true
```

The synthetic browser opens only `about:blank`; no fixture/provider file is mounted and no public
network request is possible.

- [ ] **Step 5: Add the offline harness to CI**

Run it in the existing non-live stack smoke job against the just-published digest, after private CDP
transport verification and before stack teardown. Preserve the PR/push job split and existing
failure-log policy.

- [ ] **Step 6: Run Compose rendering and Docker proof locally**

Build with Docker through WSL, never Podman:

```bash
cd /mnt/c/Users/mfr/Documents/MyTools/CLIPPER
docker build --platform linux/amd64 --tag thoth-stage1:controlled-fallback-corrective .
bash docker/test-controlled-fallback-offline.sh thoth-stage1:controlled-fallback-corrective
```

Also run existing harnesses:

```bash
bash docker/test-cdp-offline.sh thoth-stage1:controlled-fallback-corrective
bash docker/test-parity-offline.sh thoth-stage1:controlled-fallback-corrective
```

Expected: every fixed boolean is true and no test-owned container/network/volume remains. This is
offline proof only; do not use `.env.stage1.local` or the deployed Compose project.

- [ ] **Step 7: Commit Task 4**

```powershell
git add compose.stage1.controlled-fallback.yml compose.stage1.controlled-fallback-smoke.yml docker/test-controlled-fallback-offline.sh python/tests/deployment/test_container_contract.py .github/workflows/container-image.yml
git commit -m "test: prove controlled fallback orchestration"
```

---

### Task 5: Document the operator contract and close the offline audit trail

**Files:**
- Modify: `docs/operations/stage1-local-docker.md`
- Modify: `docs/python-control-plane.md`
- Modify: `BLUEPRINT.md`

**Interfaces:**
- Consumes: CLI and Compose names from Tasks 2-4 exactly.
- Produces: an operator sequence that separates preflight, single-use authorization, execution,
  result review, Issue #5 checkpoint, parity gate, and acceptance-window authorization.

- [ ] **Step 1: Add contract tests for required runbook wording**

Extend `python/tests/deployment/test_container_contract.py` to require the exact fixture/evidence
locations, residual inner-process argv exposure, pass/fail requirements, no-retry rule, and explicit
claim boundary that supervisor activation is not Python-routing evidence.

- [ ] **Step 2: Run the documentation contract test and confirm RED**

Run:

```powershell
cd python
uv run python -m pytest tests/deployment/test_container_contract.py -q
```

Expected: failure because the runbook does not yet contain the executable contract.

- [ ] **Step 3: Update the runbook and architecture documentation**

Add commands for offline preflight and the future authorized live invocation, but label the live
command as an operator gate. Document `f1` staging-copy ownership, evidence modes, raw-log handling,
atomic attempt/index records, cleanup precedence, and the distinction between this activation gate
and end-to-end Temporal routing.

Update `BLUEPRINT.md` only after all executable offline gates pass. Record actual commits, test
counts, image identity, harness results, and limitations. Do not state that `f1` ran or that the
acceptance window opened.

- [ ] **Step 4: Run the complete offline verification matrix**

Windows:

```powershell
cd C:\Users\mfr\Documents\MyTools\CLIPPER\scout
bun run test:runtime
bun run test:acquisition
bun run typecheck

cd C:\Users\mfr\Documents\MyTools\CLIPPER\python
uv run python -m pytest -q
uv run ruff check .
uv run ruff format --check .

cd C:\Users\mfr\Documents\MyTools\CLIPPER
git diff --check
```

Linux POSIX-focused tests:

```bash
cd /mnt/c/Users/mfr/Documents/MyTools/CLIPPER
UV_PROJECT_ENVIRONMENT="$HOME/.cache/thoth-stage1-parity-uv/venv" \
  uv run --project python python -m pytest \
  python/tests/deployment/test_stage1_controlled_fallback.py -q
```

Docker harnesses are those from Task 4. Confirm repository tests do not access the real fixture,
provider file, deployment project, or restricted evidence.

- [ ] **Step 5: Run final drift and security review**

Verify:

```powershell
git diff --check
git status --short
git log --format="%h %s" c61f5789c1ad702b11b025b6ce99a5ba7afef9ff..HEAD
git diff --stat c61f5789c1ad702b11b025b6ce99a5ba7afef9ff..HEAD
```

Inspect every Docker command for `shell=False` or fixed in-container expansion; inspect all safe
JSON/console paths for fixture, secret, target, URL, checksum, path, container-ID, and raw-error
leakage. Confirm `.env.stage1.local`, deployment, evidence, and Issue #5 were untouched.

- [ ] **Step 6: Commit Task 5**

```powershell
git add docs/operations/stage1-local-docker.md docs/python-control-plane.md BLUEPRINT.md python/tests/deployment/test_container_contract.py
git commit -m "docs: define controlled fallback gate"
```

---

## Executor stopping point

Stop after the local commits and complete offline report. Do not push, deploy, call the live CLI,
stage the real fixture, mutate evidence, post Issue #5, run parity, or open the acceptance window.
The next operator checkpoint is independent review of the offline corrective. A later prompt must
separately authorize push/CI, and a still later prompt must explicitly authorize one `f1` run.
