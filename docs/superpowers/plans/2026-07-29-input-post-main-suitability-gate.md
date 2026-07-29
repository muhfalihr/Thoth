# Input-Post Main Suitability Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate the user-supplied post with the same video, relevance, curator, visual-kind, media, and OCR rules as searched main candidates, retaining it when suitable and failing safely when no replacement qualifies.

**Architecture:** Add a pure, dependency-injected `main_candidate` evaluator; a small runtime adapter for existing Scout probes, embeddings, resolver, and OCR; and a `main_gate` orchestrator for retain-versus-search decisions and accepted-candidate ranking. Refactor `trace_source` discovery functions to return candidate collections, then route both the input and every replacement candidate through the shared gate.

**Tech Stack:** Bun, TypeScript, Novita embeddings/vision, yt-dlp metadata, shared OCR media resolver, Node `assert`.

## Global Constraints

- This plan begins only after `2026-07-29-platform-page-ocr-stream-resolution.md` is implemented and green.
- `THOTH_SOURCE_STORY_MIN` remains the one relevance floor and defaults to `0.33`.
- A similarity exactly equal to the configured floor is accepted.
- Curated discovery accounts are never valid mains, regardless of similarity.
- Photo-only, off-topic, commentary, subtitle-reaction, and unavailable candidates are rejected.
- A photo-first carousel with an eligible later video counts as video.
- Representative video imagery, not the carousel cover headline alone, determines footage versus commentary.
- Missing similarity may retain an otherwise-valid explicit input as `indeterminate`.
- An indeterminate searched candidate cannot replace an input.
- A rejected input with no accepted replacement fails with `main_candidate_not_found`.
- Accepted and indeterminate candidates carry current OCR metadata into `set.main`.
- Candidate evidence, embeddings, signed URLs, cookies, tokens, and raw model responses are never persisted in the content set.
- No new runtime dependency is permitted.

---

### Task 1: Implement the Pure Main-Candidate Evaluator

**Files:**
- Create: `scout/lib/main_candidate.ts`
- Create: `scout/lib/main_candidate.test.ts`
- Read/Reuse: `scout/lib/ocr_contract.ts`
- Read/Reuse: `scout/lib/media_resolution.ts`

**Interfaces:**
- Consumes: `MediaResolutionResult` and `PersistedOcrFields`.
- Produces: `evaluateMainSuitability(candidate, story, origin, deps): Promise<MainSuitability>`.
- Produces: `MainCandidate`, `MainStoryEvidence`, `MainCandidateOrigin`, `MainSuitability`, `MainCandidateEvaluatorDeps`, and `CandidateProbe`.

- [ ] **Step 1: Write the shared fixtures and accepted-input test**

Create `scout/lib/main_candidate.test.ts`:

```ts
import assert from 'node:assert/strict';
import {
  evaluateMainSuitability,
  type MainCandidate,
  type MainCandidateEvaluatorDeps,
  type MainStoryEvidence,
} from './main_candidate.ts';
import type { PersistedOcrFields } from './ocr_contract.ts';

const candidate: MainCandidate = {
  url: 'https://www.instagram.com/creator/reel/GOOD/',
  platform: 'instagram',
  caption: 'Ijal berjualan gorengan saat latihan film',
  thumbnail: 'https://img.example.test/good.jpg',
  isVideo: true,
};

const story: MainStoryEvidence = {
  caption: 'Ijal tertangkap kamera berjualan gorengan',
  headline: 'Ijal Copet Sibuk Jualan Gorengan',
  scene: 'Aktor berjualan gorengan di lokasi latihan film',
  title: 'Momen latihan film',
  description: 'Iqbaal Ramadhan mendalami karakter Ijal',
  keywords: ['Iqbaal Ramadhan', 'Ijal', 'gorengan'],
  storyText:
    'Ijal Copet Sibuk Jualan Gorengan. Aktor berjualan gorengan di lokasi latihan film.',
};

const ocrFields: PersistedOcrFields = {
  ocr_schema_version: 1,
  ocr_status: 'analyzed',
  ocr_model: 'deepseek/deepseek-ocr',
  ocr_analyzer_version: 'deepseek-ocr-v2',
  ocr_analyzed_at: '2026-07-29T00:00:00.000Z',
  ocr_requested_frames: 12,
  ocr_valid_frames: 12,
  ocr_outcome: 'clean',
  trim_start: 0,
  mute_audio: false,
  subtitle_blur: [],
};

function evaluatorDeps(
  overrides: Partial<MainCandidateEvaluatorDeps> = {},
): MainCandidateEvaluatorDeps {
  return {
    storyFloor: 0.33,
    probeVideo: async (value) => ({
      isVideo: true,
      candidate: { ...value, isVideo: true },
    }),
    isCurated: () => false,
    describeEvidence: async () => 'rekaman aktor berjualan gorengan',
    scoreSimilarity: async () => 0.67,
    resolveMedia: async () => ({
      status: 'resolved',
      media: 'https://cdn.example.test/good.mp4',
      source: 'platform-resolver',
      attempts: 1,
      elapsed_ms: 2_000,
    }),
    classifyResolvedVisual: async () => 'footage',
    attachOcr: async (value) => ({ ...value, is_video: true, ...ocrFields }),
    ...overrides,
  };
}

const accepted = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps(),
);
assert.equal(accepted.status, 'accepted');
assert.equal(accepted.status === 'accepted' && accepted.similarity, 0.67);
assert.equal(accepted.status === 'accepted' && accepted.kind, 'footage');
assert.equal(
  accepted.status === 'accepted' && accepted.candidate.ocr_status,
  'analyzed',
);
```

- [ ] **Step 2: Add failing hard-rejection and short-circuit tests**

Append:

```ts
{
  let expensiveCalls = 0;
  const notVideo = await evaluateMainSuitability(
    candidate,
    story,
    'input',
    evaluatorDeps({
      probeVideo: async (value) => ({ isVideo: false, candidate: value }),
      describeEvidence: async () => {
        expensiveCalls++;
        return '';
      },
      resolveMedia: async () => {
        expensiveCalls++;
        throw new Error('must not run');
      },
    }),
  );
  assert.deepEqual(notVideo, { status: 'rejected', reason: 'not_video' });
  assert.equal(expensiveCalls, 0);
}

{
  let similarityCalls = 0;
  const curated = await evaluateMainSuitability(
    candidate,
    story,
    'input',
    evaluatorDeps({
      isCurated: () => true,
      scoreSimilarity: async () => {
        similarityCalls++;
        return 0.99;
      },
    }),
  );
  assert.deepEqual(curated, {
    status: 'rejected',
    reason: 'curated_aggregator',
  });
  assert.equal(similarityCalls, 0);
}

{
  let resolutionCalls = 0;
  const offTopic = await evaluateMainSuitability(
    candidate,
    story,
    'input',
    evaluatorDeps({
      scoreSimilarity: async () => 0.329,
      resolveMedia: async () => {
        resolutionCalls++;
        throw new Error('must not run');
      },
    }),
  );
  assert.deepEqual(offTopic, {
    status: 'rejected',
    reason: 'off_topic',
    similarity: 0.329,
  });
  assert.equal(resolutionCalls, 0);
}

const atFloor = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({ scoreSimilarity: async () => 0.33 }),
);
assert.equal(atFloor.status, 'accepted');
```

- [ ] **Step 3: Add failing visual, media, OCR, and indeterminate tests**

Append:

```ts
const commentary = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({
    classifyResolvedVisual: async () => 'commentary',
  }),
);
assert.deepEqual(commentary, { status: 'rejected', reason: 'commentary' });

const unavailable = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({
    resolveMedia: async () => ({
      status: 'unavailable',
      code: 'stream_resolution_failed',
      reason: 'timeout',
      attempts: 3,
      elapsed_ms: 30_000,
    }),
  }),
);
assert.deepEqual(unavailable, {
  status: 'rejected',
  reason: 'media_unavailable',
  similarity: 0.67,
});

const subtitle = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({
    attachOcr: async (value) => ({
      ...value,
      is_video: true,
      ...ocrFields,
      ocr_outcome: 'subtitle',
      mute_audio: true,
      subtitle_blur: [{ x: 0.1, y: 0.8, w: 0.8, h: 0.1 }],
    }),
  }),
);
assert.deepEqual(subtitle, {
  status: 'rejected',
  reason: 'subtitle_reaction',
  similarity: 0.67,
});

const indeterminate = await evaluateMainSuitability(
  candidate,
  story,
  'input',
  evaluatorDeps({ scoreSimilarity: async () => null }),
);
assert.equal(indeterminate.status, 'indeterminate');
assert.equal(
  indeterminate.status === 'indeterminate' && indeterminate.confidence,
  'low',
);
assert.equal(
  indeterminate.status === 'indeterminate' &&
    indeterminate.candidate.ocr_status,
  'analyzed',
);

await assert.rejects(
  () =>
    evaluateMainSuitability(
      candidate,
      story,
      'input',
      evaluatorDeps({
        attachOcr: async () => {
          throw new Error('systemic OCR failure');
        },
      }),
    ),
  /systemic OCR failure/,
);

console.log('ok main_candidate');
```

