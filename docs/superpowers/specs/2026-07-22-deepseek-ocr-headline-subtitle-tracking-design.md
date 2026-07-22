# DeepSeek-OCR Headline/Subtitle Tracking — Design

**Date:** 2026-07-22
**Status:** Approved

## Problem

The current subtitle detector uses Qwen3-VL to classify each sampled frame as a
single boolean `present` plus one bounding box. That representation cannot model
a video containing both an intro headline and later burned-in subtitles. In the
reported 26.94-second source, samples at 1s and 3s contain a headline, while
samples at 5s, 8s, and 12s contain dynamic subtitles. All samples were treated as
subtitle-bearing, the classifier emitted `trim_start: 0`, and its all-text branch
used the first frame's headline box as a whole-render blur region.

The render path compounds the problem: narration videos longer than their source
loop the raw source from zero, clip-mode fallback skips `trim_start`, footage
entries carry `trim_start` without an edit-stage consumer, and source-time blur
windows are not projected through trim/segment/loop transformations.

## Goals

- Replace Qwen3-VL in this detector with `deepseek/deepseek-ocr` through Novita AI.
- Detect and localize every relevant text line in each sampled frame.
- Treat headline trimming and subtitle censoring as independent actions, so a
  main video can have both `trim_start > 0` and `subtitle_blur` regions.
- Ensure main, footage, narration-loop, and clip fallback never render source
  content before `trim_start`.
- Loop only the clean source segment after `trim_start`.
- Build blur geometry from all applicable OCR boxes, never only the first frame.
- Project source-time blur windows onto the actual output timeline.
- Preserve additive content-set compatibility and fail open when OCR is unavailable.

## Non-Goals

- Inpainting or reconstructing pixels hidden by baked text.
- Live OCR calls in regular unit tests.
- Replacing unrelated vision or narration models elsewhere in the pipeline.
- Guaranteeing pixel-perfect glyph masks; the renderer censors padded text bands.

## Provider and Model

The detector calls Novita's OpenAI-compatible endpoint with model
`deepseek/deepseek-ocr`. The documented grounding response pairs recognized text
with 0–1000 boxes:

```text
<|ref|>recognized text<|/ref|><|det|>[[x0,y0,x1,y1]]<|/det|>
```

Configuration:

```text
THOTH_SUBTITLE_OCR_MODEL=deepseek/deepseek-ocr
THOTH_SUBTITLE_OCR_MAX_FRAMES=12
```

The existing Novita API key resolution and endpoint are reused. There is no
fallback to Qwen3-VL. A model override remains available for controlled testing,
but the parser contract remains the DeepSeek grounding format.

## Sampling

Sampling is dense in the cover-intro window and distributed across the remaining
clip:

- Intro candidates: `0.5, 1, 2, 3, 4, 5` seconds, clipped to duration.
- Tail candidates: evenly distributed after 5 seconds through the real duration.
- Duplicate/near-duplicate timestamps are removed.
- Total samples are capped by `THOTH_SUBTITLE_OCR_MAX_FRAMES`, default 12.
- A clip shorter than 0.5 seconds samples time zero.

Each frame is extracted at high enough resolution to preserve caption edges while
keeping the encoded image below Novita's recommended request size. DeepSeek-OCR
receives one image per request; frame requests run sequentially.

## OCR Parsing and Geometry

For every `<|ref|>`/`<|det|>` pair, the parser produces:

```ts
type OcrBox = {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};
```

Coordinates are divided by 1000 when needed, corner order is repaired, values are
clamped to `[0,1]`, and empty or tiny boxes are discarded. Text is normalized for
tracking without changing the raw diagnostic text.

Multiple subtitle lines in the same temporal window use a padded envelope:

```text
x0 = min(box.x0)
y0 = min(box.y0)
x1 = max(box.x1)
y1 = max(box.y1)
```

Padding is clamped to the source frame. Adjacent windows merge only when their
regions overlap sufficiently; unrelated headline-middle and subtitle-bottom boxes
must never become one large union.

## Temporal Classification

Headline trimming and subtitle censoring are derived independently.

### Persistent small text

A small box with stable normalized text and stable position across most samples is
treated as a watermark/logo and ignored. This prevents handles, channel marks,
and score bugs from turning otherwise clean footage into subtitle footage.

### Intro headline

A headline track:

- occurs within the first five seconds;
- has a large overlay-sized box;
- remains text/position-similar across at least two dense intro samples; and
- disappears or is replaced by a different-position/different-text track later.

`trim_start` is the midpoint between the last sample containing the intro track
and the first following sample without it. Detecting later subtitles does not
cancel this action.

