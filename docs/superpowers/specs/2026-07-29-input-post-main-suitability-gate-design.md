# Input-Post Main Suitability Gate — Design

**Date:** 2026-07-29
**Status:** Approved design, pending written-spec review

## Context

`trace_source` builds strong evidence about the input post: caption, cover
headline, scene description, source keywords, and a combined story context. It
also has a comparatively strict main-search path that:

- verifies that candidates contain video;
- ranks caption/vision evidence against the story;
- applies `THOTH_SOURCE_STORY_MIN` (`0.33` by default);
- excludes configured curator accounts;
- prefers real footage over commentary;
- penalizes burned-in-subtitle/reaction candidates; and
- requires OCR before the selected video reaches the renderer.

The original input does not pass through that same decision boundary. When the
input platform is already considered video and no explicit source replacement
is found, the code can leave it as main without proving that it is relevant or
appropriate footage.

The desired behavior is:

- evaluate the input post first using the same rules as searched main
  candidates;
- keep it and skip replacement search when it is a strong main;
- search for main footage when it is unsuitable; and
- fail rather than render an unsuitable input when no replacement qualifies.

This design extracts one shared evaluator so input and searched candidates
cannot drift into different relevance and quality policies.

## Goals

- Decide explicitly whether the user-supplied post can be the main video.
- Reuse one evaluator, evidence builder, threshold, and reason-code vocabulary
  for input and searched candidates.
- Keep a strongly relevant, non-curator input without unnecessary search.
- Search for replacement footage when the input is not video, is off-topic, is
  a curator repost, is commentary/reaction, contains disqualifying subtitles,
  or is unavailable.
- Preserve the input caption/headline/scene as story context when replacement
  search is required.
- Preserve operational continuity when semantic similarity is unavailable by
  retaining an otherwise-valid non-curator input as low-confidence.
- Fail with `main_candidate_not_found` when an unsuitable input has no
  acceptable replacement.
- Reuse OCR metadata produced during evaluation instead of analyzing the
  selected main twice.

## Non-Goals

- Always searching and comparing alternatives when the input already qualifies.
- Selecting a merely more popular replacement for an accepted input.
- Weakening the curated-account exclusion.
- Accepting a photo-only post as a video main.
- Treating missing embeddings as proof that the input is relevant.
- Changing narration prompts, renderer behavior, or OCR classification rules.
- Persisting raw candidate evidence, embeddings, thumbnails, or signed URLs in
  the content set.
- Replacing existing profile-card or source-credit presentation behavior.

## Chosen Architecture

Add `scout/lib/main_candidate.ts` with a typed evaluator and shared evidence
contract.

```ts
type MainCandidate = {
  url: string;
  platform: string;
  caption?: string;
  thumbnail?: string;
  videoSrc?: string;
  uploader?: string;
  isVideo?: boolean;
};

type MainStoryEvidence = {
  caption: string;
  headline: string;
  scene: string;
  title: string;
  description: string;
  keywords: string[];
  storyText: string;
};

type MainRejectionReason =
  | 'not_video'
  | 'curated_aggregator'
  | 'off_topic'
  | 'commentary'
  | 'subtitle_reaction'
  | 'media_unavailable';

type MainSuitability =
  | {
      status: 'accepted';
      similarity: number;
      kind: 'footage' | 'unknown';
      confidence: 'high' | 'low';
      candidate: MainCandidate & PersistedOcrFields;
    }
  | {
      status: 'rejected';
      reason: MainRejectionReason;
      similarity?: number;
    }
  | {
      status: 'indeterminate';
      reason: 'similarity_unavailable';
      confidence: 'low';
      candidate: MainCandidate & PersistedOcrFields;
    };

type EvaluateMainCandidateDeps = {
  probeVideo?: (candidate: MainCandidate) => Promise<VideoProbeResult>;
  describeVisualKind?: (
    candidate: MainCandidate,
  ) => Promise<'footage' | 'commentary' | 'unknown'>;
  rankSimilarity?: (
    story: string,
    candidateEvidence: string,
  ) => Promise<number | null>;
  resolveMedia?: (input: string) => Promise<MediaResolutionResult>;
  attachOcr?: (
    candidate: MainCandidate,
    resolvedMedia: string,
  ) => Promise<MainCandidate & PersistedOcrFields>;
  isCurated?: (handle: string) => boolean;
  storyFloor?: number;
};

async function evaluateMainSuitability(
  candidate: MainCandidate,
  story: MainStoryEvidence,
  deps?: EvaluateMainCandidateDeps,
): Promise<MainSuitability>;
```

The evaluator owns candidate eligibility and evidence interpretation. It does
not own search, candidate enumeration, final mutation of `set.main`, profile
cropping, or pipeline persistence.

## Shared Evaluation Rules

Evaluation runs from cheapest to most expensive.

### 1. Video capability

The evaluator first proves that the post contains usable video.

- TikTok and YouTube video permalinks retain their existing verified behavior.
- Instagram, Facebook, and X/Twitter use metadata/shape probing rather than
  trusting the platform name.
