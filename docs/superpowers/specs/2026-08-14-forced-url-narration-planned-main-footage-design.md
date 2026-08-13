# Forced URL Narration-Planned Main Footage — Design

**Date:** 2026-08-14
**Status:** Approved design, pending written-spec review
**Scope:** Explicit per-run use of every usable video in an input social post as a durable, narration-planned main-footage pool

## Summary

Add an opt-in `Use URL media as main footage` mode to Scout, the server API, the Dashboard, and the CLI. In this mode the input post is authoritative: `trace_source` may not replace it, editorial suitability gates become diagnostics, and every usable video in the post becomes part of a main-footage source package. Photo media from the same post is ignored completely.

The videos are not concatenated into one synthetic main video. Scout materializes each original video as an immutable local file, indexes natural scenes, and later maps narration beats to source time ranges. The same source may appear several times in the finished video. Every selected range is materialized as its own versioned, checksummed local cut before final editing begins. Thoth renders only a verified local-file timeline; expiring platform or CDN URLs never cross the durability gate.

This mode requires narrator-driven output. Vision analysis is preferred. When the Vision provider is unavailable, planning degrades explicitly to local scene detection, caption and audio transcript evidence, embeddings, and deterministic local visual metrics. The main-footage pool must occupy at least 60% of the primary visual timeline. Exact narration matches are preferred, but topic-level matches may be used to meet that target.

## Relationship to existing designs

This design builds on and narrows existing contracts rather than replacing them globally:

- **Shared Acquisition Kernel (2026-08-02):** all post inspection and media materialization continue through `AcquisitionService`. Pipeline code does not select yt-dlp, direct HTTP, CDP, or platform-specific tools.
- **Input-Post Main Suitability Gate (2026-07-29):** the gate remains authoritative for legacy runs. Explicit forced mode bypasses its editorial rejection outcomes while retaining technical availability checks and safety metadata. This is an explicit user override, not a weakening of the default gate.
- **Instagram Carousel Slide Footage (2026-07-28):** existing per-slide detection and resolution are reused where applicable. Forced mode generalizes the normalized-media behavior to every platform adapter and keeps every detected video, regardless of slide index. It does not apply the legacy `dropCoverSlide` rule because a video in slide 1 is valid source media; only photos are ignored.
- **Narration-Aligned Montage SP2 (2026-07-22):** legacy narrator montage remains unchanged. Planned mode replaces its remote/on-demand footage placement with a complete verified timeline. Existing comment, profile, image, meme, SFX, subtitle, and layout composition remains available on top of that timeline.

## Problem

The current Content Set contract provides one `main.url`. Scout may replace the input through `trace_source`, and Thoth ingests one main video before narration is created. In narrator montage, footage candidates are selected and downloaded during editing. Candidates are treated as single-use, and the renderer may depend on a remote URL at the point it needs the footage.

That model cannot express the requested behavior:

1. A social post may contain a mixture of photos and multiple videos.
2. The user must be able to force the post's videos to remain the authoritative main footage.
3. A source video may need to appear several times at different narration beats.
4. Selection must use visual meaning and narration context, not rigid carousel order.
5. Original media and selected cuts must exist as durable local files before editing.
6. A rerun must be reproducible and must not overwrite previous cut decisions.

Pre-concatenating all post videos is rejected. It hides source identity, makes partial replanning difficult, and invites the existing single-main editor to cut the synthetic file again. The durable unit is an immutable source file plus a versioned edit-decision manifest and materialized cuts.

## Goals

- Add an explicit, per-run forced-main control with default `false`.
- Support every platform whose acquisition adapter can return normalized video media.
- Extract only video media from the input post; ignore all photos from that post throughout the pipeline.
- Preserve every successfully acquired source video as an immutable local file.
- Use natural scene boundaries, Vision evidence, transcripts, and narration beats to select cuts.
- Allow repeated use of a source and constrained repeated use of an identical scene.
- Materialize every selected video segment as a verified local file before final editing.
- Keep input-post main footage at or above 60% of the primary visual timeline.
- Preserve external b-roll, comments, figures, references, discourse, cards, subtitles, SFX, and overlays.
- Make degraded planning visible, deterministic, resumable, and auditable.
- Keep legacy Content Sets and direct `--url` runs behaviorally compatible.