- [ ] **Step 4: Run the focused test and confirm RED**

Run:

```powershell
rtk proxy bun scout/lib/main_candidate.test.ts
```

Expected: FAIL because `scout/lib/main_candidate.ts` does not exist.

- [ ] **Step 5: Define the evaluator contract**

Create `scout/lib/main_candidate.ts`:

```ts
import type { MediaResolutionResult } from './media_resolution.ts';
import type { PersistedOcrFields } from './ocr_contract.ts';

export type MainCandidate = Record<string, unknown> & {
  url: string;
  platform: string;
  caption?: string;
  thumbnail?: string;
  videoSrc?: string;
  uploader?: string;
  pageUrl?: string;
  isVideo?: boolean;
  is_video?: boolean;
};

export type MainStoryEvidence = {
  caption: string;
  headline: string;
  scene: string;
  title: string;
  description: string;
  keywords: string[];
  storyText: string;
};

export type MainCandidateOrigin = 'input' | 'search';
export type MainVisualKind = 'footage' | 'commentary' | 'unknown';

export type CandidateProbe = {
  isVideo: boolean;
  candidate: MainCandidate;
};

export type MainRejectionReason =
  | 'not_video'
  | 'curated_aggregator'
  | 'off_topic'
  | 'commentary'
  | 'subtitle_reaction'
  | 'media_unavailable';

export type MainSuitability =
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
      kind: 'footage' | 'unknown';
      candidate: MainCandidate & PersistedOcrFields;
    };

export type MainCandidateEvaluatorDeps = {
  storyFloor: number;
  probeVideo: (candidate: MainCandidate) => Promise<CandidateProbe>;
  isCurated: (candidate: MainCandidate) => boolean;
  describeEvidence: (candidate: MainCandidate) => Promise<string>;
  scoreSimilarity: (
    storyText: string,
    candidateEvidence: string,
  ) => Promise<number | null>;
  resolveMedia: (
    candidate: MainCandidate,
  ) => Promise<MediaResolutionResult | null>;
  classifyResolvedVisual: (
    candidate: MainCandidate,
    resolvedMedia: string | null,
  ) => Promise<MainVisualKind>;
  attachOcr: (
    candidate: MainCandidate,
    resolvedMedia: string | null,
  ) => Promise<MainCandidate & PersistedOcrFields>;
};
```

- [ ] **Step 6: Implement the ordered evaluator**

Add:

```ts
function candidateEvidence(
  candidate: MainCandidate,
  visualDescription: string,
): string {
  return [visualDescription, candidate.caption]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('. ');
}

export async function evaluateMainSuitability(
  rawCandidate: MainCandidate,
  story: MainStoryEvidence,
  _origin: MainCandidateOrigin,
  deps: MainCandidateEvaluatorDeps,
): Promise<MainSuitability> {
  const probe = await deps.probeVideo(rawCandidate);
  if (!probe.isVideo) return { status: 'rejected', reason: 'not_video' };
  const candidate = { ...probe.candidate, isVideo: true, is_video: true };
  if (deps.isCurated(candidate)) {
    return { status: 'rejected', reason: 'curated_aggregator' };
  }

  const visualDescription = await deps.describeEvidence(candidate);

  const similarity = await deps.scoreSimilarity(
    story.storyText,
    candidateEvidence(candidate, visualDescription),
  );
  if (similarity !== null && similarity < deps.storyFloor) {
    return { status: 'rejected', reason: 'off_topic', similarity };
  }

  const resolution = await deps.resolveMedia(candidate);
  if (resolution?.status === 'unavailable') {
    return {
      status: 'rejected',
      reason: 'media_unavailable',
      ...(similarity !== null ? { similarity } : {}),
    };
  }

  const resolvedMedia = resolution?.status === 'resolved' ? resolution.media : null;
  const visualKind = await deps.classifyResolvedVisual(candidate, resolvedMedia);
  if (visualKind === 'commentary') {
    return {
      status: 'rejected',
      reason: 'commentary',
      ...(similarity !== null ? { similarity } : {}),
    };
  }

  const analyzed = await deps.attachOcr(candidate, resolvedMedia);
  if (analyzed.ocr_outcome === 'subtitle') {
    return {
      status: 'rejected',
      reason: 'subtitle_reaction',
      ...(similarity !== null ? { similarity } : {}),
    };
  }

  const kind = visualKind === 'footage' ? 'footage' : 'unknown';
  if (similarity === null) {
    return {
      status: 'indeterminate',
      reason: 'similarity_unavailable',
      confidence: 'low',
      kind,
      candidate: analyzed,
    };
  }
  return {
    status: 'accepted',
    similarity,
    kind,
    confidence: kind === 'footage' ? 'high' : 'low',
    candidate: analyzed,
  };
}
```

- [ ] **Step 7: Run focused tests and confirm GREEN**

Run:

```powershell
rtk proxy bun scout/lib/main_candidate.test.ts
```

Expected: prints `ok main_candidate` and exits zero.

- [ ] **Step 8: Run formatting and typecheck**

Run:

```powershell
rtk proxy bunx biome check scout/lib/main_candidate.ts scout/lib/main_candidate.test.ts
rtk proxy bun run typecheck
```

Run typecheck from `scout/`. Expected: exit zero.

- [ ] **Step 9: Commit the pure evaluator**

```powershell
rtk git add -- scout/lib/main_candidate.ts scout/lib/main_candidate.test.ts
rtk git commit -m "feat(scout): add shared main suitability evaluator"
```

---

### Task 2: Add Runtime Adapters for Video Probe, Similarity, Resolution, and OCR

**Files:**
- Create: `scout/lib/main_candidate_runtime.ts`
- Create: `scout/lib/main_candidate_runtime.test.ts`
- Modify: `scout/lib/verify.ts:250-277`
- Modify: `scout/lib/verify.test.ts:16-46`
- Modify: `scout/lib/subtitle_vision.ts:516-536`
- Read/Reuse: `scout/lib/embed.ts`
- Read/Reuse: `scout/lib/aggregators.ts`
- Read/Reuse: `scout/lib/ocr_content.ts`
- Read/Reuse: `scout/lib/media_resolution.ts`

**Interfaces:**
- Consumes: `postShape`, `probeVideo`, `rankBySimilarity`, `isCuratedAggregator`, `urlHandle`, `resolveOcrMedia`, and `attachVideoOcr`.
- Produces: `probeMainCandidateVideo`, `scoreMainCandidateSimilarity`, `resolveMainCandidateMedia`, `classifyMainCandidateVisual`, `attachMainCandidateOcr`, and `createMainCandidateRuntimeDeps`.
- Accepts: separate injected operations for story-evidence description and representative-frame visual classification.

- [ ] **Step 1: Write failing video-capability tests**

Create `scout/lib/main_candidate_runtime.test.ts`:

```ts
import assert from 'node:assert/strict';
import {
  probeMainCandidateVideo,
  scoreMainCandidateSimilarity,
} from './main_candidate_runtime.ts';

const photoFirstCarousel = await probeMainCandidateVideo(
  {
    url: 'https://www.instagram.com/p/PHOTO_FIRST/',
    platform: 'instagram',
  },
  {
    postShape: () => ({
      ok: true,
      shape: 'carousel',
      slides: [
        { index: 1, kind: 'photo', duration: 0 },
        { index: 2, kind: 'video', duration: 0 },
      ],
      caption: 'carousel caption',
      uploader: 'dagelan',
      webpageUrl: 'https://www.instagram.com/dagelan/p/PHOTO_FIRST/',
    }),
  },
);
assert.equal(photoFirstCarousel.isVideo, true);
assert.equal(photoFirstCarousel.candidate.caption, 'carousel caption');
assert.equal(photoFirstCarousel.candidate.uploader, 'dagelan');

const photoOnly = await probeMainCandidateVideo(
  {
    url: 'https://www.instagram.com/p/PHOTO_ONLY/',
    platform: 'instagram',
  },
  {
    postShape: () => ({
      ok: true,
      shape: 'photo',
      slides: [{ index: 1, kind: 'photo', duration: 0 }],
      caption: 'photo',
      uploader: 'creator',
      webpageUrl: 'https://www.instagram.com/creator/p/PHOTO_ONLY/',
    }),
  },
);
assert.equal(photoOnly.isVideo, false);

const threads = await probeMainCandidateVideo(
  {
    url: 'https://www.threads.net/@creator/post/ABC',
    platform: 'threads',
    videoSrc: 'https://cdn.example.test/threads.mp4',
  },
  {
    postShape: () => {
      throw new Error('must not run');
    },
  },
);
assert.equal(threads.isVideo, true);
```

