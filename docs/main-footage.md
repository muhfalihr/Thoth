# Forced-URL narration-planned main footage

Operator documentation for the `forced_url_pool` main-footage mode: what it does, what
it writes, how to resume it, what it deliberately does not do yet, and what still has to
be checked by a human before release.

---

## 1. What the mode is

Normally Thoth renders a main video it downloaded and analysed. In `forced_url_pool` the
operator forces a single source post: Scout acquires **every usable video in that post**,
indexes each into scenes, and the narration script — not the source's own timeline —
decides what the finished video shows. Every visible second is a cut chosen for a
narration beat.

Two runtimes are involved and neither is optional:

| Runtime | Responsibility |
|---|---|
| **Scout** (TypeScript on Bun, `scout/main_footage/`) | acquisition, packaging, scene indexing, candidate ranking, timeline allocation, cut materialization, plan publication |
| **Thoth core** (Rust, `crates/thoth-core/src/main_footage/` + `src/edit/planned*.rs`) | package import into the job, narration, planner supervision, plan verification, FFmpeg render |

They exchange JSON contracts only. There is no shared memory, no Scout call from the
renderer, and no network reachable from the render path.

---

## 2. Turning it on

The mode is requested by the **Content Set**, not by a CLI flag. Scout writes a
`main_footage` descriptor next to the Content Set:

```json
{
  "main_footage": {
    "mode": "forced_url_pool",
    "package_manifest": "main-footage/<post-id>/source-package.json",
    "coverage_target": 0.8
  }
}
```

- `package_manifest` is **relative to the Content Set file** and must canonicalize inside
  the configured Scout output root. A manifest anywhere else is rejected
  (`package_outside_scout_output`); this is a containment boundary, not a convenience.
- `coverage_target` is the fraction of narration time that must be covered by planned
  cuts. Valid range **0.60 – 1.00** inclusive; anything else fails validation before any
  work starts.

Narration is mandatory in this mode. A run with narration disabled fails immediately with
`forced_main_narration_required` rather than silently falling back to clip mode.

---

## 3. What lands on disk

Everything is job-owned after import. Deleting or renaming the Scout package cannot break
a job that already imported it.

```
<job-root>/
  main-footage/
    source-package.json          # job-owned manifest, re-fingerprinted from its own bytes
    sources/<source-id>.mp4      # the acquired videos
    scene-index/<source-id>/<cache-key>/<generation>/index.json
    packages/<fingerprint>/      # a *changed* package is imported beside the old one
  narration/
    narration.mp3
    timeline.json                # words + derived beats
  cuts/v001/<cut-id>.mp4         # immutable materialized cuts
  plans/v001/main-footage-plan.json
  plans/active.json              # the resume pointer
  planned_main.mp4               # the render
```

**Immutability rule.** Published cuts and plans are never rewritten. A new narration
produces `v002` beside `v001`; `v001` stays byte-identical. `plans/active.json` is the only
mutable file, and it only ever points at a plan that has already been verified.

---

## 4. Resume

`plans/active.json` records three fingerprints: the source package, the narration timeline,
and the plan itself. On a rerun the coordinator resumes only when the first two still match
what the job holds *and* the plan re-verifies against the cuts on disk. Anything else
replans into a new version.

Consequences worth knowing:

- Re-running an unchanged job re-embeds nothing and re-cuts nothing.
- Changing the narration replans; the old cuts remain on disk and are still addressable.
- Deleting a single cut file invalidates the plan — verification fails with
  `planned_cut_missing` rather than rendering a gap.

Beats are **derived** from words and are deliberately excluded from the narration
fingerprint, so re-deriving beats from unchanged words does not invalidate a plan.

---

## 5. Failure codes

Every terminal failure surfaces one of these, both in the job record and in the SSE stream:

| Code | Meaning |
|---|---|
| `forced_main_no_usable_video` | the forced post contains no downloadable video |
| `forced_main_narration_required` | the mode was requested with narration off, or narration produced no beats |
| `source_package_invalid` | the package failed decode, containment, or artifact verification |
| `narration_generation_failed` | narration or its timeline could not be produced |
| `cut_planning_failed` | allocation could not satisfy the coverage target, or the planner process failed |
| `cut_materialization_exhausted` | FFmpeg could not produce the planned cuts |
| `plan_verification_failed` | the published plan did not verify against the artifacts |