- A photo-only post is rejected as `not_video`.
- A photo-first carousel with video on a later eligible slide counts as video.
  Detection must scan the bounded carousel range rather than pinning slide 1.
- Threads uses its existing extracted `videoSrc`.

This step determines only video capability. It does not yet resolve the final
OCR stream.

### 2. Curator exclusion

The candidate handle and canonical uploader/source handle are checked against
the shared curated-aggregator configuration.

A curator candidate is always rejected as `curated_aggregator`, even when:

- semantic similarity is high;
- it contains valid video;
- it is the original input; or
- embeddings are unavailable.

This preserves the existing rule that discovery accounts identify the story
but never remain the main source.

### 3. Shared story evidence

One evidence builder combines:

- candidate caption;
- representative video-frame/thumbnail description;
- input headline and scene;
- input title and description; and
- source keywords.

The story query uses the existing rich `storyCtx` construction. Candidate
visual evidence must describe the actual video content. A carousel's slide-1
headline remains useful story evidence but must not be used alone to classify
the later video as footage or commentary.

Both input and search evaluation call this same builder.

### 4. Semantic relevance

The evaluator reads the existing environment-backed floor:

```text
THOTH_SOURCE_STORY_MIN, default 0.33
```

When a numeric similarity is available:

- `similarity >= STORY_FLOOR` continues;
- `similarity < STORY_FLOOR` is rejected as `off_topic`.

There is one threshold and one comparison implementation for input and search
candidates.

When similarity is unavailable:

- an otherwise-valid non-curator input may continue toward media/OCR checks;
- if those checks pass, its final status is `indeterminate` and
  `source_low_confidence=true`;
- an indeterminate search candidate cannot replace an input merely because
  ranking is degraded; and
- if the input was hard-rejected and no search candidate has measurable
  qualifying relevance, selection fails with `main_candidate_not_found`.

### 5. Media resolution

The evaluator calls the typed `resolveOcrMedia` from the companion stream
resolution design.

- An unavailable input candidate is rejected as `media_unavailable`, allowing
  replacement search.
- An unavailable search candidate is dropped and the search continues.
- The evaluator never passes a platform page directly into OCR.

### 6. Visual kind and required OCR

The representative video visual is classified as footage, commentary, or
unknown. The resolved media also receives required OCR analysis.

- `commentary` is rejected.
- OCR outcome `subtitle` is rejected as `subtitle_reaction`.
- `footage` with successful OCR is accepted.
- `unknown` with measurable qualifying similarity and successful OCR is
  accepted with low confidence.
- Missing, failed, or malformed OCR is a systemic error and remains fatal; it
  is not converted into a relevance rejection.

An accepted or indeterminate result carries current persisted OCR fields so the
final main does not repeat analysis.

## Trace-Source Integration

The gate runs after story evidence exists and before any branch replaces the
main.

```text
input URL
    |
    v
caption + headline + scene + keywords + storyCtx
    |
    v
evaluateMainSuitability(input)
    |
    +-- accepted
    |      |
    |      +-- retain input
    |      +-- carry OCR metadata
    |      +-- skip replacement search
    |
    +-- indeterminate
    |      |
    |      +-- retain valid non-curator input
    |      +-- source_low_confidence=true
    |      +-- skip degraded replacement ranking
    |
    +-- rejected
           |
           +-- run replacement search
                  |
                  +-- evaluate every candidate through same evaluator
                  +-- compare accepted candidates
                  +-- select best accepted candidate
                  +-- none accepted --> main_candidate_not_found
```

### Accepted input

When the input is accepted:

- its public URL and existing editorial metadata stay unchanged;
- replacement/source-search branches are skipped;
- OCR fields from the evaluator are copied to `set.main`;
- final `attachVideoOcr` recognizes current metadata and performs no duplicate
  model calls; and
- ordinary profile enrichment may continue without changing the selected URL.

### Rejected input and replacement search

The original caption, headline, scene, title, description, and keywords remain
the story context. They are not replaced by a candidate's casual caption before
ranking completes.

Search candidates are:

1. enumerated using the existing creator/profile and story-search paths;
2. evaluated through `evaluateMainSuitability`;
3. stripped of rejected and unavailable entries; and
4. ranked among accepted results using the existing creator tier,
   non-aggregator preference, footage preference, and semantic score.

The search does not stop at the first semantically relevant URL.

### No acceptable main

If the input is rejected and no searched candidate is accepted, `trace_source`
throws a sanitized:

```text
main_candidate_not_found
```

It does not retain the rejected input, assign a clean default, or continue to
render unrelated media.

## Error and Decision Semantics

Candidate decisions are not equivalent to systemic failures.

| Outcome | Meaning | Pipeline behavior |
|---|---|---|
| `accepted` | Proven usable main | Retain/select |
| `indeterminate` | Valid explicit input, relevance service unavailable | Retain with low confidence |
| `not_video` | Candidate-local mismatch | Search/drop |
| `curated_aggregator` | Editorially forbidden main | Search/drop |
| `off_topic` | Below shared story floor | Search/drop |
| `commentary` | Not desired source footage | Search/drop |
| `subtitle_reaction` | Reaction/repost presentation | Search/drop |
| `media_unavailable` | Candidate media cannot be resolved | Search/drop |
| OCR/provider/config failure | Systemic inability to verify safety | Abort |
| No accepted replacement | No valid editorial main exists | Abort `main_candidate_not_found` |