- [ ] **Step 2: Add failing similarity-unavailable coverage**

Append:

```ts
const score = await scoreMainCandidateSimilarity(
  'actor selling food',
  'actor selling fried snacks',
  async () => [{ sim: 0.61 }],
);
assert.equal(score, 0.61);

const unavailableScore = await scoreMainCandidateSimilarity(
  'actor selling food',
  'actor selling fried snacks',
  async () => [{ sim: 0 }],
);
assert.equal(unavailableScore, null);

let extractedAt = -1;
const representativeKind = await classifyMainCandidateVisual(
  {
    url: 'https://www.instagram.com/p/CAROUSEL/',
    platform: 'instagram',
    thumbnail: 'data:image/png;base64,COVER',
  },
  'https://cdn.example.test/later-slide.mp4',
  {
    extractFrame: (_media, t) => {
      extractedAt = t;
      return 'data:image/jpeg;base64,VIDEO_FRAME';
    },
    classifyImage: async (image) => {
      assert.match(image, /VIDEO_FRAME/);
      return 'footage';
    },
  },
);
assert.equal(representativeKind, 'footage');
assert.equal(extractedAt, 0.5);

console.log('ok main_candidate_runtime');
```

- [ ] **Step 3: Run the focused test and confirm RED**

Run:

```powershell
rtk proxy bun scout/lib/main_candidate_runtime.test.ts
```

Expected: FAIL because `main_candidate_runtime.ts` does not exist.

- [ ] **Step 4: Implement platform-aware video probing**

Create `scout/lib/main_candidate_runtime.ts`:

```ts
import { isCuratedAggregator, urlHandle } from './aggregators.ts';
import { rankBySimilarity } from './embed.ts';
import type {
  CandidateProbe,
  MainCandidate,
  MainCandidateEvaluatorDeps,
  MainVisualKind,
} from './main_candidate.ts';
import { resolveOcrMedia } from './media_resolution.ts';
import { attachVideoOcr } from './ocr_content.ts';
import { extractFrameDataUrl } from './subtitle_vision.ts';
import { postShape, probeVideo } from './verify.ts';

type ProbeRuntimeDeps = {
  postShape?: (url: string) => {
    ok: boolean;
    shape: string;
    slides: Array<{ index: number; kind: string; duration: number }>;
    caption?: string;
    uploader?: string;
    webpageUrl?: string;
  };
  probeVideo?: (url: string) => {
    isVideo: boolean;
    caption: string;
    thumbnail: string;
    uploader: string;
    webpageUrl: string;
  };
};

export async function probeMainCandidateVideo(
  candidate: MainCandidate,
  deps: ProbeRuntimeDeps = {},
): Promise<CandidateProbe> {
  if (candidate.platform === 'threads') {
    return { isVideo: Boolean(candidate.videoSrc), candidate };
  }
  if (candidate.platform === 'tiktok' || candidate.platform === 'youtube') {
    return { isVideo: candidate.isVideo !== false, candidate };
  }
  if (
    candidate.platform === 'instagram' ||
    candidate.platform === 'facebook'
  ) {
    const shape = (deps.postShape ?? postShape)(candidate.url);
    const isVideo = Boolean(
      shape.ok && shape.slides.some((slide) => slide.kind === 'video'),
    );
    return {
      isVideo,
      candidate: {
        ...candidate,
        caption: candidate.caption || shape.caption || '',
        uploader: candidate.uploader || shape.uploader || '',
        pageUrl: candidate.pageUrl || shape.webpageUrl || candidate.url,
      },
    };
  }
  const probed = (deps.probeVideo ?? probeVideo)(candidate.url);
  return {
    isVideo: probed.isVideo,
    candidate: {
      ...candidate,
      caption: candidate.caption || probed.caption || '',
      thumbnail: candidate.thumbnail || probed.thumbnail || '',
      uploader: candidate.uploader || probed.uploader || '',
      pageUrl: candidate.pageUrl || probed.webpageUrl || '',
    },
  };
}
```

- [ ] **Step 5: Implement similarity and OCR adapters**

Add:

```ts
type Ranker = (
  query: string,
  items: Array<{ text: string }>,
  getText: (item: { text: string }) => string,
) => Promise<Array<{ text: string; sim: number }>>;

export async function scoreMainCandidateSimilarity(
  storyText: string,
  evidence: string,
  ranker: Ranker = rankBySimilarity,
): Promise<number | null> {
  const ranked = await ranker(
    storyText,
    [{ text: evidence }],
    (item) => item.text,
  );
  const score = ranked[0]?.sim || 0;
  return score > 0 ? score : null;
}

export async function resolveMainCandidateMedia(
  candidate: MainCandidate,
  env: Record<string, string | undefined> = process.env,
) {
  if (candidate.platform === 'tiktok') return null;
  return resolveOcrMedia(
    String(candidate.videoSrc || candidate.url),
    { env },
  );
}

type MainVisualRuntimeDeps = {
  extractFrame?: (
    media: string,
    t: number,
    env: Record<string, string | undefined>,
  ) => string | null;
  classifyImage: (image: string) => Promise<MainVisualKind>;
  env?: Record<string, string | undefined>;
};

export async function classifyMainCandidateVisual(
  candidate: MainCandidate,
  resolvedMedia: string | null,
  deps: MainVisualRuntimeDeps,
): Promise<MainVisualKind> {
  const env = deps.env ?? process.env;
  const image = resolvedMedia
    ? (deps.extractFrame ?? extractFrameDataUrl)(resolvedMedia, 0.5, env)
    : String(candidate.thumbnail || '');
  return image ? deps.classifyImage(image) : 'unknown';
}

export async function attachMainCandidateOcr(
  candidate: MainCandidate,
  resolvedMedia: string | null,
): Promise<MainCandidate & import('./ocr_contract.ts').PersistedOcrFields> {
  const record = { ...candidate, is_video: true as const };
  if (resolvedMedia === null) {
    return attachVideoOcr(record) as Promise<
      MainCandidate & import('./ocr_contract.ts').PersistedOcrFields
    >;
  }
  return attachVideoOcr(record, {
    resolve: async () => ({
      status: 'resolved',
      media: resolvedMedia,
      source: 'direct',
      attempts: 0,
      elapsed_ms: 0,
    }),
  }) as Promise<
    MainCandidate & import('./ocr_contract.ts').PersistedOcrFields
  >;
}

export function createMainCandidateRuntimeDeps(
  visual: {
    describeEvidence: (candidate: MainCandidate) => Promise<string>;
    classifyImage: (image: string) => Promise<MainVisualKind>;
  },
  env: Record<string, string | undefined> = process.env,
): MainCandidateEvaluatorDeps {
  const configuredFloor = Number.parseFloat(
    env.THOTH_SOURCE_STORY_MIN || '0.33',
  );
  return {
    storyFloor: Number.isFinite(configuredFloor) ? configuredFloor : 0.33,
    probeVideo: (candidate) => probeMainCandidateVideo(candidate),
    isCurated: (candidate) =>
      isCuratedAggregator(
        String(candidate.uploader || urlHandle(candidate.pageUrl || candidate.url)),
      ),
    describeEvidence: visual.describeEvidence,
    scoreSimilarity: scoreMainCandidateSimilarity,
    resolveMedia: (candidate) => resolveMainCandidateMedia(candidate, env),
    classifyResolvedVisual: (candidate, media) =>
      classifyMainCandidateVisual(candidate, media, {
        classifyImage: visual.classifyImage,
        env,
      }),
    attachOcr: attachMainCandidateOcr,
  };
}
```

