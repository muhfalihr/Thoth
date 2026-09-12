# Task 7 Report: Full Audit Trail

## Status

Completed after the independently reviewed Python assertion correction at
`901b9d8b7c6921860cddcffc3ea4aa35b535c6b0`. The earlier blocked attempts are
retained below; the resumed audit reran every required gate from the start.

## Baseline and final checkpoint

- Worktree: `C:\Users\mfr\Documents\MyTools\CLIPPER\.worktrees\creator-studio-guided-editing`
- Branch: `codex/creator-studio-guided-editing`
- Baseline SHA: `91400062e266203bf632e2ba969f6cab8f7049cc`
- Resumed-audit baseline SHA: `901b9d8b7c6921860cddcffc3ea4aa35b535c6b0`
- Final SHA: `47f40bc6d4ffaff58045626105050bd469ea26d8`
- Baseline `rtk git status --short --untracked-files=all`: no output.
- Final `rtk git status --short --untracked-files=all`: no output.

## Gate commands and results

1. Initial full offline Python invocation:

   ```text
   rtk uv run --project python pytest -m "not live" -q
   ```

   Result: exit 1 before collection. RTK flattened the quoted marker expression
   into the expression `not` plus a stray `live` path. A narrowed diagnostic:

   ```text
   rtk err uv run --project python pytest -m "not live" --lf -vv -x
   ```

   exited 1 with `ERROR: file or directory not found: live` and
   `run-last-failure: None`.

2. Single root-cause hypothesis test, invoked from Git Bash so the escaped
   space reached RTK as one equals-form argument:

   ```text
   rtk uv run --project python pytest -m=not\ live -q
   ```

   Result: pytest executed through 100% and exited 1 after 24.38 seconds:
   `1 failed, 747 passed, 31 skipped, 3 deselected, 19 warnings`. The failing
   test was
   `python/tests/activities/test_legacy_scout.py::test_no_fastapi_request_model_exposes_activity_mode`.
   It expected the request-schema set to contain only `ApprovalSubmission`,
   `ContentSetImportRequest`, `RetryRequest`, and `WorkflowRequest`; the actual
   set additionally contained `EditDocumentPatch`.

3. Python Ruff check: not run because the full Python suite failed.
4. Python Ruff format check: not run because the full Python suite failed.
5. Python lock check: not run because the full Python suite failed.
6. OpenAPI export and generated-client zero-diff check: not run because the
   first gate failed.
7. Full Bun test, lint, and build: not run because the first gate failed.
8. `rtk cmd.exe /c ".\build_cuda.bat build_log.txt 2>&1"`: not run because the
   first gate failed.

## Protected paths

Both checks were performed read-only in the main workspace before and after
the failed gate. Their untracked status, content hashes, lengths, and UTC write
times were unchanged:

- `compose.stage1.controlled-fallback.yml`
  - status: `??`
  - hash: `3631f1e234204522d02807d086e7b487c82cabe3`
  - length: 2,048 bytes
  - last write: 2026-09-10 15:17:40 UTC
- `docs/research/2026-09-10-programmable-video-editing-remotion-hyperframes.md`
  - status: `??`
  - hash: `bf2966c4ccd54db9d9950ed276335fccab9aab1b`
  - length: 20,714 bytes
  - last write: 2026-09-10 16:10:41 UTC

## BLUEPRINT and commit

- `rtk git diff -- BLUEPRINT.md`: no output after the failed gate.
- No audit trail was appended because not all gates passed.
- The required `docs: record guided editing core` commit was not created.

## Resumed audit evidence

The first direct `shell=` delivery of the established marker form was stripped
by the command adapter and exited 4 in 0.56 seconds with
`ERROR: file or directory not found: live`; it executed no tests. The same
inner command was then delivered through PowerShell to Git Bash, the transport
already proven by the earlier hypothesis run:

1. `rtk uv run --project python pytest -m=not\ live -q` — full suite reached
   completion and exited 0.
2. `rtk uv run --project python ruff check python/src python/tests` — exit 0,
   `All checks passed!`.
3. `rtk uv run --project python ruff format --check python/src python/tests` —
   exit 0, `94 files already formatted`.
4. `rtk uv lock --check` from `python` — exit 0,
   `Resolved 76 packages in 2ms`.
5. `rtk uv run python scripts/export_openapi.py` from `python` — exit 0.
6. `rtk bun --cwd=dashboard run generate:control-plane-types` — exit 0 with
   `openapi-typescript 7.13.0`.
7. `rtk git diff --exit-code -- python/openapi.json dashboard/src/api/generated/control-plane.ts`
   — exit 0 with no output, proving zero generated drift.
8. `rtk bun --cwd=dashboard test` — exit 0: 69 passed, 0 failed, 215
   assertions across 13 files. The existing React `act(...)` diagnostics and
   Remotion browser warnings were still printed.
9. `rtk bun --cwd=dashboard run lint` — exit 0 with the existing warnings in
   `Discovery.tsx`, `button.tsx`, and `badge.tsx`.
10. `rtk bun --cwd=dashboard run build` — exit 0; TypeScript and Vite completed,
    with the existing 733.76 kB chunk-size advisory.
11. `rtk cmd.exe /c ".\build_cuda.bat build_log.txt 2>&1"` from the repository
    root — exit 0; the final output reported
    `Finished release profile [optimized]`.

## Final protected-path proof

The main-workspace paths remained untracked before and after all resumed gates,
the BLUEPRINT edit, and the commit. Their hashes, lengths, and UTC write times
were unchanged:

- `compose.stage1.controlled-fallback.yml` —
  `3631f1e234204522d02807d086e7b487c82cabe3`, 2,048 bytes,
  2026-09-10 15:17:40 UTC.
