# Instagram Carousel First-Slide Headline Vision — Design

**Date:** 2026-07-28  
**Status:** Approved

## Context

`scout/pipeline/trace_source.ts` enriches the main post with three signals:
caption, `headline(vision)`, and `scene(vision)`. For Instagram it currently
gets `og:image` from `igPostOg`, then `visionHeadline` and `visionCover`
download that signed CDN URL independently before calling Novita.

On the reference carousel:

`https://www.instagram.com/p/DbQoG9IjzGX`

the Instagram page supplies both the caption and an `og:image` URL, but the
separate Bun request to `scontent.cdninstagram.com` fails. The pipeline
therefore prints an empty `headline(vision)` even though slide 1 visibly
contains the cover content needed to identify the story.

This failure is independent of carousel footage selection. Slide 1 must remain
excluded from footage, but it must still be read as the topic-discovery cover.

## Goals

- For an Instagram `/p/` carousel, always derive headline and scene vision from
  the media in slide 1.
- Support both possible slide-1 media types:
  - photo: capture the displayed photo;
  - video: extract the earliest usable frame from that slide's video stream.
- Avoid a second download of the selected first-slide media from Instagram's
  signed image CDN.
- Keep trace-source enrichment best-effort: failures degrade to the existing
  `og:image` path and finally to empty vision text without aborting the
  pipeline.
- Preserve the existing rule that slide 1 is not carousel footage.

## Non-Goals

- Changing footage selection, OCR subtitle filtering, story-gate similarity,
  or `dropCoverSlide`.
- Changing Reel, Instagram single-media, or non-Instagram cover behavior.
- Reading later carousel slides for headline or scene enrichment.
- Combining the two existing Novita calls for headline and scene.
- Persisting the captured first-slide image in the content set.
- Requiring a second live Instagram post for acceptance.

## Decisions

- The governing visual is the actual media displayed in slide 1, even when
  `og:image` points to a different or custom thumbnail.
- The new path applies only when all of these conditions hold:
  - platform is `instagram`;
  - the permalink uses `/p/`;
  - `postShape(url).shape === 'carousel'`.
- A video-first carousel uses the first valid frame found at `0.0`, `0.1`,
  `0.25`, or `0.5` seconds, in that order.
- `og:image` remains a fallback, not the primary source for a carousel.
- If all visual sources fail, trace-source continues with empty headline and
  scene values.

## Architecture

### First-slide vision resolver

Add `scout/lib/ig_first_slide.ts` with one public operation:

```ts
type FirstSlideVisionInput = {
  dataUrl: string;
  kind: 'photo' | 'video';
  source: 'ig-slide1-photo' | 'ig-slide1-video';
  sampledAt: number | null;
};

resolveIgFirstSlideVisionInput(postUrl: string): Promise<
  FirstSlideVisionInput | null
>;
```

The public result contains only vision-ready data and safe provenance. Signed
CDN and direct-stream URLs must not be returned for logging.

The resolver owns three internal responsibilities:

1. Inspect the active first slide through the logged-in Instagram CDP tab and
   identify its largest displayed media element.
2. Capture a photo media element directly, excluding the surrounding post
   card, controls, caption, and profile chrome.
3. For a video element, resolve slide 1 with
   `igSlideDirectUrl(postUrl, 1)` and extract its first usable frame.

These operations must accept injectable dependencies so their control flow
can be tested without CDP, yt-dlp, FFmpeg, or network access.

### Photo input

For a photo-first carousel, use the media element's DOM rectangle with the
existing CDP screenshot primitives. Return the captured PNG as a
`data:image/png;base64,...` URL.

The capture is valid only when it passes the existing blank/black guard. The
resolver must not capture the full Instagram post card because caption text or
navigation chrome could be mistaken for the cover headline.

### Video input

For a video-first carousel:

1. Resolve only carousel item 1 through `igSlideDirectUrl(postUrl, 1)`.
2. Ask FFmpeg for one PNG frame at each candidate time:
   `0.0`, `0.1`, `0.25`, then `0.5` seconds.
3. Validate each PNG with the same blank/black guard used for browser crops.
4. Stop on the first valid frame and return its timestamp as `sampledAt`.

