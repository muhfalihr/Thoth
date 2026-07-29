# Platform-Page OCR Stream Resolution — Design

**Date:** 2026-07-29
**Status:** Approved design, pending written-spec review

## Context

Scout's required OCR path accepts either a local video, a direct media URL, or a
social-platform page URL. For non-TikTok page URLs, `attachVideoOcr` currently
calls `directStreamUrl`. When that helper fails, it returns an empty string and
the caller falls back to the original page URL:

```ts
directStreamUrl(value) || value
```

That fallback makes a resolver failure look like a media-duration failure.
FFprobe receives HTML instead of video, returns no usable duration, and OCR
fails with `duration_probe_failed`.

The reported run demonstrated this exact chain. The final main was:

```text
https://www.instagram.com/imajinari.merchandise/reel/DbUrhHZpQgk/
```

The OCR diagnostic's hashed video ID matched that page URL rather than a signed
Instagram CDN URL. A later probe of the same reel resolved successfully and
FFprobe reported `53.241950` seconds, proving that the media was valid and the
trigger was transient. The exact original yt-dlp failure cannot be recovered
because the helper discards stderr and catches every process error as an empty
result.

This design makes page-to-stream resolution explicit, bounded, typed, and
observable before FFprobe or OCR runs.

## Goals

- Never pass a supported social-platform page URL to FFprobe or FFmpeg.
- Resolve Instagram, YouTube, X/Twitter, and Facebook page URLs through one
  typed OCR-media boundary.
- Recover from transient yt-dlp failures with bounded retries.
- Cap all resolver attempts for one URL to a shared 30-second deadline.
- Preserve the distinction between stream-resolution and duration-probe
  failures.
- Keep final-main failures fatal while allowing optional unavailable candidates
  to be dropped.
- Emit useful sanitized diagnostics without exposing signed media URLs,
  cookies, tokens, or authorization data.
- Make all retry, deadline, parsing, and caller-policy behavior testable without
  network access.

## Non-Goals

- Downloading every remote video to a local file before OCR.
- Replacing TikTok's existing local-download OCR path.
- Replacing Threads' existing CDP/video-source path.
- Changing OCR sampling, classification, trim, mute, or subtitle-blur behavior.
- Retrying indefinitely or increasing the parent pipeline timeout.
- Treating an unavailable main as clean or usable.
- Logging raw yt-dlp output or signed CDN query strings.

## Chosen Architecture

Add `scout/lib/media_resolution.ts` as the shared boundary between page URLs and
media consumers.

```ts
type MediaResolutionSource =
  | 'local'
  | 'direct'
  | 'platform-resolver';

type StreamResolutionReason =
  | 'timeout'
  | 'extractor_exit'
  | 'no_stream'
  | 'unsupported';

type MediaResolutionResult =
  | {
      status: 'resolved';
      media: string;
      source: MediaResolutionSource;
      attempts: number;
      elapsed_ms: number;
    }
  | {
      status: 'unavailable';
      code: 'stream_resolution_failed';
      reason: StreamResolutionReason;
      attempts: number;
      elapsed_ms: number;
      safe_exit_code?: number;
      safe_detail?: string;
    };

type ResolveOcrMediaDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  runResolver?: (
    executable: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>;
  env?: Record<string, string | undefined>;
};

async function resolveOcrMedia(
  input: string,
  deps?: ResolveOcrMediaDeps,
): Promise<MediaResolutionResult>;
```

The module owns input classification, supported-page detection, yt-dlp process
execution, retry/deadline accounting, result validation, and sanitization. It
does not own caller policy, FFprobe, OCR, candidate ranking, or persistence.

### Input classification

Inputs are classified in this order:

1. An existing local path resolves immediately with `source: local`.
2. A recognized Instagram, YouTube, X/Twitter, or Facebook page URL requires
   platform resolution.
3. A recognized TikTok or Threads page URL is rejected as `unsupported` at
   this boundary so an accidental caller cannot bypass its specialized
   localizer/source extractor and send the page to FFprobe.
