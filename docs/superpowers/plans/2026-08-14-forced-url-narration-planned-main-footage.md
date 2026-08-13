# Forced URL Narration-Planned Main Footage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an opt-in Scout mode that turns every usable video in the supplied post into durable, scene-indexed source footage, plans versioned local cuts against mandatory narration, and renders a verified timeline containing at least 60% main footage without changing legacy direct-URL or Content Set behavior.

**Architecture:** Scout owns forced-post inspection, video-only acquisition, scene indexing, candidate ranking, deterministic allocation, and cut materialization. Thoth imports the Scout package into the job root, creates the narration timeline, invokes Scout's job-local planner, validates the resulting immutable plan, and renders only verified local cuts through a dedicated planned-timeline renderer. A top-level `main_footage.mode == "forced_url_pool"` discriminator selects this branch; absence of the discriminator keeps the existing single-main pipeline and `EditService` unchanged.

**Tech Stack:** Bun 1.2+ and TypeScript 5.7 (Scout), Rust workspace (`thoth-types`, `thoth-jobs`, `thoth-core`, `thoth-server`), React 19 + Bun Test + Testing Library (Dashboard), FFmpeg/FFprobe, SQLite job/event storage, existing LLM/Vision/embedding providers.

## Global Constraints

- `use_input_as_main` defaults to `false`, is scoped to one Scout run, and is never persisted in local storage or a profile.
- `main_coverage_target` defaults to `0.60`; API/CLI accept only `[0.60, 1.00]`; the first Dashboard release exposes no coverage control.
- Forced mode keeps the input post authoritative: `trace_source` cannot replace it, editorial suitability failures become warnings, and technical acquisition failures remain blocking.
- Mixed posts retain every usable video, including media index `1`, and ignore every photo from the forced post in both primary footage and enrichment deduplication.
- Partial acquisition succeeds when at least one video is usable; zero usable videos fails with `forced_main_no_usable_video`.
- Original source videos are immutable local files. Do not pre-concatenate sources and do not trim, normalize, or remove source audio in `sources/`.
- Narration is mandatory in forced mode. The Dashboard and authoritative server job-creation boundary reject effective `narration.enabled == false` with `forced_main_narration_required`.
- Scene indexing persists natural boundaries, representative frames, transcript evidence, Vision descriptions when available, embeddings, and deterministic visual metrics. Vision failure must persist `planning_mode: "degraded"`, not discard a valid source.
- Planning order is Vision evidence, bounded embedding shortlist, planner LLM ranking, deterministic global allocator, then Vision/local boundary validation.
- The primary timeline is gap-free. Main cuts cover at least the configured target; exact matches outrank topic-only matches; off-topic scenes are ineligible.
- Normal visible cuts are `1.5..=6.0` seconds. Long narration beats may contain multiple ordered cuts.
- A source may recur. An identical source time range is fallback-only and its next output start must be at least `8.0` seconds after its preceding use.
- Approved transitions are only `match_cut`, `cross_dissolve`, and `fade_through_black`, with durations `120..=300` ms. Invalid or unavailable handles fall back to `match_cut`.
- Every selected segment is atomically published and verified under `cuts/vNNN/` before final rendering. A cut failure retries, invalidates that candidate for the attempt, and replans only the affected beat.
- The durability gate verifies path containment, fingerprints, FFprobe metadata, duration, checksum, complete timeline, coverage, reuse spacing, handles, and transition bounds. Planned rendering performs no remote media download.
- Source audio remains ambience, is normalized, micro-faded, and smoothly ducked under narration; existing BGM, SFX, cards, subtitles, and overlays remain downstream of the narration spine.
- Reruns never overwrite artifacts: narration changes create a new plan/cut version; style/layout-only changes reuse the active verified plan; source changes invalidate dependent indexes and plans.
- Sources, indexes, narration, plans, cuts, and renders remain until an explicit, confirmed, root-confined cleanup request. There is no automatic cleanup.
- Persisted paths are relative to a declared package/job root. Reject unknown schema versions, path traversal, remote cut URLs, and resolved paths outside the configured root.
- Stable terminal codes are `forced_main_no_usable_video`, `forced_main_narration_required`, `source_package_invalid`, `narration_generation_failed`, `cut_planning_failed`, `cut_materialization_exhausted`, and `plan_verification_failed`.
- Stable warning codes are `source_video_skipped`, `photo_slide_ignored`, `vision_degraded`, `exact_scene_reused`, `topic_only_match`, and `transition_fallback`.
- Logs/manifests must not persist cookies, credentials, signed transport URLs, response bodies, or unnecessary absolute paths.
- Publish progress stages exactly as `importing_sources`, `validating_scene_index`, `generating_narration`, `planning_cuts`, `materializing_cuts`, `verifying_plan`, and `rendering`.
- All shell commands in this repository are prefixed with `rtk`; use focused tests during development and run the full regression matrix before completion.

---

## File Structure

### Shared fixtures and contracts

- Create `tests/fixtures/main-footage/contracts/source-package.v1.json`: language-neutral valid package fixture consumed by TypeScript and Rust contract tests.
- Create `tests/fixtures/main-footage/contracts/narration-timeline.v1.json`: ordered, non-overlapping narration beats with a stable fingerprint.
- Create `tests/fixtures/main-footage/contracts/main-footage-plan.v1.json`: verified mixed main/external timeline with legal transitions and at least 60% coverage.
- Create `scout/main_footage/contracts.ts`: schema-v1 TypeScript types, stable error/warning codes, runtime decoders, canonical fingerprint helpers, and plan/version naming.
- Create `scout/main_footage/paths.ts`: package/job-root containment, relative-path normalization, atomic publish, SHA-256, and next-version helpers.
- Create `scout/main_footage/contracts.test.ts` and `scout/main_footage/paths.test.ts`: fixture compatibility, schema rejection, path traversal, atomic publish, and fingerprint tests.
- Create `crates/thoth-core/src/main_footage/contracts.rs`: Rust mirrors for source package, narration timeline, plan, warnings, transitions, and discriminator.
- Create `crates/thoth-core/src/main_footage/paths.rs`: canonical containment and job-owned hardlink/copy import helpers.
- Create `crates/thoth-core/src/main_footage/mod.rs`: exports the planned-mode domain without growing `ingest/content_search.rs` further.

### Scout acquisition and analysis

- Create `scout/main_footage/source_package.ts`: forced-post partitioning, all-video tolerant materialization, FFprobe/checksum publication, ignored-photo records, dedup identities, and package summary.
- Create `scout/main_footage/source_package.test.ts`: mixed-post, index-1 video, partial success, total failure, atomicity, redaction, and dedup tests.
- Create `scout/main_footage/scene_index.ts`: natural scene detection, frame extraction, transcript association, Vision/degraded analysis, embeddings, metrics, cache/fingerprint validation.
- Create `scout/main_footage/scene_index.test.ts`: ordered/bounded scenes, cache reuse/invalidation, Vision success/degradation, and safe persisted evidence.
- Modify `scout/acquisition/types.ts`: add stable acquisition metadata needed by source manifests without adding ephemeral URLs to persisted types.
- Modify `scout/acquisition/materialize.ts`: accept an optional destination publication policy while preserving current call behavior.
- Modify `scout/lib/types.ts`: add the optional `main_footage` Content Set discriminator and package summary types.
- Modify `scout/pipeline/run_pipeline.ts`: parse forced options, skip `trace_source`, exclude forced media from enrichment, build/index the package, and persist the discriminator.
- Modify `scout/pipeline/validate_content_set.ts`: validate the optional manifest relative to the Content Set and Scout output root.
- Modify `scout/cli.ts`: document the new run flags and add the internal `plan-main-footage` command used by Thoth.

### Scout narration planning and cuts

- Create `scout/main_footage/candidates.ts`: beat-to-scene embedding shortlist, exact/topic-only/off-topic tiers, and planner-LLM ranking restricted to known IDs.
- Create `scout/main_footage/candidates.test.ts`: tiering, shortlist bound, unknown-ID rejection, and degraded evidence tests.
- Create `scout/main_footage/allocator.ts`: deterministic complete-timeline allocation, coverage/reuse/variation constraints, and affected-beat replacement.
- Create `scout/main_footage/allocator.test.ts`: 60% coverage, topic-only fill, recurring source, eight-second identical-range spacing, multi-cut beats, and deterministic replan.
- Create `scout/main_footage/cuts.ts`: version reservation, handle-aware FFmpeg cut commands, retry/atomic publication, FFprobe/checksum verification, and immutable plan writing.
- Create `scout/main_footage/cuts.test.ts`: versioning, retry, candidate exclusion, affected-beat replan, transition fallback, and no-overwrite tests.
- Create `scout/main_footage/plan_job.ts`: internal CLI coordinator that reads only job-local inputs and emits plan/cut artifacts plus safe machine-readable progress.

