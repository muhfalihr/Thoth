# Subtitle-Aware Footage Selection & Fallback Censor — Design

**Date:** 2026-07-22
**Status:** Approved design (pending spec review)

## Problem

A reaction video with **baked-in (burned) subtitles** was selected as the `main` visual
spine of a narration clip
(`.thoth/…/clips/clip_000_narration.mp4`). At ~6s the source's own English subtitle
("All the foo…") bleeds through underneath Thoth's own CapCut caption, and the source's
audio leaks because narration mode **ducks-and-mixes** the event audio rather than dropping
it.

Two root causes, both confirmed:

1. **Selection is blind to baked subtitles on `main`.** `hasReactionSubtitle`
   (`scout/lib/subtitle_vision.ts`) is wired only into the footage pool
   (`scout/pipeline/build_footage.ts:453`) and samples a **single frame at t=3s**. `main` is
   never checked, and a subtitle that appears at 6s evades a 3s-only probe regardless.
2. **Render can't censor an unavoidable subtitle main.** In narration mode the event audio
   is ducked under the voiceover (`crates/thoth-core/src/edit/ffmpeg.rs:1264–1279`), not
   dropped; and there is no mechanism to blur a source-subtitle region.

## Goals

- Stop picking subtitle-laden sources as `main` when a cleaner source exists.
- When a source's only defect is a **short intro cover / headline** (text in the first
  seconds, clean afterward), **trim** the intro instead of discarding the clip.
- When a subtitle main is genuinely unavoidable, **censor** it at render time:
  **blur** the detected subtitle region(s) and **drop** the source audio.
- Fully additive and graceful: `thoth run --url` (no content-set) and existing content-sets
  render exactly as before.

## Non-Goals

- Pixel-perfect subtitle bounding boxes. A **coarse normalized band** is what the vision
  model returns reliably and is all a blur needs.
- Removing subtitles by inpainting/OCR-erase. We blur (censor), not reconstruct.
- Changing footage behavior beyond the cover-trim case (footage with continuous subtitles is
  still hard-rejected — alternatives exist).

## Detection Model (scout)

One reusable detector samples several frames of a clip and classifies the clip into exactly
one outcome.

**Sampling.** Frame times `T = [1, 3, 5, 8, 12]` seconds, each capped to the clip duration
(drop times ≥ duration; a clip shorter than 1s samples t=0). `512`px-wide JPEG per frame, as
today.

**Per-frame vision result.** The qwen3-vl call returns, per frame:
`{ present: boolean, region: { x0, y0, x1, y1 } | null }` — `region` in normalized `[0,1]`
coordinates (a band, not a tight box). A frame the model cannot read → `present:false`
(conservative: never fabricate a subtitle).

**Clip classification.** Let `lastText` = greatest sampled time with `present:true`,
`COVER_MAX = 5.0`s.

| Condition | Outcome |
|---|---|
| No frame has text | **CLEAN** — accept, no changes |
| `lastText ≤ COVER_MAX` **and** a later sampled frame is clean | **COVER** — accept + `trim_start` |
| text at any sample `> COVER_MAX`, or text in every sample (no clean tail) | **SUBTITLE** |

The COVER vs SUBTITLE split is **temporal** (which frames carry text), not the model naming
itself — more robust than trusting a model label. A clip with both an intro cover *and* later
subtitles is `lastText > COVER_MAX` → **SUBTITLE**, and the blur path covers the intro too.

**Outcome → action:**

- **CLEAN:** no change.
- **COVER:** set `trim_start` = midpoint between `lastText` and the next clean sample (e.g.
  text through 3s, clean at 5s → `trim_start = 4.0`). Applies to **footage and main**.
- **SUBTITLE, footage:** hard-reject (unchanged behavior, now multi-frame).
- **SUBTITLE, main:** apply a **ranking penalty** in source selection so a cleaner source
  wins if one exists. If the subtitle source is nonetheless kept (it is the only viable
  `main`), emit `subtitle_blur` regions + `mute_audio:true`.

**`subtitle_blur` regions.** For each sampled time `tᵢ` with `present:true`, emit region
`Rᵢ` = `{ x:x0, y:y0, w:x1-x0, h:y1-y0 }` over window `[tᵢ-Δ/2, tᵢ+Δ/2]` (`Δ` = local sample
spacing). Overlapping windows merge into their union region. Text in every sample →
one region `[0, duration]`.