## Non-goals

- A manual timeline or per-cut editor.
- Persisting the forced-main checkbox in a project profile or browser storage.
- Using photos from the forced input post as main footage, b-roll, or image cards.
- Supporting forced-main mode without successful narrator audio and word timings.
- Generative transitions or an unrestricted transition vocabulary.
- Automatic source, plan, cut, or render cleanup.
- Moving Scout acquisition into Rust.
- Changing the editorial suitability policy for runs where forced mode is off.

## Locked product decisions

| Area | Decision |
|---|---|
| Semantics | Forced means the input post is authoritative. `trace_source` cannot replace it. |
| Default | Off. The choice applies to one run only. |
| Surfaces | Dashboard, server API, and CLI. |
| Platforms | Every supported Scout platform, capability-driven rather than name-gated. |
| Mixed posts | Keep every detected video; ignore every photo. |
| Partial acquisition | Skip unavailable videos with warnings; fail only when no video is usable. |
| Editorial gates | Off-topic/commentary/aggregator/subtitle verdicts become warnings or processing metadata. Technical media failures still reject an asset. |
| Narration | Required in forced mode. Narration-disabled or narration-generation failure is terminal and resumable. |
| Main share | At least 60% of primary visual duration, configurable for the run with a default of `0.60`. |
| Relevance | Prefer exact beat matches, then topic-level matches. Topic-level matches may be forced to meet coverage. Truly unrelated or technically invalid scenes remain excluded. |
| Reuse | A source may appear repeatedly. An identical time range is fallback-only and must be at least eight output seconds from its previous use. |
| Cut duration | Narration-paced, normally 1.5–6 seconds, refined to natural shot boundaries. A long beat may contain multiple cuts. |
| AI | Vision scene evidence → embedding shortlist → planner LLM → deterministic allocator → Vision boundary check. |
| Degraded AI | Local scene detection, caption/transcript evidence, embeddings, and deterministic local visual analysis. |
| Persistence | Immutable sources and versioned plans/cuts remain until explicit cleanup. |
| Continuation | Final editing starts automatically after the complete durability gate passes. |

## Architecture and ownership

### Scout owns acquisition and planning

Scout owns platform-facing and semantic media work:

1. inspect the canonical input post through `AcquisitionService`;
2. enumerate normalized media and discard photo media from forced-main consideration;
3. materialize video sources locally through the acquisition kernel;
4. build or reuse a scene index;
5. consume a narration timeline produced by Thoth;
6. rank and allocate source ranges to narration beats;
7. materialize versioned cut files;
8. verify the plan package before hand-off.

Platform pipeline code never calls a resolver directly. Signed URLs remain transport details inside acquisition/materialization and are not persisted as media identity.

### Thoth owns narration and deterministic rendering

Thoth owns the job lifecycle after a Content Set is submitted:

1. import the immutable source package into the job;
2. validate package and scene-index fingerprints;
3. generate required narration audio and word timings;
4. provide the narration timeline to the Scout planner;
5. validate the returned versioned edit plan and local cuts;
6. compose the visual timeline, audio mix, transitions, overlays, subtitles, cards, SFX, and output encodes.

The renderer does not understand platform URLs and does not download planned media. The manifest is the cross-runtime interface.

### Durability gate

The durability gate is the boundary between planning and final editing. It passes only when:

- the plan schema and fingerprints are valid;
- every narration beat is covered without timeline gaps or overlaps;
- required coverage and reuse invariants hold;
- every selected video segment has a local cut file;
- every cut passes path containment, file existence, FFprobe, duration, and checksum validation;
- every transition belongs to the approved palette and has valid handles;
- the plan status is `verified`.

No remote URL is allowed in a timeline item below this gate.

## Pipeline lifecycle

Forced mode uses a dedicated staged branch. The legacy six-stage single-main pipeline remains intact.

```text
1. Import Package
2. Validate Scene Index
3. Generate Narration
4. Plan and Materialize Cuts
5. Durability Gate
6. Compose and Render
```

### Stage 1 — Import package

The Content Set identifies an immutable Scout package. The worker imports it into the job by hardlink when source and destination are on the same filesystem and the operation is safe; it copies otherwise. Imported files are verified against the source manifest. The job owns its links or copies, so later source-package cleanup cannot invalidate a running or retained job.