### Thoth import, narration, validation, and rendering

- Modify `crates/thoth-core/src/ingest/content_search.rs`: parse the optional discriminator and return it in `LoadedSet`, leaving `main_url` semantics unchanged for legacy sets.
- Create `crates/thoth-core/src/main_footage/import.rs`: resolve the Content Set manifest, verify package structure/fingerprint, and hardlink-or-copy it under the job root.
- Create `crates/thoth-core/src/narration/timeline.rs`: turn the generated narration words into stable, contiguous beats and write `narration-timeline.json`.
- Modify `crates/thoth-core/src/narration/mod.rs`: export timeline generation.
- Create `crates/thoth-core/src/main_footage/verify.rs`: durability validator returning a typed `VerifiedMainFootagePlan` that is the only planned renderer input.
- Create `crates/thoth-core/src/main_footage/coordinator.rs`: resumable stage orchestration and supervised invocation of Scout's job-local planner.
- Modify `crates/thoth-core/src/pipeline/job.rs`: add main-footage package, plan, cut, and active-plan path helpers.
- Modify `crates/thoth-core/src/pipeline/state.rs`: persist forced-stage fingerprints, active version, metrics, warnings, and resume invalidation.
- Modify `crates/thoth-core/src/pipeline/mod.rs`: make narration fatal in forced mode, create the timeline, invoke the coordinator, and dispatch the dedicated renderer.
- Modify `crates/thoth-core/src/lib.rs`: import forced packages instead of ingesting `main.url`; preserve existing Content Set sidecars and legacy branch.
- Create `crates/thoth-core/src/edit/planned.rs`: bounded planned renderer API and overlay integration.
- Create `crates/thoth-core/src/edit/planned_ffmpeg.rs`: deterministic item ordering, handles/transitions, loudness normalization, ambience ducking, audio fades, and final FFmpeg graph construction.
- Modify `crates/thoth-core/src/edit/mod.rs`: export planned rendering without changing legacy `EditService` behavior.

### Profile/server/dashboard operations

- Modify `crates/thoth-jobs/src/profiles.rs`: add `NarrationSettings.enabled` with a backward-compatible default of `true` and a typed per-run override.
- Modify `crates/thoth-jobs/src/validation.rs`: validate narration settings and keep existing JobSpec rules.
- Modify `crates/thoth-server/src/scout.rs`: accept/map `use_input_as_main` and `main_coverage_target`.
- Modify `crates/thoth-server/src/routes.rs`: authoritative forced-mode/profile gate, planned artifact manifest fields, package facts, and root-scoped cleanup handlers.
- Modify `crates/thoth-server/src/lib.rs`: mount summary and cleanup routes.
- Modify `crates/thoth-server/tests/routes_http.rs`: HTTP contracts, validation codes, progress/artifact facts, and cleanup confinement.
- Modify `dashboard/src/api.ts` and `dashboard/src/api.test.ts`: typed flags, package/plan facts, narration-enabled settings, and confirmed cleanup calls.
- Modify `dashboard/src/components/Discovery.tsx`: unchecked per-run forced-main control and narrator requirement copy.
- Modify `dashboard/src/components/ContentSet.tsx`: forced-main badge, source/index facts, counts, fingerprint, warnings, and package cleanup.
- Modify `dashboard/src/components/RunForm.tsx` and `RunForm.test.tsx`: immediate narration-required rejection for a forced Content Set handed off from Scout.
- Modify `dashboard/src/components/ProfileStudio.tsx` and `ProfileStudio.test.tsx`: expose and persist the existing narrator-mode setting now represented in profile schema.
- Modify `dashboard/src/components/JobMonitor.tsx`: plan version/mode/coverage/cuts/reuse/transitions/warnings/storage and explicit job cleanup.
- Modify `dashboard/src/App.tsx`: carry forced Content Set metadata through the existing “Send to render” handoff.

### Acceptance and operator documentation

- Create `scout/main_footage/offline_acceptance.test.ts`: network-free mixed-media acquisition, planning, cut persistence, rerun, and source-removal acceptance.
- Create `crates/thoth-core/tests/planned_main_footage.rs`: short generated-media durability/render acceptance.
- Create `docs/main-footage.md`: operator flags, artifacts, errors/warnings, retention/cleanup, resume semantics, and live-platform smoke checklist.
- Modify `scout/acquisition/run_all_tests.ts`: include all `scout/main_footage/*.test.ts` files in deterministic order.

---

### Task 1: Versioned Cross-Runtime Contracts and Safe Paths

**Files:**
- Create: `tests/fixtures/main-footage/contracts/source-package.v1.json`
- Create: `tests/fixtures/main-footage/contracts/narration-timeline.v1.json`
- Create: `tests/fixtures/main-footage/contracts/main-footage-plan.v1.json`
- Create: `scout/main_footage/contracts.ts`
- Create: `scout/main_footage/contracts.test.ts`
- Create: `scout/main_footage/paths.ts`
- Create: `scout/main_footage/paths.test.ts`
- Create: `crates/thoth-core/src/main_footage/contracts.rs`
- Create: `crates/thoth-core/src/main_footage/paths.rs`
- Create: `crates/thoth-core/src/main_footage/mod.rs`
- Modify: `crates/thoth-core/src/lib.rs`

**Interfaces:**
- Produces TypeScript `SourcePackageV1`, `NarrationTimelineV1`, `MainFootagePlanV1`, `MainFootageDescriptor`, `MainFootageErrorCode`, `MainFootageWarningCode`, `decodeSourcePackage(value)`, `decodeNarrationTimeline(value)`, `decodeMainFootagePlan(value)`, `fingerprintCanonical(value)`, `resolveContained(root, relative)`, `atomicPublish(temp, destination)`, and `nextVersion(root): "vNNN"`.
- Produces Rust mirrors `SourcePackageV1`, `NarrationTimelineV1`, `MainFootagePlanV1`, `MainFootageDescriptor`, `MainFootageMode`, `TransitionKind`, `MainFootageErrorCode`, `MainFootageWarningCode`, `resolve_contained(root, relative)`, and `import_file(source, destination)`.
- Contract rule: `cut_path`, source paths, frames, embeddings, scene indexes, and manifest references are slash-separated relative paths; URLs are never accepted as artifact paths.
- Fingerprint rule: source package hashes canonical schema/post/analysis identity, accepted source checksums/technical metadata, scene-index checksums, and stable ignored/unavailable outcome codes; it excludes `created_at`, human messages, and the fingerprint field itself. Narration hashes audio bytes plus normalized ordered word text/timings. Object keys are sorted and array order remains significant in both runtimes.

- [ ] **Step 1: Write failing TypeScript contract/path tests and the three valid fixtures**

```ts
test('rejects unknown schemas and escaped or remote artifact paths', () => {
  expect(() => decodeMainFootagePlan({ schema_version: 2 })).toThrow('unsupported schema_version');
  expect(() => resolveContained(root, '../escape.mp4')).toThrow('path_outside_root');
  expect(() => resolveContained(root, 'https://cdn.test/a.mp4')).toThrow('artifact_path_must_be_relative');
});

test('canonical fingerprints ignore object key order but not array order', () => {
  expect(fingerprintCanonical({ b: 2, a: 1 })).toBe(fingerprintCanonical({ a: 1, b: 2 }));
  expect(fingerprintCanonical({ a: [1, 2] })).not.toBe(fingerprintCanonical({ a: [2, 1] }));
});
```

- [ ] **Step 2: Run the focused TypeScript tests and verify they fail because the modules do not exist**

Run: `rtk bun test scout/main_footage/contracts.test.ts scout/main_footage/paths.test.ts`

Expected: FAIL with module-not-found errors for `contracts.ts` and `paths.ts`.

- [ ] **Step 3: Implement the TypeScript schemas, canonical JSON hashing, containment, atomic publish, and version naming**

```ts
export const MAIN_FOOTAGE_SCHEMA_VERSION = 1 as const;
export type TransitionKind = 'match_cut' | 'cross_dissolve' | 'fade_through_black';
export type MatchLevel = 'exact' | 'topic_only';
export type PlanningMode = 'vision' | 'degraded';

export function resolveContained(root: string, relative: string): string {
  if (path.isAbsolute(relative) || /^[a-z]+:\/\//i.test(relative)) throw new Error('artifact_path_must_be_relative');
  const resolved = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(prefix)) throw new Error('path_outside_root');
  return resolved;
}
```

Define all fields shown in the design contract, including source technical metadata, ignored/unavailable outcomes, scene evidence/status, plan diagnostics, visible timeline coordinates, handles, checksums, match level, reuse count, transition, warnings, and safe summary counts. Decoders must reject non-finite numbers, invalid time ranges, target outside `[0.60, 1.00]`, duplicate IDs, unsupported schema versions, and artifact paths that are absolute, remote, or traversing.