The planner subprocess only ever emits codes from this allowlist on stderr. Anything else
it might print is collapsed to `cut_planning_failed`, so an unexpected message cannot leak
a URL, a token or a local path into an operator-visible field.

---

## 6. Known limitations

These are deliberate. They are listed so nobody discovers them in production and files
them as regressions.

### 6.1 No subtitle burn-in

The planned renderer builds its graph from cuts, narration audio and layout only. The
subtitle burn-in that the clip-mode renderer performs is not wired into the planned graph.
A planned render has no on-screen captions.

### 6.2 No hook-title PNG overlay

`planned_ffmpeg.rs` *can* composite a hook-title image — the graph builder accepts
`hook_title_png` — but nothing in the planned pipeline ever supplies one. The hook text
lives on `narration::Narration.hook`, and the planned stage discards it when it converts
narration into a timeline. Wiring the overlay therefore means first carrying the hook
through the timeline contract, which is a contract change, not a render change.

### 6.3 No cover overlay

Same shape as 6.2: `cover` is an accepted graph input that the planned pipeline never
populates. There is no cover selection step in the planned path.

### 6.4 Scene-index checksum semantics differ across runtimes

Scout's `SceneIndexV1.checksum` is a **content fingerprint** over the source digest, the
planning mode, the projected scene evidence, and the bytes of every artifact a scene
declares — including the `-start.jpg` / `-end.jpg` frame siblings the typed contract never
names (`scout/main_footage/scene_index.ts::computeIndexChecksum`). It is *not* the digest
of `index.json` and cannot be recomputed by Rust, which does not import those siblings.

Rust therefore carries the value through unchanged and verifies the imported index file a
different way: the file must still declare the same `source_id`, `planning_mode` and
`scenes` as the manifest (`crates/thoth-core/src/main_footage/import.rs::verify_index_contents`).

If you change either side, change both. Treating the field as a file digest rejects every
genuine package.

---

## 7. Behaviour change: narration audio mix defaults

Before this feature the planned renderer's ducking constants were hardcoded at
`duck_event_vol = 0.25` and `leak_event_vol = 0.60`. Production now binds the configured
values through `pipeline::planned_audio_options`, and `NarrationConfig`'s defaults are
**`duck_event_vol = 0.12`** and **`leak_event_vol = 0.45`**.

**Source audio under narration is quieter than it used to be, and ambience leaking through
narration pauses is quieter too.** This is intended — the previous values were a fallback
that had drifted into production — but it is an audible change. Operators who preferred the
old mix should set the two values explicitly in `config.toml` rather than expect the old
numbers back.

The `0.25` / `0.60` pair still exists in `edit/planned.rs` as a last-resort fallback for a
render request that carries no narration voice at all. It is not the configured default and
must not be documented as one.

---

## 8. Test and gate constraints

### 8.1 The suite is verified serially, and only serially

Every gate command for this feature runs with `--test-threads=1`.

This is a **disclosed constraint, not a claim of determinism**. Task 14 reported ten
consecutive green parallel runs of `cargo test -p thoth-core --all-targets`. A reviewer ran
twelve and saw **ten green and two red**.

Task 15 reproduced it: eleven parallel runs of the same command produced **five red**. Every
failure was in `execution::tests`, and the failing assertions were all about process
liveness:

```
execution::tests::dropping_a_wait_future_does_not_orphan_the_process_tree
  -> process 32096 is still alive
execution::tests::immediately_exiting_roots_cannot_escape_job_ownership
  -> assertion failed: process_is_alive(child_pid)
execution::tests::immediately_exiting_roots_cannot_escape_job_ownership
  -> liveness probe for process 30660 could not answer (exit Some(1))
```