- `docs/research/2026-09-10-programmable-video-editing-remotion-hyperframes.md`
  — `bf2966c4ccd54db9d9950ed276335fccab9aab1b`, 20,714 bytes,
  2026-09-10 16:10:41 UTC.

## BLUEPRINT and commit

- `BLUEPRINT.md` gained an eight-line English audit entry covering the typed
  operation union, positive revisions and schema v1, atomic PATCH/409 behavior,
  autosave, conflict recovery, accessibility, verified gates, and excluded
  work.
- `rtk git diff --check` and `rtk git diff --cached --check` exited 0.
- Commit: `47f40bc6d4ffaff58045626105050bd469ea26d8`
  (`docs: record guided editing core`), one subject only with no body or
  trailer. The commit changes only `BLUEPRINT.md` (8 insertions).

## Concerns

- Three pre-existing dashboard lint warnings, legacy React `act(...)`
  diagnostics, Remotion browser warnings, and the Vite chunk-size advisory
  remain; none failed its gate.
- `EditDocument` still has a legacy docstring that says “immutable
  revision-one” although the validated model accepts every positive revision;
  no Python source edit was authorized in Task 7.
- No push, deployment, publication, Docker action, live request, secret or
  fixture evidence access/mutation, S3 export, rollback drill, or soak action
  was performed.

## Final fix wave 2026-09-12

### Scope

- Fixed Guided Studio-generated operation IDs to use an `op_` prefix while still
  satisfying the backend `OpaqueId` regex.
- Disabled `Back` whenever the editor is dirty, saving, failed, offline, or
  conflicted, with an accessible description explaining when Back becomes
  available.
- Preserved `latestConflict` and visible Conflict state through local edit,
  undo, and redo until explicit Reload Latest or Keep Editing Locally recovery.
- Added browser `online`/`offline` signal handling so offline drafts remain
  pending, autosave is suppressed offline, and dirty autosave resumes on
  reconnect.
- Implemented the spec §7 three-region workstation with native labelled range
  controls for scene-board and inspector widths while preserving the center
  `StudioPreview` child.
- Replaced obsolete source wording that described `EditDocument` as
  `revision-one`; regenerated OpenAPI and generated TypeScript contracts.

### RED evidence

- `rtk bun test src/features/studio/editor_state.final-fix.test.ts
  src/features/studio/GuidedStudio.final-fix.test.tsx` exited 1 with 7 failing
  regression tests: conflict persistence, offline reducer recovery, `op_`
  operation ID prefix, guarded Back behavior, stale-base autosave suppression,
  offline autosave suppression/reconnect, and resizable workstation controls.
- `rtk uv run pytest tests/domain/test_edit_document_final_fix.py -q` exited 1
  because `EditDocument.__doc__` still contained `revision-one`.

### GREEN evidence

- `rtk bun test src/features/studio/editor_state.final-fix.test.ts
  src/features/studio/GuidedStudio.final-fix.test.tsx
  src/features/studio/editor_state.test.ts
  src/features/studio/GuidedStudio.test.tsx` exited 0: 16 pass, 0 fail.
- `rtk uv run pytest tests/domain/test_edit_document_final_fix.py
  tests/domain/test_edit_documents.py tests/domain/test_edit_document_operations.py
  -q` exited 0: 32 passed.
- `rtk uv run pytest '-m=not live' -q` exited 0: 749 passed, 31 skipped,
  3 deselected, 16 warnings.
- `rtk uv run ruff check .` exited 0: all checks passed.
- `rtk uv run ruff format --check .` exited 0: 99 files already formatted.
- `rtk uv lock --check` exited 0: resolved 76 packages.
- `rtk bun test` exited 0: 76 pass, 0 fail across 15 files.
- `rtk bun run lint` exited 0 with the three pre-existing warnings in
  `Discovery.tsx`, `badge.tsx`, and `button.tsx`.
- `rtk bun run build` exited 0; Vite emitted the existing chunk-size advisory.
- `rtk cmd.exe /c ".\build_cuda.bat build_log.txt 2>&1"` exited 0; Cargo
  release CUDA build finished successfully.

### Contract generation proof

- First generation commands: `rtk uv run python scripts/export_openapi.py` from
  `python`, then `rtk bun run generate:control-plane-types` from `dashboard`.
- Second-generation pre/post SHA256 hashes were identical:
  `python/openapi.json`
  `beda1fcc67a1958b1412b0a8e12c0d9a839fd0318a0d56e2cd2a9bdaf38732b3`;
  `dashboard/src/api/generated/control-plane.ts`
  `7eaa5c740d2d36885c58e38145dafe5370be1aa62effd649cdbb1c4e5f5e2bd8`.
- After staging only the generated contract files, a third generation followed
  by `rtk git diff --exit-code -- python/openapi.json
  dashboard/src/api/generated/control-plane.ts` exited 0, proving no
  second-generation drift.
- `rtk rg -n "revision-one" python/src python/openapi.json
  dashboard/src/api/generated/control-plane.ts` returned no matches.

### Protected paths and exclusions

- `rtk git diff -- BLUEPRINT.md` produced no output; this final fix wave did not
  modify `BLUEPRINT.md`.
- `rtk git diff --check` exited 0.
- No push, deployment, publication, Docker action, live request, secret or
  fixture evidence access/mutation, S3 export, rollback drill, or soak action
  was performed.

### Concerns

- The dashboard lint gate still reports the three pre-existing warnings in
  `Discovery.tsx`, `badge.tsx`, and `button.tsx`.
- Full Python pytest still emits the pre-existing Pydantic serializer warnings.
- Vite build still reports the pre-existing chunk-size advisory.