### Stage 2 — Validate scene index

The worker verifies source fingerprints, scene time ranges, analysis schema versions, and the configured analysis identity. A valid source/index pair is reusable across narration and style reruns. Any source fingerprint change invalidates its scene index and every downstream plan.

### Stage 3 — Generate narration

Planned mode does not pretend a multi-source package is one ingest video. A `NarrationPreparationService` builds grounding input from:

- input post title, caption, and metadata;
- transcripts from every usable source video;
- comments, figures, references, discourse, and dossier;
- relevant enrichment context.

Narration must produce `narration.mp3`, word-level timings, and a narration fingerprint. Unlike legacy mode, failure is terminal because planning has no valid beat timeline without it. The job remains resumable and does not reacquire sources.

### Stage 4 — Plan and materialize

Thoth writes the narration timeline and invokes the Scout planning entrypoint with the package root, narration timeline, enrichment pool, main coverage target, output plan version, and cancellation context. Scout creates a new immutable version; it never overwrites an earlier plan or cut directory.

### Stage 5 — Durability gate

Thoth validates the complete returned plan. A failed cut is retried, then its beat is replanned against the next eligible candidate. If no candidate can materialize, the plan remains unverified and editing does not start.

### Stage 6 — Compose and render

The planned renderer consumes local files and validated edit decisions. It applies transitions and audio mixing at render time so clean cut assets remain reusable across styles.

## Data contracts

All persisted paths are relative to an explicit package or job root. Readers resolve and canonicalize a path, then prove it remains within the expected root before opening it. JSON schemas use explicit integer versions. Unknown future fields may be tolerated where existing Content Set forward compatibility requires it; unknown schema versions are rejected.

`main_footage.package_manifest` resolves relative to the Content Set file's parent and must remain inside the configured Scout output root. Paths inside the package manifest resolve relative to the package root. Narration, plan, and cut paths created after job import resolve relative to the job root. APIs expose these relative artifact paths or artifact endpoints rather than private absolute filesystem paths.

### Content Set extension

```json
{
  "main": {
    "url": "https://platform.example/post/123",
    "title": "Post title",
    "description": "Post caption"
  },
  "main_footage": {
    "mode": "forced_url_pool",
    "package_manifest": "main-footage/package.json",
    "coverage_target": 0.6
  },
  "footage": [],
  "comments": []
}
```

`main.url` remains the canonical context, attribution, and comment source. When `main_footage.mode == "forced_url_pool"`, it is not the Stage 1 ingest URL. A Content Set without `main_footage` follows the legacy contract.

### Source package manifest

The source package contains:

- `schema_version`, package ID, creation time, canonical post identity, platform;
- source package fingerprint;
- requested analysis identity and mode;
- usable source video entries;
- ignored photo entries and unavailable video outcomes;
- scene-index references and summaries;
- warnings and safe acquisition provenance.

Each video source entry has a stable source ID, media index, relative path, SHA-256, byte size, duration, dimensions, audio presence, and safe technical metadata. Ephemeral transport URLs are absent.

Each scene entry contains a stable scene ID, source ID, start/end time, representative-frame references, transcript text, Vision description when available, embedding reference, local visual metrics, topic classification, and analysis status.

### Narration timeline

```json
{
  "schema_version": 1,
  "narration_fingerprint": "sha256:...",
  "duration_sec": 47.3,
  "beats": [
    {
      "id": "beat-001",
      "start_sec": 0.0,
      "end_sec": 3.8,
      "text": "Narration text for the beat"
    }
  ]
}
```

Beat IDs and time ranges are stable for a narration fingerprint. Beats cover the narration timeline in order without overlap.

### Versioned main-footage plan

