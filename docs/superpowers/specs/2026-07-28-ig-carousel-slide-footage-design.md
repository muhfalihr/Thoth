# Instagram Carousel Slide Footage — Design

**Date:** 2026-07-28
**Status:** Approved

## Context

An Instagram slide post (`/p/` carousel) can carry several videos on the same
topic. The user wants every one of those slides harvested as footage, under the
same conditions and filtering as externally sourced footage.

The scout layer already has the machinery for this: `build_footage` has an
"OPSI A" branch that turns a multi-video IG carousel into the entire footage
pool, and `pushSlides` already runs each slide through the OCR contract. The
branch never fires, because slide detection is broken.

Live probe of the reported post `https://www.instagram.com/p/DbQoG9IjzGX`:

| Probe | Result |
|---|---|
| `yt-dlp -J --flat-playlist` (raw) | `entries=5`, `title="Post by dagelan"` |
| entry 1 | `ext=(none)`, `duration=None` |
| entries 2–5 | `ext=mp4`, `duration=None` |
| `igCarouselSlides(url, 10)` | `[]` |
| `postShape(url).slides` | 5 × `{kind:'photo'}` |

Two independent defects produce that result.

**Defect 1 — missing `--ignore-no-formats-error`.** The post's first slide is a
photo, so yt-dlp errors with "No video formats found" and `igCarouselSlides`
returns `[]`. This is the same root cause already fixed in the sibling helper
`directStreamArgs` (`scout/lib/verify.ts:173`) and present in `shapeArgs`
(`:252`). `igCarouselSlides` (`:213`) is the one caller left behind.

**Defect 2 — `kind` derived from `duration`.** Both `igCarouselSlides` (`:233`)
and `parseShape` (`:275`) classify a slide as video when `e.duration` is
truthy. yt-dlp never populates `duration` for Instagram carousel entries —
verified both with and without `--flat-playlist`, so the flag is not the cause.
Every slide is therefore classified `photo`, and the OPSI A threshold of
"≥2 video slides" can never be met.

With both defects fixed, the reported post yields 1 photo + 4 video slides.

## Goals

- Detect Instagram carousel slides and their media kind correctly.
- Harvest every video slide of a multi-video carousel as footage.
- Exclude slide #1, which is conventionally a cover, from footage.
- Apply exactly the filtering that external footage already receives — no new
  filtering code.

## Non-Goals

- Photo-only carousels as image-card footage.
- Extending the carousel branch beyond Instagram (TikTok photo slideshow, FB, X).
- Changing the OPSI A "≥2 video slides" threshold.
- Fixing `probeVideo` (`verify.ts:80`), which still pins `--playlist-items 1`
  and so probes a photo-first carousel as non-video.
- Carrying `discover_reels`' already-detected `shape` into the content set to
  avoid the redundant re-probe.

## Part 1 — Slide Detection (`scout/lib/verify.ts`)

Fixing detection at the helper fixes all three footage paths at once, because
all three route through `igCarouselSlides` or `postShape`.

1. `igCarouselSlides` gains `--ignore-no-formats-error`, matching `shapeArgs`
   and `directStreamArgs`.
2. `kind` classification becomes `ext === 'mp4' || duration ? 'video' : 'photo'`.
   `duration` is retained as a fallback for platforms that do supply it. The
   same change applies to `parseShape`, which shares the defect.
3. The yt-dlp argument list is extracted into a named function, following the
   existing `directStreamArgs` / `shapeArgs` pattern, so the flag set is
   assertable without spawning yt-dlp.

`--flat-playlist` is kept. It is not implicated in either defect, and `ext` is
present in flat mode.

## Part 2 — Cover Slide Exclusion (`scout/pipeline/build_footage.ts`)

Slide #1 of a carousel is conventionally a cover and must not become footage.

The OPSI A branch (`:222`) already drops index 1. The same exclusion is applied
to the two remaining slide-harvest paths:

- **Creator feed post** (`:355`): `igCarouselSlides(r.url, 5).slice(0, 3)`
  currently includes the cover.
- **Generic footage entry** (`:510`): the `cropPost({ maxSlides })` path
  currently includes the cover.

The exclusion is conditional on `slides.length > 1`. A single-media post has no
cover to drop, and unconditionally removing index 1 would strip its only
content.

## Part 3 — Filtering

No new filtering code. Every gate the user asked for already runs on these
slides:

- **Per-slide OCR gate** — `pushSlides` (`:169`) sends each video slide through
  `selectCarouselFootageVideoCandidate`, drops `status: 'unavailable'`, and
  drops `ocr_outcome === 'subtitle'`. This is the same contract external
  candidates get.
- **Story-gate cosine** — `pushSlides` already attaches `description` to every
  entry it pushes, so non-main slides reach the story-gate at `:647` and are
  dropped below `THOTH_FOOTAGE_STORY_MIN` (default `0.33`) like any external
  footage.
- **`looksReaction` / `sameAsMain`** — already applied at post level on the
  non-main paths.

OPSI A deliberately returns before the story-gate: on that path the footage
comes from the main post itself, so comparing it against the main story is
always ≈1.0 and the gate carries no signal. This is existing intended behavior
and is not changed.

## Testing

One unit test in the scout suite, asserting against a fixture of the reported
post (5 entries; entry 1 without `ext`; entries 2–5 with `ext: 'mp4'`; all with
`duration: null`):

- The extracted argument builder includes `--ignore-no-formats-error`.
- Parsing the fixture yields exactly 1 `photo` (index 1) and 4 `video`
  (indices 2–5).

This test fails on current code — `[]` from the missing flag, and all-`photo`
from the `duration` classification.

Regression: `tsc --noEmit` clean and the existing 13 scout suites still exit 0.

Live verification: run the footage stage against
`https://www.instagram.com/p/DbQoG9IjzGX` and confirm OPSI A fires, slide #1 is
absent from `set.footage`, and the retained slides are video with
`ocr_status: analyzed`.

## Acceptance Criteria

- `igCarouselSlides` returns 5 slides for the reported photo-first carousel
  instead of `[]`.
- Slide kind reflects actual media: 1 photo + 4 video for that post.
- OPSI A fires for that post and produces footage from its video slides.
- Slide #1 never appears in `set.footage` on any of the three harvest paths.
- A single-media post still yields its one slide.
- No filtering behavior changes for externally sourced footage.