- [ ] **Step 6: Export frame extraction and preserve shape ownership metadata**

Rename and export the existing frame helper in `subtitle_vision.ts`:

```ts
export function extractFrameDataUrl(
  videoUrl: string,
  t: number,
  env: Record<string, string | undefined>,
): string | null {
```

Update its internal call site in `analyzeSubtitlesDetailed` to use
`extractFrameDataUrl`.

Extend every successful `parseShape` return in `verify.ts` with:

```ts
uploader: String(
  d.uploader ||
    d.channel ||
    (Array.isArray(d.entries) && d.entries[0]?.uploader) ||
    '',
),
webpageUrl: String(
  d.webpage_url ||
    d.original_url ||
    (Array.isArray(d.entries) && d.entries[0]?.webpage_url) ||
    '',
),
```

Extend the reported carousel fixture in `verify.test.ts`:

```ts
const fixture = JSON.stringify({
  title: 'Post by dagelan',
  uploader: 'dagelan',
  webpage_url: 'https://www.instagram.com/dagelan/p/DbQoG9IjzGX/',
  entries: [
    { duration: null },
    { ext: 'mp4', duration: null },
    { ext: 'mp4', duration: null },
    { ext: 'mp4', duration: null },
    { ext: 'mp4', duration: null },
  ],
});
const shape = parseShape(fixture);
assert.equal(shape.uploader, 'dagelan');
assert.match(shape.webpageUrl, /dagelan/);
```

- [ ] **Step 7: Run runtime and evaluator tests**

Run:

```powershell
rtk proxy bun scout/lib/main_candidate_runtime.test.ts
rtk proxy bun scout/lib/main_candidate.test.ts
rtk proxy bun scout/lib/verify.test.ts
rtk proxy bun scout/lib/ocr_content.test.ts
```

Expected: every script exits zero.

- [ ] **Step 8: Run typecheck and formatting**

Run:

```powershell
rtk proxy bun run typecheck
rtk proxy bunx biome check lib/main_candidate_runtime.ts lib/main_candidate_runtime.test.ts lib/subtitle_vision.ts lib/verify.ts lib/verify.test.ts
```

Run from `scout/`. Expected: exit zero.

- [ ] **Step 9: Commit runtime adapters**

```powershell
rtk git add -- scout/lib/main_candidate_runtime.ts scout/lib/main_candidate_runtime.test.ts scout/lib/subtitle_vision.ts scout/lib/verify.ts scout/lib/verify.test.ts
rtk git commit -m "feat(scout): adapt main suitability to Scout runtime"
```

---

### Task 3: Implement Retain-or-Replace Orchestration and Ranking

**Files:**
- Create: `scout/lib/main_gate.ts`
- Create: `scout/lib/main_gate.test.ts`
- Read/Reuse: `scout/lib/aggregators.ts`
- Read/Reuse: `scout/lib/main_candidate.ts`

**Interfaces:**
- Consumes: `evaluateMainSuitability`.
- Produces: `chooseInputOrReplacement(input, story, deps): Promise<MainGateDecision>`.
- Produces: `rankAcceptedMainCandidates`, `MainCandidateNotFoundError`, `MainGateDecision`, and `MainGateDeps`.

- [ ] **Step 1: Write failing retain, indeterminate, and search tests**

Create `scout/lib/main_gate.test.ts`:

```ts
import assert from 'node:assert/strict';
import {
  chooseInputOrReplacement,
  MainCandidateNotFoundError,
  rankAcceptedMainCandidates,
} from './main_gate.ts';
import type {
  MainCandidate,
  MainStoryEvidence,
  MainSuitability,
} from './main_candidate.ts';

const input: MainCandidate = {
  url: 'https://www.instagram.com/p/INPUT/',
  platform: 'instagram',
};
const story = {
  caption: 'story',
  headline: 'headline',
  scene: 'scene',
  title: 'title',
  description: 'description',
  keywords: ['keyword'],
  storyText: 'headline scene description',
} satisfies MainStoryEvidence;

const accepted = (
  value: MainCandidate,
  similarity: number,
): Extract<MainSuitability, { status: 'accepted' }> => ({
  status: 'accepted',
  similarity,
  kind: 'footage',
  confidence: 'high',
  candidate: {
    ...value,
    ocr_schema_version: 1,
    ocr_status: 'analyzed',
    ocr_model: 'deepseek/deepseek-ocr',
    ocr_analyzer_version: 'deepseek-ocr-v2',
    ocr_analyzed_at: '2026-07-29T00:00:00.000Z',
    ocr_requested_frames: 1,
    ocr_valid_frames: 1,
    ocr_outcome: 'clean',
    trim_start: 0,
    mute_audio: false,
    subtitle_blur: [],
  },
});

{
  let searches = 0;
  const decision = await chooseInputOrReplacement(input, story, {
    evaluate: async (candidate, _story, origin) => {
      assert.equal(origin, 'input');
      return accepted(candidate, 0.7);
    },
    search: async () => {
      searches++;
      return [];
    },
  });
  assert.equal(decision.status, 'retain');
  assert.equal(decision.confidence, 'high');
  assert.equal(searches, 0);
}

{
  let searches = 0;
  const decision = await chooseInputOrReplacement(input, story, {
    evaluate: async (candidate) => ({
      status: 'indeterminate',
      reason: 'similarity_unavailable',
      confidence: 'low',
      kind: 'footage',
      candidate: accepted(candidate, 0.5).candidate,
    }),
    search: async () => {
      searches++;
      return [];
    },
  });
  assert.equal(decision.status, 'retain');
  assert.equal(decision.confidence, 'low');
  assert.equal(searches, 0);
}
```

- [ ] **Step 2: Add failing replacement and fail-closed tests**

Append:

```ts
{
  const first = {
    url: 'https://x.com/news/status/1',
    platform: 'twitter',
    uploader: 'news',
  };
  const second = {
    url: 'https://www.instagram.com/creator/reel/2/',
    platform: 'instagram',
    uploader: 'creator',
  };
  const decision = await chooseInputOrReplacement(input, story, {
    evaluate: async (candidate, _story, origin) => {
      if (origin === 'input') {
        return { status: 'rejected', reason: 'off_topic', similarity: 0.1 };
      }
      return accepted(candidate, candidate.url === second.url ? 0.63 : 0.8);
    },
    search: async () => [first, second],
    rankAccepted: (results) =>
      rankAcceptedMainCandidates(results, {
        credited: 'creator',
        repostHandle: 'news',
        preferFootage: true,
      }),
  });
  assert.equal(decision.status, 'replace');
  assert.equal(decision.status === 'replace' && decision.candidate.url, second.url);
}

await assert.rejects(
  () =>
    chooseInputOrReplacement(input, story, {
      evaluate: async (_candidate, _story, origin) =>
        origin === 'input'
          ? { status: 'rejected', reason: 'curated_aggregator' }
          : {
              status: 'indeterminate',
              reason: 'similarity_unavailable',
              confidence: 'low',
              kind: 'footage',
              candidate: accepted(input, 0.5).candidate,
            },
      search: async () => [
        { url: 'https://example.test/unranked', platform: 'youtube' },
      ],
    }),
  (error: unknown) =>
    error instanceof MainCandidateNotFoundError &&
    error.code === 'main_candidate_not_found' &&
    !error.message.includes('example.test'),
);

console.log('ok main_gate');
```

- [ ] **Step 3: Run the focused test and confirm RED**

Run:

```powershell
rtk proxy bun scout/lib/main_gate.test.ts
```

Expected: FAIL because `main_gate.ts` does not exist.

- [ ] **Step 4: Define the gate contract and safe error**

Create `scout/lib/main_gate.ts`:

```ts
import { normHandle, urlHandle } from './aggregators.ts';
import type {
  MainCandidate,
  MainCandidateOrigin,
  MainStoryEvidence,
  MainSuitability,
} from './main_candidate.ts';
import type { PersistedOcrFields } from './ocr_contract.ts';

type AcceptedSuitability = Extract<MainSuitability, { status: 'accepted' }>;

export type MainGateDecision =
  | {
      status: 'retain';
      candidate: MainCandidate & PersistedOcrFields;
      confidence: 'high' | 'low';
      suitability: 'accepted' | 'indeterminate';
    }
  | {
      status: 'replace';
      candidate: MainCandidate & PersistedOcrFields;
      confidence: 'high' | 'low';
      suitability: 'accepted';
    };

export class MainCandidateNotFoundError extends Error {
  readonly code = 'main_candidate_not_found';

  constructor() {
    super('No acceptable main video candidate was found');
    this.name = 'MainCandidateNotFoundError';
  }
}

export type MainGateDeps = {
  evaluate: (
    candidate: MainCandidate,
    story: MainStoryEvidence,
    origin: MainCandidateOrigin,
  ) => Promise<MainSuitability>;
  search: () => Promise<MainCandidate[]>;
  rankAccepted?: (
    candidates: AcceptedSuitability[],
  ) => AcceptedSuitability | null;
};
```

