# Task 15 — Offline End-to-End Acceptance, Documentation, and Release Gate

Append-only working record. Base commit `7a7c517`, tree clean (verified with
`git status --porcelain` -> empty).

## Reconnaissance (before first edit)

Branch surface: 80 files, +21455/-186 vs `master`, 40 commits `52fe793..7a7c517`.

Feature surfaces that exist today:

- Scout: `scout/main_footage/{source_package,scene_index,candidates,allocator,cuts,contracts,paths,plan_job}.ts`
  each with a co-located `.test.ts`. Runner: `scout/acquisition/run_all_tests.ts`.
- Rust: `crates/thoth-core/src/main_footage/{mod,import,verify,coordinator,paths,contracts}.rs`,
  render at `crates/thoth-core/src/edit/{planned,planned_ffmpeg}.rs`, wire types at
  `crates/thoth-types/src/main_footage.rs`.
- Server: `crates/thoth-server/src/routes.rs` (+ `tests/routes_http.rs`).
- Dashboard: `dashboard/src/api.ts`, `components/{Discovery,RunForm,JobMonitor,ContentSet,CleanupButton}.tsx`.
- `crates/thoth-core/tests/` does not exist yet -> Step 3's integration test is the
  first file in it.
- `docs/main-footage.md` does not exist yet.

Planned commit grouping (cheapest/green-soonest first, per kill-protection):

1. Carried Ruling AS items + Ruling AX liveness probe (small, self-contained).
2. Scout offline acceptance test + runner wiring + Ruling AV Scout-produced fixture.
3. Rust end-to-end render/resume test (`crates/thoth-core/tests/planned_main_footage.rs`).
4. Readiness capability (Ruling E) + Discovery gate.
5. `docs/main-footage.md` (Rulings G, AJ, AT, AW, plus FM4 latent invariant).

Known-going-in constraints:

- Ruling G: Step 7 is a human action. Template only, columns empty.
- Ruling AW: the gate runs serial. No parallel-determinism claim is permitted.

## Commit 1 — carried items (Ruling AS 1+2, Ruling AX)

Three changes:

1. `crates/thoth-core/src/edit/planned.rs:39-45` — corrected the factually wrong
   comment. `NarrationConfig` defaults are `0.12`/`0.45` (`config.rs:155-156`),
   not `0.25`/`0.60`; the constants are a no-voice fallback, not "the legacy
   narrator defaults".
2. `crates/thoth-core/src/edit/planned.rs` I4 — added the lead-in arrival
   assertion so the equality below cannot degrade into a tautology.
3. `crates/thoth-core/src/execution.rs` — Ruling AX. Probe now answers on
   `exit 0 = alive` / `exit 3 = dead` and panics on anything else, including a
   launch failure. Extracted `liveness_from_probe(pid, Option<i32>)` so the
   distinction is unit-testable.

### Verification (literal)

- `cargo test -p thoth-core --lib execution:: -- --test-threads=1`
  -> `test result: ok. 24 passed; 0 failed; 0 ignored; 324 filtered out` (exit 0).

### Mutation verification

M1 (Ruling AS item 1) — `crates/thoth-core/src/pipeline/mod.rs`
- old: `        lead_in_secs: narration.lead_in_secs,` — 1 occurrence
- new: `        lead_in_secs: 0.0,`
- RED: `edit::planned::tests::the_narration_lead_in_never_shifts_the_planned_graph`
- message: `the configured lead-in must reach the renderer before we can claim the graph ignores it` (left 0.0, right 2.5)
- exit 101. Reverted.

M2 (Ruling AX) — `crates/thoth-core/src/execution.rs`
- old: the `other => panic!("liveness probe for process {pid} could not answer ...")` arm — 1 occurrence
- new: `            _ => false,` (the pre-fix semantics)
- RED: `execution::tests::the_liveness_probe_separates_death_from_an_unanswerable_probe`
- message: `an unanswerable probe (Some(1)) must not be reported as a verdict`
- exit 101. Reverted.

### Gate finding, recorded early: `cargo fmt --check` does NOT exit 0

`cargo fmt --check` reports diffs in **83 distinct files** repo-wide. This is a
pre-existing baseline condition, not introduced by this branch or this task:

- I stashed only my two edited files and re-ran: still **83** files, and both
  `execution.rs` and `edit/planned.rs` were already on the list before my edits.
- The list includes files outside the branch's 80-file diff entirely (e.g.
  `crates/thoth-core/src/analyze/asset_catalog.rs`), so it predates the plan.

Step 6 expects exit 0 here. It does not, and it did not before Task 15. Reported,
not fixed: reformatting 83 files would bury the release diff.

## Commit 2 — Scout offline acceptance test (Steps 1, 2)

`scout/main_footage/offline_acceptance.test.ts` (new). Runs the whole forced-URL path
offline: real ffmpeg generates two 15 s sources, a mixed `PostRecord`
(`photo · video A · photo · video B`) goes through the real `buildSourcePackage`,
a three-beat narration timeline is written, and the real `runPlanMainFootageCli`
plans, cuts and verifies. Only the four external intelligences are injected
(scene boundaries, vision, embeddings, planner ranking). `ffmpeg`/`ffprobe` are the
production ports.

`scout/main_footage/plan_job.ts` — exported `ffmpegCut` so the acceptance test drives
the real cut-command builder rather than a double.

**`scout/acquisition/run_all_tests.ts` needed no change.** The plan's file list predates
Task 12/13, which replaced the hand-maintained list with directory discovery of every
`*.test.ts` under `scout/`. Verified: the suite reports `56 files` (was 55) and greps
`offline_acceptance` once.

### Step 2 outcome — honest deviation

The brief expects this test to FAIL first at an unmet integration seam. **It passed on
the first run.** That is a real outcome, not a weakened test: Task 15 is the last task,
and Tasks 1-14 closed every seam it exercises. Because "it passed immediately" is exactly
what a vacuous test also looks like, the discrimination is established by mutation below
instead of by an initial RED.

### Verification (literal)

- `bun scout/main_footage/offline_acceptance.test.ts` -> `ok main_footage_offline_acceptance`, exit 0.
- `bun run --cwd scout typecheck` -> `tsc --noEmit`, exit 0.
- `bun run --cwd scout test:acquisition` -> `ok acquisition_suite (56 files)`, exit 0.