- [ ] **Step 4: Run the TypeScript contract/path tests and verify they pass**

Run: `rtk bun test scout/main_footage/contracts.test.ts scout/main_footage/paths.test.ts`

Expected: PASS; atomic-publish test also proves a pre-existing destination is never overwritten.

- [ ] **Step 5: Write failing Rust mirror/containment tests against the same fixtures**

```rust
#[test]
fn shared_v1_fixtures_deserialize_and_remote_cut_paths_are_rejected() {
    let plan: MainFootagePlanV1 = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/main-footage/contracts/main-footage-plan.v1.json"
    )).unwrap();
    assert_eq!(plan.schema_version, 1);
    assert!(resolve_contained(Path::new("job"), Path::new("https://cdn.test/a.mp4")).is_err());
}
```

- [ ] **Step 6: Run the focused Rust tests and verify they fail because `main_footage` is not exported**

Run: `rtk cargo test -p thoth-core main_footage::contracts`

Expected: FAIL with unresolved module/type errors.

- [ ] **Step 7: Implement Rust schema mirrors and containment/import helpers**

Use `#[serde(deny_unknown_fields)]` inside versioned package/timeline/plan objects, `#[serde(rename_all = "snake_case")]` for enums, reject unknown schema versions after deserialize, canonicalize both root and parent before opening a file, and implement `import_file` as destination-parent creation followed by hardlink with copy fallback into a temporary sibling and atomic rename.

- [ ] **Step 8: Run both contract suites and workspace formatting**

Run: `rtk bun test scout/main_footage/contracts.test.ts scout/main_footage/paths.test.ts`

Run: `rtk cargo test -p thoth-core main_footage::`

Run: `rtk cargo fmt --check`

Expected: all PASS and formatting exits 0.

- [ ] **Step 9: Commit the shared contract layer**

```bash
rtk git add tests/fixtures/main-footage/contracts scout/main_footage/contracts.ts scout/main_footage/contracts.test.ts scout/main_footage/paths.ts scout/main_footage/paths.test.ts crates/thoth-core/src/main_footage crates/thoth-core/src/lib.rs
rtk git commit -m "feat: add planned main footage contracts"
```

### Task 2: Backward-Compatible Content Set Discriminator

**Files:**
- Modify: `scout/lib/types.ts`
- Modify: `scout/pipeline/validate_content_set.ts`
- Modify: `scout/lib/validate.test.ts`
- Modify: `crates/thoth-core/src/ingest/content_search.rs`
- Test: `crates/thoth-core/src/ingest/content_search.rs` module tests

**Interfaces:**
- Consumes: Task 1 `MainFootageDescriptor` and Rust mirror.
- Produces: optional `ContentSet.main_footage?: MainFootageDescriptor` and `LoadedSet.main_footage: Option<MainFootageDescriptor>`.
- Produces: `validateMainFootageDescriptor(contentSetPath, set, scoutOutputRoot): SourcePackageV1 | undefined`, called by the existing `runValidateContentSet`; no second end-user validator is introduced.
- Invariant: only `mode == "forced_url_pool"` selects planned behavior; omitted `main_footage` retains the exact legacy `main_url`, still-image, OCR, footage, comment, and sidecar behavior.

- [ ] **Step 1: Add failing TypeScript validation tests**

```ts
test('forced descriptor resolves beside the content set and stays under Scout output', () => {
  const packageManifest = validateMainFootageDescriptor(forcedFixturePath, forcedSet, outputRoot);
  expect(packageManifest?.schema_version).toBe(1);
});

test('rejects a package manifest escaping Scout output', () => {
  expect(() => validateMainFootageDescriptor(escapedFixturePath, escapedSet, outputRoot))
    .toThrow('source_package_invalid');
});
```

- [ ] **Step 2: Run the focused Scout tests and verify the new assertions fail**

Run: `rtk bun test scout/lib/validate.test.ts`

Expected: FAIL because `main_footage` is neither typed nor validated.

- [ ] **Step 3: Add the optional TypeScript discriminator and manifest validation**

```ts
export interface MainFootageDescriptor {
  mode: 'forced_url_pool';
  package_manifest: string;
  coverage_target: number;
}
```

Resolve `package_manifest` from the Content Set parent, prove it stays below the configured `scout/output` root, decode it with `decodeSourcePackage`, and compare its canonical post URL with `main.url`. Do not require this field for legacy sets.

- [ ] **Step 4: Verify the Scout validation tests pass**

Run: `rtk bun test scout/lib/validate.test.ts`

Expected: PASS for legacy and forced fixtures; traversal fixture returns `source_package_invalid`.

- [ ] **Step 5: Add failing Rust legacy/discriminator tests**

```rust
#[test]
fn legacy_set_has_no_planned_main_footage() {
    assert!(load_content_set(legacy_fixture.path()).unwrap().main_footage.is_none());
}

#[test]
fn forced_descriptor_selects_only_forced_url_pool() {
    let loaded = load_content_set(forced_fixture.path()).unwrap();
    assert_eq!(loaded.main_footage.unwrap().mode, MainFootageMode::ForcedUrlPool);
}
```

- [ ] **Step 6: Run focused Rust ingest tests and verify failure**

Run: `rtk cargo test -p thoth-core ingest::content_search`

Expected: FAIL because `LoadedSet.main_footage` does not exist.

- [ ] **Step 7: Extend Rust Content Set parsing without altering legacy fields**

Add `#[serde(default)] pub main_footage: Option<MainFootageDescriptor>` to `ContentSet` and copy it to `LoadedSet`. Do not reinterpret `main.url` inside the loader; branch selection remains the caller's responsibility.

- [ ] **Step 8: Run Scout and Rust regression tests**

Run: `rtk bun --cwd scout run test:acquisition`

Run: `rtk cargo test -p thoth-core ingest::content_search`

Expected: PASS, including all pre-existing legacy Content Set tests.

- [ ] **Step 9: Commit the discriminator contract**

```bash
rtk git add scout/lib/types.ts scout/pipeline/validate_content_set.ts scout/lib/validate.test.ts crates/thoth-core/src/ingest/content_search.rs
rtk git commit -m "feat: discriminate forced main footage content sets"
```

### Task 3: Narration Profile Setting and Authoritative Enqueue Gate

**Files:**
- Modify: `crates/thoth-jobs/src/profiles.rs`
- Modify: `crates/thoth-jobs/src/validation.rs`
- Modify: `crates/thoth-server/src/routes.rs`
- Modify: `crates/thoth-server/tests/routes_http.rs`
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/components/ProfileStudio.tsx`
- Modify: `dashboard/src/components/ProfileStudio.test.tsx`
- Modify: `dashboard/src/components/RunForm.tsx`
- Modify: `dashboard/src/components/RunForm.test.tsx`
- Modify: `dashboard/src/App.tsx`

**Interfaces:**
- Produces: `NarrationSettings { enabled: bool, language: Option<String> }`, defaulting `enabled` to `true` for missing persisted fields; `RunOverrides.narration_enabled: Option<bool>`; Dashboard mirrors, including a RunForm keep/enabled/disabled one-off selector.
- Produces: route-local `canonical_scout_output_root()`, `inspect_main_footage_descriptor(content_set_path, scout_output_root) -> Result<Option<MainFootageDescriptor>, ValidationError>`, and `validate_forced_main_profile(content_set_path, resolved_settings, scout_output_root) -> Result<(), ValidationError>` at the server enqueue boundary.
- Consumes: `initialContentSetForced: boolean` in `RunForm` for immediate handoff validation; server validation remains authoritative for typed/manual paths.

- [ ] **Step 1: Write failing profile compatibility and override tests**

```rust
#[test]
fn missing_narration_enabled_defaults_true_for_existing_profiles() {
    let settings: ProfileSettings = serde_json::from_value(legacy_profile_json()).unwrap();
    assert!(settings.narration.enabled);
}

#[test]
fn run_override_can_disable_narration_without_mutating_profile() {
    let resolved = resolve_settings(&profile, &RunOverrides { narration_enabled: Some(false), ..Default::default() }, &home).unwrap();
    assert!(!resolved.narration.enabled);
    assert!(profile.narration.enabled);
}
```

- [ ] **Step 2: Run thoth-jobs tests and verify failure**

Run: `rtk cargo test -p thoth-jobs profiles`

Expected: FAIL because `enabled` and `narration_enabled` are absent.

- [ ] **Step 3: Implement narration settings with an explicit true default**

```rust
fn default_narration_enabled() -> bool { true }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NarrationSettings {
    #[serde(default = "default_narration_enabled")]
    pub enabled: bool,
    pub language: Option<String>,
}

