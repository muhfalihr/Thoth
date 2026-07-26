# Platform-Agnostic OCR Frame Extraction Recovery — Design

**Date:** 2026-07-27  
**Status:** Approved

## Context

The required OCR pipeline currently fails the whole analysis when any scheduled
frame cannot be extracted. This fail-closed behavior is intentional, but the
extractor makes only one attempt at the exact scheduled timestamp.

In the investigated Instagram reel, FFprobe reported a duration of `41.235782`
seconds. Eleven frames were extracted and analyzed successfully, while the final
sample at `41.135782` seconds failed with `frame_extract`. This is a normal media
edge case: a container-reported duration can extend slightly beyond the final
decodable video frame. Similar seek and duration discrepancies can occur in
media from any social platform.

## Goals

- Recover safely when an individual FFmpeg frame seek fails.
- Apply the behavior to every OCR video source, independent of social platform.
- Preserve the requirement that every scheduled sample must have a successfully
  extracted and OCR-analyzed frame.
- Use the actual recovered frame time for classification and blur timing.
- Preserve explicit failure when bounded recovery cannot obtain a frame.
- Make fallback activity visible in sanitized diagnostics.

## Non-Goals

- Treating partial frame coverage as a successful OCR analysis.
- Adding platform-specific Instagram, TikTok, YouTube, Facebook, or X branches.
- Downloading every remote social video before OCR.
- Changing the DeepSeek-OCR provider, parser, classifier, or blur geometry.
- Retrying indefinitely.

## Chosen Design

Frame recovery belongs in the platform-agnostic OCR analysis layer. For each
scheduled timestamp, the analyzer:

1. attempts extraction at the requested timestamp;
2. retries the same timestamp for transient extraction failures;
3. if extraction still fails, tries bounded earlier timestamps;
4. accepts the sample only when extraction returns a valid image; and
5. passes that image to the existing bounded OCR request loop.

Recovery timestamps use fixed backward offsets selected to cover common
container-duration and seek-boundary discrepancies without moving far enough to
change the semantic section being sampled:

```text
requested time
requested time - 0.25 seconds
requested time - 0.50 seconds
requested time - 1.00 seconds
```

Candidates are clamped to zero and deduplicated. A recovered timestamp must
remain later than the preceding accepted sample, preventing reordered or
duplicate temporal evidence. If no valid candidate remains, the sample retains
`frame_extract` and the complete analysis fails with
`incomplete_frame_coverage`.

The existing OCR retry count remains specific to OCR requests. Frame extraction
gets its own fixed, bounded recovery sequence so request retry diagnostics do
not conflate media extraction with provider retries.

## Data and Diagnostics

`OcrFrame.t` remains the actual timestamp represented by the extracted image and
is the timestamp used by classification and blur-window construction.

Diagnostics add the originally requested timestamp when recovery changed it:

```json
{
  "t": 40.735782,
  "requested_t": 41.135782,
  "boxes": []
}
```

For a sample extracted at its requested timestamp, `requested_t` is omitted.
Diagnostics continue to contain only a hashed source identifier and sanitized
error codes; raw private URLs, credentials, and FFmpeg output remain excluded.

`requested_frames` continues to count scheduled samples. `valid_frames` counts
samples that completed both extraction and OCR. Recovery does not weaken the
required equality between those fields.

## Platform Scope

The recovery loop is implemented inside `analyzeSubtitlesDetailed`, after any
source resolution or platform-specific localization. Therefore it applies
equally to:

- local files produced by ingest;
- direct media/CDN URLs;
- Instagram, TikTok, YouTube, Facebook, X/Twitter, Threads, and other supported
  page URLs after their existing resolver/localizer runs; and
- future platforms that use the same OCR analyzer.

## Error Handling

- A thrown extractor exception is sanitized to `frame_extract`.
- A null or empty extraction result advances to the next bounded candidate.
- A successful recovered image continues through normal OCR processing.
- OCR failures continue to use their existing bounded retry behavior.
- Exhausted extraction recovery keeps the analysis fail-closed with
  `incomplete_frame_coverage`.
- No recovery path creates an empty synthetic frame or clean verdict.

## Testing

Scout tests will verify:

- an EOF sample that fails at the requested timestamp recovers from an earlier
  frame and produces `ocr_status: analyzed`;
- classification receives the actual recovered timestamp;
- diagnostics include both `t` and `requested_t` for recovered samples;
- extraction at the requested timestamp does not emit `requested_t`;
- fallback timestamps are clamped, deduplicated, ordered, and never cross the
  preceding accepted sample;
- a permanently unreadable frame still produces
  `incomplete_frame_coverage`; and
- OCR request retry accounting is unchanged by extraction recovery.

The existing Scout OCR tests and TypeScript typecheck must pass. A live smoke
test against the reported Instagram reel should confirm full frame coverage.

## Acceptance Criteria

- The reported reel no longer fails solely because the exact final timestamp is
  beyond the last decodable frame.
- Successful analysis still reports equal requested and valid frame counts.
- Recovered samples use their real timestamps for tracking and blur windows.
- Permanent extraction failures still stop the required OCR pipeline.
- No platform name is required by the recovery implementation.