## Selection Change (scout, Part A)

- `hasReactionSubtitle` → multi-frame (the sampling above); reject footage if the clip
  classifies **SUBTITLE**. COVER footage is kept with `trim_start`.
- `main`/source resolution (`scout/pipeline/trace_source.ts`): baked-subtitle detection
  becomes a **negative ranking signal**, not a hard reject — CLEAN/COVER candidates rank
  above SUBTITLE ones, so a clean original wins when available. A SUBTITLE main survives
  only when it is the sole viable source, which is exactly the case that triggers the render
  fallback. (Hard-rejecting unconditionally risks leaving zero `main`.)

## Content-Set Contract (additive)

New fields on **both** `MainVideo` and `ContentResult`, on **both** sides — `scout/lib/types.ts`
(optional) and `crates/thoth-core/src/ingest/content_search.rs` (`#[serde(default)]`, no
`deny_unknown_fields`, so old JSON stays valid and new JSON is ignored by old binaries):

```ts
trim_start?: number;              // in-point seconds; skip source content before this. Default 0.
mute_audio?: boolean;             // drop this source's audio from the mix. Default false.
subtitle_blur?: SubtitleBlur[];   // normalized censor regions. Default [].

interface SubtitleBlur {
  x: number; y: number; w: number; h: number;  // normalized [0,1] region
  start?: number; end?: number;                 // seconds; omitted → whole clip
}
```

```rust
#[serde(default)] pub trim_start: f64,
#[serde(default)] pub mute_audio: bool,
#[serde(default)] pub subtitle_blur: Vec<SubtitleBlur>,

#[derive(Default, Clone, Deserialize)]
pub struct SubtitleBlur { pub x: f64, pub y: f64, pub w: f64, pub h: f64,
                          #[serde(default)] pub start: f64, #[serde(default)] pub end: f64 }
```

`trim_start` and `mute_audio` are meaningful for both types (COVER-trim applies to footage
too); `subtitle_blur` is emitted only for `main` in practice but is harmless as a default on
footage.

## Render Change (Rust `crates/thoth-core/src/edit/`)

Reuses the primitives introduced by SP2 (`enable='between(t,a,b)'` gating, `crop`, `boxblur`,
`overlay`, unique per-index filter labels).

1. **`trim_start`** — the clip's in-point. The main spine and footage segment selection never
   read source content before `trim_start`; a footage segment `[seg, seg+dur]` is constrained
   to `seg ≥ trim_start`, and the main spine starts at `trim_start`.
2. **`subtitle_blur`** — per region `k`: `crop` the normalized band from the composited main,
   `boxblur` it, `overlay` it back at the same position, gated
   `enable='between(t,start,end)'` (whole clip when `start==end==0`). Labels unique per `k`
   (`[sb{k}]`, `[sbblur{k}]`), consistent with the SP2 labeling scheme.
3. **`mute_audio`** — exclude that source from the `amix` inputs (drop, don't duck), keeping
   narration + BGM.

All three are no-ops when their fields are default → `--url` and legacy content-sets are
unaffected.

## Testing

- **scout (pure classifier):** unit tests in `scout/lib/subtitle_vision.test.ts` feeding
  synthetic per-frame results → assert the outcome and derived values: CLEAN → no change;
  COVER → correct `trim_start` midpoint; SUBTITLE with intermittent frames → merged
  `subtitle_blur` windows + regions; text-everywhere → single whole-clip region. No live
  vision call in tests.
- **Rust (filtergraph builder):** assert the emitted filter string for `subtitle_blur` uses
  unique labels and correct `between()` gating per region; `mute_audio` removes the source
  from `amix`; `trim_start` sets the in-point. Mirrors the SP2 builder tests.

## Error Handling / Degradation

- Vision unavailable or all frames unreadable → clip treated as CLEAN (no trim/blur/reject);
  pipeline never blocks on the detector.
- A single frame's vision failure → that frame is `present:false`; other frames still drive
  the classification.
- Unknown/missing content-set fields → serde defaults → current behavior.

## Accepted Ceilings

- A subtitle appearing only *between* two samples for less than one interval is missed
  (denser sampling is the upgrade path if it ever matters).
- The coarse band may blur slightly more than a pixel-tight box would — acceptable for a
  censor, and it sits under Thoth's own caption anyway.
- `trim_start` is quantized to the sample grid midpoint; up to ~one interval of clean footage
  may be trimmed with the cover.