impl Default for NarrationSettings {
    fn default() -> Self { Self { enabled: true, language: None } }
}
```

Wire `RunOverrides.narration_enabled` through `resolve_settings` and through override summaries. Validation accepts either boolean and retains all current language checks.

- [ ] **Step 4: Run thoth-jobs tests and verify pass**

Run: `rtk cargo test -p thoth-jobs`

Expected: PASS; legacy JSON resolves narration enabled.

- [ ] **Step 5: Write failing server HTTP tests for the enqueue gate**

Test these cases: forced Content Set + resolved narration false returns HTTP 422 and `{ "error": { "code": "forced_main_narration_required" } }`; forced + true enqueues; legacy + false enqueues; a package path outside Scout output returns `source_package_invalid`; rejection occurs before a job row/output import exists.

- [ ] **Step 6: Run the focused server tests and verify failure**

Run: `rtk cargo test -p thoth-server --test routes_http forced_main`

Expected: FAIL because `create_project_job` does not inspect the Content Set or narration setting.

- [ ] **Step 7: Implement the authoritative gate after settings resolution and before job ID/import**

```rust
if let Some(path) = resolved.ingest_source.content_set.as_deref() {
    let scout_root = canonical_scout_output_root()?;
    let forced = inspect_main_footage_descriptor(path, &scout_root)?;
    if forced.is_some() && !resolved.narration.enabled {
        return coded_validation(StatusCode::UNPROCESSABLE_ENTITY, "forced_main_narration_required");
    }
}
```

Return stable safe codes without absolute paths. The legacy `create_job(JobSpec)` endpoint has no profile snapshot, so a forced set requires explicit `params.narration_enabled == true`; missing/false returns `forced_main_narration_required`. Add the parameter to `validate_job_spec` and Task 12's worker mapping so this older route cannot claim narration and then run with it disabled.

- [ ] **Step 8: Add Dashboard profile and RunForm tests**

Test `ProfileStudio` reads/writes the narrator checkbox. Test `RunForm` refuses a forced handoff when the selected profile and one-off override resolve to disabled, displays “Narrator mode is required for URL main footage,” and never calls `createProfileJob`; forced + enabled submits normally.

- [ ] **Step 9: Implement Dashboard mirrors and immediate validation**

Add `enabled: boolean` to `ProfileSettings.narration`, `narration_enabled?: boolean` to `RunOverrides`, a narrator-mode profile control, a RunForm override selector with values keep/enabled/disabled, and `initialContentSetForced` handoff metadata in `App`. Immediate validation is advisory; retain server error-code mapping for manual Content Set paths.

- [ ] **Step 10: Run jobs/server/dashboard suites**

Run: `rtk cargo test -p thoth-jobs`

Run: `rtk cargo test -p thoth-server --test routes_http forced_main`

Run: `rtk bun --cwd dashboard test`

Expected: all PASS.

- [ ] **Step 11: Commit the narration gate**

```bash
rtk git add crates/thoth-jobs/src/profiles.rs crates/thoth-jobs/src/validation.rs crates/thoth-server/src/routes.rs crates/thoth-server/tests/routes_http.rs dashboard/src/api.ts dashboard/src/components/ProfileStudio.tsx dashboard/src/components/ProfileStudio.test.tsx dashboard/src/components/RunForm.tsx dashboard/src/components/RunForm.test.tsx dashboard/src/App.tsx
rtk git commit -m "feat: require narration for forced main footage"
```

### Task 4: Public Scout Flag Wiring and Preflight

**Files:**
- Modify: `scout/pipeline/run_pipeline.ts`
- Modify: `scout/pipeline/run_pipeline_acquisition.test.ts`
- Modify: `scout/cli.ts`
- Modify: `crates/thoth-server/src/scout.rs`
- Modify: `crates/thoth-server/tests/routes_http.rs`
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/api.test.ts`
- Modify: `dashboard/src/components/Discovery.tsx`

**Interfaces:**
- Produces: `RunPipelineOptions.useInputAsMain: boolean` and `mainCoverageTarget: number`.
- Produces: server `RunReq.use_input_as_main: bool`, `main_coverage_target: Option<f64>` and CLI flags `--use-input-as-main --main-coverage-target <number>`.
- Preflight requires supported normalized URL, writable output/package parent, FFmpeg, and FFprobe before acquisition begins.

- [ ] **Step 1: Write failing CLI/server/API/UI tests**

Assert default requests omit both flags; `use_input_as_main: true` emits `--use-input-as-main`; target `0.75` emits both flag/value; `0.59`, `1.01`, `NaN`, and missing value are rejected before `createContext`; Discovery checkbox is unchecked on initial render and remount and is not written to storage.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `rtk bun test scout/pipeline/run_pipeline_acquisition.test.ts dashboard/src/api.test.ts`

Run: `rtk cargo test -p thoth-server scout::tests::args_run`

Expected: FAIL on missing options and mappings.

- [ ] **Step 3: Implement strict parsing and early preflight**

```ts
const coverage = Number(getFlag('--main-coverage-target', '0.60'));
if (!Number.isFinite(coverage) || coverage < 0.60 || coverage > 1.00) {
  throw codedError('invalid_main_coverage_target');
}
```

Preflight uses existing URL normalization/capability discovery, verifies `fs.accessSync(parent, fs.constants.W_OK)`, and checks executable capability without inspecting the post's media from URL shape.

- [ ] **Step 4: Implement server/API/Dashboard mapping**

Add the unchecked “Use URL media as main footage” control and exact explanatory copy from the design. Send `main_coverage_target` only for API callers that explicitly choose a non-default; Dashboard sends only the boolean and uses `0.60` implicitly.

- [ ] **Step 5: Run focused and compatibility tests**

Run: `rtk bun test scout/pipeline/run_pipeline_acquisition.test.ts dashboard/src/api.test.ts`

Run: `rtk cargo test -p thoth-server scout::tests`

Run: `rtk bun --cwd dashboard test`

Expected: PASS; default request snapshots remain unchanged.

- [ ] **Step 6: Commit public-surface wiring**

```bash
rtk git add scout/pipeline/run_pipeline.ts scout/pipeline/run_pipeline_acquisition.test.ts scout/cli.ts crates/thoth-server/src/scout.rs crates/thoth-server/tests/routes_http.rs dashboard/src/api.ts dashboard/src/api.test.ts dashboard/src/components/Discovery.tsx
rtk git commit -m "feat: wire forced main footage run option"
```

### Task 5: Forced Source Package Acquisition

**Files:**
- Create: `scout/main_footage/source_package.ts`
- Create: `scout/main_footage/source_package.test.ts`
- Modify: `scout/acquisition/types.ts`
- Modify: `scout/acquisition/materialize.ts`
- Modify: `scout/acquisition/materialize.test.ts`
- Modify: `scout/pipeline/run_pipeline.ts`
- Modify: `scout/pipeline/run_pipeline_acquisition.test.ts`
- Modify: `scout/pipeline/build_footage.ts`
- Modify: `scout/pipeline/build_footage_acquisition.test.ts`

**Interfaces:**
- Consumes: `AcquisitionRunContext.service.inspectPost(url)` and `.materialize(asset, 'main')` through the shared kernel only.
- Produces: `buildSourcePackage({ post, contentSetPath, coverageTarget }, deps): Promise<{ descriptor; summary; excludedMediaIds }>`.
- Publication layout: `<content-set-parent>/main-footage/<package-id>/sources/`, `scene-index/`, `.tmp/`, and `package.json`; descriptor path is relative to the Content Set parent.

- [ ] **Step 1: Write failing mixed-post and partial-acquisition tests**

```ts
const media = [photo(0), video(1), photo(2), video(3)];
const result = await buildSourcePackage(input(media), depsFailingOnlyMedia3);
expect(result.package.sources.map(s => s.media_index)).toEqual([1]);
expect(result.package.ignored_photos).toHaveLength(2);
expect(result.package.unavailable_videos[0].warning_code).toBe('source_video_skipped');
expect(result.packageJson).not.toContain('ephemeral_url');
```

Also assert all-video failure throws `forced_main_no_usable_video` only after every candidate was attempted, accepted source bytes/checksum/FFprobe metadata match, and an interrupted temp file never appears in `sources/`.

- [ ] **Step 2: Run focused tests and verify module-not-found failure**

Run: `rtk bun test scout/main_footage/source_package.test.ts scout/acquisition/materialize.test.ts`

Expected: FAIL because `buildSourcePackage` is missing.

- [ ] **Step 3: Implement tolerant video-only materialization and atomic publication**

Partition the single inspected `PostRecord.media` by `kind`. Record photos without calling materialization. For each video, call the kernel, copy/hardlink returned local bytes to a package temp sibling, FFprobe duration/dimensions/audio, calculate SHA-256 and size, then atomically rename to `sources/<stable-source-id>.<ext>`. Record only safe `AcquisitionSource`, attempt count, elapsed time, and technical metadata.

- [ ] **Step 4: Make the forced branch authoritative in `runPipelineWithDeps`**

