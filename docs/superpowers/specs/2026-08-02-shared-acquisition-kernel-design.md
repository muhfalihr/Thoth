# Shared Acquisition Kernel Design

**Date:** 2026-08-02

**Status:** Approved for implementation planning

**Scope:** Scout acquisition from discovery through source tracing, footage, comments, and social-card capture

## Summary

Scout will replace its stage-specific platform acquisition with a shared acquisition kernel. Pipeline stages will request outcomes such as discovery, post inspection, comment collection, media materialization, or social-card capture. The kernel will choose the safest available source for the platform and purpose: cached normalized data, passive CDP network capture, public metadata, `gallery-dl`, yt-dlp, direct HTTP, or limited DOM extraction.

The design minimizes repetitive logged-in browser behavior by serializing CDP activity, deduplicating canonical URLs, caching normalized results, and stopping a platform when authentication, rate-limit, or challenge signals appear. It does not attempt to evade bot detection through stealth plugins, fingerprint spoofing, CAPTCHA bypass, or simulated human randomness.

## Goals

- Give `discover_reels`, `run_pipeline`, `trace_source`, `build_footage`, `collect_comments`, and image enrichment one acquisition interface.
- Prefer passive observation of network responses over repeated DOM interactions.
- Navigate a canonical post URL at most once per pipeline run.
- Use `gallery-dl` for original photos and carousels when available.
- Use CDP screenshots when author, text, replies, comments, or other social context must remain visible.
- Preserve platform-specific behavior behind adapters while returning normalized records.
- Keep the current Rust content-set contract compatible.
- Fail safely when a platform is rate-limited, logged out, challenged, unsupported, or temporarily broken.

## Non-goals

- Replaying captured private GraphQL requests automatically.
- Persisting complete request headers, cookies, CSRF values, authorization values, or raw private payloads.
- Making every platform use the same underlying capture tool.
- Replacing Scout's relevance, ownership, main-suitability, OCR, or story gates.
- Adding a persistent acquisition daemon in the first implementation.
- Circumventing platform security controls or account verification.

## Architecture

Create `scout/acquisition/` as the only Scout layer allowed to acquire platform data or materialize platform media.

### Public facade

`service.ts` exposes intent-oriented operations:

```ts
interface AcquisitionService {
  discover(request: DiscoveryRequest): Promise<DiscoveryResult>;
  inspectPost(url: string): Promise<PostRecord>;
  collectComments(url: string, limits: CommentLimits): Promise<CommentRecord[]>;
  materialize(asset: MediaAsset, purpose: AssetPurpose): Promise<LocalAsset>;
  captureSocialCard(url: string, purpose: SocialCardPurpose): Promise<LocalAsset>;
}
```

Pipeline code chooses the intent. It does not choose CDP, `gallery-dl`, yt-dlp, or DOM selectors.

### Modules

- `types.ts` owns normalized request, post, media, comment, provenance, and outcome types.
- `service.ts` is the facade and coordinates policy, adapters, cache, and materialization.
- `policy.ts` chooses sources by platform, intent, capability, cache state, and open circuits.
- `browser_coordinator.ts` serializes CDP work and owns navigation budgets and platform circuits.
- `network_capture.ts` observes CDP Network events without platform-specific parsing.
- `cache.ts` owns canonical identities, same-run deduplication, expiration, negative caching, and sanitized persistence.
- `materialize.ts` saves approved assets through direct HTTP, `gallery-dl`, or yt-dlp.
- `adapters/` contains Instagram, X/Twitter, TikTok, YouTube, Facebook, Threads, and Reddit adapters.

The browser coordinator remains in-process. The facade and adapter boundaries must permit a future sidecar without changing pipeline consumers.

## Normalized contracts

The precise types may grow during planning, but every adapter must return the following semantic fields where available:

```ts
type AcquisitionSource =
  | 'cache'
  | 'network'
  | 'public-metadata'
  | 'gallery-dl'
  | 'yt-dlp'
  | 'direct-http'
  | 'dom';

type AcquisitionStatus = 'resolved' | 'unavailable' | 'blocked';

interface AcquisitionOutcome {
  status: AcquisitionStatus;
  source?: AcquisitionSource;
  attempts: number;
  elapsed_ms: number;
  reason?:
    | 'timeout'
    | 'not-found'
    | 'unsupported'
    | 'rate-limited'
    | 'auth-required'
    | 'challenge'
    | 'invalid-response'
    | 'materialization-failed';
}

interface PostRecord {
  canonical_url: string;
  platform: string;
  post_id: string;
  owner_handle: string;
  text: string;
  published_at?: string;
  engagement?: Record<string, number>;
  media: MediaAsset[];
  outcome: AcquisitionOutcome;
}

interface MediaAsset {
  id: string;
  kind: 'image' | 'video';
  index: number;
  width?: number;
  height?: number;
  duration_sec?: number;
  ephemeral_url?: string;
  canonical_post_url: string;
}
```

