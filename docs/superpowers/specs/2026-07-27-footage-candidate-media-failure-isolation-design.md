# Footage Candidate Media Failure Isolation — Design

**Date:** 2026-07-27  
**Status:** Approved

## Context

The required OCR stage now analyzes the reported Instagram main video
successfully with complete frame coverage. The subsequent `build_footage` stage
still aborts when one optional search candidate cannot be localized.

In the investigated run, the first TikTok result for the query
`Iqbaal Ramadhan behind the scenes film` resolved and completed OCR. The second
result did not produce a CDN URL. `build_footage` then handed the original
TikTok page to `attachVideoOcr`, which invoked the TikTok localizer and repeated
the same resolution path. TikWM network calls have no explicit timeout, so the
candidate can consume the parent step's 600-second timeout. A resulting
`media_access_failed` error is rethrown by `build_footage`, allowing one
optional candidate to abort the entire required pipeline stage.

## Goals

- Bound TikTok resolver and download network waits.
- Avoid resolving the same known-unresolvable TikTok candidate twice.
- Drop an optional footage candidate when its media cannot be accessed.
- Continue evaluating later candidates until the requested footage quota is
  filled or the candidate list is exhausted.
- Keep systemic OCR/configuration failures fatal.
- Ensure no failed or unanalyzed video candidate reaches the content set or
  renderer.
- Apply candidate-failure handling consistently across footage acquisition
  paths and supported social platforms.

## Non-Goals

- Treating an OCR provider outage as a clean or acceptable candidate.
- Retrying indefinitely.
- Downloading every search result before relevance selection.
- Changing OCR classification, trimming, subtitle blur, or rendering.
- Guaranteeing that every query yields video footage.

## Failure Classification

Candidate handling distinguishes two classes.

### Candidate-local media failure

`OcrAnalysisError` with code `media_access_failed` means the current candidate
could not be resolved or downloaded safely. The candidate is rejected, a
sanitized drop diagnostic is emitted, and selection continues.

The rejected record is never appended to `set.footage`. It carries no implicit
clean verdict and cannot reach validation or rendering.

### Systemic or analysis failure

Every other `OcrAnalysisError` remains fatal, including missing configuration,
provider/model failure, malformed analysis, and incomplete OCR coverage. These
errors indicate that the pipeline cannot establish safety for video candidates
in general, rather than merely lacking access to one optional source.

This preserves the enforced OCR contract while isolating media availability
from analysis correctness.

## Resolver and Download Deadlines

TikWM API resolution and CDN download each receive an explicit 15-second
deadline. Timeout is represented internally as an unavailable result, never as
clean media.

The existing CDP fallback retains its bounded WebSocket, command, and navigation
timeouts. The resolver proceeds from TikWM to CDP once, then returns `null`.
There is no unbounded third attempt.

`downloadTiktok` applies its own 15-second deadline to the CDN body request so a
server that accepts the connection but stalls the response cannot consume the
parent pipeline timeout.

## Footage Candidate Boundary

`build_footage` uses one candidate-level OCR adapter with this contract:

```ts
type CandidateOcrResult<T> =
  | { status: 'accepted'; entry: T & PersistedOcrFields }
  | { status: 'unavailable'; code: 'media_access_failed' };
```

The adapter:

1. calls the required `attachVideoOcr`;
2. returns the analyzed entry on success;
3. converts only `media_access_failed` into `unavailable`; and
4. rethrows every other error unchanged.

All optional footage-video paths use this boundary:

- creator-profile reels;
- video slides from Instagram/Facebook carousels; and
- search-result videos from TikTok, YouTube, or future supported platforms.

Each caller handles `unavailable` by incrementing a media-drop count and moving
to the next candidate.

For TikTok search results, if the existing first `tiktokDirectUrl` attempt
returns no URL, `build_footage` rejects that candidate immediately instead of
passing the page to `attachVideoOcr` for a duplicate resolution attempt.
Page URLs sent to `attachVideoOcr` by other callers retain its localization
safety behavior.

## Logging and Diagnostics

Per-query output includes a sanitized count:

```text
(1 drop media tak dapat diakses)
```

No raw CDN URL, response body, cookie, authorization header, or local temporary
path is logged. The original public candidate URL may remain in ordinary search
artifacts, but failure messages use only the safe error code and aggregate
count.

The final content set contains only successfully analyzed video footage and
ordinary still-image entries.

## Persistence and Quotas

Unavailable candidates do not consume video or post quota. Selection continues
through remaining candidates using the existing two-pass fill and cross-fill
logic.

`build_footage` continues its crash-resilient write after each completed query.
If all video candidates are unavailable, valid profile cards or still posts may
remain; the stage succeeds as long as no systemic OCR error occurs and the
result satisfies existing validation.

## Testing

### Resolver tests

- A stalled TikWM resolution request aborts at the configured deadline and
  permits the CDP fallback.
- A stalled CDN download returns an unavailable result without writing a
  partial media file.
- Successful resolution and download behavior remains unchanged.

### Candidate-boundary tests

- `media_access_failed` becomes `status: unavailable`.
- An unavailable candidate is not appended and does not consume quota.
- Selection proceeds to the next candidate, which may be accepted.
- `missing_api_key`, `incomplete_frame_coverage`, and ordinary unexpected
  exceptions remain fatal.
- The sanitized media-drop count is emitted without secrets.

### Pipeline regression

Use the reported content set/query where the second TikTok candidate is
unresolvable. `build_footage` must finish instead of reaching its 600-second
parent timeout. The resulting content set must validate, and every retained
video entry must have `ocr_status: analyzed`.

## Acceptance Criteria

- The reported pipeline proceeds beyond `build_footage`.
- One unresolvable optional candidate cannot abort or hold the stage for 600
  seconds.
- Later candidates are still evaluated.
- No inaccessible or unanalyzed video enters `set.footage`.
- Systemic OCR and configuration failures still abort the stage.
- Logs explain how many candidates were dropped without leaking sensitive
  media-access details.