### Gate finding: `bun run --cwd scout lint` does NOT exit 0

`292 errors / 242 warnings / 122 infos` across 164 files. Pre-existing: with my new file
removed the run is `292 errors / 242 warnings / 122 infos` across 163 files — my file
contributes **0**. (It contributed 1 formatting error before `biome check --write`.)

### Mutation verification of the acceptance test (post-commit, all reverted)

M3 — `scout/main_footage/source_package.ts`: let photos into `sources`.
- RED: `only the two videos are ever fetched` (deepEqual `[0,1,2,3]` vs `[1,3]`).

M4 — `scout/main_footage/cuts.ts`: skip `atomicPublish` in `publishCut`.
- RED: `plan item item-001 returned without its cut on disk`.

M5 — `scout/main_footage/plan_job.ts`: `const reusable = null` (never resume).
- RED: `an unchanged rerun must not re-embed`.

M6 — `scout/main_footage/source_package.ts`: persist `ephemeral_url` into the manifest.
- RED: `signed acquisition URL leaked into scout-output\main-footage\v001\package.json`.

Each mutation was applied singly, the suite run, the RED message recorded, then reverted.

## Commit 3 (`9c060e4`) — RELEASE BLOCKER found and fixed

### The finding

`SceneIndexV1.checksum` is Scout's **content fingerprint** (`scene_index.ts::computeIndexChecksum`:
`fingerprintCanonical({source_checksum, planning_mode, scenes-projection, artifact byte
hashes})`), not `sha256(index.json)`. It cannot equal the file digest — it hashes inputs the
file does not contain, including the `-start.jpg`/`-end.jpg` siblings the typed contract
never names. `import.rs:196` verified it as a file digest.

**Consequence before this commit: every genuine forced-URL package failed import with
`source_package_invalid: artifact_checksum_mismatch`. The feature could not run at all.**

Measured, not inferred. A throwaway probe drove the real `buildSourcePackage` (real ffmpeg
media, fixture scene/vision ports) and printed:

```
declared index.checksum : sha256:a723510998eacf9dc4f571b93a39472d2555da4fee77b90fb6dc8584ec8741ad
sha256(index.json file): sha256:26f5b4bc06ab61f09720844864156ce307bb8c075ea3afd12bd36f50a8af4d1d
EQUAL: false
source declared: sha256:434e69b8... | file: sha256:434e69b8... | EQUAL: true
```

Source checksums are genuine file digests; only the scene index was wrong. The probe script
was deleted after use.

### Why 8 existing tests hid it

`import.rs`'s fixture wrote `index_bytes = {"scenes":[{"id":"scene-0"}]}` and declared
`"checksum": digest(&index_bytes)`. The fixture was built to match the implementation's
assumption, so the assumption was never tested. One of the 8 was even named
`import_accepts_the_source_members_scout_actually_writes`.

### The fix

`verify_index_contents` replaces `verify_checksum` for scene indexes: decode the imported
file with a non-`deny_unknown_fields` mirror (tolerating `analyzer_identity`) and require
`source_id`, `planning_mode` and `scenes` to equal what the manifest declares, compared
through Rust's own serializer. Scout's checksum is carried into the job manifest unchanged;
Rust no longer pretends to be able to recompute it.

Rejected alternative: mirroring `computeIndexChecksum` in Rust. It hashes the
`-start.jpg`/`-end.jpg` artifacts, which `import_package` does not import, so Rust could not
recompute it without also changing what gets imported. That is a design change, not a fix.

### Verification (literal)

- `cargo test -p thoth-core --lib main_footage::import -- --test-threads=1`
  BEFORE fixture repair: `test result: FAILED. 7 passed; 8 failed` — all 8 with
  `source_package_invalid: scene_index_rejected`. That is the honest RED the plan's Step 2
  expected, arriving here instead.
- After: `cargo test -p thoth-core --lib main_footage:: -- --test-threads=1`
  -> `test result: ok. 55 passed; 0 failed`.
- `cargo test -p thoth-core --all-targets -- --test-threads=1` -> `350 passed`.
- `cargo test -p thoth-core --test planned_main_footage -- --test-threads=1` -> `2 passed`.
- `bun run --cwd scout typecheck` -> exit 0.
- `bunx biome check main_footage/plan_job.ts main_footage/contracts.test.ts`
  -> `Found 3 errors` both with and without my edits (stash-compared): my diff adds 0.

Discrimination for the replacement check is inside
`a_scene_index_is_verified_against_its_declared_scenes_not_a_file_digest`: the second half
rewrites `scenes[0].end_sec` in the published file only and requires
`scene_index_contents_mismatch`. Without the new check that half passes silently.

### Also in this commit

- `THOTH_PLANNER_OFFLINE=1` (Step 4 seam). `scout/lib/env.ts` fills any falsy
  `process.env` entry from the repo `.env`, so clearing `THOTH_NOVITA_API_KEY` cannot
  make a subprocess offline and setting a dummy makes it attempt a real fetch. An
  explicit flag is the only honest offline switch.
- `crates/thoth-core/tests/fixtures/scout_source_package.v1.json` (Ruling AV) captured
  from a real `buildSourcePackage`, decoded from both runtimes
  (`crates/thoth-core/tests/planned_main_footage.rs` + `scout/main_footage/contracts.test.ts`)
  with a cross-runtime fingerprint equality assertion (Ruling AU).

## Commit 4 (`0623502`) + Commit 5 (`75b9b2c`) — `docs/main-footage.md`

Step 5. Operator guide (mode, descriptor, on-disk layout, resume, failure codes) plus the
four rulings that had to be written down:

- **Ruling AJ** — §6.1/6.2/6.3: no subtitle burn-in, no hook-title PNG overlay, no cover
  overlay. Verified in source, not assumed: `planned_ffmpeg.rs` *accepts* `hook_title_png`
  and `cover` (lines 87-88, 262-282, 333-338) but the planned pipeline never populates
  them — `planned_audio_options` (`pipeline/mod.rs:145`) only sets narration and mute. The
  hook case is a contract change because the text lives on `narration::Narration.hook`,
  which the planned stage drops when building the timeline.
- **Ruling AT** — §7: the mix default change from hardcoded `0.25`/`0.60` to configured
  `0.12`/`0.45`, described as an audible change with the remedy.