- [ ] **Step 5: Implement accepted-candidate tier ranking**

Add:

```ts
const AGGREGATOR_MARKERS =
  /(news|berita|media|infotainment|seleb|gosip|viral|update|terkini|trending|repost|kabar|warta|portal|redaksi|jurnal|koran|radar|grid|tempo|detik|kompas|tribun|cnnindo|cnbc|official)$/i;

export function rankAcceptedMainCandidates(
  candidates: AcceptedSuitability[],
  options: {
    credited: string;
    repostHandle: string;
    preferFootage: boolean;
  },
): AcceptedSuitability | null {
  const credited = normHandle(options.credited);
  const repost = normHandle(options.repostHandle);
  const tier = (result: AcceptedSuitability): number => {
    const handle = normHandle(
      String(
        result.candidate.uploader ||
          urlHandle(result.candidate.pageUrl || result.candidate.url),
      ),
    );
    if (credited && handle === credited) return 0;
    if (!handle) return 1;
    if (handle === repost || AGGREGATOR_MARKERS.test(handle)) return 2;
    return 1;
  };
  const score = (result: AcceptedSuitability): number =>
    result.similarity +
    (options.preferFootage && result.kind === 'footage' ? 1 : 0);

  for (const currentTier of [0, 1, 2]) {
    const pool = candidates
      .filter((result) => tier(result) === currentTier)
      .sort((a, b) => score(b) - score(a));
    if (pool[0]) return pool[0];
  }
  return null;
}
```

- [ ] **Step 6: Implement retain-or-search orchestration**

Add:

```ts
export async function chooseInputOrReplacement(
  input: MainCandidate,
  story: MainStoryEvidence,
  deps: MainGateDeps,
): Promise<MainGateDecision> {
  const inputResult = await deps.evaluate(input, story, 'input');
  if (inputResult.status === 'accepted') {
    return {
      status: 'retain',
      candidate: inputResult.candidate,
      confidence: inputResult.confidence,
      suitability: 'accepted',
    };
  }
  if (inputResult.status === 'indeterminate') {
    return {
      status: 'retain',
      candidate: inputResult.candidate,
      confidence: 'low',
      suitability: 'indeterminate',
    };
  }

  const discovered = await deps.search();
  const acceptedResults: AcceptedSuitability[] = [];
  for (const candidate of discovered) {
    const result = await deps.evaluate(candidate, story, 'search');
    if (result.status === 'accepted') acceptedResults.push(result);
  }
  const selected = (deps.rankAccepted ?? ((results) => results[0] || null))(
    acceptedResults,
  );
  if (!selected) throw new MainCandidateNotFoundError();
  return {
    status: 'replace',
    candidate: selected.candidate,
    confidence: selected.confidence,
    suitability: 'accepted',
  };
}
```

- [ ] **Step 7: Run focused tests and confirm GREEN**

Run:

```powershell
rtk proxy bun scout/lib/main_gate.test.ts
```

Expected: prints `ok main_gate` and exits zero.

- [ ] **Step 8: Run evaluator regressions and typecheck**

Run:

```powershell
rtk proxy bun scout/lib/main_candidate.test.ts
rtk proxy bun scout/lib/main_candidate_runtime.test.ts
rtk proxy bun run typecheck
```

Run typecheck from `scout/`. Expected: exit zero.

- [ ] **Step 9: Commit the gate**

```powershell
rtk git add -- scout/lib/main_gate.ts scout/lib/main_gate.test.ts
rtk git commit -m "feat(scout): choose input or replacement main"
```

---

### Task 4: Refactor Story Search to Return Raw Candidate Collections

**Files:**
- Modify: `scout/pipeline/trace_source.ts:605-862`
- Create: `scout/lib/main_search_candidates.ts`
- Create: `scout/lib/main_search_candidates.test.ts`
- Read/Reuse: `scout/lib/verify.ts`

**Interfaces:**
- Produces: `admitSearchCandidates(entries, deps): Promise<MainCandidate[]>`.
- Changes: `findStoryVideo` becomes `findStoryCandidates` and returns raw candidates before semantic, visual-kind, resolution, or OCR decisions.
- Preserves: query composition, search platform coverage, candidate limit of 10, and safe public candidate metadata.

- [ ] **Step 1: Write failing candidate-admission tests**

Create `scout/lib/main_search_candidates.test.ts`:

```ts
import assert from 'node:assert/strict';
import { admitSearchCandidates } from './main_search_candidates.ts';

const entries = [
  { url: 'https://x.com/user/status/1', platform: 'twitter' },
  { url: 'https://x.com/user/status/2', platform: 'twitter' },
  { url: 'https://www.youtube.com/watch?v=3', platform: 'youtube' },
  { url: 'https://example.test/page', platform: 'web' },
];
const candidates = await admitSearchCandidates(entries, {
  downloadablePlatforms: new Set(['twitter', 'youtube']),
  probeGeneric: async (entry) => ({
    isVideo: !entry.url.endsWith('/2'),
    caption: entry.url.endsWith('/1') ? 'incident caption' : '',
    thumbnail: 'https://img.example.test/cover.jpg',
    uploader: 'user',
    webpageUrl: entry.url,
  }),
  youtubeMeta: async () => ({
    title: 'youtube incident',
    thumbnail: 'https://img.example.test/youtube.jpg',
  }),
  tiktokMeta: async () => null,
  threadsVideoSrc: async () => '',
});
assert.deepEqual(
  candidates.map((candidate) => candidate.url),
  ['https://x.com/user/status/1', 'https://www.youtube.com/watch?v=3'],
);
assert.equal(candidates[0].caption, 'incident caption');
assert.equal(candidates[1].caption, 'youtube incident');
```

Add carousel admission:

```ts
const carousel = await admitSearchCandidates(
  [{ url: 'https://www.instagram.com/p/CAROUSEL/', platform: 'instagram' }],
  {
    downloadablePlatforms: new Set(['instagram']),
    probeGeneric: async () => ({
      isVideo: false,
      caption: 'carousel incident',
      thumbnail: 'https://img.example.test/carousel.jpg',
      uploader: 'creator',
      webpageUrl: 'https://www.instagram.com/creator/p/CAROUSEL/',
    }),
    youtubeMeta: async () => null,
    tiktokMeta: async () => null,
    threadsVideoSrc: async () => '',
  },
);
assert.equal(carousel.length, 1);
assert.equal(carousel[0].isVideo, true);

console.log('ok main_search_candidates');
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
rtk proxy bun scout/lib/main_search_candidates.test.ts
```

Expected: FAIL because `main_search_candidates.ts` does not exist.

- [ ] **Step 3: Implement candidate admission without ranking**

Create `scout/lib/main_search_candidates.ts`:

```ts
import type { MainCandidate } from './main_candidate.ts';

export type SearchEntry = { url: string; platform: string };

type SearchCandidateDeps = {
  downloadablePlatforms: Set<string>;
  probeGeneric: (entry: SearchEntry) => Promise<{
    isVideo: boolean;
    caption: string;
    thumbnail: string;
    uploader: string;
    webpageUrl: string;
  }>;
  youtubeMeta: (url: string) => Promise<{
    title: string;
    thumbnail: string;
  } | null>;
  tiktokMeta: (url: string) => Promise<{
    title: string;
    thumbnail: string;
  } | null>;
  threadsVideoSrc: (url: string) => Promise<string>;
};

export async function admitSearchCandidates(
  entries: SearchEntry[],
  deps: SearchCandidateDeps,
): Promise<MainCandidate[]> {
  const seen = new Set<string>();
  const admitted: MainCandidate[] = [];
  for (const entry of entries) {
    if (
      admitted.length >= 10 ||
      !deps.downloadablePlatforms.has(entry.platform) ||
      seen.has(entry.url)
    ) {
      continue;
    }
    seen.add(entry.url);
    if (entry.platform === 'tiktok') {
      const meta = await deps.tiktokMeta(entry.url);
      admitted.push({
        ...entry,
        caption: meta?.title || '',
        thumbnail: meta?.thumbnail || '',
        isVideo: true,
      });
      continue;
    }
    if (entry.platform === 'youtube') {
      const meta = await deps.youtubeMeta(entry.url);
      admitted.push({
        ...entry,
        caption: meta?.title || '',
        thumbnail: meta?.thumbnail || '',
        isVideo: true,
      });
      continue;
    }
    if (entry.platform === 'threads') {
      const videoSrc = await deps.threadsVideoSrc(entry.url);
      if (videoSrc) admitted.push({ ...entry, videoSrc, isVideo: true });
      continue;
    }
    const probed = await deps.probeGeneric(entry);
    const shapeCheckedLater =
      entry.platform === 'instagram' || entry.platform === 'facebook';
    if (!probed.isVideo && !shapeCheckedLater) continue;
    admitted.push({
      ...entry,
      caption: probed.caption,
      thumbnail: probed.thumbnail,
      uploader: probed.uploader,
      pageUrl: probed.webpageUrl,
      ...(probed.isVideo ? { isVideo: true } : {}),
    });
  }
  return admitted;
}
```

- [ ] **Step 4: Replace `findStoryVideo` with raw discovery**

In `trace_source.ts`, retain query composition and `searchAll`, then use:

```ts
async function findStoryCandidates(
  keywords,
  storyText,
  opts: any = {},
): Promise<MainCandidate[]> {
  const kws = (keywords || []).map((value) => String(value).trim()).filter(Boolean);
  const query = tightenQuery(
    (opts.query || '').trim() ||
      kws.slice(0, 3).join(' ') ||
      String(storyText || '').split(/\s+/).slice(0, 6).join(' '),
  );
  if (!query) return [];
  const entries = searchAll(query, kws[0] || query.split(/\s+/)[0]);
  return admitSearchCandidates(entries, {
    downloadablePlatforms: DLABLE,
    probeGeneric: async (entry) => probeVideo(entry.url),
    youtubeMeta: async (url) => {
      const meta = await youtubeOembed(url);
      return meta
        ? { title: meta.title || '', thumbnail: meta.thumbnail || '' }
        : null;
    },
    tiktokMeta: async (url) => {
      const meta = await tiktokOembed(url);
      return meta
        ? { title: meta.title || '', thumbnail: meta.thumbnail || '' }
        : null;
    },
    threadsVideoSrc: (url) => threadsVideoSrc(url),
  });
}
```

Delete semantic filtering, curator filtering, direct-stream fallback, OCR loop,
subtitle penalty, and final pick from the old `findStoryVideo`; those decisions
now belong to `evaluateMainSuitability` and `main_gate`.

- [ ] **Step 5: Run admission and existing search dependencies**

Run:

```powershell
rtk proxy bun scout/lib/main_search_candidates.test.ts
rtk proxy bun scout/lib/verify.test.ts
rtk proxy bun scout/lib/main_candidate.test.ts
rtk proxy bun scout/lib/main_gate.test.ts
```

Expected: every script exits zero.

- [ ] **Step 6: Run typecheck and formatting**

Run:

```powershell
rtk proxy bun run typecheck
rtk proxy bunx biome check lib/main_search_candidates.ts lib/main_search_candidates.test.ts pipeline/trace_source.ts
```

Run from `scout/`. Expected: exit zero.

- [ ] **Step 7: Commit raw candidate discovery**

```powershell
rtk git add -- scout/lib/main_search_candidates.ts scout/lib/main_search_candidates.test.ts scout/pipeline/trace_source.ts
rtk git commit -m "refactor(scout): separate main discovery from evaluation"
```

---

### Task 5: Route Input and Credited/Profile Candidates Through the Shared Gate

**Files:**
- Modify: `scout/pipeline/trace_source.ts:430-550`
- Modify: `scout/pipeline/trace_source.ts:605-670`
- Modify: `scout/pipeline/trace_source.ts:974-1270`
- Modify: `scout/pipeline/trace_source.ts:1411-1417`
- Modify: `scout/lib/main_gate.test.ts`

**Interfaces:**
- Consumes: `chooseInputOrReplacement`, `createMainCandidateRuntimeDeps`, `findStoryCandidates`, and `setMainTo`.
- Changes: creator/profile finders return candidate arrays rather than a preselected URL.
- Produces: one `MainGateDecision` before final-main OCR enforcement.

- [ ] **Step 1: Add gate coverage for multiple credited and generic candidates**

Append to `scout/lib/main_gate.test.ts`:

```ts
{
  const evaluated: string[] = [];
  const candidates = [
    {
      url: 'https://www.instagram.com/creator/reel/OFF/',
      platform: 'instagram',
      uploader: 'creator',
    },
    {
      url: 'https://www.instagram.com/creator/reel/GOOD/',
      platform: 'instagram',
      uploader: 'creator',
    },
    {
      url: 'https://www.youtube.com/watch?v=GENERIC',
      platform: 'youtube',
    },
  ];
  const decision = await chooseInputOrReplacement(input, story, {
    evaluate: async (value, _story, origin) => {
      evaluated.push(`${origin}:${value.url}`);
      if (origin === 'input') {
        return { status: 'rejected', reason: 'curated_aggregator' };
      }
      if (value.url.endsWith('/OFF/')) {
        return { status: 'rejected', reason: 'off_topic', similarity: 0.2 };
      }
      return accepted(value, value.url.endsWith('/GOOD/') ? 0.68 : 0.6);
    },
    search: async () => candidates,
    rankAccepted: (results) =>
      rankAcceptedMainCandidates(results, {
        credited: 'creator',
        repostHandle: 'curator',
        preferFootage: true,
      }),
  });
  assert.equal(decision.status, 'replace');
  assert.equal(
    decision.status === 'replace' && decision.candidate.url,
    'https://www.instagram.com/creator/reel/GOOD/',
  );
  assert.equal(evaluated.length, 4);
}
```

- [ ] **Step 2: Change creator finders to return candidate arrays**

Change Instagram discovery:

```ts
async function findOriginalInstagramCandidates(
  username,
): Promise<MainCandidate[]> {
  const all = await igProfileReels(username, {
    max: 10,
    captions: true,
    includePosts: true,
  });
  return all
    .filter((item) => item.isVideo !== false)
    .map((item) => ({
      url: item.url,
      platform: 'instagram',
      caption: item.caption || '',
      thumbnail: item.thumbnail || '',
      uploader: username,
      isVideo: true,
    }));
}
```

Change TikTok discovery:

```ts
async function findOriginalTiktokCandidates(
  username,
): Promise<MainCandidate[]> {
  const videos = await tiktokProfileVideos(username, {
    max: 30,
    captions: true,
  });
  return videos.map((video) => ({
    url: video.url,
    platform: 'tiktok',
    caption: video.caption || '',
    thumbnail: video.thumbnail || '',
    uploader: username,
    isVideo: true,
  }));
}
```

Change handle search to preserve every matching candidate:

```ts
function findOriginalHandleCandidates(username, topic): MainCandidate[] {
  const queryUser = username.replace(/[._]+/g, ' ').trim();
  const all = searchAll(
    (topic ? `${queryUser} ${topic}` : queryUser).trim(),
  );
  const normalized = cleanUser(username);
  return all
    .filter((entry) => handleMatch(entry.url, normalized))
    .map((entry) => ({
      url: entry.url,
      platform: entry.platform,
      uploader: username,
    }));
}
```

Replace the single-result YouTube finder with a collection-returning version:

```ts
async function findOriginalYouTubeCandidates(
  username,
  topic,
): Promise<MainCandidate[]> {
  const query = (
    `${username.replace(/[._]+/g, ' ')} ${topic || ''}`
  ).trim();
  let connection;
  try {
    connection = await connect({
      match: 'youtube.com',
      requireMatch: true,
    });
  } catch {
    return [];
  }
  try {
    try {
      await connection.cmd('Page.bringToFront');
    } catch {}
    await connection.navigate(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      6_000,
    );
    await sleep(2_000);
    const raw = await connection.evaluate(
      `(() => {
        const out = [];
        document.querySelectorAll('ytd-video-renderer').forEach((video) => {
          const anchor = video.querySelector('a#video-title');
          const channel = video.querySelector(
            'ytd-channel-name #text, .ytd-channel-name',
          );
          const channelName = (
            (channel && channel.innerText) || ''
          ).split('\\n').map((value) => value.trim()).filter(Boolean)[0] || '';
          if (anchor && anchor.href.includes('watch')) {
            out.push({
              u: anchor.href.split('&')[0],
              ch: channelName,
            });
          }
        });
        return JSON.stringify(out.slice(0, 12));
      })()`,
    );
    let items: Array<{ u: string; ch: string }> = [];
    try {
      items = JSON.parse(raw || '[]');
    } catch {}
    const wanted = normHandle(username);
    return items
      .filter((item) => normHandle(item.ch) === wanted)
      .map((item) => ({
        url: item.u,
        platform: 'youtube',
        uploader: username,
        isVideo: true,
      }));
  } finally {
    connection.close();
  }
}
```