```json
{
  "schema_version": 1,
  "plan_id": "v001",
  "status": "verified",
  "planning_mode": "vision",
  "source_package_fingerprint": "sha256:...",
  "narration_fingerprint": "sha256:...",
  "coverage": {
    "target": 0.6,
    "actual": 0.66
  },
  "timeline": [
    {
      "item_id": "item-001",
      "beat_id": "beat-001",
      "timeline_start_sec": 0.0,
      "timeline_end_sec": 3.8,
      "asset_kind": "main_cut",
      "cut_path": "cuts/v001/beat-001-a.mp4",
      "source_id": "source-01",
      "source_in_sec": 12.4,
      "source_out_sec": 16.2,
      "head_handle_ms": 250,
      "tail_handle_ms": 250,
      "sha256": "...",
      "match_level": "exact",
      "reuse_count": 0,
      "transition_after": {
        "kind": "cross_dissolve",
        "duration_ms": 180
      }
    }
  ]
}
```

Timeline items are `main_cut` or `external_cut`. `timeline_start_sec` and `timeline_end_sec` are coordinates on the narration-aligned output timeline; they make several ordered cuts inside one beat unambiguous. `source_in_sec` and `source_out_sec` are coordinates in the immutable source, excluding transition handles. Cards and other overlays remain separate overlay cues and do not replace underlying primary-video time. The manifest records planner scores and reasons in diagnostic fields, but renderer correctness depends on validated decisions rather than prose.

Main coverage is calculated as the union of non-overlapping visible durations whose `asset_kind` is `main_cut`, divided by the narration-aligned primary-video duration. Transition handles, cover/title overlays, image/comment/profile cards, and audio-only time do not add to or subtract from the denominator. A valid strict plan has a target in `[0.60, 1.00]` and an actual value greater than or equal to that target.

## Source acquisition and indexing

### Preflight

When the control is enabled, `run_pipeline` registers inspect, comments, media, and social-card intents before the first visit. It inspects the post once through the shared acquisition context and partitions `PostRecord.media` by `kind`.

- `image` assets become ignored-photo records and are never passed to forced-main materialization or reintroduced through enrichment.
- `video` assets become source candidates, including a video at media index 1.
- Post/media identity deduplication prevents the same forced-post asset from returning through footage discovery.

The pipeline fails with `forced_main_no_usable_video` only after every video candidate exhausts the acquisition kernel's approved materialization paths.

### Atomic source materialization

Each video downloads to a temporary file under the package root. The published source preserves the full acquired video and audio stream; scene selection, trimming, loudness normalization, and transition handles happen only in derived cuts. Scout validates the media with FFprobe, computes SHA-256, writes its metadata, and atomically renames it into `sources/`. A crash or cancellation leaves either a complete accepted source or a disposable temporary file; it never publishes a partial source path.

### Scene indexing

For every accepted source:

1. local scene detection finds candidate shot boundaries;
2. representative start, middle, and end frames are extracted;
3. source audio is transcribed or associated with existing transcript evidence;
4. Vision describes subject, action, setting, composition, motion, and semantic topic;
5. text evidence is embedded;
6. deterministic local metrics record luminance, color distribution, sharpness, and optical flow;
7. scenes are persisted under the source fingerprint.

Vision failure does not discard an otherwise valid source. The index records degraded evidence and continues with scene detection, captions, transcripts, embeddings, and local visual metrics.

## Narration-aware planning

Planning is a constrained global allocation problem, not a free-form LLM response and not a greedy per-beat rotation.

### Candidate construction

Beat duration targets normally fall between 1.5 and 6 seconds. Natural shot boundaries refine start and end points. A long narration beat may receive multiple consecutive cut items rather than stretching or looping one short scene.

For each beat, the planner builds candidates in tiers:

1. **Exact:** visual/transcript evidence directly matches the narration beat.
2. **Topic-only:** the scene remains connected to the main topic but does not literally depict the beat.
3. **Off-topic:** no defensible topic connection; ineligible.

Embeddings create a bounded shortlist. The planner LLM ranks shortlist candidates and supplies an editorial reason. Vision verifies proposed boundaries when available. In degraded mode, deterministic local metrics replace the Vision boundary check.

### Deterministic allocator

The allocator validates and chooses the global timeline under these constraints:

- primary visual time is fully covered;
- `main_cut` duration is at least the configured target, default 60%;
- exact candidates outrank topic-only candidates when both satisfy remaining constraints;
- topic-only main candidates may be forced to meet main coverage;
- source reuse is allowed;
- an identical source time range is fallback-only and must begin at least eight output seconds after its preceding use;
- broken, empty, technically invalid, or off-topic scenes are excluded;
- visual variation is preferred after coverage and relevance constraints;
- long beats can receive multiple natural cuts;
- external b-roll fills eligible non-main slots but cannot reduce main share below the target.