- **Ruling AW / AG** — §8.1: serial-only, plus the root cause below.
- **FM4 latent invariant** — §8.4: redaction depends on `worker/mod.rs` persisting
  `Some(e.to_string())`, not `{e:#}`. Confirmed present at `worker/mod.rs:256`.
- **Ruling G** — §9: the live-platform checklist is a 12-row template with `Result`,
  `Date` and `Operator` **empty**, headed by an explicit statement that it has not been
  executed and is a human release action. Nothing is pre-filled.
- §6.4 documents the scene-index checksum divergence found in Commit 3.

### Ruling AW — the parallel non-determinism is now root-caused (measured)

Eleven parallel runs of `cargo test -p thoth-core --all-targets`: **six green, five red**
(5 runs in the gate script, 6 in a follow-up capture). Every failure was in
`execution::tests`:

```
RUN 1 EXIT=101  (name truncated by tail; 348 passed, 1 failed)
RUN 2 EXIT=101  execution::tests::dropping_a_wait_future_does_not_orphan_the_process_tree
                -> process 32096 is still alive
RUN 3 EXIT=101  execution::tests::immediately_exiting_roots_cannot_escape_job_ownership
                -> assertion failed: process_is_alive(child_pid)
RUN 5 EXIT=101  execution::tests::immediately_exiting_roots_cannot_escape_job_ownership
                -> liveness probe for process 30660 could not answer (exit Some(1))
RUN 6 EXIT=101  execution::tests::immediately_exiting_roots_cannot_escape_job_ownership
                -> assertion failed: process_is_alive(child_pid)
```