The cause is the test harness, not the product. `process_is_alive` identifies a process by
**PID alone** and answers by spawning a `powershell` child. Under parallel `cargo test` the
suite spawns hundreds of those, so three things go wrong at once: Windows reuses a freed PID
and an exited process looks alive; a just-spawned child is probed before it is schedulable
and looks dead; and the interpreter itself sometimes fails to start under load, which is the
`exit Some(1)` case. Closing this needs identity-aware probing — creation time and image
name captured at spawn — not a wider timeout. The in-code note at
`crates/thoth-core/src/execution.rs` records the same limitation.

Until that lands:

- The serial gate is the gate. A red parallel run is a **harness artefact in
  `execution::tests`** unless the failure is somewhere else, in which case investigate it.
- Do not "fix" a parallel failure by weakening an assertion.
- Do not add a claim of parallel determinism to this document or to a release record.

One related contributor is process-global state in binary resolution;
`PlannedFfmpegRenderer` deliberately keeps its resolved binary path as per-instance state
for that reason.

### 8.2 FFmpeg is required, never skipped

The tests that prove a playable file is produced fail with an explicit message when FFmpeg
is absent. They do not skip. A skipped media test is indistinguishable from a passing one in
a summary line, and this feature's whole output is media.

### 8.3 Offline planning

`THOTH_PLANNER_OFFLINE=1` makes the planner's two model-backed ports return exactly what a
machine with no API key returns — a null beat vector and no planner ranking — so an
end-to-end run needs no network. Candidate tiering, allocation, cutting and verification all
still run for real. Do not set it in production.

It exists because `scout/lib/env.ts` back-fills any falsy `process.env` entry from the
repository `.env`: unsetting an API key in a child process does **not** make that process
offline.

### 8.4 Latent invariant: failure-detail redaction

Redaction of operator-visible failures depends on `crates/thoth-core/src/worker/mod.rs`
persisting `Some(e.to_string())` — the error's own `Display` — rather than `{e:#}`. The
alternate formatter appends the full cause chain, which is where unredacted paths and URLs
live. Nothing in the type system prevents that edit. If you change how a worker failure is
persisted, re-check the redaction tests.

---

## 9. Pre-release live-platform smoke test — HUMAN ACTION REQUIRED

**This checklist has not been executed. The result columns below are intentionally empty.**

It cannot be executed by an automated agent: it requires controlled accounts on live
platforms, real authenticated sessions, and real network egress. Running it is a human
release action. Do not fill these cells from an offline run, and do not treat a green
automated suite as a substitute — the automated suite proves the *mechanism*, this
checklist proves the *integration with live platforms*.

Fill in `Result` (`pass` / `fail`), `Date`, and `Operator` at release time.

| # | Scenario | What must be true | Result | Date | Operator |
|---|---|---|---|---|---|
| 1 | Instagram single-video post | package has 1 source, plan renders, audio present |  |  |  |
| 2 | Instagram carousel, mixed photos + videos | only videos become sources; photos appear in `ignored` |  |  |  |
| 3 | TikTok post | acquisition succeeds; scene index is `vision`, not `degraded` |  |  |  |
| 4 | X / Twitter video post | acquisition succeeds with the configured cookie source |  |  |  |
| 5 | YouTube Shorts | acquisition succeeds; duration/aspect survive the render |  |  |  |
| 6 | Post with no downloadable video | fails with `forced_main_no_usable_video`, no partial job artifacts |  |  |  |
| 7 | Login-walled / removed post | fails with a redacted message; no URL or token in the job record |  |  |  |
| 8 | Long narration (> 90 s) over a short source | coverage target met by reuse; no cut shorter than the minimum |  |  |  |
| 9 | Rerun unchanged | resumes from `plans/active.json`; no re-cut, no re-embed |  |  |  |
| 10 | Rerun with edited narration | publishes `v002`; `v001` remains byte-identical |  |  |  |
| 11 | Cancel mid-plan | job ends `cancelled`; no half-written cut or plan is published |  |  |  |
| 12 | Render output inspection | playable in a normal player; narration audible; no black frames |  |  |  |

Sign-off (name / date) once every row above is filled and passing:

```
Released by: ____________________    Date: ____________
```