Planner output is validated independently. An LLM cannot authorize an unknown source, an out-of-range timecode, a forbidden transition, or a path.

## Cut materialization and versioning

Each selected item is rendered first to a temporary local video. The cut preserves source audio and contains the selected content range plus transition handles where source bounds allow. A successful cut passes FFprobe, expected-duration tolerance, and checksum before atomic rename into its immutable version directory.

```text
sources/source-01.mp4
sources/source-02.mp4
scene-index/source-01.json
narration/narration-timeline.json
plans/v001/main-footage-plan.json
cuts/v001/beat-001-a.mp4
cuts/v001/beat-002-a.mp4
cuts/v001/beat-002-b.mp4
plans/v002/main-footage-plan.json
cuts/v002/...
```

A materialization failure follows this sequence:

1. retry the same deterministic operation within its bounded attempt policy;
2. mark the candidate unavailable for the current plan attempt;
3. replan only the affected beat against its next eligible candidates;
4. verify the complete new timeline;
5. fail with `cut_materialization_exhausted` if the beat has no materializable candidate.

An existing version is never modified. Narration changes create a new fingerprint and plan version. Style/layout-only changes reuse the active plan and cuts. Source changes invalidate the scene index and every dependent plan.

## Rendering

### Planned timeline renderer

Introduce a bounded renderer interface whose input is a validated plan, narration assets, output settings, and overlay cues. It resolves no platform media and performs no semantic candidate selection. It composes timeline items in manifest order and returns typed render artifacts.

Legacy `EditService` behavior remains available for a single ingested main. Planned mode reaches the new renderer through the explicit `main_footage` discriminator rather than by overloading `main.url` semantics deep inside the existing editor.

### Transition handles

The approved transition palette is:

- `match_cut` for compatible motion/composition;
- `cross_dissolve` for a soft visual change;
- `fade_through_black` for a strong time/topic discontinuity.

Durations are 120–300 ms. A cut may contain head/tail handles outside its visible content range. Overlap consumes handles rather than narration-aligned content. If required handles are absent or invalid, the renderer falls back to `match_cut`. In degraded planning, histogram, luminance, and optical-flow rules choose from the same palette; if local analysis fails, the final fallback is a short cross-dissolve.

Transitions are applied only in final rendering. Clean cut files remain reusable.

### Audio

- Source audio remains in every main or external video cut.
- Loudness is measured per source and normalized in the final mix.
- Narration speech drives a smooth ducking envelope over source ambience.
- Source audio may rise during narration gaps up to the configured ambience ceiling.
- Audio boundaries receive micro-fades to avoid clicks.
- Existing safety metadata may mute a cut whose source audio should not be heard.
- BGM, SFX, meme audio, and other existing mix policy remains downstream of the same narration spine.

## Public surfaces

### Dashboard

Add an unchecked control under `Discovery → Run pipeline`:

```text
Use URL media as main footage
Download every video from this post, ignore photos,
and build narration-aligned cuts.
```

The control applies to the Content Set produced by that Scout run. It is not stored in local storage or a profile. The UI explains that narrator mode is required. Scout may build the source package before a render profile is selected; when the Content Set is handed to `RunForm`, the selected profile's effective settings determine whether the render job is valid.

The Content Set view shows source-package facts available before rendering:

- `Forced main` badge;
- canonical URL and platform;
- usable and skipped video count;
- ignored photo count;
- total source duration and size;
- scene-analysis mode and package fingerprint;
- warnings.

The Job Monitor shows facts available after narration/planning:

- current stage;
- active plan version;
- Vision or degraded planning mode;
- actual main coverage;
- beat and cut count;
- source/scene reuse count;
- transition distribution;
- retry and replan warnings;
- relative artifact paths and retained storage size.

### Server API

Extend the Scout run request compatibly:

```json
{
  "url": "https://platform.example/post/123",
  "use_input_as_main": true,
  "main_coverage_target": 0.6
}
```

`main_coverage_target` is optional, defaults to `0.60`, and must be between `0.60` and `1.00`. The initial Dashboard uses the default and does not add a second control. API and CLI callers may increase the target per run. The server converts the request to Scout CLI flags. The persisted `main_footage` discriminator, not transient request state, selects the worker branch later.