When enabled, call `buildSourcePackage` after the one seed inspection, write `main_footage`, and do not call `traceSource`. Pass the forced post/media identity set to `buildFootage` so those photos/videos cannot be reintroduced as enrichment. Continue comments, dossier, footage, figures, validation, and summary normally.

- [ ] **Step 5: Verify forced and legacy acquisition tests**

Run: `rtk bun test scout/main_footage/source_package.test.ts scout/pipeline/run_pipeline_acquisition.test.ts scout/pipeline/build_footage_acquisition.test.ts scout/acquisition/materialize.test.ts`

Expected: PASS; a legacy run still invokes `traceSource` exactly once and does not create a package.

- [ ] **Step 6: Run Scout typecheck and acquisition suite**

Run: `rtk bun --cwd scout run typecheck`

Run: `rtk bun --cwd scout run test:acquisition`

Expected: PASS.

- [ ] **Step 7: Commit source packaging**

```bash
rtk git add scout/main_footage/source_package.ts scout/main_footage/source_package.test.ts scout/acquisition/types.ts scout/acquisition/materialize.ts scout/acquisition/materialize.test.ts scout/pipeline/run_pipeline.ts scout/pipeline/run_pipeline_acquisition.test.ts scout/pipeline/build_footage.ts scout/pipeline/build_footage_acquisition.test.ts
rtk git commit -m "feat: package every usable forced source video"
```

### Task 6: Natural Scene Index with Vision Degradation

**Files:**
- Create: `scout/main_footage/scene_index.ts`
- Create: `scout/main_footage/scene_index.test.ts`
- Modify: `scout/main_footage/source_package.ts`
- Modify: `scout/main_footage/source_package.test.ts`

**Interfaces:**
- Produces: `indexSource(source, packageRoot, deps): Promise<SceneIndexV1>` and `indexPackage(packageManifest, deps): Promise<PackageSceneSummary>`.
- Dependencies are injected ports: `detectScenes`, `extractFrames`, `transcribe`, `describeWithVision`, `embed`, and `measureVisuals` so tests never call network or real models.
- Cache key includes source SHA-256 plus analyzer/model identities; cached evidence is reusable only when every declared artifact exists and checksums match.

- [ ] **Step 1: Write failing scene-index tests**

Assert boundaries are ordered and within source duration; scenes shorter than the natural-boundary tolerance are merged; start/middle/end frames are relative package paths; Vision success stores subject/action/setting/composition/motion/topic; Vision exception stores `analysis_status: "degraded"`, warning `vision_degraded`, transcript/caption embedding, and local luminance/color/sharpness/optical-flow metrics; unchanged fingerprint reuses the index; changed bytes or analyzer identity rebuilds it.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `rtk bun test scout/main_footage/scene_index.test.ts`

Expected: FAIL because `scene_index.ts` does not exist.

- [ ] **Step 3: Implement deterministic scene persistence**

Use FFmpeg scene scores for candidate boundaries, clamp/merge them deterministically, extract three representative frames per scene, associate transcript spans by temporal overlap, request structured Vision output, embed concatenated caption/transcript/Vision topic evidence, and persist metrics/artifact checksums under `scene-index/<source-id>/`. Never put raw model response bodies in the manifest.

- [ ] **Step 4: Integrate indexing before package publication**

`buildSourcePackage` indexes every accepted immutable source, writes scene summary references, calculates the package fingerprint after all indexes are complete, and publishes `package.json` last. Cancellation between sources keeps already published source/index checkpoints but does not publish a final manifest until internally consistent.

- [ ] **Step 5: Run focused tests, typecheck, and lint**

Run: `rtk bun test scout/main_footage/scene_index.test.ts scout/main_footage/source_package.test.ts`

Run: `rtk bun --cwd scout run typecheck`

Run: `rtk bun --cwd scout run lint`

Expected: PASS with no unsafe absolute/signed URL fields in persisted fixture snapshots.

- [ ] **Step 6: Commit scene indexing**

```bash
rtk git add scout/main_footage/scene_index.ts scout/main_footage/scene_index.test.ts scout/main_footage/source_package.ts scout/main_footage/source_package.test.ts
rtk git commit -m "feat: index forced footage by natural scenes"
```

### Task 7: Job-Owned Package Import and Narration Timeline

**Files:**
- Create: `crates/thoth-core/src/main_footage/import.rs`
- Create: `crates/thoth-core/src/narration/timeline.rs`
- Modify: `crates/thoth-core/src/narration/mod.rs`
- Modify: `crates/thoth-core/src/pipeline/job.rs`
- Modify: `crates/thoth-core/src/ingest/content_search.rs`
- Modify: `crates/thoth-core/src/lib.rs`
- Modify: `crates/thoth-core/src/config.rs`

**Interfaces:**
- Produces: `import_package(content_set_path, descriptor, job, scout_output_root) -> Result<ImportedSourcePackage>`.
- Produces: `build_narration_timeline(narration: &Narration, target: BeatPolicy) -> Result<NarrationTimelineV1>` and `write_narration_timeline(job, timeline)`.
- Job paths: `job.main_footage_dir()`, `job.source_package_manifest()`, `job.scene_index_dir()`, `job.plans_dir()`, `job.cuts_dir()`, and existing `job.narration_dir()`.

- [ ] **Step 1: Write failing import tests**

Assert a valid package is copied/hardlinked into `<job>/main-footage/`, imported manifest paths resolve only within that root, checksum mismatch and missing index return `source_package_invalid`, source files remain after the original Scout package is renamed, and cancellation leaves only atomic checkpoints.

- [ ] **Step 2: Write failing narration timeline tests**

```rust
#[test]
fn words_become_stable_contiguous_beats() {
    let timeline = build_narration_timeline(&narration_fixture(), BeatPolicy::default()).unwrap();
    assert_eq!(timeline.beats[0].start_sec, 0.0);
    assert!(timeline.beats.windows(2).all(|w| w[0].end_sec == w[1].start_sec));
    assert_eq!(timeline.beats.last().unwrap().end_sec, timeline.duration_sec);
}
```

Beat splitting uses sentence punctuation and word timings, then divides spans longer than six seconds at the nearest word boundary; IDs are `beat-001`, `beat-002`, and the fingerprint hashes narration audio plus normalized word timings/text.

- [ ] **Step 3: Run focused Rust tests and verify failure**

Run: `rtk cargo test -p thoth-core main_footage::import`

Run: `rtk cargo test -p thoth-core narration::timeline`

Expected: FAIL because both modules are absent.

- [ ] **Step 4: Implement job-owned import and path helpers**

Resolve the package manifest from the Content Set parent and configured Scout output root, decode/verify it, create job directories, import every source/index artifact using Task 1's safe helper, re-read and checksum the imported copy, and write the job-owned manifest last. Do not retain links to the Scout path in the job manifest.

- [ ] **Step 5: Implement narration beat generation and persistence**

Extract a public narration-generation result from the existing private pipeline method without duplicating its prompt/TTS logic. `Narration` remains the audio/word owner; the timeline module only segments stable timings and writes JSON atomically.

- [ ] **Step 6: Branch `run_once` before Stage 1 ingest for forced sets**

Legacy sets continue resolving/ingesting `main_url`. Forced sets import the package, retain existing title/comments/profile/dossier sidecars, and pass a `PlannedMainInput` into `PipelineRunner`; they must never synthesize or download `main.url` as the Stage 1 clip.

- [ ] **Step 7: Make narration fatal only for forced mode**

If the effective runtime config disables narration, return `forced_main_narration_required`. If script/TTS/timing fails, return `narration_generation_failed`. Keep current best-effort warning semantics for legacy mode. Apply the resolved profile's `NarrationSettings.enabled/language` to the job's runtime config before this check.

- [ ] **Step 8: Run focused and legacy pipeline tests**

Run: `rtk cargo test -p thoth-core main_footage::import narration::timeline ingest::content_search pipeline::`

Expected: PASS; legacy narration-failure test still continues while forced failure is terminal.

- [ ] **Step 9: Commit import and narration seam**

```bash
rtk git add crates/thoth-core/src/main_footage/import.rs crates/thoth-core/src/narration/timeline.rs crates/thoth-core/src/narration/mod.rs crates/thoth-core/src/pipeline/job.rs crates/thoth-core/src/ingest/content_search.rs crates/thoth-core/src/lib.rs crates/thoth-core/src/config.rs
rtk git commit -m "feat: import forced sources and emit narration timeline"
```

### Task 8: Candidate Tiers and Planner-LLM Ranking

**Files:**
- Create: `scout/main_footage/candidates.ts`
- Create: `scout/main_footage/candidates.test.ts`

