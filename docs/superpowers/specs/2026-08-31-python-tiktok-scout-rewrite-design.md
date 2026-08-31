# Python TikTok Scout Rewrite Design

**Status:** Approved in conversation; written specification awaiting file review

**Date:** 2026-08-31

**Scope:** Replace the single-URL TikTok source-investigation path in TypeScript Scout with a Python implementation. Scrapling headless acquisition is the primary strategy, TikWM-backed CDN resolution is the secondary strategy, and the existing TypeScript Scout activity remains a temporary, explicitly enabled safety net.

## Context

The Python control plane and Temporal source-investigation workflow are already implemented. The workflow currently has two worker paths:

- `inspect_source_candidates`, a Python placeholder that writes a minimal report without inspecting the supplied source URL; and
- `inspect_legacy_scout`, a bounded subprocess adapter that invokes `bun scout/cli.ts run <url> --out <path>`.

The control-plane design intentionally deferred Scout replacement to later, capability-sized plans. It requires each Python replacement to pass offline fixtures, a controlled live smoke, cancellation, restart, and artifact gates before the legacy adapter can be retired.

The first replacement slice is deliberately limited to one canonical TikTok post URL. It does not port Scout discovery, comments, OCR, footage planning, enrichment, or any other platform.

## Goals

- Inspect one TikTok post from the existing durable Python workflow.
- Use Scrapling's stealthy headless browser as the first acquisition attempt.
- Fall back to TikWM only when headless acquisition fails, is blocked, is incomplete, or yields media that cannot be materialized.
- Materialize ephemeral media immediately into the configured artifact root.
- Produce a strict, versioned `source-report.json` and preserve the existing `ArtifactRef` API boundary.
- Keep browser, provider, CDN, cookie, and signed-URL details out of Temporal history, API responses, and persisted diagnostics.
- Keep the TypeScript Scout subprocess available behind a migration mode until the Python TikTok path passes its retirement gates.
- Route non-TikTok sources to the legacy activity during this slice when the selected migration mode permits it.

## Non-goals

- Rewriting Scout as a whole.
- TikTok profile, keyword, or trending discovery.
- Collecting TikTok comments or producing social-card crops.
- Identifying an earlier/original source by searching other posts or platforms.
- Porting OCR, candidate ranking, main-footage selection, narration, or enrichment.
- Supporting Instagram, Threads, Facebook, X, YouTube, or Reddit in Python.
- Persisting raw page HTML, raw Scrapling responses, raw TikWM responses, cookies, browser profiles, or ephemeral media URLs.
- Removing `scout/`, Bun, or `LegacyScoutActivity` in this slice.

## Architectural Decision

The implementation will add a small Python acquisition kernel with one TikTok adapter. The kernel owns strategy ordering and typed outcomes but knows nothing about Temporal or the legacy subprocess. The Temporal activity owns timeouts, cancellation, artifact destinations, safe progress events, and conversion into `SourceInvestigationActivityResult`. The workflow owns the optional transition to the legacy activity.

```text
SourceInvestigationWorkflow
    |
    +-- Python source activity
    |      |
    |      +-- TikTokAcquisitionService
    |             |
    |             +-- 1. Scrapling headless strategy
    |             |      load post -> parse metadata -> locate media
    |             |
    |             +-- 2. TikWM CDN strategy
    |             |      resolve ephemeral URL -> materialize immediately
    |             |
    |             +-- validated SourceReport + local media
    |
    +-- 3. LegacyScoutActivity, only when workflow mode permits fallback
           bun scout/cli.ts run <url> --out <path>
```

Headless is the primary path. A direct media URL found by the headless browser is an output of the primary path, not the CDN fallback. "CDN fallback" in this design specifically means calling the TikWM mirror after the headless attempt is unsuccessful or incomplete.

## Module Boundaries

The target structure is:

```text
python/src/thoth_control_plane/
|-- acquisition/
|   |-- __init__.py
|   |-- models.py
|   |-- service.py
|   |-- materializer.py
|   |-- browser.py
|   `-- adapters/
|       |-- __init__.py
|       `-- tiktok.py
|-- activities/
|   |-- source_investigation.py
|   `-- legacy_scout.py
`-- workflows/
    `-- source_investigation.py
```

### `acquisition/models.py`

Defines strict internal contracts only:

- `AcquisitionStrategy`: `scrapling_headless` or `tikwm_cdn`.
- `AttemptStatus`: `succeeded`, `failed`, or `incomplete`.
- `AcquisitionReason`: a finite safe reason code.
- `AcquisitionAttempt`: strategy, status, reason, attempt count, and elapsed milliseconds.
- `TikTokPost`: canonical URL, post ID, owner handle, caption, optional publication time, and optional engagement counts.
- `ResolvedMedia`: in-memory media descriptor whose ephemeral URL is excluded from serialization.
- `MaterializedMedia`: artifact-relative location, media type, byte count, checksum, and optional dimensions and duration.
- `TikTokSourceReport`: the persisted versioned report.

No model in this module imports Scrapling, HTTPX, Temporal, FastAPI, or the legacy adapter.

### `acquisition/browser.py`

Wraps Scrapling behind a narrow asynchronous protocol. The production implementation uses a stealthy headless session and returns an in-memory `BrowserSnapshot` containing:

- the validated final TikTok post URL;
- normalized metadata candidates;
- direct HTTP(S) media candidates observed in embedded page data, the active video element, or matching browser network responses; and
- safe acquisition timing and failure classification.

Raw HTML, network response bodies, cookies, storage state, request headers, and browser traces are never returned across this boundary or persisted. Scrapling-specific selectors and API calls remain isolated here so the TikTok parser and service can be tested without installing or launching a browser.

### `acquisition/adapters/tiktok.py`

Owns TikTok URL validation, post-ID and owner parsing, extraction from the sanitized browser snapshot, and TikWM response validation. It accepts only HTTPS URLs on these host forms:

- `tiktok.com`, `www.tiktok.com`, or `m.tiktok.com` with an `/@<owner>/video/<post-id>` path;
- `vm.tiktok.com` or `vt.tiktok.com` short links whose validated redirect terminates at an allowed canonical post URL.

URLs containing user information, a non-default port, or a redirect outside the TikTok host set are rejected. Query strings and fragments are removed from the persisted canonical URL.

The adapter exposes no discovery, comments, or social-card interface in this slice.

### `acquisition/materializer.py`

Streams a resolved video to the configured artifact root. It:

1. accepts only HTTPS URLs without user information and with port 443 or no explicit port;
2. rejects loopback, private, link-local, multicast, and otherwise non-public resolved addresses before every request and redirect;
3. follows at most three redirects and revalidates every target;
4. writes to a `.part` file under the final artifact directory;
5. caps a media response at 500 MiB;
6. requires an advertised video content type or a recognized MP4-compatible file signature;
7. requires at least 10,000 bytes;
8. computes SHA-256 while streaming;
9. atomically replaces the final file only after validation; and
10. deletes partial files on failure or cancellation.

The materializer never logs or persists its input URL.

### `acquisition/service.py`

Implements the strategy chain and evidence merge:

1. Run Scrapling headless.
2. If headless yields usable metadata and a media candidate, try to materialize that candidate.
3. If headless is blocked, times out, yields incomplete required metadata, has no usable media candidate, or its media cannot be materialized, call TikWM once through the shared rate gate.
4. Validate and materialize the TikWM media candidate.
5. Merge compatible headless metadata with validated TikWM metadata. Canonical URL, post ID, and owner from the validated TikTok URL take precedence over provider-supplied values.
6. Return either a complete `TikTokSourceReport` or a safe terminal acquisition failure.

A complete result requires a canonical post URL, post ID, owner handle, one locally materialized video, its byte count, and its checksum. Caption may be empty. Publication time, engagement, dimensions, and duration are optional.

The service does not call the TypeScript legacy adapter. It returns typed failure information to the activity/workflow boundary.

### `activities/source_investigation.py`

Replaces the placeholder behavior for TikTok. `SourceInvestigationActivityInput` gains `canonical_source_url`. The activity:

- validates its input before starting acquisition;
- constructs the service with runtime settings and artifact paths;
- enforces strategy deadlines;
- emits only typed safe progress events;
- writes `source-report.json` atomically after media materialization succeeds; and
- maps the report to the existing `SourceInvestigationActivityResult` and `ArtifactRef` boundary.

The report location remains `reports/<workflow-id>/source-report.json`. The video location is `reports/<workflow-id>/media/tiktok-<post-id>.mp4`. Both paths are artifact-root-relative and contain no user-controlled path segment.

The generic Python progress-event model will be named for source acquisition rather than the legacy subprocess. A compatibility alias may remain for internal imports during the change, but the serialized event shape and existing workflow query boundary do not change.

### `workflows/source_investigation.py`

The workflow passes the source display URL into the Python activity. Routing is deterministic from the workflow input's activity mode:

- `python`: run only the Python activity; unsupported platforms and terminal Python acquisition failures remain structured workflow failures.
- `python_tiktok_with_legacy_fallback`: run Python for TikTok, then run the legacy activity only for an eligible terminal acquisition failure; route non-TikTok sources directly to legacy.
- `legacy_scout`: retain the existing legacy-only path.

Invalid or unsafe input, artifact persistence failure, and local configuration failure are not eligible for legacy fallback. They fail directly because retrying them through a subprocess would either bypass validation or repeat an infrastructure problem. Headless block, headless timeout, incomplete page evidence, TikWM unavailability/rate limiting, and media validation failure are eligible acquisition failures.

The workflow remains deterministic: strategy execution stays inside activities, and the workflow branches only on serialized inputs and typed activity results.

## Persisted Report Contract

`source-report.json` has the following version 1 shape:

```json
{
  "schema_version": 1,
  "workflow_id": "wf_example",
  "source": {
    "platform": "tiktok",
    "canonical_url": "https://www.tiktok.com/@creator/video/1234567890"
  },
  "post": {
    "post_id": "1234567890",
    "owner_handle": "creator",
    "caption": "",
    "published_at": null,
    "engagement": {}
  },
  "media": [
    {
      "media_id": "media_1",
      "kind": "video",
      "index": 1,
      "location": "reports/wf_example/media/tiktok-1234567890.mp4",
      "media_type": "video/mp4",
      "bytes": 123456,
      "checksum": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "acquisition_strategy": "scrapling_headless",
      "width": null,
      "height": null,
      "duration_seconds": null
    }
  ],
  "outcome": {
    "status": "resolved",
    "attempts": [
      {
        "strategy": "scrapling_headless",
        "status": "succeeded",
        "reason": null,
        "attempt_count": 1,
        "elapsed_ms": 1200
      }
    ]
  }
}
```

Null optional values are explicit so fixture comparisons remain stable. The report never contains an ephemeral URL, redirect chain, provider body, raw exception, cookie, request header, browser executable path, or absolute filesystem path.

## Safe Failure Model

Final failures use a finite code set:

| Code | Retryable | Legacy fallback eligible | Meaning |
|---|---:|---:|---|
| `invalid_tiktok_url` | No | No | Input or redirect is not a safe canonical TikTok post URL. |
| `unsupported_platform` | No | Yes, for non-TikTok routing only | The Python slice does not implement this platform. |
| `headless_timeout` | Yes | Yes | Scrapling exceeded its strategy deadline. |
| `headless_blocked` | Yes | Yes | TikTok returned a challenge, login wall, or blocked response. |
| `headless_incomplete` | Yes | Yes | Page loaded but required evidence was absent. |
| `cdn_rate_limited` | Yes | Yes | TikWM remained rate limited after its bounded attempt. |
| `cdn_unavailable` | Yes | Yes | TikWM returned no valid media descriptor. |
| `media_validation_failed` | Yes | Yes | Resolved media could not be downloaded or validated. |
| `artifact_persistence_failed` | Yes | No | Local artifact creation or atomic replacement failed. |
| `acquisition_dependency_unavailable` | No | No | Required Scrapling/browser installation is missing or invalid. |

Provider messages are mapped to these codes at the infrastructure boundary. Workflow history receives a code, retryability flag, safe strategy events, and no raw diagnostic text.

## Timeouts, Cancellation, and Rate Control

- Scrapling headless deadline: 45 seconds.
- TikWM resolution deadline: 15 seconds.
- Media download deadline: 30 seconds.
- Overall Temporal activity `start_to_close_timeout`: 5 minutes.
- Python activity retry policy: at most three attempts, preserving the current workflow policy.
- TikWM calls: one call per strategy execution, guarded by an in-process monotonic rate gate with at least one second between starts.
- Acquisition worker concurrency for this initial slice: one activity at a time.

Temporal cancellation closes the Scrapling session, cancels pending HTTP work, and removes partial artifacts before the activity exits. Browser cleanup is idempotent so timeout and cancellation races do not leak processes.

## Dependencies and Runtime Configuration

Scrapling is an acquisition-worker extra rather than an API-server dependency:

```toml
[project.optional-dependencies]
acquisition = ["scrapling[fetchers]>=0.4.15,<0.5"]
```

The acquisition worker installation commands are:

```powershell
rtk uv sync --extra acquisition
rtk uv run scrapling install
```

Browser-related imports are lazy and remain behind the browser protocol, allowing the API process and the normal offline unit suite to run without launching a browser. A worker configured for Python TikTok acquisition performs a startup capability check and refuses Python acquisition work with `acquisition_dependency_unavailable` when the extra or browser is absent.

`THOTH_SOURCE_INVESTIGATION_ACTIVITY_MODE` accepts:

- `python`;
- `python_tiktok_with_legacy_fallback`; or
- `legacy_scout`.

During migration the documented default is `python_tiktok_with_legacy_fallback`. The default changes to `python` only after the retirement gates pass. Provider endpoints and timeout values remain internal constants in this slice; no user-facing request can select a provider, browser executable, CDN URL, or fallback order.

## Security and Privacy

- Browser and CDN fetching use an explicit public-HTTPS policy and redirect validation.
- User-controlled identifiers never become filesystem paths.
- Ephemeral signed URLs remain in memory only for the minimum time required to materialize media.
- No raw HTML or provider response is stored as an artifact.
- Logs identify workflow, strategy, result code, attempt count, and elapsed time only. They do not include source query strings, media hosts, signed URLs, cookies, response bodies, or subprocess output.
- The public API still exposes only the existing sanitized workflow source and `ArtifactRef` contract.
- The legacy fallback remains worker-only and uses an argument vector without shell interpolation.
- The feature does not attempt to bypass account access controls; it processes public TikTok post URLs and classifies challenge/login walls as blocked acquisition.

## Testing Strategy

### Unit tests

- URL validation covers canonical, mobile, short-link, malformed, user-info, non-HTTPS, non-default-port, cross-domain redirect, and non-post paths.
- Pure TikTok parsing uses sanitized captured fixtures and never accesses the network.
- Strategy-order tests prove headless always runs first.
- A complete headless result proves TikWM is not called.
- Blocked, timed-out, incomplete, and invalid-media headless outcomes prove TikWM is called exactly once.
- Evidence-merge tests prove canonical URL data wins over provider-supplied values.
- Materializer tests cover redirect revalidation, private-address rejection, response-size limit, content-type/signature checks, minimum size, checksum, atomic rename, timeout, and partial cleanup.
- Serialization tests prove reports and events contain no ephemeral URL, cookie, provider body, or absolute path.

### Activity and workflow tests

- The activity receives the canonical source URL and returns the existing artifact result shape.
- Cancellation closes the fake browser and removes a partial download.
- `python` mode never invokes legacy.
- `python_tiktok_with_legacy_fallback` does not invoke legacy after Python success.
- Eligible TikTok acquisition failure invokes legacy once.
- Unsafe input, dependency failure, and artifact failure never invoke legacy.
- Non-TikTok input routes directly to legacy only in the fallback mode.
- Temporal retries do not expose raw provider errors or produce duplicate final artifacts.

### Contract parity

A normalized TikTok fixture compares the Python report with the stable subset of the TypeScript Scout acquisition contract:

- canonical post URL;
- platform;
- post ID;
- owner handle;
- caption;
- video kind and index;
- resolved local media presence; and
- safe acquisition outcome.

Fields from the larger legacy content-set that are outside this slice are excluded rather than synthesized.

### Live smoke

The live smoke is opt-in, accepts one public TikTok post URL from an environment variable, and is not part of the ordinary offline suite. It verifies:

1. Scrapling is attempted first.
2. A report and local video are produced.
3. The local video satisfies size, checksum, and media validation.
4. The report contains no ephemeral URL or sensitive browser/provider data.
5. Cancellation leaves no browser process or `.part` artifact.

The smoke records which strategy succeeded but does not require TikWM to be unavailable or force a provider failure.

## Rollout

1. Land strict contracts, pure URL/parser behavior, and materializer tests.
2. Add the Scrapling wrapper and headless-first service behind dependency injection.
3. Add TikWM fallback and safe attempt telemetry.
4. Replace the placeholder Python source activity for TikTok.
5. Add deterministic workflow routing and the explicit fallback mode.
6. Run the full offline Python suite, Ruff checks, and legacy Scout regression tests.
7. Run the opt-in live smoke with fallback mode enabled.
8. Compare the normalized report with the same URL processed by TypeScript Scout.
9. Operate in `python_tiktok_with_legacy_fallback` until the retirement gates pass.
10. Change the documented mode to `python`; remove the legacy adapter only in a later, separately approved cleanup.

## Acceptance Criteria

- A canonical TikTok post can be inspected by the durable Python workflow.
- Headless acquisition is observably attempted before TikWM.
- TikWM is not called on a complete, materialized headless success.
- TikWM is called only after a categorized headless failure, incomplete result, or failed headless-media materialization.
- A successful result contains a validated local video and strict `source-report.json`.
- The public `ArtifactRef` shape remains compatible.
- No ephemeral URL, cookie, raw provider response, raw browser response, or absolute path is persisted or returned.
- Invalid or unsafe URLs cannot reach Scrapling, TikWM, the materializer, or legacy fallback.
- Cancellation closes the browser and removes partial files.
- Legacy executes only in the explicit fallback or legacy modes.
- Non-TikTok behavior remains on the existing legacy path during this slice.
- Ruff lint, Ruff format check, the complete Python test suite, focused Scout regressions, and the opt-in live smoke pass.

## Legacy Retirement Gates

This slice does not delete TypeScript Scout. TikTok may stop using the fallback mode only after all of the following are true:

- offline contract fixtures pass for both headless-success and CDN-fallback paths;
- the controlled live smoke passes on the supported worker environment;
- cancellation and activity-retry tests prove no leaked browser or partial artifact;
- normalized parity with the TypeScript TikTok result passes for the agreed stable subset;
- operators have run the Python path long enough to confirm its safe failure codes and artifact behavior; and
- a separately reviewed change switches the documented default from fallback mode to Python-only.

Removal of the legacy adapter, Bun package, or remaining Scout modules requires separate specifications for the remaining capabilities and platforms.