### CLI

Scout exposes:

```text
bun scout/cli.ts run <url> --use-input-as-main [--main-coverage-target 0.60]
```

Thoth continues to receive the resulting Content Set through:

```text
thoth run --content <set.json>
```

No generic profile key is added. The source package and Content Set carry the decision explicitly.

## Validation, errors, and observability

### Early validation

Before Scout acquisition, reject:

- empty or unsupported input URLs;
- unwritable package/output roots;
- missing required FFmpeg or FFprobe capability.

Whether a post contains video is decided by inspection, not URL shape.

Before a forced Content Set can create or queue a render job, validate the selected profile's effective settings. Reject an effective `narration.enabled == false` with `forced_main_narration_required`. This validation belongs in `RunForm` for immediate feedback and in the server's job-creation boundary for authority. It occurs after reusable Scout acquisition may have completed, but before job import, narration, planning, or rendering work begins.

### Terminal errors

- `forced_main_no_usable_video`
- `forced_main_narration_required`
- `source_package_invalid`
- `narration_generation_failed`
- `cut_planning_failed`
- `cut_materialization_exhausted`
- `plan_verification_failed`

### Non-terminal warnings

- `source_video_skipped`
- `photo_slide_ignored`
- `vision_degraded`
- `exact_scene_reused`
- `topic_only_match`
- `transition_fallback`

Codes are stable API values. Messages are human-readable and include safe counts or IDs. Logs and diagnostics exclude cookies, credentials, signed media URLs, response bodies, and unnecessary absolute paths.

### Progress

Expose distinct progress states:

```text
importing_sources
validating_scene_index
generating_narration
planning_cuts
materializing_cuts
verifying_plan
rendering
```

Cancellation stops current child work and preserves every artifact already published by an atomic checkpoint. Resume begins from the last stage whose fingerprints and files remain valid.

## Storage and cleanup

Sources, scene indexes, narration artifacts, every plan version, every cut version, and output renders remain until explicit user cleanup. There is no age-based or post-render cleanup.

The Dashboard reports retained size. Cleanup requires explicit confirmation and reports what will be removed. Cleanup is scoped to a resolved package/job root; it never accepts a broad or unresolved filesystem target.

## Testing strategy

### Scout unit and contract tests

- A mixed normalized post produces video sources only; images become ignored records.
- A video at media index 1 remains eligible.
- Partial video acquisition publishes successful sources and safe warnings.
- All-video failure returns `forced_main_no_usable_video`.
- Source writes are atomic and checksummed.
- Scene ranges are ordered, bounded, and natural-boundary derived.
- Vision failure creates an explicit degraded index.
- Candidate tiers distinguish exact, topic-only, and off-topic.
- Global allocation meets coverage and complete-timeline invariants.
- A source may serve multiple beats.
- Identical range reuse enforces the eight-second spacing rule.
- Materialization retry and affected-beat replan are deterministic.
- Transition selection emits only the approved palette and bounds.
- Path traversal and paths outside the expected root are rejected.
- Acquisition logs and manifests contain no signed URL or credential material.

Vision and planner calls use injected fixtures. Tests assert schema and invariants rather than exact natural-language reasons.

### Rust unit and integration tests

- Legacy Content Sets still parse and select single-main behavior.
- `main_footage.mode` selects the planned branch.
- Narration-disabled planned mode fails before render.
- Source, scene index, narration, and plan fingerprints must agree.
- Timeline validation rejects gaps, overlaps, invalid source times, invalid paths, remote cut URLs, forbidden transitions, invalid handles, bad duration, and bad checksums.
- Coverage and reuse-spacing validation are exact and deterministic.
- A narration change invalidates the plan but retains imported sources/indexes.
- A style-only change reuses the plan.
- Cancellation retains prior checkpoints.
- Generated FFmpeg graphs preserve item order, use transition handles, and apply ambience ducking.
- A missing cut fails the durability gate and never triggers an edit-time download.

Use short local media fixtures so CI has no platform or network dependency.

### Dashboard and server tests