**Interfaces:**
- Consumes: `SourcePackageV1`, `NarrationTimelineV1`, injected `embedText` and `rankShortlist` ports.
- Produces: `buildBeatCandidates(beat, scenes, policy, deps): Promise<RankedCandidate[]>` where every candidate references existing `beat_id`, `scene_id`, `source_id`, bounded `source_in_sec/source_out_sec`, `match_level`, deterministic similarity/quality scores, and safe editorial reason.
- Shortlist is bounded by `policy.maxCandidatesPerBeat`; the LLM ranks known candidate IDs only and cannot create timecodes, paths, transitions, or sources.

- [ ] **Step 1: Write failing tier/ranking tests**

Test direct visual/transcript evidence yields `exact`; shared package topic yields `topic_only`; unrelated evidence is excluded; embeddings pass only the configured top-K; unknown/duplicate LLM IDs are rejected; malformed LLM output falls back to deterministic embedding/quality order; degraded scenes remain eligible using caption/transcript/local evidence.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `rtk bun test scout/main_footage/candidates.test.ts`

Expected: FAIL because candidate builder does not exist.

- [ ] **Step 3: Implement evidence normalization, tiering, shortlist, and constrained ranking**

```ts
export interface RankedCandidate {
  beat_id: string;
  scene_id: string;
  source_id: string;
  source_in_sec: number;
  source_out_sec: number;
  match_level: 'exact' | 'topic_only';
  embedding_score: number;
  visual_quality_score: number;
  planner_rank: number;
  reason: string;
}
```

Natural scene bounds are the only initial time ranges. Boundary refinement can choose existing index boundary/frame points but must remain inside the scene/source. Normalize reasons to bounded plain text and never persist raw provider responses.

- [ ] **Step 4: Run test, typecheck, and lint**

Run: `rtk bun test scout/main_footage/candidates.test.ts`

Run: `rtk bun --cwd scout run typecheck`

Run: `rtk bun --cwd scout run lint`

Expected: PASS.

- [ ] **Step 5: Commit candidate ranking**

```bash
rtk git add scout/main_footage/candidates.ts scout/main_footage/candidates.test.ts
rtk git commit -m "feat: rank narration scene candidates"
```

### Task 9: Deterministic Global Timeline Allocator

**Files:**
- Create: `scout/main_footage/allocator.ts`
- Create: `scout/main_footage/allocator.test.ts`

**Interfaces:**
- Consumes: ordered narration beats, ranked main candidates, coverage target, and optional external candidates that already have verified job-local source paths. Remote enrichment entries are never eligible in planned mode; when no local external candidate exists, main candidates cover that slot.
- Produces: `allocateTimeline(input): AllocationResult` and `reallocateBeat(prior, failedItemId, candidates): AllocationResult`.
- `AllocationResult` is structurally complete but has no `cut_path`/checksum until Task 10 materializes it.

- [ ] **Step 1: Write failing invariant tests**

Cover: gap-free ordered timeline; exact candidates preferred; topic-only main cuts forced when needed to reach target; external cuts cannot reduce main share; same source on separated beats; identical range rejected when output starts less than eight seconds later and warning when fallback reuse is legal; long beat split into 1.5–6 second cuts at natural bounds; off-topic/empty/broken candidates excluded; stable output independent of input map iteration order; affected-beat replan leaves every other item unchanged.

- [ ] **Step 2: Run allocator tests and verify failure**

Run: `rtk bun test scout/main_footage/allocator.test.ts`

Expected: FAIL because allocator does not exist.

- [ ] **Step 3: Implement deterministic allocation and exact coverage math**

Sort by match tier, planner rank, embedding score, visual quality, lower reuse, then stable IDs. Build a full beat timeline, reserve enough main duration globally to satisfy target, replace eligible external slots with topic-only main candidates if necessary, and calculate main coverage as the union of non-overlapping visible `main_cut` durations divided by total primary duration. Handles and overlays never enter either sum.

- [ ] **Step 4: Implement deterministic affected-beat replacement**

Remove only the failed item, ban its candidate key for that plan attempt, allocate replacement(s) within the same beat coordinates, then re-run complete timeline/coverage/reuse validation. If none exists, return `cut_materialization_exhausted` with safe beat/item IDs.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `rtk bun test scout/main_footage/allocator.test.ts`

Run: `rtk bun --cwd scout run typecheck`

Expected: PASS and repeated runs serialize byte-identically.

- [ ] **Step 6: Commit allocator**

```bash
rtk git add scout/main_footage/allocator.ts scout/main_footage/allocator.test.ts
rtk git commit -m "feat: allocate deterministic main footage timeline"
```

### Task 10: Immutable Versioned Cut Materialization

**Files:**
- Create: `scout/main_footage/cuts.ts`
- Create: `scout/main_footage/cuts.test.ts`
- Create: `scout/main_footage/plan_job.ts`
- Modify: `scout/cli.ts`

**Interfaces:**
- Produces: `materializePlan(allocation, jobRoot, deps): Promise<MainFootagePlanV1>`.
- Produces internal command: `bun scout/cli.ts plan-main-footage --job-root <root> --package main-footage/package.json --narration narration/narration-timeline.json --coverage-target <target>`.
- Machine progress is newline JSON `{ stage, pct, message, warning? }`; messages contain relative paths/IDs only.

- [ ] **Step 1: Write failing version/cut/replan tests**

Assert first reservation is `v001`, existing versions are never modified, a narration fingerprint change reserves `v002`, style-only rerun returns existing active version, FFmpeg receives visible range plus available handles, published cut duration/checksum/FFprobe metadata match, first failure retries same command, repeated failure calls `reallocateBeat`, missing replacement returns `cut_materialization_exhausted`, and no plan is marked verified before every cut is valid.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `rtk bun test scout/main_footage/cuts.test.ts`

Expected: FAIL because cut materializer is absent.

- [ ] **Step 3: Implement version reservation and handle-aware cut publication**

Reserve `plans/vNNN/.reserved` using exclusive create, mirror version under `cuts/vNNN/`, and never reuse a partially verified version. Each FFmpeg output goes to a temp sibling, maps source video/audio without remote input, preserves source ambience, includes available head/tail handles, then passes FFprobe, expected-duration tolerance, byte-size, and SHA-256 checks before rename.

- [ ] **Step 4: Implement transitions and fallback selection**

Vision-compatible motion/composition may choose `match_cut`; soft changes choose `cross_dissolve`; strong discontinuity chooses `fade_through_black`. Clamp durations to `120..=300` ms. Missing handles force `match_cut`; degraded mode uses histogram/luminance/optical-flow rules, then short cross-dissolve when metrics fail. Persist `transition_fallback` warnings.

- [ ] **Step 5: Implement internal coordinator CLI**

Decode and fingerprint job-local package/timeline, build candidates, allocate, materialize, validate structural invariants, write `plans/vNNN/main-footage-plan.json` atomically with `status: "verified"`, and update `plans/active.json` only after success. Reject job roots/package paths that fail containment and reject any transport URL below this command boundary.

- [ ] **Step 6: Run focused tests, typecheck, and Scout suite**

Run: `rtk bun test scout/main_footage/cuts.test.ts scout/main_footage/allocator.test.ts scout/main_footage/candidates.test.ts`

Run: `rtk bun --cwd scout run typecheck`

Run: `rtk bun --cwd scout run test:acquisition`

Expected: PASS.

- [ ] **Step 7: Commit planning and cuts**

```bash
rtk git add scout/main_footage/cuts.ts scout/main_footage/cuts.test.ts scout/main_footage/plan_job.ts scout/cli.ts
rtk git commit -m "feat: materialize versioned narration planned cuts"
```

### Task 11: Rust Durability Gate and Resume State

**Files:**
- Create: `crates/thoth-core/src/main_footage/verify.rs`
- Create: `crates/thoth-core/src/main_footage/coordinator.rs`
- Modify: `crates/thoth-core/src/main_footage/mod.rs`
- Modify: `crates/thoth-core/src/pipeline/state.rs`
- Modify: `crates/thoth-core/src/pipeline/job.rs`
- Modify: `crates/thoth-core/src/util/progress.rs`

**Interfaces:**
- Produces opaque `VerifiedMainFootagePlan` with accessors for timeline, narration duration, warnings, metrics, version, and retained bytes; it can only be constructed by `verify_plan(job, imported, narration, plan_path)`.
- Produces `MainFootageCoordinator::prepare(job, input, narration, execution) -> Result<VerifiedMainFootagePlan>`.
- Adds `StageResults.main_footage: Option<MainFootageStageResult>` with source/narration/plan fingerprints, active version, planning mode, coverage, counts, transition distribution, warnings, and retained bytes.

- [ ] **Step 1: Write failing durability validator tests**

Start from the valid fixture and individually reject: source fingerprint mismatch, narration fingerprint mismatch, gap, overlap, beat mismatch, source range out of bounds, absolute/traversal/remote cut path, missing cut, checksum mismatch, FFprobe failure, duration mismatch, target below 0.60, actual below target, forbidden transition, duration 119/301 ms, invalid handles, identical-range reuse at 7.99 seconds, unknown source/scene, and unverified status.