- [ ] **Step 3: Build one replacement-candidate collection**

Add inside `trace_source.ts`:

```ts
async function discoverReplacementCandidates({
  username,
  platHint,
  searchTopic,
  keywords,
  storyText,
  query,
}) {
  const credited: MainCandidate[] = [];
  if (username && platHint === 'instagram') {
    credited.push(...(await findOriginalInstagramCandidates(username)));
  } else if (username && platHint === 'tiktok') {
    credited.push(...(await findOriginalTiktokCandidates(username)));
    credited.push(...findOriginalHandleCandidates(username, searchTopic));
  } else if (username && platHint === 'youtube') {
    credited.push(...(await findOriginalYouTubeCandidates(username, searchTopic)));
  } else if (username && platHint === 'threads') {
    const post = await findOriginalThreads(
      username,
      keywords.length ? keywords : KEYWORDS,
    );
    if (post) {
      const videoSrc = await threadsVideoSrc(post.url);
      if (videoSrc) {
        credited.push({
          url: post.url,
          platform: 'threads',
          videoSrc,
          uploader: username,
          isVideo: true,
        });
      }
    }
  } else if (username) {
    credited.push(...findOriginalHandleCandidates(username, searchTopic));
    credited.push(...(await findOriginalYouTubeCandidates(username, searchTopic)));
  }

  const generic = await findStoryCandidates(
    keywords.length ? keywords : KEYWORDS,
    storyText,
    {
      credited: username,
      query,
    },
  );
  const seen = new Set<string>();
  return [...credited, ...generic].filter(
    (candidate) =>
      candidate.url &&
      !seen.has(candidate.url) &&
      seen.add(candidate.url),
  );
}
```

- [ ] **Step 4: Construct story evidence and runtime evaluator once**

After the existing `storyCtx` construction, add:

```ts
const storyEvidence: MainStoryEvidence = {
  caption: caption || '',
  headline: headline || '',
  scene: scene || '',
  title: main.title || '',
  description: main.description || '',
  keywords: keywords || [],
  storyText: storyCtx,
};
```

Update `visionCoverKind` so the representative frame produced by
`extractFrameDataUrl` does not get fetched again:

```ts
let ct = 'image/jpeg';
let b64 = '';
const dataMatch = String(imgUrl).match(
  /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i,
);
if (dataMatch) {
  ct = dataMatch[1];
  b64 = dataMatch[2];
} else {
  try {
    const response = await fetch(imgUrl);
    if (!response.ok) return { desc: '', kind: '' };
    ct = response.headers.get('content-type') || ct;
    b64 = Buffer.from(await response.arrayBuffer()).toString('base64');
  } catch {
    return { desc: '', kind: '' };
  }
}
```

Then create the runtime evaluator:

```ts
const runtimeDeps = createMainCandidateRuntimeDeps({
  describeEvidence: async (candidate) => {
    if (!candidate.thumbnail) return '';
    const result = await visionCoverKind(
      candidate.thumbnail,
      novitaKey(),
      MODEL,
    );
    return result.desc || '';
  },
  classifyImage: async (image) => {
    const result = await visionCoverKind(image, novitaKey(), MODEL);
    return result.kind === 'footage' || result.kind === 'commentary'
      ? result.kind
      : 'unknown';
  },
});

const evaluate = (
  candidate: MainCandidate,
  evidence: MainStoryEvidence,
  origin: MainCandidateOrigin,
) => evaluateMainSuitability(candidate, evidence, origin, runtimeDeps);
```

- [ ] **Step 5: Replace branch-local main selection with one gate call**

Build the input candidate:

```ts
const inputCandidate: MainCandidate = {
  ...main,
  url: main.url,
  platform: main.platform || '',
  caption,
  isVideo: main.is_video !== false,
};
```

Use the gate:

```ts
const decision = await chooseInputOrReplacement(inputCandidate, storyEvidence, {
  evaluate,
  search: () =>
    discoverReplacementCandidates({
      username,
      platHint,
      searchTopic,
      keywords,
      storyText: storyCtx,
      query: '',
    }),
  rankAccepted: (results) =>
    rankAcceptedMainCandidates(results, {
      credited: username,
      repostHandle: urlHandle(main.url),
      preferFootage: process.env.THOTH_SOURCE_PREFER_FOOTAGE !== '0',
    }),
});

if (decision.status === 'retain') {
  carryCurrentOcrMetadata(set.main, decision.candidate);
  if (decision.confidence === 'low') {
    set.main.source_low_confidence = true;
  } else {
    delete set.main.source_low_confidence;
  }
  console.log(
    `[main-gate] input ${decision.suitability} confidence=${decision.confidence}`,
  );
} else {
  const oldUrl = set.main.url;
  await setMainTo(set, decision.candidate, username);
  if (decision.confidence === 'low') {
    set.main.source_low_confidence = true;
  }
  console.log(
    ui.gold(
      `    ${ui.OK} GANTI main → ${decision.candidate.platform} ${decision.candidate.url}\n       (dari: ${oldUrl})`,
    ),
  );
}
```

Remove the old platform-specific mutation branches after their discovery logic
has been moved into `discoverReplacementCandidates`. Keep profile-image cropping
as post-selection enrichment based on `set.main.platform` and
`set.main.source_traced`.

- [ ] **Step 6: Ensure final OCR reuses evaluator metadata**

Keep the final required check:

```ts
if (shouldAttachVideoOcr(set.main) && set.main.url) {
  await attachVideoOcr(set.main);
}
```

Add an assertion to `main_gate.test.ts` that the retained/replaced candidate has
`ocr_status: analyzed`; `currentOcrFields` in `attachVideoOcr` then prevents a
second resolver/OCR call.

- [ ] **Step 7: Run focused gate and dependency tests**

Run:

```powershell
rtk proxy bun scout/lib/main_candidate.test.ts
rtk proxy bun scout/lib/main_candidate_runtime.test.ts
rtk proxy bun scout/lib/main_gate.test.ts
rtk proxy bun scout/lib/main_search_candidates.test.ts
rtk proxy bun scout/lib/ocr_content.test.ts
rtk proxy bun scout/lib/verify.test.ts
```

Expected: every script exits zero.

- [ ] **Step 8: Run typecheck and formatting**

Run:

```powershell
rtk proxy bun run typecheck
rtk proxy bunx biome check lib/main_candidate.ts lib/main_candidate_runtime.ts lib/main_gate.ts lib/main_search_candidates.ts pipeline/trace_source.ts
```

Run from `scout/`. Expected: exit zero.

- [ ] **Step 9: Commit gate integration**

```powershell
rtk git add -- scout/pipeline/trace_source.ts scout/lib/main_gate.test.ts
rtk git commit -m "feat(scout): gate input before main replacement search"
```

---

### Task 6: Add Decision Diagnostics and Fail-Closed Regression Coverage

**Files:**
- Modify: `scout/lib/main_gate.ts`
- Modify: `scout/lib/main_gate.test.ts`
- Modify: `scout/pipeline/trace_source.ts`
- Create: `scout/lib/main_candidate_diagnostics.ts`
- Create: `scout/lib/main_candidate_diagnostics.test.ts`

**Interfaces:**
- Produces: `appendMainCandidateDiagnostic(record)` and `formatMainGateSummary`.
- Preserves: `MainCandidateNotFoundError.code === 'main_candidate_not_found'`.
- Adds: aggregate rejected-candidate counts by safe reason.

- [ ] **Step 1: Write failing diagnostic sanitization tests**

Create `scout/lib/main_candidate_diagnostics.test.ts`:

```ts
import assert from 'node:assert/strict';
import {
  formatMainGateSummary,
  sanitizeMainCandidateDiagnostic,
} from './main_candidate_diagnostics.ts';

const sanitized = sanitizeMainCandidateDiagnostic({
  candidate_url:
    'https://cdn.example.test/video.mp4?sessionid=private-session',
  embedding: [0.1, 0.2, 0.3],
  authorization: 'Bearer private-token',
  status: 'rejected',
  reason: 'media_unavailable',
  similarity: 0.31,
  floor: 0.33,
});
const serialized = JSON.stringify(sanitized);
assert.doesNotMatch(
  serialized,
  /cdn\.example|sessionid|private-session|embedding|private-token/i,
);
assert.match(serialized, /media_unavailable/);

assert.equal(
  formatMainGateSummary({
    accepted: 1,
    rejected: {
      off_topic: 2,
      media_unavailable: 1,
    },
  }),
  'accepted=1 rejected(off_topic=2,media_unavailable=1)',
);

console.log('ok main_candidate_diagnostics');
```

- [ ] **Step 2: Run the diagnostic test and confirm RED**

Run:

```powershell
rtk proxy bun scout/lib/main_candidate_diagnostics.test.ts
```

Expected: FAIL because the diagnostic module does not exist.

- [ ] **Step 3: Implement safe decision diagnostics**

Create `scout/lib/main_candidate_diagnostics.ts`:

```ts
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { outPath } from './paths.ts';

const SAFE_KEYS = new Set([
  'origin',
  'platform',
  'safe_handle',
  'status',
  'reason',
  'similarity',
  'floor',
  'visual_kind',
  'ocr_outcome',
  'replacement_started',
]);

export function sanitizeMainCandidateDiagnostic(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SAFE_KEYS.has(key)) output[key] = value;
  }
  if (typeof input.candidate_url === 'string') {
    output.candidate_id = createHash('sha256')
      .update(input.candidate_url)
      .digest('hex')
      .slice(0, 16);
  }
  return output;
}

export function appendMainCandidateDiagnostic(
  record: Record<string, unknown>,
): void {
  const safe = sanitizeMainCandidateDiagnostic(record);
  fs.appendFileSync(
    outPath('main_candidate_debug.jsonl'),
    `${JSON.stringify(safe)}\n`,
    'utf8',
  );
}

export function formatMainGateSummary(value: {
  accepted: number;
  rejected: Record<string, number>;
}): string {
  const rejected = Object.entries(value.rejected)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(',');
  return `accepted=${value.accepted} rejected(${rejected})`;
}
```

- [ ] **Step 4: Record every gate decision through injected diagnostics**

Extend `MainGateDeps`:

```ts
appendDiagnostic?: (record: Record<string, unknown>) => void;
```

After each evaluation, call:

```ts
deps.appendDiagnostic?.({
  candidate_url: candidate.url,
  origin,
  platform: candidate.platform,
  status: result.status,
  reason:
    result.status === 'rejected'
      ? result.reason
      : result.status === 'indeterminate'
        ? result.reason
        : undefined,
  similarity:
    result.status === 'accepted' || result.status === 'rejected'
      ? result.similarity
      : undefined,
  visual_kind:
    result.status === 'accepted' || result.status === 'indeterminate'
      ? result.kind
      : undefined,
  ocr_outcome:
    result.status === 'accepted' || result.status === 'indeterminate'
      ? result.candidate.ocr_outcome
      : undefined,
  replacement_started: origin === 'search',
});
```

Use `appendMainCandidateDiagnostic` in `trace_source.ts`.

- [ ] **Step 5: Add explicit no-replacement assertions**

In `main_gate.test.ts`, capture diagnostics and assert:

```ts
const diagnostics: Record<string, unknown>[] = [];
await assert.rejects(
  () =>
    chooseInputOrReplacement(input, story, {
      evaluate: async (_candidate, _story, origin) =>
        origin === 'input'
          ? { status: 'rejected', reason: 'off_topic', similarity: 0.1 }
          : { status: 'rejected', reason: 'media_unavailable' },
      search: async () => [
        { url: 'https://example.test/unavailable', platform: 'youtube' },
      ],
      appendDiagnostic: (record) => diagnostics.push(record),
    }),
  (error: unknown) =>
    error instanceof MainCandidateNotFoundError &&
    error.code === 'main_candidate_not_found',
);
assert.equal(diagnostics.length, 2);
assert.deepEqual(
  diagnostics.map((record) => record.status),
  ['rejected', 'rejected'],
);
```

- [ ] **Step 6: Run diagnostic and gate tests**

Run:

```powershell
rtk proxy bun scout/lib/main_candidate_diagnostics.test.ts
rtk proxy bun scout/lib/main_gate.test.ts
rtk proxy bun scout/lib/main_candidate.test.ts
```

Expected: every script exits zero.

- [ ] **Step 7: Run all Scout regression scripts**

```powershell
rtk proxy bun scout/lib/media_resolution.test.ts
rtk proxy bun scout/lib/ocr_content.test.ts
rtk proxy bun scout/lib/subtitle_vision.test.ts
rtk proxy bun scout/lib/footage_candidate_ocr.test.ts
rtk proxy bun scout/lib/footage_candidate_selection.test.ts
rtk proxy bun scout/lib/verify.test.ts
rtk proxy bun scout/lib/main_candidate.test.ts
rtk proxy bun scout/lib/main_candidate_runtime.test.ts
rtk proxy bun scout/lib/main_gate.test.ts
rtk proxy bun scout/lib/main_search_candidates.test.ts
rtk proxy bun scout/lib/main_candidate_diagnostics.test.ts
rtk proxy bun scout/pipeline/ocr_local.test.ts
```

Expected: every script exits zero.

- [ ] **Step 8: Run typecheck, formatting, and diff validation**

Run:

```powershell
rtk proxy bun run typecheck
rtk proxy bunx biome check lib pipeline
rtk git diff --check
rtk git status --short
```

Run Bun commands from `scout/`. Expected: checks pass and status contains only
the intended implementation plus pre-existing user changes.

- [ ] **Step 9: Commit diagnostics and fail-closed behavior**

```powershell
rtk git add -- scout/lib/main_candidate_diagnostics.ts scout/lib/main_candidate_diagnostics.test.ts scout/lib/main_gate.ts scout/lib/main_gate.test.ts scout/pipeline/trace_source.ts
rtk git commit -m "feat(scout): diagnose fail-closed main selection"
```

---

### Task 7: Run Live Input-Gate Acceptance

**Files:**
- Verify: `scout/output/thoth_content_set.json`
- Verify: `scout/output/main_candidate_debug.jsonl`
- Verify: `scout/output/subtitle_ocr_debug.jsonl`

**Interfaces:**
- Verifies the full input-evidence -> input gate -> replacement search -> resolver -> OCR -> final-main chain.
- Produces no source changes unless a verification failure returns to the owning task's red-green-refactor loop.

- [ ] **Step 1: Run the reported pipeline**

```powershell
rtk proxy bun scout/cli.ts run-pipeline "https://www.instagram.com/p/DbQoG9IjzGX"
```

Expected:

- input decision is `rejected reason=curated_aggregator`;
- replacement search starts;
- every replacement candidate emits an accepted/rejected decision;
- the selected replacement has `kind=footage`;
- platform-page resolution succeeds before FFprobe;
- final OCR status is analyzed.

- [ ] **Step 2: Inspect the content-set main safely**

Read only these fields from `scout/output/thoth_content_set.json`:

```text
main.platform
main.url
main.source_url
main.source_low_confidence
main.ocr_status
main.ocr_model
main.ocr_analyzer_version
main.ocr_requested_frames
main.ocr_valid_frames
main.ocr_outcome
```

Expected:

- `main.url` is not the rejected Dagelan/curator input;
- `ocr_status` is `analyzed`;
- requested and valid frame counts are equal;
- no signed CDN URL appears in diagnostic files.

- [ ] **Step 3: Run the accepted-input offline fixture**

Use the dependency-injected `main_gate.test.ts` accepted-input case. Expected:

- result is `retain`;
- replacement search call count is zero;
- retained candidate carries current OCR fields;
- a subsequent `attachVideoOcr` call makes zero resolver and OCR calls.

- [ ] **Step 4: Verify fail-closed behavior**

Run the no-accepted-replacement fixture in `main_gate.test.ts`. Expected:

- `MainCandidateNotFoundError.code` is `main_candidate_not_found`;
- the rejected input is not returned;
- no indeterminate search candidate is selected;
- diagnostics contain safe reason counts only.