- The checkbox defaults to `false` and resets on remount/new run.
- API request, Rust argument mapping, and Scout CLI flag stay aligned.
- A forced Content Set paired with a narration-disabled effective profile is rejected by `RunForm` and the server job-creation boundary with an actionable validation error.
- Content Set shows source-package facts.
- Job Monitor shows stage, plan version, mode, coverage, warnings, and retained size.
- Cleanup requires explicit confirmation and resolves only the selected job/package.
- Stable backend codes map to the intended human message.

### End-to-end fixture acceptance

Use a local acquisition fixture equivalent to:

```text
photo · video A · photo · video B
```

Use a narration fixture with multiple beats. Acceptance proves:

1. only A and B appear in `sources/`;
2. A may produce cuts for more than one separated beat;
3. every selected segment exists in the versioned cut directory before render;
4. main coverage is at least 60%;
5. the primary timeline has no gap;
6. the output is playable and contains expected duration/audio streams;
7. removing the original fixture URL/source after the durability gate cannot affect render;
8. resume does not reacquire or re-index unchanged sources;
9. a narration change creates `v002` while preserving `v001`.

Live platform acceptance is manual and small-budget because login state, cookies, rate limits, and response shape are not stable CI dependencies. Test one single-video and one mixed-media post for each capable platform.

## Rollout sequence

1. **Contracts and validation:** add schema types, path/fingerprint validators, and backward-compatible Content Set parsing.
2. **Source package:** add forced input flag, normalized video-only acquisition, atomic materialization, summary API, and Dashboard package display.
3. **Scene index:** add local scene detection, Vision/degraded analysis, persistence, and cache invalidation.
4. **Narration seam:** extract narration preparation from the single-main assumption and emit the narration timeline.
5. **Planner and cut materializer:** add shortlist, planner, allocator, versioning, retry/replan, and durability verification.
6. **Planned renderer:** add local timeline composition, handles, transitions, ambience ducking, and existing overlay integration.
7. **Operational UI:** add Job Monitor states, warnings, storage reporting, resume, and explicit cleanup.
8. **Acceptance:** run offline end-to-end fixtures, regression suites, and controlled live platform checks.

Each rollout phase must leave legacy runs green. Keep the public control unavailable until the complete durability gate and planned renderer are present. A partially implemented flag must not silently fall back to single-main behavior.

## Risks and mitigations

- **Planning cost:** scene-level Vision can be expensive. Bound concurrency, persist by source fingerprint, use representative frames, and reuse indexes across plan versions.
- **Nondeterministic AI:** constrain AI to ranking known IDs; validate all structural decisions deterministically; record model/analyzer identity and planning mode.
- **Disk growth:** retain by explicit product decision, but expose size and targeted cleanup.
- **Cross-runtime drift:** version all contracts and maintain mirrored fixture tests in TypeScript and Rust.
- **Timeline math:** handle overlap can desynchronize narration. Store visible content duration separately from transition handles and test exact effective duration.
- **Platform media volatility:** complete acquisition before narration/planning and forbid remote URLs below the durability gate.
- **Legacy regression:** use a top-level discriminator and dedicated planned branch; keep `main.url` legacy flow untouched when the discriminator is absent.
- **Weak topic visuals:** allow topic-only matches to meet the user-selected 60% main share, while reporting them in warnings and metrics.

## Completion criteria

- The control exists on Dashboard, API, and CLI, defaults off, and is not persisted as a preference.
- Forced input cannot be replaced by `trace_source` or rejected by editorial suitability gates.
- A mixed post retains every usable video and no photo from that post enters primary or enrichment visuals.
- Original sources, scene index, narration timeline, versioned plans, and selected cuts are durable local artifacts.
- Narration is required and planner input uses its word-aligned beats.
- The same source can appear repeatedly; identical scene reuse follows the spacing rule.
- The verified timeline reaches at least 60% main footage and covers every beat.
- Every selected video segment is a verified local file before editing.
- Vision and explicit degraded planning both produce auditable planning modes.
- The renderer performs no platform-media download in planned mode.
- Transition and audio behavior follows the approved palette and ambience policy.
- Narration reruns create new versions without overwriting prior cuts.
- Cleanup occurs only after explicit user action.
- Legacy direct URL and legacy Content Set behavior remains green.
- Offline end-to-end acceptance and targeted live platform smoke tests pass.