- [ ] **Step 2: Write failing resume/invalidation tests**

Assert matching imported/narration/plan fingerprints reuse active plan; narration change keeps sources/index but invalidates plan/render and selects next version; source change invalidates indexes/plans/render; style/layout change leaves plan reusable; cancelled planning retains already atomically published sources/cuts but never records an unverified active plan.

- [ ] **Step 3: Run focused Rust tests and verify failure**

Run: `rtk cargo test -p thoth-core main_footage::verify main_footage::coordinator pipeline::state`

Expected: FAIL because validator/coordinator/state fields are missing.

- [ ] **Step 4: Implement deterministic validation**

Canonicalize every opened path beneath `job.root()`, recompute fingerprints/checksums, invoke FFprobe through the execution context, compare duration with an explicit `max(0.08 sec, one frame)` tolerance, validate sorted union coverage and eight-second spacing using integer milliseconds, and construct `VerifiedMainFootagePlan` only after all checks pass.

- [ ] **Step 5: Implement supervised Scout invocation and progress mapping**

Use `JobExecutionContext` supervised child APIs to invoke Task 10's command. Translate safe machine stages to the seven exact Thoth progress states, check cancellation before/after each checkpoint, and map command errors to stable terminal codes. Planner subprocess stdout must be parsed, not relayed as trusted logs.

- [ ] **Step 6: Implement state persistence and invalidation matrix**

Persist state after import, narration timeline, verified plan, and render. Reuse only when fingerprints plus declared files validate. Never delete old versions during invalidation; clear only active references/downstream stage results.

- [ ] **Step 7: Run focused tests and core checks**

Run: `rtk cargo test -p thoth-core main_footage:: pipeline::state`

Run: `rtk cargo check -p thoth-core`

Expected: PASS.

- [ ] **Step 8: Commit durability and resume**

```bash
rtk git add crates/thoth-core/src/main_footage/verify.rs crates/thoth-core/src/main_footage/coordinator.rs crates/thoth-core/src/main_footage/mod.rs crates/thoth-core/src/pipeline/state.rs crates/thoth-core/src/pipeline/job.rs crates/thoth-core/src/util/progress.rs
rtk git commit -m "feat: verify and resume planned main footage"
```

### Task 12: Planned Pipeline Orchestration

**Files:**
- Modify: `crates/thoth-core/src/pipeline/mod.rs`
- Modify: `crates/thoth-core/src/lib.rs`
- Modify: `crates/thoth-core/src/worker/mod.rs`
- Test: module tests in the same files

**Interfaces:**
- Consumes: `PlannedMainInput`, generated `Narration`, and `MainFootageCoordinator`.
- Produces explicit pipeline branch `run_planned_main(...)`; legacy `run(...)` remains the existing single-main path.
- Runtime profile snapshot applies `narration.enabled`/language before the forced-mode check.

- [ ] **Step 1: Write failing orchestration tests with injected stage fakes**

Assert ordered stages are import → validate index → narration → planning → materialization → verification → render; forced mode never calls main ingest or edit-time downloader; narration failure is terminal; planner failure maps to `cut_planning_failed`; missing cut fails before render; cancellation after import preserves imported package and skips later calls; matching resume state skips completed work; legacy branch call order is unchanged.

- [ ] **Step 2: Run focused pipeline/worker tests and verify failure**

Run: `rtk cargo test -p thoth-core pipeline:: planned_main worker::`

Expected: FAIL because there is no planned branch.

- [ ] **Step 3: Extract a branch-safe pipeline entry point**

Keep the current `PipelineRunner::run` signature and behavior for legacy callers. Add `run_planned_main(&PlannedMainInput, ...)` that prepares context sidecars, requires narration, writes its timeline, delegates planning/cuts to the coordinator, receives `VerifiedMainFootagePlan`, and calls the renderer. Do not route a package source through `IngestService` as a fake single main.

- [ ] **Step 4: Apply the resolved profile narration snapshot in the worker**

Deserialize `JobRecord.resolved_settings_snapshot` when present and apply only typed, validated settings before `run_once`; at minimum narration enabled/language must match the enqueue-time gate. For the profile-less legacy server endpoint, map validated `spec.params.narration_enabled` into the same runtime field. Missing snapshot/parameter retains CLI/config behavior for legacy direct jobs.

- [ ] **Step 5: Emit exact progress and safe terminal codes**

Use `emit_stage` at atomic checkpoint boundaries with monotonic percentages. Store detailed metrics/warnings in state/artifacts; progress messages contain safe counts, IDs, and relative paths only.

- [ ] **Step 6: Run pipeline, worker, and legacy regressions**

Run: `rtk cargo test -p thoth-core pipeline:: worker:: ingest:: edit::service::`

Expected: PASS; existing legacy tests remain byte/behavior compatible where snapshots exist.

- [ ] **Step 7: Commit orchestration**

```bash
rtk git add crates/thoth-core/src/pipeline/mod.rs crates/thoth-core/src/lib.rs crates/thoth-core/src/worker/mod.rs
rtk git commit -m "feat: orchestrate narration planned main footage"
```

### Task 13: Deterministic Planned Renderer, Transitions, and Ambience

**Files:**
- Create: `crates/thoth-core/src/edit/planned.rs`
- Create: `crates/thoth-core/src/edit/planned_ffmpeg.rs`
- Modify: `crates/thoth-core/src/edit/mod.rs`
- Modify: `crates/thoth-core/src/edit/ffmpeg.rs`
- Test: module tests in `planned.rs` and `planned_ffmpeg.rs`

**Interfaces:**
- Produces `PlannedRenderRequest { plan: VerifiedMainFootagePlan, narration: NarrationVoice, layout: OutputLayout, audio: AudioOptions, overlays: OverlayCues, output: PathBuf }`.
- Produces `PlannedRenderer::render(request, execution) -> Result<EditResult>`.
- Renderer receives no URL/client/planner interface; the type boundary makes edit-time media acquisition impossible.

- [ ] **Step 1: Write failing graph-construction tests**

Assert input order follows plan timeline regardless of filesystem order; visible durations exclude handles; `match_cut`, `cross_dissolve`, and `fade_through_black` generate bounded overlap without shifting narration coordinates; absent handles take the recorded fallback; source audio streams are normalized/micro-faded/ducked under narration; narration gaps rise only to ambience ceiling; muted safety metadata suppresses the source stream; BGM/SFX remain in the final mix; overlays do not change coverage duration.

- [ ] **Step 2: Write failing no-download API test**

Compile/run a test constructing `PlannedRenderRequest` exclusively from local paths and assert `planned.rs` has no dependency on `edit::overlay::fetch_overlay_from_url`, `reqwest`, acquisition types, or URL strings. Missing cut returns `plan_verification_failed` instead of attempting fallback download.

- [ ] **Step 3: Run focused renderer tests and verify failure**

Run: `rtk cargo test -p thoth-core edit::planned`

Expected: FAIL because planned renderer modules are absent.

- [ ] **Step 4: Implement the bounded renderer and filter graph**

Build one normalized video/audio stream per cut, trim handles into transition inputs, use `xfade`/fade-through-black only according to the verified plan, concatenate resulting visible timeline, delay/mix narration on the existing spine, apply `loudnorm` (or measured gain) and `sidechaincompress`/volume envelopes for ambience, and reuse existing subtitle/card/headline/BGM/SFX helpers after the primary timeline label is produced.

- [ ] **Step 5: Add short generated-media render tests**

Generate two color/test-tone clips in a temp directory with FFmpeg, construct a verified three-item plan that reuses source A, render it, then FFprobe output duration/video/audio streams. Delete/rename the original fixture sources after cut verification and prove rendering still succeeds from `cuts/v001/`.

- [ ] **Step 6: Run renderer and edit regressions**

Run: `rtk cargo test -p thoth-core edit::planned edit::ffmpeg edit::service`

Run: `rtk cargo check -p thoth-core`

Expected: PASS; legacy montage/download tests remain unchanged.

- [ ] **Step 7: Commit renderer**

```bash
rtk git add crates/thoth-core/src/edit/planned.rs crates/thoth-core/src/edit/planned_ffmpeg.rs crates/thoth-core/src/edit/mod.rs crates/thoth-core/src/edit/ffmpeg.rs
rtk git commit -m "feat: render verified local main footage plans"
```

### Task 14: Package Facts, Job Monitoring, and Explicit Cleanup

**Files:**
- Modify: `crates/thoth-server/src/routes.rs`
- Modify: `crates/thoth-server/src/lib.rs`
- Modify: `crates/thoth-server/tests/routes_http.rs`
- Modify: `dashboard/src/api.ts`
- Modify: `dashboard/src/api.test.ts`
- Modify: `dashboard/src/components/ContentSet.tsx`
- Modify: `dashboard/src/components/JobMonitor.tsx`
- Modify: `dashboard/src/App.tsx`

