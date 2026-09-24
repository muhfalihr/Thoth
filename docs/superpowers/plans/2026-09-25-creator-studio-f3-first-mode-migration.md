# Creator Studio F3 First-Mode Migration Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` task by task. Do not start this plan until the operator approves an executor prompt. Check each step only after its stated evidence exists.

**Goal:** Make `vertical_text_story` Content Sets genuinely editable in Studio: preserve source choices, resume a draft, resolve media through the artifact root, reorder scenes, and render only a saved, ready revision.

**Architecture:** Keep the existing EditDocument, revision-bound render service, single Studio preview, and legacy **Send render** path. A project-scoped import manifest records sanitized source identity and unresolved inputs separately from the EditDocument. The browser never asks the container to open a Windows path or fetch a provider/CDN URL; users explicitly upload or select a ready asset, then attach it to a scene. Import resolution and document revision changes are atomic. The renderer continues to consume only ready, checksum-verified assets under `THOTH_CONTROL_PLANE_ARTIFACT_ROOT`.

**Tech Stack:** Existing React/Vite dashboard, Python control plane, PostgreSQL editor migrations, Remotion renderer, Bun and pytest. No new dependency unless a later operator gate approves one.

**Spec:** `docs/superpowers/specs/2026-09-24-creator-studio-f3-ux-first-migration-design.md`. Plan A: `docs/superpowers/plans/2026-09-24-creator-studio-f3-workspace-ux.md`. Active checkpoint: `.superpowers/sdd/2026-09-24-creator-studio-f3-ux-first-migration/progress.md`.

## Boundary and preflight

- Work on `codex/stage1-container-ci`; verify `bd9bcb4701712c03ffb39bd45ff5c352718d0917` is an ancestor, inspect `HEAD`, upstream, staged/unstaged/untracked state, and stop for overlapping product-code drift. Preserve the operator-owned modified `dashboard/src/features/studio/StudioPreview.tsx` byte-for-byte; do not stage it.
- Read `AGENTS.md`, active checkpoint, F3 spec, Plan A, this plan, and the current import/render/asset contracts before editing. The executor must record its actual starting `HEAD`; this plan's baseline is not permission to reset or rewrite later work.
- Source contracts to pin in tests: `scout/lib/types.ts`, `scout/pipeline/run_pipeline.ts`, `crates/thoth-server/src/routes.rs` Content Set data route, and representative non-live Content Set fixtures. The current browser importer keeps only text and three footage titles; Python creates a new text-only v1 document every time. Neither behavior satisfies this plan.
- Preserve **Send render** without rerouting, rename, or changed payload. No automatic live fetch, provider request, secret access, URL/CDN download, path-based copy from a different host, deployment, image promotion, F1 golden mutation, Python Scout rewrite, or Stage 1 acceptance work.
- All generated files remain under the existing single configured artifact parent. Do not introduce a second output directory or persist absolute artifact locations in EditDocument, import manifest, public API, or browser state.
- Use TDD at each seam: failing behavior test, minimal implementation, focused green, then commit. Repository artifacts and commit subjects are English; operator reports are Indonesian. Keep checkpoint current; record completed work in `CHANGELOG.md` at the final task. No push.

## Product decisions fixed by this plan

1. **Open choice:** Clicking Open in Studio first inspects the current source and lists existing drafts for that exact source in the selected project. The user chooses **Resume** or **Create new**. Inspection must not create a document. A repeat Create request with the same idempotency key returns the same document; a new explicit Create may create a second draft.
2. **Source identity:** Derive a server-side digest from a bounded canonical projection of ordered source roles, canonical source URLs without query/fragment, text, trim/mute/blur values, and media-presence flags. Do not use a host filename, `output_root`, signed query, or a browser-supplied digest as authority. Keep only the digest, role/order, safe platform/title, media kind, and resolution state in the manifest; neither raw URL nor local path becomes public Studio state or renderer input.
3. **Honest import:** Account for every first-mode creative input the legacy path uses. Represent an unsupported field or unavailable media as a named manifest item with source role/order and a human-readable reason. Do not fabricate a ready media clip or silently keep the first three footage items. The user may attach a ready asset or explicitly exclude an item; exclusion stays visible in the import summary. Studio Render is blocked while any item is unresolved. Exclusion is a deliberate creative difference, not parity with legacy.
4. **Asset bridge:** An asset is available only after an explicit project-scoped browser upload or selection from the already-registered ready list. Upload streams into a bounded temporary file beneath `THOTH_CONTROL_PLANE_ARTIFACT_ROOT`, validates type and media metadata, hashes bytes, atomically publishes a relative locator, and registers the ready asset. Abort/error cleans temporary files. No server-side fetch of Content Set URLs or host-path read.
5. **Saved-revision render:** The server rechecks the import manifest's unresolved items, document revision, asset ownership/readiness/checksums, and existing renderer capability when creating a render job. The UI checklist mirrors this authority; a disabled button is not the only guard.
6. **Resolution revision:** Attaching or explicitly excluding an import item advances the saved EditDocument revision atomically with the manifest decision. A render job cannot pair an older document revision with a newer item-resolution state.

