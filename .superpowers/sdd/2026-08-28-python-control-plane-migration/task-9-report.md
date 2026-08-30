# Task 9 implementation report

## Outcome

- Added the operator guide for the four-process local control-plane stack, v1 HTTP/SSE contract,
  authorization/approval semantics, redaction/artifact rules, safe environment handling, retry
  limitation, legacy adapter queue/cancellation behavior, and its exact retirement proof.
- Added a deterministic offline vertical smoke over the real FastAPI application,
  `TemporalWorkflowGateway`, Temporal time-skipping server, workflow and worker.
- Added the binding-spec artifact download endpoint. It first authorizes the workflow/actor and
  artifact reference, then resolves only the validated relative path beneath
  `THOTH_CONTROL_PLANE_ARTIFACT_ROOT`; it never exposes that storage path.
- Regenerated `python/openapi.json` and the checked-in dashboard v1 types.
- Preserved the design ruling that durable retry remains unavailable. A retryable failure means
  eligible for future checkpoint-policy evaluation; `POST .../retry` returns `503` today rather
  than risking duplicate side effects.

## TDD evidence

1. `rtk uv run pytest tests/integration/test_control_plane_smoke.py -q`
   initially exited `1`: collection reported missing fixture `control_plane`.
2. `rtk uv run pytest tests/api/test_workflows.py -q -k artifact_download`
   initially exited `1`: `Settings` rejected the then-missing
   `THOTH_CONTROL_PLANE_ARTIFACT_ROOT` field.
3. After the minimal endpoint/service/config seam, the focused artifact test exited `0`:
   `1 passed, 26 deselected`.
4. The first restart-capable smoke reached `awaiting_approval` but stalled after stopping the
   original test worker: Temporal's test server retained the workflow on that worker's sticky
   cache. The harness now sets `max_cached_workflows=0`, which makes the restart proof use the
   normal task queue rather than a dead sticky queue.
5. Fresh final smoke command exited `0` in `5.26s`. It covers submit, snapshot/ordered events,
   approval after API and worker restart, completion, owner-authorized artifact download and
   wrong-key `403`, retryable failure plus controlled retry `503`, running cancellation, and an
   assertion that every recorded HTTP path starts with `/api/v1/workflows` and none contains
   `/api/scout/`.

## Local live-smoke attempt

Bounded preflight on 2026-08-30 (Asia/Jakarta) checked only command/configuration presence and did
not print values:

- `Get-Command temporal` presence: `False`;
- `THOTH_CONTROL_PLANE_API_KEY` presence: `False`;
- `THOTH_LEGACY_API_BASE_URL` presence: `False`;
- `THOTH_LEGACY_API_KEY` presence: `False`.

Therefore no four-process provider/legacy live smoke was claimed or attempted beyond preflight.
The exact blockers are the absent Temporal development-server CLI and absent operator credentials.
The offline Temporal smoke above is automated evidence only; the operator guide explicitly keeps
the controlled live parity smoke as a legacy-adapter retirement requirement.

## Verification matrix

Run from `python/` unless another directory is named:

- `rtk uv sync --all-groups` — exit `0`; 51 packages resolved, 50 audited.
- `rtk uv run ruff check .` — exit `0`; all checks passed.
- `rtk uv run ruff format --check .` — exit `0`; 44 files already formatted.
- `rtk uv run pytest` — exit `0`; 105 tests collected and passed.
- `rtk bun --cwd dashboard run generate:control-plane-types` — exit `1`; installed Bun 1.3.14
  treated this argument order as invalid and printed usage. Equivalent command run from
  `dashboard/`, `rtk bun run generate:control-plane-types`, exited `0` and regenerated the client.
- `rtk bun test` from `dashboard/` — exit `0`; 50 passed, 0 failed, 148 assertions.
- `rtk bun run build` from `dashboard/` — exit `0`; TypeScript and Vite production build passed.
- `rtk bun run lint` from `dashboard/` — exit `0`; three existing warnings, no errors.
- `rtk cargo test -p thoth-server` — exit `0`; 129 passed, 101 filtered out.
- `rtk cargo test -p thoth-core` — exit `0`; 375 passed, 370 filtered out.
- `rtk cargo check --workspace` — exit `0`.
- `rtk cargo fmt --check` — exit `1`, the ledger-approved repository baseline. The output begins
  in pre-existing Rust files including `crates/thoth/src/main.rs` and spans unrelated Rust source
  and tests. No Rust file was changed or mass-formatted for Task 9.
- `rtk git diff --check` — exit `0`.

The existing untracked `docs/research/2026-08-28-python-framework-options.md` was left untouched,
and `progress.md` was not modified.