Signed media URLs are ephemeral transport values, not identities. Cache keys use canonical platform, post ID, asset index, and purpose.

## Acquisition flow

Every request follows this bounded sequence:

1. Canonicalize the URL and remove tracking parameters.
2. Consult same-run deduplication and the durable sanitized cache.
3. Select the platform adapter and source policy.
4. Acquire metadata and candidate media references.
5. Normalize and validate the response.
6. Apply existing Scout admission gates before downloading candidate footage.
7. Materialize only selected assets.
8. Capture a targeted social-context screenshot only when requested.
9. Persist normalized data, safe provenance, and safe failure information.

For passive browser capture, the coordinator enables CDP Network monitoring before one direct navigation. The adapter observes matching JSON and media responses, extracts normalized fields, and removes its listeners. Captured private requests are not replayed.

## Platform policy

| Platform | Preferred acquisition | Media materialization | Context visuals |
|---|---|---|---|
| Instagram | Passive GraphQL response, then public metadata or limited DOM | `gallery-dl` for photos/carousels; captured CDN or yt-dlp for video | Targeted CDP post/comment crop |
| X/Twitter | Passive network response, then limited DOM | `gallery-dl` or direct image; captured CDN or yt-dlp for video | Targeted CDP tweet/reply crop |
| TikTok | Public metadata plus passive capture when necessary | Existing direct resolver, then yt-dlp; `gallery-dl` for photo posts | Targeted CDP comment crop |
| YouTube | Public metadata/player information | yt-dlp | CDP only for requested comment context |
| Facebook | Passive network response, then limited DOM | `gallery-dl` where supported; captured CDN or yt-dlp for video | Targeted CDP post/comment crop |
| Threads | Passive response, Open Graph, then limited DOM | `gallery-dl` or direct image; captured Meta CDN video | Targeted CDP post/reply crop |
| Reddit | Public JSON where available, then passive capture | `gallery-dl` or direct media | Targeted CDP post/comment crop when required |

The fallback order is capability-aware rather than a single universal chain:

- Images and carousels: captured media reference, `gallery-dl`, direct HTTP, limited DOM extraction.
- Videos: captured CDN reference, existing platform resolver, yt-dlp.
- Metadata: passive response, public metadata, limited DOM extraction.
- Social cards and comments: reuse an existing page visit when possible, then take a targeted CDP crop.
- Exhausted fallbacks: return a structured unavailable result and skip the candidate.

`gallery-dl` is optional. Scout resolves it from `GALLERY_DL` or the `gallery-dl` executable on `PATH`. Missing capability continues through the approved fallbacks.

## Browser safety and coordination

The browser coordinator enforces these invariants:

- Only one browser navigation runs globally at a time.
- A canonical post URL receives at most one browser acquisition attempt per run.
- Acquisition uses direct navigation. Feed scrolling and repeated clicking are disallowed unless a requested screenshot cannot otherwise be produced.
- Backoff and budgets are deterministic and configurable. There is no randomized human simulation.
- Visible persistent Chromium remains the default.
- Network listeners are removed after success, timeout, or failure.

Initial defaults are:

- Network-capture deadline: 15 seconds.
- Transport-timeout attempts: at most two.
- Every other acquisition outcome: one attempt.
- Discovery cache lifetime: 30 minutes.
- Normalized post metadata lifetime: six hours.
- Negative-result cache lifetime: 15 minutes.
- Downloaded asset lifetime: content-addressed cache until normal cleanup.
- Signed CDN lifetime: current process only.

These values live in configuration so future tuning does not require adapter changes.

## Circuit breaking

The coordinator opens a platform circuit for the rest of the run when an authenticated platform acquisition detects:

- HTTP `401`, `403`, or `429`;
- a login, CAPTCHA, checkpoint, or account-verification screen;
- session invalidation;
- repeated malformed platform responses.

Once open, the circuit prevents further browser activity for that platform. Cached results and other platform adapters may continue. A required pipeline stage fails only when its existing success criteria cannot be met from remaining sources.

## Privacy, credentials, and diagnostics

CDP events may expose cookies, headers, CSRF values, and signed URLs. These values remain in memory only. Scout must not write complete HAR files or raw request recipes.

Persistent records may contain:

- canonical public URLs;
- normalized public metadata;
- content-addressed local paths;
- source category and timestamps;
- attempts, elapsed time, and safe failure reason.

Logs and diagnostics redact tracking parameters, signed query strings, cookies, authorization values, request bodies, and response bodies. A diagnostic may use a hash of the canonical URL when the full public URL is unnecessary.