## File responsibilities

- `dashboard/src/features/studio/content_set_import.ts`: bounded, typed browser projection and unsupported-field inventory from Rust's Content Set JSON; no network or document state.
- `python/src/thoth_control_plane/domain/studio_imports.py`: strict import request, canonical digest inputs, manifest/status rules; no storage or URLs in public projections.
- `python/migrations/editor/0007_studio_import_sources.sql`: append-only source/draft and item-resolution records, project-scoped keys and idempotency uniqueness.
- `python/src/thoth_control_plane/application/studio_imports.py` and `infrastructure/studio_import_repository.py`: inspect/create/list/resolve orchestration and transactions.
- `python/src/thoth_control_plane/api/routes/studio_imports.py`: project-scoped inspect, explicit create, draft listing, resolution endpoints.
- `python/src/thoth_control_plane/application/editor_asset_uploads.py` and corresponding API route/repository additions: bounded local upload, validation, registration, cleanup.
- `python/src/thoth_control_plane/domain/timeline_operations.py`: persisted scene reorder and import-asset attachment operations on v2 documents.
- Existing caption/audio/style operations, plus the smallest missing caption-create or style-slot operation: every Simple control must round-trip through the canonical document and preview/render composition.
- `dashboard/src/features/studio/StudioImportGate.tsx`: Resume/Create chooser, complete source inventory, explicit attach/exclude actions and recovery text.
- `dashboard/src/features/studio/SceneBoard.tsx` and `Inspector.tsx`: real scene reorder and media-first text selection; `GuidedStudio.tsx` remains editor owner.
- `dashboard/src/features/studio/RenderPanel.tsx` and Python render service: matching readiness display and server enforcement.
- Generated OpenAPI/TypeScript contracts: regenerate from the modified Python API; never hand-edit generated shapes.

## Review focus

1. A repeated Open or network retry cannot create or overwrite a draft without an explicit choice (Tasks 2 and 5).
2. A Content Set with more than three footage entries, main footage, comments, trims, or an unknown creative field cannot appear “fully imported” after text-only conversion (Tasks 1 and 2).
3. A path from Windows, a signed CDN URL, or a different project's asset cannot become a container read or a render bundle locator (Tasks 1, 3, and 4).
4. A media-first scene still exposes its first text clip for heading/body edits, and reordering preserves text/media alignment (Task 4).
5. Caption, audio, and style controls must change the saved document and the single preview/render composition, not just local UI state (Task 4A).
6. Render cannot race a newly unresolved item, a stale revision, or asset invalidation after the browser checklist was shown (Task 6).

### Task 1: Pin the first-mode source inventory and safe projection

**Files:** Create `dashboard/src/features/studio/content_set_import.ts` and `.test.ts`; create `python/src/thoth_control_plane/domain/studio_imports.py` and `python/tests/domain/test_studio_imports.py`; modify `dashboard/src/features/studio/domain.ts` only to retire the lossy F3 call path, not legacy behavior.

**Interfaces:** `projectStudioSource(content: unknown): StudioSourceProjection` returns ordered main/footage/comment source items and named unsupported fields. `inspect_source(project_id, projection)` computes the digest on the server. The request projection may contain a canonical source URL; public responses, persisted manifests, and browser-rendered inventory may not contain the URL or a host path.

- [ ] Write RED tests with a realistic `vertical_text_story` fixture containing main video, four footage items, a cropped image, comments, `main_footage`, trim/mute/blur, and one unknown creative field. Assert stable role/order and that every field is either mapped or reported. Assert Windows paths and signed query strings are never in a public response or canonical digest. Assert malformed/oversize inputs fail closed rather than truncate. In particular:

```ts
const projection = projectStudioSource(contentSetWithFourFootageItems);
expect(projection.items.filter((item) => item.role === "footage")).toHaveLength(4);
expect(projection.items.some((item) => item.role === "main_footage")).toBe(true);
expect(projection.unsupported.map((item) => item.field)).toContain("unknown_creative_field");
```

- [ ] Run `bun --cwd=dashboard test src/features/studio/content_set_import.test.ts` and `uv run --project python pytest python/tests/domain/test_studio_imports.py -q`; capture the relevant RED assertion.
- [ ] Implement the smallest allowlisted projection and strict Python contract. Use a canonical JSON representation for digesting, sort object keys but preserve item order, and use SHA-256. Define item dispositions `unresolved | attached | excluded`. Do not add a URL fetcher or path resolver.
- [ ] Run both focused suites GREEN and commit only Task 1 files with `git commit -m "feat: inventory Studio import sources"`.

### Task 2: Persist inspection, draft choice, and unresolved imports

**Files:** Create `python/migrations/editor/0007_studio_import_sources.sql`, application/repository/route files named above and focused tests under `python/tests/{application,infrastructure,api}/`; modify `python/src/thoth_control_plane/api/app.py`, `application/ports.py`, existing EditDocument repository only where transactional creation requires it; regenerate `python/openapi.json` and `dashboard/src/api/generated/control-plane.ts` using repository scripts.

**Interfaces:** `POST /projects/{project_id}/studio-imports/inspect` is read-only and returns `source_key`, bounded source inventory, and existing draft summaries. `POST /projects/{project_id}/studio-imports` requires the projected source, `source_key`, and `Idempotency-Key`; the server recomputes the key, creates a schema-v2 draft and manifest atomically, and returns the document ID. `GET /projects/{project_id}/studio-imports/{source_key}` lists drafts newest-first. `GET /projects/{project_id}/studio-imports/documents/{document_id}` returns the source inventory for one draft. `POST /projects/{project_id}/studio-imports/documents/{document_id}/items/{item_id}/resolve` takes `base_revision` and one explicit `attach_asset` or `exclude` decision. Inspect and read responses must not contain raw source URLs, paths, or artifact locators.