PNG is used instead of JPEG so the existing dimension-aware pixel-density
guard can consistently reject blank output. A failure to resolve or extract
the slide-1 video is non-fatal and enters the fallback path.

### Vision input normalization

`visionHeadline` and `visionCover` must accept either:

- an HTTP(S) URL, preserving existing behavior for other platforms and
  fallback sources; or
- a `data:` URL, which is passed directly to Novita without another fetch.

Both calls receive the same selected first-slide data URL. They remain
separate calls and preserve their existing prompts and output limits.

## Data Flow

```text
trace_source main
    |
    +-- Instagram /p/ carousel?
    |       |
    |       +-- resolveIgFirstSlideVisionInput
    |               |
    |               +-- photo --> CDP media-only PNG
    |               |
    |               +-- video --> slide 1 stream --> earliest valid PNG
    |                       |
    |                       +-- failure
    |                               |
    |                               v
    +--------------------------> og:image fallback
                                    |
                                    +-- failure --> empty vision values
    |
    +-- same selected input --> visionHeadline
    |
    +-- same selected input --> visionCover
```

Caption extraction continues to use `igPostOg`. Carousel shape detection uses
the corrected shared `postShape` helper and does not alter footage harvesting.

## Failure Handling and Diagnostics

Every failure remains best-effort, but the selected path must be observable.
Logs use stable reason codes and never print signed media URLs:

```text
[cover] source=ig-slide1-photo
[cover] source=ig-slide1-video sampled_at=0.1s
[cover] slide1 gagal (frame_extract_failed) -> fallback og:image
[cover] slide1 gagal (photo_capture_failed) -> fallback og:image
```

Expected internal reason codes include:

- `shape_probe_failed`
- `slide1_dom_missing`
- `photo_capture_failed`
- `slide1_stream_unavailable`
- `frame_extract_failed`
- `og_fetch_failed`

The normal `[2] headline(vision)` and `[2b] scene(vision)` lines remain. A
missing Novita key, failed Novita request, unavailable CDP tab, or exhausted
fallback produces empty vision text but does not fail `trace_source`.

## Testing

### Unit tests

Add `scout/lib/ig_first_slide.test.ts` as a plain Bun assertion script
following the existing Scout test style.
Through injected dependencies, prove:

- A photo-first carousel returns the CDP-captured slide-1 data URL and never
  resolves a video stream.
- A video-first carousel tries exactly `0.0`, `0.1`, `0.25`, and `0.5`
  seconds in order and stops at the first valid frame.
- Blank or invalid extracted frames are rejected.
- Failure of every video-frame candidate falls back to `og:image`.
- Failure of both the resolver and `og:image` yields empty vision values
  without throwing.
- Reel, Instagram single-media `/p/`, and non-Instagram inputs bypass the new
  resolver.
- `visionHeadline` and `visionCover` receive the same selected data URL.

Keep the existing `dropCoverSlide` tests unchanged as the regression proof
that reading slide 1 for topic discovery does not return it to footage.

### Regression

- Run the new resolver test.
- Run the existing `verify`, `ig_profile`, and complete Scout test set.
- Run `bun run typecheck` inside `scout/`.

## Live Acceptance

Run the pipeline against:

`https://www.instagram.com/p/DbQoG9IjzGX`

The result must show:

- `[cover] source=ig-slide1-photo`;
- non-empty `headline(vision)` that matches text visible on slide 1;
- `scene(vision)` derived from the same slide-1 input;
- no bare main URL or `#slide1` in carousel footage;
- retained carousel footage still consists only of eligible slides 2–5.

A video-first carousel is covered deterministically by the unit test. A second
external live post is not required for acceptance.

## Acceptance Criteria

- Instagram `/p/` carousel headline and scene vision use actual slide-1 media.
- Photo and video slide-1 inputs are both supported.
- Video extraction uses the first valid candidate from
  `0.0/0.1/0.25/0.5` seconds.
- The selected first-slide data is reused by both vision calls without a CDN
  refetch.
- `og:image` remains a graceful fallback.
- Vision failure does not abort the pipeline.
- Reel, single-media, other-platform, footage, and filtering behavior remain
  unchanged.