## Pipeline migration

### `discover_reels`

Use `discover()` for account feeds and trending sources. Adapters return normalized post summaries; the existing topic extraction, vision, audio, recency, and ranking logic remains in the pipeline.

### `run_pipeline`

Use `inspectPost()` once to construct the seed. Pass one acquisition service and run context through subsequent stages so budgets, cache entries, deduplication, and circuits are shared.

### `trace_source`

Use `inspectPost()` for caption, cover, shape, ownership, and media. Use `discover()` for account and keyword searches. Keep the existing source-resolution, main-suitability, ranking, vision, and OCR gates.

### `collect_comments`

Use `collectComments()` for normalized comment data. Prefer captured or public response data. Render only selected comment screenshots through CDP, reusing the same page visit where possible.

### `build_footage`

Use `discover()` for candidates and `inspectPost()` for validation. Run ownership, duplication, relevance, reaction, story, and OCR admission before `materialize()` whenever the gate does not require a local asset. Only admitted candidates are downloaded.

### `enrich_image_paths`

Convert the command into a compatibility and repair wrapper around `materialize()` and `captureSocialCard()`. It is no longer required in the normal pipeline after every stage produces the correct asset.

### `validate_content_set`

Keep the existing content-set contract and validation behavior. Acquisition cache and provenance remain internal unless rendering later needs a new field.

## Rollout phases

### Phase 1: Foundation

Add normalized contracts, URL canonicalization, policy, cache, browser coordinator, network observer, materializer, and dependency-injected tests.

### Phase 2: Platform adapters

Add adapters for Instagram, X/Twitter, TikTok, YouTube, Facebook, Threads, and Reddit. Existing platform helpers may initially be wrapped behind adapters. Each adapter must pass the shared contract suite.

### Phase 3: Pipeline migration

Migrate seed construction, discovery, source tracing, footage discovery and inspection, comments, and image enrichment. Share one run context across stages. Remove direct acquisition decisions from pipeline files.

### Phase 4: Cleanup and acceptance

Remove or internalize superseded direct helpers, add installation and operations documentation, run test fixtures, and perform controlled live acceptance with manually supplied URLs and small budgets.

## Error handling

- Cache hit: return immediately with `source: 'cache'`.
- Unsupported capability: advance to the next allowed source without retrying the same source.
- Transport timeout: retry once within the operation deadline.
- Invalid response: record a safe failure and advance once; do not probe response variants repeatedly.
- Materialization failure: try the next tool allowed for the asset kind.
- Authentication, challenge, or rate limit: open the platform circuit and return `blocked`.
- All sources exhausted: return `unavailable`; required pipeline gates decide whether the whole run can continue.

Cancellation and child-process timeouts must use the repository's existing supervised process patterns. Downloader commands use argument arrays through `execFile` or equivalent, never shell-composed command strings.

## Testing strategy

### Unit and contract tests

- Canonical URL and tracking-parameter removal.
- Cache expiration, same-run deduplication, and negative caching.
- Source ordering by platform, purpose, capability, and circuit state.
- Network matcher and sanitized parser fixtures.
- Circuit opening and subsequent acquisition suppression.
- Credential, signed-URL, and payload redaction.
- Adapter fallback behavior through dependency injection.
- Safe `gallery-dl` and yt-dlp argument construction.
- Listener and session cleanup after every terminal outcome.

### Integration tests

Use fake CDP and fake downloader processes to prove:

- one canonical URL causes at most one browser navigation per run;
- passive capture does not replay private requests;
- a selected social card can reuse an existing page visit;
- an open platform circuit prevents subsequent navigation;
- rejected candidates are not downloaded;
- missing `gallery-dl` reaches the next approved fallback;
- no sensitive material reaches cache, logs, diagnostics, or content-set output;
- pipeline stages share the same acquisition context.

### Controlled live acceptance

Live acceptance is manual, small-budget, and excluded from CI. For each supported platform, verify metadata acquisition, appropriate media materialization, cache reuse, and safe failure. Visual acceptance includes an X post card and representative comment cards.

## Completion criteria

- Target pipeline files no longer connect to CDP or invoke downloader executables directly.
- All platform acquisition flows through the shared kernel.
- A canonical URL is browser-navigated at most once per run.
- Original photos and carousels prefer `gallery-dl` when supported.
- Social-context posts and comments use targeted CDP capture.
- Only admitted footage candidates are materialized.
- Rate-limit, authentication, or challenge detection stops that platform for the run.
- Sensitive request data is absent from persistent output and diagnostics.
- Scout typecheck, unit tests, integration tests, and content-set validation pass.
- Rust accepts and renders the unchanged content-set schema.
- Documentation covers the managed browser, cache, safety controls, `GALLERY_DL`, and fallback behavior.