Cause: `process_is_alive` identifies a process by PID alone and answers by spawning a
`powershell` child. Under parallel load that gives reused-PID false positives, not-yet-
scheduled false negatives, and interpreter-start failures (the `exit Some(1)` case — which
Ruling AX's probe correctly refused to interpret as "dead" instead of silently lying).

**No claim of parallel determinism is made anywhere.** The gate is serial.

## Step 8 — placeholder scan

`grep -rniE 'TODO|FIXME|XXX|HACK|placeholder|unimplemented|todo!\('` over
`scout/main_footage`, `crates/thoth-core/src/main_footage`, `crates/thoth-core/tests` and
`docs/main-footage.md` -> **0 matches**. (A wider scan including `edit/planned*.rs` and the
phrase "stub" returns 3 lines, all prose: two use "stub" as the allocator's term for a
sub-minimum leftover segment, one records that a placeholder renderer *was replaced*.)

`git diff --check` -> exit 0.

## Mutation verification round (Task 15, post-gate)

All three mutations were applied, run, and reverted. `git status --porcelain` is empty
after each revert.

### M-AR — Ruling AR: FFmpeg-absent fails, never skips (inspection, not mutation)

`crates/thoth-core/src/edit/planned.rs:688` defines `FFMPEG_REQUIRED` and both real-media
tests call `test_ffmpeg().expect(FFMPEG_REQUIRED)` (lines 784, 1042). There is no
skip-style early return in that file. Verified by reading, not by uninstalling FFmpeg —
stated plainly because it is an inspection claim.

### M-F1 — Item 3/F1: `dashboard/src/api.test.ts:399`

Target test: `ContentSet package cleanup deletes nothing when the operator cancels`
(api.test.ts:399-420).
Mutated file: `dashboard/src/components/CleanupButton.tsx`.
Literal `old`: `            <Button variant="outline" size="sm" onClick={close}>` — 1 occurrence.
Literal `new`: same line with `onClick={run}`.
RED result: `(fail) ContentSet package cleanup deletes nothing when the operator cancels`,
`error: expect(received).toHaveLength(expected)` at api.test.ts:418, `39 pass 1 fail`, EXIT=1.
Reverted; re-run `40 pass 0 fail`, EXIT=0.

### M-I4 — Task 6 / Ruling M: source checksum test still discriminates

Mutated `crates/thoth-core/src/main_footage/import.rs::verify_checksum`,
`if sha256_file(path)? != expected {` -> `if false && sha256_file(path)? != expected {`.
RED result: exactly one test failed —
`main_footage::import::tests::source_checksum_mismatch_is_source_package_invalid`,
panic at `import.rs:675:42`. `15 passed; 1 failed`.
Reverted; `16 passed; 0 failed`.

### M-IDX — the new scene-index verification test discriminates

Mutated `verify_index_contents`, guarding the mismatch branch with `if false && (...)`.
RED result: exactly one test failed —
`a_scene_index_is_verified_against_its_declared_scenes_not_a_file_digest`, panic at
`import.rs:774:36`, message `a rewritten index file must not import`. `15 passed; 1 failed`.
Reverted; `16 passed; 0 failed`.

## Step 4 closed: server readiness capability (commit 516a210)

`GET /api/scout/status` now reports `main_footage_ready`. Predicate:
`crates/thoth-server/src/routes.rs::planner_is_installed(FsPath::new(SCOUT_PLANNER))`,
`SCOUT_PLANNER = "scout/main_footage/plan_job.ts"`, resolved cwd-relative exactly like
`scout::SCOUT_CLI`. The Rust half is not probed because it is linked into the binary.

Dashboard: `Discovery.tsx` disables the "Use URL media as main footage" checkbox, greys the
label, shows the reason, and forces `use_input_as_main: false` in the POST body when
readiness is false. A payload with no `main_footage_ready` at all counts as NOT ready.
`api.ts` carries the field as optional for exactly that reason.

Mutation verification for this commit:

- `Discovery.tsx`, `const mainFootageReady = status?.main_footage_ready === true;`
  -> `= true;`. RED: `(fail) Discovery refuses forced main footage when the server reports it
  unready`, `40 pass 1 fail`. Reverted -> `41 pass 0 fail`.
- `routes.rs`, `SCOUT_PLANNER` value `plan_job.ts` -> `planner.ts`. RED: exactly one test,
  `routes::readiness_tests::the_probed_path_names_the_planner_this_repository_ships`, panic at
  `routes.rs:1761:9`, `SCOUT_PLANNER no longer points at a module in this repository`.
  Reverted -> `2 passed`.
- `readiness_follows_whether_the_planner_module_is_actually_a_file` was NOT mutation-verified
  against production code; it is a direct three-state table test of the predicate itself
  (missing / directory / file).

## build_cuda.bat

Invoked from Bash as `cmd //c ".\build_cuda.bat"`. It was a real build, not the documented
Bash no-op: the log header names this worktree, compilation of thoth-jobs / thoth-core /
thoth was observed progressing live, and it ended
`Finished 'release' profile [optimized] target(s) in 21m 23s`, `[exited with code 0]`.
`target/release/thoth.exe` mtime `2026-08-24 17:09:51 +0700`, i.e. minutes before this was
recorded. Zero lines in the log start with `error` or `warning`.

CAVEAT (corrected by Ruling BB): this build ran BEFORE commit 516a210.
`build_cuda.bat` builds `thoth` with CUDA **and** `thoth-server`; it does not build the
dashboard, which is covered by `bun run --cwd dashboard build` and `bun test`. The controller
independently verified the `thoth-server.exe` artifact as fresh after 516a210, so the build
requirement is satisfied at HEAD. Per the ruling, the CUDA build was NOT re-run afterwards.

## Final gate matrix (run after the last commit, 7366a4f)

    bun run --cwd scout typecheck              EXIT=0  (tsc --noEmit, silent)
    bun run --cwd scout test:acquisition       EXIT=0  ok acquisition_suite (56 files)
    bun run --cwd scout lint                   EXIT=1  295 errors / 164 files  <-- see below
    cargo test -p thoth-jobs --test-threads=1  EXIT=0  72 passed; 0 failed
    cargo test -p thoth-core --all-targets
      --test-threads=1                         EXIT=0  349 + 2 + 1 passed; 0 failed
    cargo test -p thoth-server --test-threads=1 EXIT=0 24 + 1 + 1 + 102 passed; 0 failed
    cargo check --workspace --all-targets      EXIT=0
    cargo fmt --check                          EXIT=1  pre-existing; see below
    bun test --cwd dashboard                   EXIT=0  41 pass 0 fail
    bun run --cwd dashboard build              EXIT=0  built in 670ms
    bun run --cwd dashboard lint               EXIT=0  (warnings only, pre-existing)
    git diff --check                           EXIT=0

### `bun run --cwd scout lint` EXIT=1 — measured, not assumed

Baseline measured directly: my new file moved aside, both modified files checked out at
`7a7c517`, `biome check .` in `scout/` -> **`Checked 163 files ... Found 295 errors`**.
With my changes: **`Checked 164 files ... Found 295 errors`**. My diff adds **zero** lint
errors. (An earlier note in this file said the baseline was 292; that figure was wrong and
this measurement supersedes it.) The three diagnostics in files I touched are all
`noUselessLoneBlockStatements` at `contracts.test.ts:60,66,85` — the file's pre-existing
bare-block test idiom, not lines I wrote. Tree verified clean after the measurement.

### `cargo fmt --check` EXIT=1 — pre-existing, my code is clean

27080 diff lines repo-wide. After fixing the one hunk rustfmt raised against my own code
(an `assert!` in `readiness_tests`), a grep of the fmt output for every identifier I
introduced (`planner_is_installed`, `main_footage_ready`, `readiness_tests`,
`SCOUT_PLANNER`, `verify_index_contents`, `PublishedSceneIndex`) returns **0 matches**.

---

# Task 15 — fix round 1 (second implementer dispatch)

Base `7366a4f`, tree verified clean (`rtk proxy git status --porcelain` -> 0-byte file).
Everything below this heading is the fix round; nothing above it was edited except where
Ruling BB explicitly required a false statement corrected (marked inline).

## Reconnaissance (written before the first code edit)

### Ruling BA — what the import->render seam actually needs

Traced the whole chain rather than trusting the review's summary:

- `import_package` (`crates/thoth-core/src/main_footage/import.rs:143`, `pub`) reads a Scout
  manifest, copies `sources/*`, `scene-index/**/index.json`, representative frames and
  embeddings into `job.main_footage_dir()`, and republishes a job-owned manifest.
- `MainFootageCoordinator::prepare` (`coordinator.rs:266`, `pub`) hardcodes the planner's two
  inputs as `"main-footage/source-package.json"` and `"narration/timeline.json"` relative to
  the job root, spawns `bun scout/cli.ts plan-main-footage` through
  `pipeline::ocr::resolve_scout_runtime()`, then verifies the produced plan with a real
  `SupervisedFfprobe`. It returns a `VerifiedMainFootagePlan`, the only type
  `PlannedFfmpegRenderer::render` accepts.
- `PlannedFfmpegRenderer` (`edit/planned.rs:110`) renders from cut files only.

So the seam is reachable end to end **without any fake port** as long as three things are on
the machine: `bun` (1.3.14, on PATH), `ffmpeg.exe`/`ffprobe.exe` (both present at the repo
root), and a Scout-produced package **directory** on disk.

The blocker: `crates/thoth-core/tests/fixtures/scout_source_package.v1.json` is the manifest
*only*. The mp4, `index.json`, frames and embeddings it addresses were produced by a throwaway
probe that `task-15-report.md:163` records as deleted. `import_package` copies and
sha256-verifies every declared artifact, and the planner cuts real media out of the imported
mp4, so a manifest with no artifacts cannot be imported, planned or rendered.

Decision: capture the fixture package again from Scout's real `buildSourcePackage`, this time
committing **the whole package directory** plus the capture script that produced it, so it is
reproducible instead of archaeological. The manifest's three machine-derived values the
reviewer verified (`fingerprintCanonical` self-consistency, `packageId`, the scene-index cache
key) are all recomputed by the same production functions on re-capture.

### Ruling BD — why "emit a loud warning" cannot work as written

`consume_planner_stderr` (`coordinator.rs:145`) reads planner stderr solely to find a terminal
error code and **discards every other line**. `parse_planner_progress_line`
(`util/progress.rs:348`) deliberately discards the planner's `message` and `warning` text and
substitutes a fixed string ("Read and deliberately discard both untrusted text fields"). There
is therefore no existing channel by which free-text from the planner reaches an operator, so a
warning alone would be unmissable only to someone reading raw subprocess stderr.

Plan: close the hazard at its source instead (details in the BD section below).

### Ruling BC — the server-side shape

`scout_run` (`routes.rs:1500`) already returns 400 for an empty URL and for an out-of-range
coverage target, and `planner_is_installed` + `SCOUT_PLANNER` already live in the same file.
One guard clause plus one `routes_http.rs` case.

### Ruling BA — a third instance of the same defect, found while designing the test

Reading the seam end to end turned up the same false equality Ruling BA predicted, still
live, one module downstream of the one `9c060e4` fixed:

`crates/thoth-core/src/main_footage/verify.rs:631-636`

    for index in &published_package.scene_indexes {
        let index_path = canonical_file(&root, &imported.root.join(&index.path))?;
        let bytes = file_bytes(&index_path)?;
        if checksum(&bytes) != index.checksum {
            return Err(invalid("scene_index_checksum_mismatch"));
        }

`checksum` (`verify.rs:252`) is `sha256(bytes)`. `SceneIndexV1.checksum` is Scout's content
fingerprint over the source checksum, planning mode, projected scene evidence and artifact
*bytes* (`scout/main_footage/scene_index.ts::computeIndexChecksum`) — it can never equal the
digest of `index.json`. `9c060e4` corrected exactly this in `import.rs` and left the copy in
`verify.rs` untouched, so every genuine Scout package would still be rejected at plan
verification, which is the gate `MainFootageCoordinator::prepare` runs before any render.

This is the *third* production-breaking defect on this plan living in this seam (Ruling AU,
`9c060e4`, this), and the first two were each found only by exercising the real path. It was
invisible to every existing test because the `verify.rs` fixture hand-writes an `index.json`
and then sets `index.checksum = sha256` of those bytes — the fixture is built to the
implementation, so it satisfies an equality Scout never satisfies.

Fix: verify the file the same way `import.rs` does — the published `index.json` must still
describe the scenes the manifest declares — instead of demanding a digest fixed point.

### Ruling BA — landed at `4ae86ce`, and it found four more defects

The acceptance test is `crates/thoth-core/tests/planned_main_footage.rs::a_captured_scout_package_imports_plans_and_renders_a_playable_file`.
It imports the committed package with `import_package`, runs
`MainFootageCoordinator::prepare` (which spawns the real `bun scout/cli.ts
plan-main-footage`), verifies through the real durability gate with the real
ffprobe, renders with `PlannedFfmpegRenderer` and ffprobes the rendered file.
The only fakes anywhere are the planner's two model-facing ports, degraded by
`THOTH_PLANNER_OFFLINE` to the shortlist's own deterministic ranking; the
assertion is on the rendered mp4, so a fake that produced no cuts could not
satisfy it.

The fixture is a whole Scout package (`crates/thoth-core/tests/fixtures/scout_package/`,
11 files, 214 KB) captured by the committed, re-runnable
`scout/main_footage/capture_fixture.ts`. `.gitignore` gained one negation so the
real mp4 and jpg artifacts can be committed.

Getting it to pass required fixing, in order, four cross-runtime defects that
every existing test was blind to because every existing test drove typed values
or fake ports across this seam:

1. `ignored[0].message must be a non-empty string` — Rust serialized absent
   optionals as `null`, Scout's decoder reads optionals as "`undefined` or a
   valid value". The manifest Rust republishes into the job is the manifest the
   planner Rust then invokes reads. Every mixed carousel died with
   `cut_planning_failed`. Fixed with `skip_serializing_if` on `message`,
   `created_at`, `vision_description`, `embedding_path` and the narration
   timeline's `created_at`/`fingerprint` — matching `bytes`/`acquisition`, which
   already carried it from the Ruling AU fix.
2. `source_package_invalid` — `canonical_json` printed an integral `f64` as
   `6.0`; `JSON.stringify` prints `6`. Scout's declared fingerprints matched
   because Rust hashed Scout's *raw* bytes, where `6` is an integer `Number`;
   anything Rust re-serialized diverged. Fixed in `canonical_number`.
3. `cut_handles_out_of_bounds` — verification measured handles against the
   scene, Scout computes them against the source (`cuts.ts::publishCut`). A cut
   beginning at a scene start, which is the common case, was always rejected.
4. `source_metadata_mismatch` — `container_contains` split only the probed side,
   so each member of ffprobe's `mov,mp4,m4a,3gp,3g2,mj2` was compared against
   that entire string, which is what Scout stores as `container`. Every real mp4
   source failed.

Literal result after all four:
`test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out`
(`cargo test -p thoth-core --test planned_main_footage -- --test-threads=1`), and
`cargo test -p thoth-types -p thoth-core -- --test-threads=1` is green at
349 + 3 + 14 + 1 + 0 passed, 0 failed. Scout side: `bun main_footage/contracts.test.ts`
and `bun main_footage/offline_acceptance.test.ts` both exit 0.

## Resume verification and Ruling BC

At resumed HEAD `126a834`, the reported compiler diagnostics at
`import.rs:242` and `verify.rs:917` did not reproduce: `cargo check -p thoth-core`
finished successfully (exit 0). Both cited locations are ordinary fallible calls in the
already-committed import/verification path. The real seam test also passed from a clean
rebuild: `cargo test -p thoth-core --test planned_main_footage -- --test-threads=1` ->
`3 passed; 0 failed` (exit 0). This is therefore the known phantom-IDE diagnostic class,
not a Rust compiler defect; no source change was justified for it.

Ruling BC was still incomplete despite the dashboard/status readiness work: `scout_run`
validated URL and coverage but forwarded `use_input_as_main` regardless of the planner's
presence. Added a pre-supervisor server validation that returns `503` with
`main_footage_unavailable` when a forced-main request targets a missing planner; legacy
Scout runs remain unaffected. RED first: the new direct server validation test failed to
compile because `validate_scout_run` did not exist. GREEN:
`cargo test -p thoth-server readiness_tests::forced_main_request_is_rejected_when_the_planner_is_unavailable -- --test-threads=1`
-> `1 passed; 0 failed` (exit 0). `git diff --check` also exited 0.

## Ruling BD, Ruling BB, and documentation correction

Ruling BD was incomplete: `THOTH_PLANNER_OFFLINE=1` alone still selected degraded providers,
and `scout/lib/env.ts` can supply it from a repository `.env`. Chosen remedy: refuse it outside
an explicit test context, rather than write a warning the Rust supervisor deliberately discards.
`plannerIsOffline()` now throws the explicit error
`THOTH_PLANNER_OFFLINE is test-only; refusing degraded planning outside test context` unless
`THOTH_PLANNER_TEST_CONTEXT=1` is also set. The Rust import→render acceptance test sets that
test context itself. RED: the new TypeScript test failed because `plannerIsOffline` was not
exported. GREEN: `bun scout/main_footage/planner_offline.test.ts` -> `ok planner_offline`
(exit 0), followed by the serial Rust seam test -> `3 passed; 0 failed` (exit 0).

Ruling BB's false claim was corrected above without rerunning `build_cuda.bat`, as required.
`docs/main-footage.md` §8.3 now documents the refused production flag, and §8.4 now records
the actual Rust import→plan→render+FFprobe coverage while retaining the changed-narration
`v001` → `v002` resume/immutability gap and live smoke tests as uncovered work.

## Final resume checks

- `bun run --cwd scout typecheck` -> `tsc --noEmit`, exit 0.
- `cargo check --workspace --all-targets` -> finished successfully, exit 0.
- `cargo test -p thoth-server -- --test-threads=1` -> 25 library + 1 reaper + 102 HTTP
  integration tests passed, 0 failed (exit 0).
- Focused server guard test rerun after its formatting correction -> 1 passed, 0 failed
  (exit 0).
- `git diff --check` -> exit 0.

`rustfmt --edition 2024 --check` on the two touched Rust files still reports broad existing
formatting diffs in `routes.rs` and pre-existing committed lines in the acceptance test. It
identified one line added in this resume (`error.1 .0`); that line was corrected to Rustfmt's
`error.1.0` output and committed. No repository-wide format rewrite was performed.

## Task 15 corrective round — canonical JSON numbers

- RED: `cargo test -p thoth-types canonical_json_numbers_match_json_stringify_at_ecmascript_boundaries -- --test-threads=1` failed at the valid protocol value `0.000001`: Rust emitted `1e-6`, while JavaScript `JSON.stringify` emits `0.000001` (exit 101).
- GREEN: `ryu-js` 1.0.3 now supplies ECMAScript number formatting for `serde_json` f64 values. The table pins literal JavaScript outputs for `-0`, `1e-7`, `1e-6`, `0.000001`, `1e20`, `1e21`, and `-1e21`.
- Verification: the same serial Rust test passed with `1 passed; 0 failed` (exit 0). This explicitly covers both ECMAScript notation thresholds and exponent-sign behavior rather than only the original integral-float case.

## Task 15 corrective round — offline planner confinement

- RED: the former production-path check set both `THOTH_PLANNER_OFFLINE=1` and `THOTH_PLANNER_TEST_CONTEXT=1`; `plannerIsOffline()` returned `true` (exit 1). Because `scout/lib/env.ts` backfills ordinary `.env` values, those keys were not a test boundary.
- GREEN: `scout/main_footage/plan_job.ts` no longer reads either key. `productionPlannerProviders()` always composes the model-backed embedding/ranking ports. `planner_offline.test.ts` sets both former flags, supplies a controlled non-empty planner key, and proves the real production ranking port performs its request (one intercepted request); the old offline branch yields zero requests and fails this test.
- The offline acceptance composition is now an explicit test-only script, `scout/main_footage/test_support/offline_plan_cli.ts`. It injects only `embedText: null` and empty model ranking; it retains the real file embedding loader, `ffmpegCut`, `probeSourceVideo`, candidate builder, allocator, materialization, and verification. The Rust import → plan → render acceptance test calls it through the explicitly named test-only coordinator API; production `MainFootageCoordinator::prepare` still launches only `scout/cli.ts`.
- Verification: `bun run --cwd scout typecheck`, `bun scout/main_footage/planner_offline.test.ts`, `cargo test -p thoth-types -- --test-threads=1` (15 passed), and `cargo test -p thoth-core --test planned_main_footage -- --test-threads=1` (3 passed) all exited 0. `git diff --check` exited 0. `build_cuda.bat` was not run.

### Correction to the preceding offline GREEN record

- The final policy is stronger than the intermediate request-observation implementation recorded above: production `productionPlannerProviders()` rejects when either former offline key is present. The final RED set **both** `THOTH_PLANNER_OFFLINE=1` and `THOTH_PLANNER_TEST_CONTEXT=1` and failed with a missing `planner_offline_environment_not_supported` exception (exit 1); the final GREEN emitted that exact rejection and exited 0. This is the evidence for “both former flags rejected.”
- Final reruns: `bun run --cwd scout typecheck`, `bun scout/main_footage/planner_offline.test.ts`, `bun scout/main_footage/offline_acceptance.test.ts`, and serial `cargo test -p thoth-core --test planned_main_footage -- --test-threads=1` (3 passed) all exited 0.

- Documentation correction: `docs/main-footage.md` now identifies the former environment-driven offline description as superseded, documents the production rejection code, and distinguishes the explicit test-only planner composition from production `scout/cli.ts`.
## Task 15 documentation correction

Updated `docs/main-footage.md` §8.3 to remove obsolete environment-authorized offline-planning
prose. It now states that production rejects both former flags and that `scout/cli.ts` maps
the internal rejection to `cut_planning_failed`; the explicit test-only offline planner path
remains documented. Verified with targeted `rg`, `git diff --check`, and the documentation-only
diff. No production code changed.

## Task 15 final-review fix — imported source generation path

- Root cause: `import_package` correctly retained changed source packages under
  `main-footage/packages/<fingerprint>/source-package.json`, but
  `MainFootageCoordinator` discarded `ImportedSourcePackage.manifest_path` and always
  passed `main-footage/source-package.json` to Scout.
- RED: `changed_source_generation_passes_its_actual_manifest_to_the_planner` expected
  `main-footage/packages/source-generation-v2/source-package.json`; the planner captured
  the legacy manifest path.
- GREEN: the coordinator canonicalizes the selected imported manifest, rejects files
  outside the job root, and passes its slash-separated job-relative path. A real changed
  source identity/byte generation now creates and verifies plan `v002` while preserving
  the byte-identical `v001` plan.
- Verification: `rtk cargo test -p thoth-core main_footage::coordinator --
  --test-threads=1` → 7 passed, 0 failed. Commit: `f1d60e9`.

## Task 15 external b-roll corrective round — shared cut contract

- Root cause: the allocator already distinguishes `main_cut` and `external_cut`, but the published TypeScript/Rust `PlannedCutV1` contract dropped that discriminator. Rust therefore had no sound way to exclude external duration from forced-main coverage. The strict forced descriptor also had no path for an immutable external-source manifest.
- RED (Scout): `bun test scout/main_footage/contracts.test.ts` failed because decoding an explicit `external_cut` returned `asset_kind: undefined`.
- RED (Rust): the focused `thoth-types` test failed to compile with missing `AssetKind`, `PlannedCutV1.asset_kind`, and `MainFootageDescriptor.external_sources_manifest`.
- GREEN: both runtimes now share `main_cut | external_cut`; legacy schema-v1 plans without the field decode as `main_cut`, newly published cuts always include it, unknown kinds fail closed, and `external_sources_manifest` is an optional contained descriptor path.
- Verification: `bun test scout/main_footage/contracts.test.ts`; `bun test scout/main_footage/cuts.test.ts scout/main_footage/allocator.test.ts`; `cargo test -p thoth-types main_footage -- --test-threads=1` (17 passed); and `git diff --check` all exited 0.

## Task 15 external b-roll corrective round — immutable Scout package

- RED: the forced acquisition integration expected a new `external` stage immediately after `build_footage`; production skipped it and the observed stage list lacked that entry. The focused package test initially failed because `external_sources.ts` did not exist.
- GREEN: forced runs now re-open the enriched Content Set after `build_footage`, inspect accepted video identities through the shared acquisition service, fail closed on ambiguous/excluded media, materialize through `service.materialize(..., 'footage')`, probe and checksum local bytes, and publish a write-once `main-footage/external-footage/vNNN/manifest.json` package. The Content Set receives only its relative descriptor path.
- Durability/security proof: the manifest contains no remote URL or acquisition-cache path, only relative immutable source paths plus technical/context fields. The test deletes the materializer output and verifies the packaged copy remains readable; forced-post media and photos never reach materialization.
- Verification: focused external package, shared contract, and forced pipeline tests all exited 0; `bun run --cwd scout typecheck` exited 0.

## Task 15 external b-roll corrective round — job import and planner input

- RED 1: the Rust external contract test failed to compile because `ExternalSourcesV1` did not exist. RED 2: the production import test failed because `ImportedSourcePackage` carried no external registry. RED 3: the coordinator path-capture test observed `None` instead of the imported job-relative manifest path. RED 4: Scout rejected Rust's new `--externals` argument as `invalid_arguments`.
- GREEN: Rust mirrors the strict versioned external manifest, imports every declared/checksummed source into `main-footage/external-footage/<fingerprint>/`, writes its job-owned manifest last, and retains it after the Scout generation is removed. The coordinator resolves that imported manifest inside the canonical job root and passes its relative path through both production and explicit acceptance planner compositions. Scout accepts the optional internal CLI argument.
- Compatibility correction: `asset_kind` defaults legacy schema-v1 plans to `main_cut`. The durability gate now fingerprints the original decoded JSON value rather than a typed reserialization that inserts defaulted fields; this preserves old plan identities while still binding newly explicit `asset_kind` bytes.
- Verification: `cargo test -p thoth-types main_footage -- --test-threads=1` (18 passed), `cargo test -p thoth-core main_footage:: -- --test-threads=1` (59 passed), `cargo check -p thoth-core --all-targets`, focused Scout contracts/cuts, Scout typecheck, and `git diff --check` all exited 0.

## Task 15 final-review fix — cross-runtime narration Unicode parity

- Root cause: Scout normalizes narration word text to NFC before canonical hashing;
  Rust collapsed whitespace but did not normalize Unicode, so composed `café` and
  decomposed `cafe\u0301` signed differently.
- RED: the shared composed/decomposed fixture produced distinct Rust SHA-256 identities.
- GREEN: Rust now applies NFC before whitespace normalization. Both runtimes consume
  `tests/fixtures/main-footage/contracts/narration-unicode-equivalence.v1.json`.
- Verification: focused Rust parity test passed; `rtk cargo test -p thoth-types
  main_footage::tests -- --test-threads=1` → 15 passed, 0 failed; `rtk bun test
  scout/main_footage/contracts.test.ts` exited 0 (top-level assertions, Bun reports zero
  registered tests). Commit: `0bb8c30`.

## Task 15 final-review fix — immutable versioned narration

- Root cause trace: production reuse loaded only `narration/timeline.json`;
  `write_narration_timeline` rejected a changed audio checksum; the coordinator passed
  the same fixed path to Scout; the verifier also reopened that fixed path. Versioning
  only the JSON would still let overwritten `narration/narration.mp3` mutate v1.
- RED 1: `changed_narration_activates_a_new_immutable_timeline_and_audio_version`
  expected `narration/v001/timeline.json`; the writer returned the legacy timeline.
- RED 2: the coordinator path-capture test expected
  `narration/v001/timeline.json`; it captured `narration/timeline.json`.
- RED 3: the durability gate received an otherwise-valid plan bound to the active
  versioned timeline and failed `declared_artifact_missing` because it reopened the
  removed legacy path.
- GREEN: narration publication validates the supplied fingerprint and staging-audio
  checksum, copies audio into an immutable `vNNN` generation, writes the immutable
  timeline with its versioned audio path, and atomically replaces
  `narration/active.json`. Re-publishing the active identity reuses its version. The
  reader validates the active pointer/timeline and retains a legacy fallback. Production
  loading, generation, coordinator planning, verification, and rendering now share that
  selected version.
- Immutability proof: the focused writer test publishes changed audio/words as `v002`
  and asserts v1 audio and timeline bytes are unchanged. The real Rust→Scout acceptance
  publishes v1, renders it, changes both narration audio and words, publishes v2, invokes
  the real Scout planner, verifies `plans/v002`, and asserts the v1 plan/timeline/audio
  remain byte-identical.
- GREEN verification so far: narration timeline suite 8 passed; coordinator suite 7
  passed; verifier suite 26 passed; focused real Rust→Scout v1→v2 acceptance 1 passed,
 all serial and with 0 failures. Final group verification and commit are recorded below.

## Task 15 external b-roll corrective round — Scout allocation and materialization binding

- RED runtime: `bun test scout/main_footage/cuts.test.ts scout/main_footage/contracts.test.ts` exited 1 because the CLI fixture passed `--externals main-footage/external-footage/v001/manifest.json` without publishing that manifest (`ENOENT` in `planMainFootageJob`).
- RED compiler: `bun run --cwd scout typecheck` exited 1 because `MainFootagePlanV1` omitted `external_sources_fingerprint` while the decoder, reuse gate, and mixed-cut test consumed it.
- GREEN: the CLI fixture now publishes a checksum-bound local external source plus a canonical-fingerprint manifest, passes the same external path on reuse, and asserts the immutable plan binds both path and fingerprint. The plan contract requires both external identity fields or neither. Mixed materialization resolves external bytes only through the external registry, honors `trim_start_sec` as the head-handle floor, publishes job-relative `source_path`, preserves `external_cut`, and keeps forced-main coverage at exactly 0.60.
- Verification: `bun test scout/main_footage/cuts.test.ts scout/main_footage/contracts.test.ts` exited 0 and printed `ok cuts`; `bun run --cwd scout typecheck` exited 0; `git diff --check` exited 0.

## Task 15 external b-roll corrective round — Rust durability semantics

- RED contract: `cargo test -p thoth-types plans_require_both_halves_of_external_source_identity -- --test-threads=1` failed to compile because `MainFootagePlanV1` had no external path/fingerprint fields.
- RED verifier: the valid 6-second main + 4-second external fixture failed `cut_source_unknown`, proving Rust still resolved every cut through the forced package. The paired mutation already rejected an inflated summary.
- GREEN: the Rust plan wire accepts a contained external manifest path and SHA-256 fingerprint only as a pair. The verifier reopens and fingerprints the imported job-owned external manifest, binds `external_cut` only to that registry, enforces trim/range/handle/source metadata/checksum rules, retains manifest plus source bytes, and counts only `main_cut` duration toward forced-main coverage.
- Mutation proof: the valid mixed fixture verifies at exactly 6.0 seconds / 0.60 main coverage; changing its summary to claim the external four seconds as main is rejected before any probe.
- Verification: `cargo test -p thoth-types main_footage -- --test-threads=1` passed 19/19; `cargo test -p thoth-core main_footage::verify -- --test-threads=1` passed 28/28; `cargo check -p thoth-core --all-targets` exited 0; `git diff --check` exited 0.

## Task 15 external b-roll corrective round — mixed render acceptance

- Acceptance RED: the real nine-second Rust → Scout plan (six seconds forced main plus three seconds external) failed the Rust durability gate with `plan_summary_mismatch`. Scout published the exact mixed timeline and `main_coverage_ratio: 0.666667`; Rust compared it with exact `6 / 9` using a stricter `1e-9` tolerance.
- Focused verifier RED: `cargo test -p thoth-core scout_rounded_coverage_ratio_matches_rust_recomputation -- --test-threads=1` reproduced `plan_summary_mismatch` without FFprobe. This proved the defect was the cross-runtime six-decimal ratio comparison, not candidate selection, source binding, or media probing.
- GREEN: Rust still recomputes main-only coverage from millisecond-normalized timeline values, but now accepts Scout's documented six-decimal serialization precision. The focused verifier regression passed 1/1.
- Durability and render proof: the acceptance copies the captured Scout tree, publishes a checksum-bound external registry, imports both packages, deletes the copied Scout tree, then runs the real planner, verifier, and renderer. It asserts both `main_cut` and `external_cut`, a job-relative retained external source, main coverage at least 0.60 but below 1.0, a materialized external cut that survives rendering, and a playable nine-second audio/video output.
- GREEN acceptance evidence: focused mixed acceptance passed 1/1; `cargo test -p thoth-core --test planned_main_footage -- --test-threads=1` passed 3/3. Final scoped verification is recorded below after documentation and formatting checks.
- Final scoped verification: `cargo test -p thoth-core main_footage::verify -- --test-threads=1` passed 29/29; `cargo test -p thoth-core --test planned_main_footage -- --test-threads=1` passed 3/3; `cargo check -p thoth-core --all-targets` exited 0; `git diff --check` exited 0.

## Task 15 final-fix checkpoint — external footage chain

Commits landed in this corrective chain:

- `04e1f9f feat(main-footage): classify planned external cuts`
- `0644d6d feat(main-footage): package external b-roll locally`
- `c82f788 feat(main-footage): import external sources into jobs`
- `c5da78b feat(main-footage): bind external cuts to local sources`
- `af9421b feat(main-footage): verify external cut durability`
- `2d98846 fix(main-footage): accept mixed external render plans`

Exact final-fix evidence:

- RED acceptance: `cargo test -p thoth-core --test planned_main_footage a_captured_scout_package_imports_plans_and_renders_a_playable_file -- --test-threads=1` exited 1 with `plan_verification_failed: plan_summary_mismatch` for Scout's mixed `6 / 9` plan serialized as `0.666667`.
- RED verifier regression: `cargo test -p thoth-core scout_rounded_coverage_ratio_matches_rust_recomputation -- --test-threads=1` exited 1 with the same `plan_summary_mismatch` (0 passed, 1 failed).
- GREEN verifier regression: the same focused verifier command passed 1/1 after aligning Rust with Scout's six-decimal serialization tolerance.
- GREEN focused acceptance: the same focused acceptance command passed 1/1 and rendered the nine-second mixed plan.
- Final verifier suite: `cargo test -p thoth-core main_footage::verify -- --test-threads=1` passed 29/29 with 330 filtered out.
- Final real acceptance suite: `cargo test -p thoth-core --test planned_main_footage -- --test-threads=1` passed 3/3.
- Compile gate: `cargo check -p thoth-core --all-targets` exited 0.
- Diff gate: `git diff --check` exited 0 before the implementation commit.

Remaining disclosed limitations:

- Live-platform smoke tests remain the human release action documented in `docs/main-footage.md`; this offline round used no authenticated session or network acquisition.
- The external acceptance fixture reuses the committed captured MP4 with deterministic external query/description metadata. It proves registry selection, import, binding, durability, and rendering, but not a third-party external media provider.
- This corrective round ran the scoped Rust verifier/acceptance/check matrix above, not the entire Scout/dashboard/workspace release matrix. The final release gate must retain the broader Task 15 commands.
- `build_cuda.bat` was not run, as required.