**Interfaces:**
- Produces safe package facts: platform/canonical URL, usable/skipped/ignored counts, total duration/bytes, analysis mode, fingerprint, warnings.
- Extends job manifest/status facts with stage, active plan version, planning mode, actual/target coverage, beat/cut/reuse counts, transition distribution, retry/replan warnings, relative artifact paths, retained bytes.
- Produces confirmed cleanup endpoints scoped to either one current Scout package ID or one job ID; request body must repeat the exact ID. Package cleanup removes that package directory. Job cleanup removes the exact resolved job artifact root—including imported sources/indexes, narration artifacts, every plan/cut version, and renders—while retaining the terminal database row as an audit record with an empty artifact manifest.

- [ ] **Step 1: Write failing server summary/cleanup tests**

Assert summaries expose no absolute path/signed URL; artifact manifest includes narration timeline, package, active plan, and cuts directory only when they exist; cleanup without/mismatched confirmation returns 422; `..`, encoded traversal, separators, symlinks escaping roots, and unknown IDs are rejected; package cleanup removes only the exact package directory; job cleanup removes only the exact job artifact root (including narration and renders), retains the terminal job row, and reports files/bytes; no background or age-based cleanup path exists.

- [ ] **Step 2: Run focused server tests and verify failure**

Run: `rtk cargo test -p thoth-server --test routes_http main_footage`

Expected: FAIL because summary/cleanup routes are missing.

- [ ] **Step 3: Implement read-only facts and destructive confirmation handlers**

Resolve IDs as single normal components beneath configured roots, canonicalize the target and parent, reject links/escapes, inventory files/bytes before deletion, delete only the exact terminal job artifact root or exact Scout package directory, and return `{ removed_files, removed_bytes, recoverable: false }`. Never accept a caller-provided absolute deletion target, and never delete the SQLite job/event audit row.

- [ ] **Step 4: Write failing Dashboard display/confirmation tests**

Test Content Set shows “Forced main,” counts, duration/size, mode/fingerprint/warnings. Test Job Monitor shows all post-plan metrics. Test cleanup requires opening confirmation, typing/clicking exact confirmation, calls the typed endpoint once, reports irreversible removal, refreshes facts, and does not delete on cancel.

- [ ] **Step 5: Implement API types and operational UI**

Map stable warning/error codes to human copy while retaining raw code for diagnostics. Use artifact endpoints/relative paths, never render private absolute paths. Keep cleanup controls disabled for running jobs and packages currently used by a running Scout command.

- [ ] **Step 6: Run server/dashboard tests and builds**

Run: `rtk cargo test -p thoth-server --test routes_http main_footage`

Run: `rtk bun --cwd dashboard test`

Run: `rtk bun --cwd dashboard run build`

Run: `rtk bun --cwd dashboard run lint`

Expected: all PASS.

- [ ] **Step 7: Commit monitoring and cleanup**

```bash
rtk git add crates/thoth-server/src/routes.rs crates/thoth-server/src/lib.rs crates/thoth-server/tests/routes_http.rs dashboard/src/api.ts dashboard/src/api.test.ts dashboard/src/components/ContentSet.tsx dashboard/src/components/JobMonitor.tsx dashboard/src/App.tsx
rtk git commit -m "feat: monitor and clean retained main footage"
```

### Task 15: Offline End-to-End Acceptance, Documentation, and Release Gate

**Files:**
- Create: `scout/main_footage/offline_acceptance.test.ts`
- Create: `crates/thoth-core/tests/planned_main_footage.rs`
- Create: `docs/main-footage.md`
- Modify: `scout/acquisition/run_all_tests.ts`
- Modify: `dashboard/src/components/Discovery.tsx`

**Interfaces:**
- Offline fixture shape is exactly `photo · video A · photo · video B` with multiple narration beats.
- The user-facing checkbox becomes available only when the complete package/index/planner/cut/durability/renderer capability is compiled and reported ready; there is no silent legacy fallback.

- [ ] **Step 1: Add the failing Scout offline acceptance test to the test runner**

The test generates two short local FFmpeg videos, injects a normalized mixed `PostRecord`, uses fixed Vision/embedding/planner fixtures, and asserts: only A/B are in `sources/`; A is reused on separated beats; every plan item has an existing cut before the result returns; main coverage is at least 0.60; timeline has no gap; no persisted signed URL; unchanged rerun does not reacquire/re-index.

- [ ] **Step 2: Run Scout acceptance and verify the first unmet integration seam fails**

Run: `rtk bun test scout/main_footage/offline_acceptance.test.ts`

Expected: FAIL at the first missing end-to-end integration, not due to network/model access.

- [ ] **Step 3: Add the failing Rust end-to-end render/resume test**

Import the generated package into a temp job, create multi-beat narration, invoke the real planner CLI with fixture provider ports, pass the durability gate, rename the original acquisition fixture, render, and assert FFprobe reports expected duration/video/audio. Resume must reuse unchanged sources/index/plan; changed narration creates `v002` while `v001` remains byte-identical.

- [ ] **Step 4: Close integration seams without weakening assertions**

Wire test-only injected provider configuration through the internal planner command, ensure cross-runtime fixtures use the same schema/fingerprint algorithm, and expose a server readiness capability only after the planned renderer/durability gate are present. Discovery keeps the checkbox disabled/hidden unless readiness is true.

- [ ] **Step 5: Write operator documentation**

Document exact Dashboard/API/CLI usage, `main_footage` discriminator, job directory layout, stage/resume rules, terminal/warning codes, retention/irreversible cleanup, storage reporting, offline verification commands, and a small-budget manual matrix containing one single-video plus one mixed post for each capable platform.

- [ ] **Step 6: Run the complete verification matrix**

Run: `rtk bun --cwd scout run typecheck`

Run: `rtk bun --cwd scout run test:acquisition`

Run: `rtk bun --cwd scout run lint`

Run: `rtk cargo test -p thoth-jobs`

Run: `rtk cargo test -p thoth-core`

Run: `rtk cargo test -p thoth-server`

Run: `rtk cargo check --workspace`

Run: `rtk cargo fmt --check`

Run: `rtk bun --cwd dashboard test`

Run: `rtk bun --cwd dashboard run build`

Run: `rtk bun --cwd dashboard run lint`

Expected: every command exits 0; acceptance has no live network dependency; legacy direct URL and legacy Content Set regressions are green.

- [ ] **Step 7: Perform safe manual live-platform smoke tests**

For each acquisition-capable platform, run one single-video and one mixed photo/video post with a controlled account/session. Confirm counts and warnings only; do not snapshot signed URLs or cookies. Record platform, canonical post ID, package fingerprint, usable/skipped/ignored counts, planning mode, coverage, and output FFprobe result in the release checklist.

- [ ] **Step 8: Verify the diff contains no placeholder or unsafe path drift**

Run: `rtk grep "TB[D]|TO[DO]|implement la[te]r|fill in deta[il]s|https://.*cut" scout/main_footage crates/thoth-core/src/main_footage docs/main-footage.md`

Expected: no implementation placeholders; any documented URL is an input example, never a cut path.

Run: `rtk git diff --check`

Expected: exit 0 with no whitespace errors.

- [ ] **Step 9: Commit acceptance and documentation**

```bash
rtk git add scout/main_footage/offline_acceptance.test.ts scout/acquisition/run_all_tests.ts crates/thoth-core/tests/planned_main_footage.rs docs/main-footage.md dashboard/src/components/Discovery.tsx
rtk git commit -m "test: accept forced narration planned main footage"
```

---

## Final Review Checklist

- [ ] Confirm every design completion criterion maps to Tasks 2–15 and no forced-mode requirement relies on the legacy single-main renderer.
- [ ] Confirm TypeScript/Rust names match exactly: `forced_url_pool`, `package_manifest`, `coverage_target`, `source_package_fingerprint`, `narration_fingerprint`, `timeline_start_sec`, `timeline_end_sec`, `source_in_sec`, `source_out_sec`, `head_handle_ms`, `tail_handle_ms`, `match_level`, and `transition_after`.
- [ ] Confirm the only public opt-in is `use_input_as_main`; the internal worker branch is selected from persisted `main_footage`, never transient request state.
- [ ] Confirm package planning accepts only imported job-local sources/indexes and planned rendering accepts only `VerifiedMainFootagePlan` local cuts.
- [ ] Confirm every write is temp-plus-atomic-rename, every version is immutable, and cancellation/resume never treats a partial artifact as complete.
- [ ] Confirm logs, API responses, manifests, errors, and tests contain no credentials, cookies, signed transport URLs, response bodies, or unnecessary absolute paths.
- [ ] Confirm cleanup is explicit, exact-ID confirmed, root-confined, reports irreversible deletion, and no automatic cleanup exists.
- [ ] Confirm `rtk git status --short` shows no unrelated files staged before each commit.