### Burned subtitle

A subtitle track:

- uses a consistent positional band across at least two samples; and
- changes recognized text between samples, or continues as a multi-line spoken
  caption sequence after the intro boundary.

Only subtitle boxes at or after `trim_start` become blur regions. A dynamic caption
that begins immediately is classified as subtitle, not cover.

### Verdict contract

`ClipVerdict` retains the existing compatibility fields:

```ts
type ClipVerdict = {
  outcome: 'clean' | 'cover' | 'subtitle';
  trim_start: number;
  mute_audio: boolean;
  subtitle_blur: SubtitleRegion[];
};
```

Actions are no longer mutually exclusive. A hybrid clip uses
`outcome: 'subtitle'`, `trim_start > 0`, `mute_audio: true`, and non-empty
`subtitle_blur`. Pure cover remains `outcome: 'cover'`. Footage with subtitle is
still rejected; pure-cover footage is retained with its in-point.

## Blur Windows

Every subtitle-bearing sample owns a source-time window bounded by midpoints to
its neighboring samples. Its geometry is the padded envelope of subtitle boxes in
that frame. Adjacent windows merge only when geometry is sufficiently similar.

The all-text special case must not select `find(first region)`. It processes every
frame and may collapse time coverage to whole-source only when the resulting
geometry track is stable. Moving or multi-band captions remain time-varying.

## Render-Time Projection

OCR windows are expressed in source time. Before FFmpeg filter construction, a
pure Rust projection helper maps each source window through:

1. chosen source segment start;
2. `trim_start`;
3. clean-segment duration;
4. output duration; and
5. each loop iteration.

The resulting regions are output-relative and are the only regions passed to
`enable='between(t,start,end)'`.

For looped narration, the renderer loops the clean segment `[trim_start,
source_duration]`, never the raw source. Pure-cover audio follows the same clean
segment. Hybrid/subtitle main audio remains muted. Clip-mode fallback and all
footage segment selection clamp their source in-points to their entry's
`trim_start`.

## Error Handling

- Frame extraction failure: skip that frame.
- Per-frame timeout/API failure: mark unreadable and continue.
- Malformed grounding output or invalid bbox: ignore the invalid detection.
- All frames unreadable: return the existing fail-open clean verdict.
- Missing Novita key: return clean without attempting network access.
- No silent Qwen fallback.

## Diagnostics

Each analysis appends a JSONL record under scout output containing:

- OCR model ID;
- SHA-256-derived URL identifier, never the raw URL;
- real duration and sample times;
- parsed OCR boxes, headline boxes, and subtitle boxes per frame;
- frame-level error reason without credentials or response headers; and
- final verdict.

Diagnostics are best-effort: a log write failure never changes the verdict.

## Testing

### Scout pure tests

- Parse multiple DeepSeek grounding pairs.
- Normalize 0–1000 coordinates and repair/reject malformed boxes.
- Cover-only produces trim without blur.
- Subtitle-only produces mute plus blur.
- Intro headline followed by subtitle produces both trim and blur.
- Persistent small watermark remains clean.
- Moving subtitle boxes use every frame rather than the first.
- Multi-line subtitles produce the correct padded envelope.
- Adjacent windows merge only for sufficiently similar geometry.
- Adaptive samples cover intro and tail without exceeding the configured cap.

### Rust tests

- Main non-loop starts at or after `trim_start`.
- Main loop repeats only the clean segment.
- Clip fallback respects `trim_start`.
- Footage segment selection respects its own `trim_start`.
- Source-time blur regions shift correctly after trim/segment selection.
- Blur windows repeat correctly for every clean-segment loop.
- Missing content-set fields retain legacy defaults.

### Verification

- Run scout detector unit tests.
- Run scout TypeScript type-check.
- Run all `cargo test -p thoth-core` tests.
- Run the repository-required full CUDA build.
- Run a live, explicitly invoked DeepSeek-OCR smoke test against the reported
  source frames; network is never required for normal unit tests.
- Update `BLUEPRINT.md` after the build and tests pass.

## Acceptance Criteria

For the reported source:

- the headline visible around source seconds 0–3 never appears in the output,
  including after looping;
- later burned subtitles cause source audio mute and are blurred at their OCR
  regions;
- the intro headline region is not used as a whole-video subtitle blur;
- footage cover trim is honored before segment selection; and
- failures in OCR degrade without blocking the content pipeline.

## Primary References

- Novita DeepSeek-OCR usage: https://novita.ai/docs/guides/llm-deepseek-ocr
- Novita vision input guidance: https://novita.ai/docs/guides/llm-vision