- [ ] Write RED domain/API/repository tests: inspect does not write; Create and its idempotent replay produce one draft; an explicit second key produces a second draft; project isolation, stale source-key conflict, bounded listing, and rollback on a partial insert. Confirm existing v1 import API still works for old callers. Migration tests assert 0001–0006 bytes are unchanged. Pin replay with `assert replay.document_id == first.document_id` and `assert await repository.count_drafts(project_id, source_key) == 1`.
- [ ] Run the focused tests and record RED. Add append-only tables and one transaction for source snapshot, document revision, and item records. Build F3 text scenes from **all ordered items selected for scene text** (up to the document's 100-scene bound), then reuse `upgrade_edit_document_v1` for the initial schema-v2 shape; do not call the existing three-footage v1 builder unmodified. Context-only items remain manifest entries rather than fabricated scenes. Overflow is a reported unsupported condition, never truncation. Ensure the manifest can be read with the document's latest revision without silently mutating the EditDocument. No raw source JSON, URL, or host path is persisted.
- [ ] Run focused Python tests, export OpenAPI, regenerate dashboard types twice and verify no second diff. Commit only Task 2 files with `git commit -m "feat: persist Studio source drafts"`.

### Task 3: Register a real project asset under the central artifact root

**Files:** Create `python/src/thoth_control_plane/application/editor_asset_uploads.py`, upload route tests, application tests, and artifact-store tests; extend `api/routes/editor_assets.py`, `application/editor_asset_ports.py`, `infrastructure/editor_asset_repository.py`, `infrastructure/artifact_root.py`, `api/app.py`, and config only as needed; regenerate API/types.

**Interfaces:** `POST /projects/{project_id}/editor-assets` accepts one explicit streamed file body (media `Content-Type`, no multipart dependency) and returns existing public `EditorAsset` metadata. It never accepts a URL or filesystem path. Ready-asset listing and preview capability remain the existing API.

- [ ] Write RED tests for supported image/video/audio, unsupported MIME or spoofed bytes, size limit, invalid metadata, interrupted upload, cross-project lookup, and a missing/unwritable artifact root. Assert no partial database row or temporary file remains after failure and the public `EditorAsset` has no `artifact_location`. Use small generated local test media only; no real operator asset.
- [ ] Run focused RED. Implement streaming with a fixed documented byte ceiling, media inspection through the existing ffprobe runtime, checksum, relative locator, atomic publish, and transactional registration. Never load a whole video into memory or follow redirects. If artifact storage is unavailable, return a safe `503` and keep legacy render usable.
- [ ] Run focused GREEN, generated-contract stability, and Compose config. Commit only Task 3 files with `git commit -m "feat: register Studio media uploads"`.

### Task 4: Attach media, reorder scenes, and edit a media-first scene

**Files:** Modify `python/src/thoth_control_plane/domain/timeline_operations.py`, EditDocument operations/repository/service and their focused tests; modify `dashboard/src/features/studio/SceneBoard.tsx`, `Inspector.tsx`, `GuidedStudio.tsx`, client and focused component/reducer tests. Add only a small `studio_scene.ts` helper if the selection rule cannot live in the existing module.

**Interfaces:** A revision-bound `reorder_scene` operation moves a scene in the v2 scene sequence and shifts its clips as a unit, preserving their relative offsets, source trim, asset reference, and IDs. The Task 2 `resolve` endpoint with `attach_asset` binds a ready project asset to one unresolved item and inserts the corresponding media clip into the specified scene in the same transaction; `exclude` records an explicit omission with no fabricated clip. Existing `reorder_track` is not scene reorder.

- [ ] Write RED tests for first/middle/last reorder, mixed text/media scenes, unequal durations, conflict replay, invalid scene IDs, and no drift in total frames or clip-to-scene membership. For example, moving `scene_003` to index 0 must preserve total canvas frames and make `scene_003` the first scene in the next revision. Test attachment rejects wrong project, unready/changed asset, duplicate resolution, stale document revision, and partial transaction failure. Add a component test where `clip_ids[0]` is media but the Inspector edits the first text clip.
- [ ] Run focused RED. Implement only the two real persisted operations and accessible Move earlier/Move later buttons (drag may be progressive enhancement); use the saved document's frame rate for any human duration display. Keep Advanced mode on the same document and preview, with no conversion on mode switch.
- [ ] Run focused Python/dashboard GREEN and commit Task 4 files with `git commit -m "feat: edit imported Studio scenes"`.

### Task 4A: Expose real first-mode caption, audio, and style controls

**Files:** Modify the existing timeline operation/domain tests, `dashboard/src/features/studio/Inspector.tsx`, `GuidedStudio.tsx`, and their focused tests. Modify the shared Remotion composition and tests only for a style slot not already rendered by it; do not change `StudioPreview.tsx` while its operator-owned modification exists.

**Interfaces:** Simple mode edits caption text/timing, audio placement/volume/mute, and one allowlisted template style slot through revision-bound EditDocument operations. Reuse `set_caption_cue_text`, `set_clip_volume`, `set_track_muted`, and `add_clip_from_asset` where they already cover the action. Add `add_caption_clip` or `set_text_style_slot` only if the corresponding user action cannot be expressed by those existing operations. Advanced uses the same revision and operations.

- [ ] Write RED domain and component tests: a creator can add a caption to a scene with none, edit its cue, attach a ready audio asset to the appropriate track, change volume/mute, and select a valid style. Each action survives save/reload and appears in the one preview and the offline render composition. Unknown style IDs, locked clips/tracks, stale revisions, and unavailable audio are rejected with visible reasons. Do not add a style picker if the selected style has no real renderer effect.
- [ ] Run focused RED. Implement only missing operations and creator-facing controls, with preset values defined in one shared composition contract. No arbitrary CSS, JavaScript, prompt, executable template, or provider-authored style input enters rendering.
- [ ] Run focused Python, dashboard, and renderer GREEN; regenerate affected schemas/types twice if operations changed. Commit only Task 4A files with `git commit -m "feat: edit Studio captions audio and style"`.

### Task 5: Make Open in Studio a reversible creator choice

**Files:** Create `dashboard/src/features/studio/StudioImportGate.tsx` and `.test.tsx`; modify `dashboard/src/App.tsx`, `dashboard/src/components/ContentSet.tsx`, `dashboard/src/api/control-plane.ts`, `dashboard/src/features/studio/GuidedStudio.tsx` and relevant tests.

**Interfaces:** App invokes inspect from Task 2; chooser shows **Resume** with saved revision and **Create new**. A selected draft opens existing `GuidedStudio`; Create sends one caller-owned idempotency key. Inventory shows each unresolved item by scene/source, supports upload or selecting an existing ready asset, and permits an explicit **Exclude from Studio edit** decision. Offline, conflict, and upload failure preserve the chooser and local UI state.

- [ ] Write RED tests proving Open is inspection-only; Resume fetches the selected existing document; Create makes exactly one request per click and an explicit retry reuses its key; no auto-create on remount or project switch; **Send render** remains on the original path. Cover four footage items, missing main media, unsupported fields, keyboard selection, and no raw path/URL in UI, responses, persisted document, or logs (the bounded inspect request may carry a canonical source URL solely for digesting). Immediately after Open, assert `inspectStudioImport` has one call and `createStudioImport` has none.
- [ ] Run focused RED. Compose the chooser and inventory in the approved dark Studio workspace. Give each unresolved item a concrete route to attach or explicitly exclude; exclusions stay visibly listed. Do not expose a cosmetic control that does not persist. Handle a stale draft by refreshing the project-scoped list, never by silently creating a replacement.
- [ ] Run focused dashboard GREEN and commit Task 5 files with `git commit -m "feat: resume and resolve Studio imports"`.

### Task 6: Enforce import readiness at render creation and verify the journey

**Files:** Modify `python/src/thoth_control_plane/application/render_jobs.py` and focused API/application tests, `dashboard/src/features/studio/RenderPanel.tsx` and focused tests; add browser contract tests in the existing dashboard/browser test location; update `CHANGELOG.md` and active checkpoint.

**Interfaces:** A saved-revision Studio render for a source-linked document is refused with stable safe codes while the manifest has unresolved items, the revision is stale, or an attached asset is not ready. Existing source-unlinked documents keep their current render behavior. RenderPanel obtains readiness for the saved revision, names affected scene/source and offers Edit/import resolution; it never claims the local unsaved draft is rendered.

- [ ] Write RED server tests for unresolved main/footage/comment items, explicit exclusion, cross-project or invalidated asset, stale saved revision, and a race in which an item becomes unresolved after UI readiness. Assert an unresolved source raises a safe render error before `renderer_gateway` is called. Write RED UI tests for distinct readiness explanations and no create-render request while blocked. Verify legacy **Send render** is unaffected.
- [ ] Run focused RED. Add the server-side guard inside render-job creation's authoritative transaction, reuse existing asset verification, and expose only safe item labels/codes. Connect the Render checklist without a second preview or duplicate readiness model.
- [ ] Run focused GREEN. Browser-check the complete journey at 1440, 820, and 375 px plus 200% text zoom: inspect, Resume/Create, attach/exclude, edit/reorder, Prompt/Review round trip, saved-revision Render, offline/conflict recovery, keyboard focus, and no hidden horizontal overflow. A fixture-only no-network run is sufficient; no live source request.
- [ ] Run full offline gates: `uv run --project python pytest -m "not live" -q`; `uv run --project python ruff check python/src python/tests`; `uv run --project python ruff format --check python/src python/tests`; OpenAPI export and TypeScript regeneration twice; `bun --cwd=dashboard test`, lint, build; renderer tests if the bundle or preview changed; `docker compose -f compose.stage1.local.yml config --quiet`; and the mandatory `cmd /c ".\build_cuda.bat > build_log.txt 2>&1"` even if Rust did not change. Run relevant `cargo test --bin thoth <module>` if Rust changed. Report any environment-unavailable gate instead of claiming it passed. Run `git diff --check` and `graphify update .` without staging the index.
- [ ] Update the active checkpoint and append one concise completed-work record to `CHANGELOG.md`. Commit only task-owned files with `git commit -m "feat: gate Studio render on import readiness"`. Stop for a single end-of-feature Codex review; do not push or deploy.

## Completion boundary

Plan B is complete only when an offline fixture demonstrates no source item is silently lost, the creator can resolve media through the central artifact root, reorder and edit scenes including caption/audio/style, render a saved ready draft, and see an unresolved input block Studio Render while **Send render** still works. This is not F1 golden promotion, live parity, deployment, legacy cutover, or the separate Python Scout rewrite. The executor report must name actual commits, RED/GREEN evidence, full gate outcomes, unchanged operator files, and any unmet acceptance item rather than declaring F3 complete from UI appearance alone.