The initial input is a candidate until the evaluator accepts it. The
final-main fatal stream policy begins only after selection is complete.

## Persistence and Diagnostics

No large evidence payload or embedding vector is added to the content set.

Existing persisted fields remain authoritative:

- selected public URL/platform/source URL;
- `source_low_confidence` for indeterminate or accepted-unknown cases; and
- current OCR schema/model/analyzer/directive fields.

A sanitized decision diagnostic contains:

- hashed candidate URL;
- normalized platform and safe handle;
- input-versus-search origin;
- status and reason;
- similarity when available;
- configured floor;
- visual kind;
- OCR outcome;
- whether replacement search started; and
- aggregate rejected-candidate counts by reason.

Example console lines:

```text
[main-gate] input accepted sim=0.672 kind=footage
[main-gate] input rejected reason=curated_aggregator
[main-gate] input indeterminate reason=similarity_unavailable low_confidence=true
[main-gate] replacement selected sim=0.611 kind=footage
[main-gate] no acceptable replacement
```

Signed media URLs, embeddings, cookies, authorization data, and raw model
responses are never logged.

## Testing Strategy

Implementation follows red-green-refactor with injected dependencies.

### Evaluator unit tests

- An on-topic, non-curator video with footage visuals and successful OCR is
  accepted.
- A similarity exactly equal to the configured floor is accepted.
- A similarity below the floor is rejected as `off_topic`.
- A photo-only input is rejected as `not_video`.
- A photo-first carousel with a later video is recognized as video.
- A curated input is rejected even with high similarity.
- A commentary candidate is rejected.
- OCR subtitle outcome is rejected as `subtitle_reaction`.
- A media-resolution miss is rejected as `media_unavailable`.
- OCR provider/configuration failures remain thrown systemic errors.
- Unknown visual kind with strong similarity is accepted low-confidence.
- Missing similarity retains an otherwise-valid explicit input as
  `indeterminate`.
- Missing similarity does not allow an indeterminate search result to replace
  the input.
- Input and search paths receive identical evidence and threshold values.

### Trace-source orchestration tests

- Accepted input skips replacement enumeration.
- Accepted input OCR metadata is reused by the final attachment.
- Rejected input starts search using the original story context.
- Search drops rejected/unavailable candidates and evaluates later candidates.
- Search selects the best accepted candidate, not the first result.
- Rejected input with no accepted replacement throws
  `main_candidate_not_found`.
- Curator enforcement is handled by the shared gate without a contradictory
  later decision.
- `source_low_confidence=true` is persisted for an indeterminate retained input.
- Caption/title/description grounding remains intact after replacement.

### Regression tests

- Existing source-credit/profile selection cases retain their creator tier.
- Existing carousel shape and cover-slide rules remain green.
- Existing OCR currentness and fail-closed tests remain green.
- Existing optional candidate media-isolation behavior remains green.
- No final selected video lacks analyzed OCR metadata.

### Required verification

- Focused main-candidate and trace-source tests.
- Existing verify, OCR-content, subtitle-vision, carousel, and source-resolution
  tests.
- Scout TypeScript typecheck.
- Biome checks for modified Scout files.
- Repository whitespace/diff validation.
- One final live smoke test after all offline checks pass.

## Live Acceptance

Run the pipeline with:

```text
https://www.instagram.com/p/DbQoG9IjzGX
```

Expected behavior:

1. The input is identified as a curator/discovery post and rejected with
   `curated_aggregator`.
2. The input caption, first-slide headline, scene, and keywords remain the
   ranking context.
3. Replacement search evaluates candidates through the same main gate.
4. Unavailable candidates are dropped without hiding their safe reason.
5. A relevant footage candidate is selected only after passing video,
   relevance, media, visual-kind, and OCR checks.
6. The final main carries complete current OCR metadata.
7. If no candidate qualifies, the run stops with
   `main_candidate_not_found`.

An additional offline fixture must prove the opposite path: a strongly on-topic,
non-curator input is retained and search functions are never invoked.

## Acceptance Criteria

- Every input post receives an explicit main-suitability decision.
- A strong accepted input is used directly without replacement search.
- Input and searched candidates use the same story floor, evidence builder,
  eligibility rules, and reason codes.
- Curator, off-topic, photo-only, commentary, subtitle-reaction, and unavailable
  inputs trigger replacement search.
- A degraded similarity service does not cause an otherwise-valid explicit
  input to be replaced by unrankable search results.
- An unsuitable input is never rendered when no acceptable replacement exists.
- Accepted/indeterminate input OCR metadata is not recomputed.
- The reported Instagram run either selects a verified replacement or fails
  explicitly; it never silently retains the rejected discovery post.