4. Any other HTTP(S) URL that is not a known platform page is treated as a
   direct-media candidate and resolves with `source: direct`; FFprobe remains
   the authority on whether it is valid media.
5. An empty, malformed, or unsupported non-HTTP input returns
   `stream_resolution_failed` with `reason: unsupported`.

Supported-page detection must use explicit host/path rules rather than file
extensions. Signed CDN URLs frequently lack a useful extension, while platform
pages may contain misleading path fragments.

TikTok page URLs continue through the existing safe localization/download path.
Threads callers must continue supplying their resolved video source rather than
passing a Threads page into this resolver.

### Resolver attempts and shared deadline

Platform resolution uses at most three attempts. All attempts and backoff waits
share one 30-second monotonic deadline.

The default backoff schedule after failed attempts is:

```text
attempt 1
wait 500 ms
attempt 2
wait 1500 ms
attempt 3
```

Before each process invocation, the runner receives only the remaining deadline
as its timeout. No attempt starts when the remaining budget is exhausted.
Therefore the worst-case resolver time remains 30 seconds, not three separate
30-second waits.

The following outcomes are retryable while budget remains:

- child-process timeout;
- nonzero yt-dlp exit;
- empty stdout;
- stdout with no valid direct HTTP(S) stream; and
- a returned URL that is still a recognized platform page.

Malformed input and unsupported input kinds are not retryable.

### Stream validation

A successful platform-resolution result must contain an HTTP(S) URL that:

- is not identical to the input page;
- does not match a supported platform-page pattern;
- contains no embedded credentials; and
- is the first valid URL emitted by the resolver.

The raw URL remains available only to the media consumer. Diagnostics use a
hash of the public input URL and never persist or print the signed result.

## Integration

### Required OCR boundary

`attachVideoOcr` calls `resolveOcrMedia` for every non-TikTok input instead of:

```ts
directStreamUrl(value) || value
```

When resolution is unavailable, `attachVideoOcr` throws an
`OcrAnalysisError('stream_resolution_failed', ...)`. It must not invoke
`analyzeSubtitlesDetailed`, FFprobe, frame extraction, or Novita.

Successful resolution passes the local/direct stream into the existing OCR
analysis. Existing current-OCR metadata reuse remains unchanged.

### Caller policy

The typed resolver failure is interpreted according to candidate ownership:

| Caller context | Persistent resolution failure |
|---|---|
| Finalized main | Fatal `stream_resolution_failed` |
| Input candidate before final selection | Reject as `media_unavailable`, then search |
| Optional footage/main-search candidate | Convert to candidate-local `media_access_failed`, drop, continue |
| Local OCR CLI input | Not applicable; CLI accepts a local path |

A candidate-local failure never creates clean OCR metadata and never consumes a
candidate quota.

### Existing direct-stream callers

Non-OCR callers may retain `directStreamUrl` temporarily, but OCR and
main-suitability paths must use the typed resolver. Any compatibility wrapper
must not be used where required analysis depends on the result.

## Duration-Probe Contract

`probeDuration` currently maps every non-ENOENT FFprobe exception to numeric
zero. Refactor its internal result so diagnostics can distinguish process
failure from invalid output:

```ts
type DurationProbeResult =
  | { status: 'ok'; duration: number }
  | {
      status: 'failed';
      code: 'ffprobe_missing' | 'duration_probe_failed';
      reason: 'missing_binary' | 'timeout' | 'process_exit' | 'invalid_output';
      safe_exit_code?: number;
    };
```

The public OCR envelope keeps the existing `ffprobe_missing` and
`duration_probe_failed` codes for compatibility. The more specific reason is
diagnostic-only. Raw FFprobe stderr and private URLs are not persisted.

This separation guarantees:

- a failed page resolver reports `stream_resolution_failed`;
- a successfully resolved stream with unreadable duration reports
  `duration_probe_failed`; and
- an absent executable reports `ffprobe_missing`.

## Data Flow

```text
attachVideoOcr
    |
    v
resolveOcrMedia
    |
    +-- local/direct -----------------------------+
    |                                             |
    +-- supported platform page                   |
            |                                     |
            +-- bounded yt-dlp attempts           |
                    |                             |
                    +-- unavailable --> caller policy
                    |
                    +-- resolved -----------------+
                                                  |
                                                  v
                                          duration probe
                                                  |
                                                  v
                                         frame extraction
                                                  |
                                                  v
                                                OCR
```

## Diagnostics and Security

Each resolver diagnostic contains only:

- schema/analyzer version;
- hashed public source ID;
- normalized platform;
- final status and safe reason code;
- attempt count;
- elapsed milliseconds;
- safe numeric exit code when available; and
- a sanitized, length-bounded error detail.

Sanitization must remove:

- HTTP(S) URLs and their query strings;
- cookie-file paths;
- `Cookie`, `Authorization`, and bearer-token values;
- Instagram session identifiers;
- local temporary paths; and
- arbitrary long process output.

Ordinary console logs use stable messages such as:

```text
[media] instagram resolve attempt 2/3
[media] resolved attempts=2 elapsed=6412ms
[media] unavailable reason=timeout attempts=3 elapsed=30000ms
```

They never include the resolved CDN URL.

## Testing Strategy

Implementation follows red-green-refactor.

### Resolver unit tests

- Local files resolve without invoking yt-dlp.
- Non-platform HTTP(S) URLs pass through as direct candidates.
- Supported platform pages invoke the resolver.
- A first failure followed by success returns the second direct stream.
- Empty stdout and a returned platform-page URL are retryable failures.
- Three persistent failures return one typed unavailable result.
- All attempts and backoffs share one 30-second deadline.
- No attempt starts after the shared deadline expires.
- Unsupported inputs fail without retry.
- Result parsing accepts the first valid direct HTTP(S) URL.
- Sanitization removes URLs, queries, cookies, authorization values, tokens,
  and local paths.

### OCR integration tests

- An unavailable platform page throws `stream_resolution_failed`.
- Resolver failure never calls duration probing, frame extraction, or OCR.
- A resolved stream proceeds through existing analysis.
- A missing FFprobe still returns `ffprobe_missing`.
- A resolved but unprobeable stream returns `duration_probe_failed`.
- Current OCR metadata prevents redundant resolution and analysis.

### Caller-policy tests

- Final-main resolution failure remains fatal.
- An unavailable input candidate enters replacement search.
- An unavailable optional candidate is dropped without consuming quota.
- A later available candidate can still be accepted.
- Systemic OCR/provider failures remain fatal and are never converted into
  candidate-local media failures.

### Required verification

- Focused resolver, OCR-content, subtitle-vision, and trace-source tests.
- Scout TypeScript typecheck.
- Biome checks for modified Scout files.
- Repository whitespace/diff validation.
- One live smoke test against the reported Instagram source after offline tests
  pass.

## Live Acceptance

Run the pipeline against:

```text
https://www.instagram.com/p/DbQoG9IjzGX
```

For the selected reel, the run must show that:

- a platform page is resolved before duration probing;
- a transient resolver failure is retried within the shared deadline;
- FFprobe never receives the Instagram page URL;
- the duration is positive;
- final-main OCR completes with full metadata; and
- the pipeline does not report a page-resolution problem as
  `duration_probe_failed`.

If all resolver attempts fail, the surfaced error must be
`stream_resolution_failed` with sanitized diagnostics.

## Acceptance Criteria

- Supported platform page URLs never reach FFprobe or FFmpeg.
- One transient resolver failure can recover within a total 30-second budget.
- Persistent failures retain their true `stream_resolution_failed` identity.
- Final main remains fail-closed.
- Optional unavailable candidates are isolated and selection continues.
- `duration_probe_failed` is reserved for already-resolved media.
- Diagnostics identify the failure class and attempt behavior without exposing
  sensitive URLs or credentials.
- Existing TikTok localization and Threads source handling remain unchanged.
