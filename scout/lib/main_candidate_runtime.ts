import { isCuratedAggregator, urlHandle } from './aggregators.ts';
import { rankBySimilarity } from './embed.ts';
import type {
  CandidateProbe,
  MainCandidate,
  MainCandidateEvaluatorDeps,
  MainVisualKind,
} from './main_candidate.ts';
import { type MediaResolutionResult, resolveOcrMedia } from './media_resolution.ts';
import { attachVideoOcr } from './ocr_content.ts';
import { extractFrameDataUrl } from './subtitle_vision.ts';
import {
  directStreamUrl,
  igCarouselSlides,
  igSlideDirectUrl,
  postShape,
  probeVideo,
} from './verify.ts';

// Platforms whose posts can be multi-slide carousels, i.e. where "the post" is not "the video".
const CAROUSEL_PLATFORMS = new Set(['instagram', 'facebook']);

type ProbeRuntimeDeps = {
  postShape?: (url: string) => {
    ok: boolean;
    shape: string;
    slides: Array<{ index: number; kind: string; duration: number }>;
    caption?: string;
    thumbnail?: string;
    time?: number;
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
    return { available: true, isVideo: Boolean(candidate.videoSrc), candidate };
  }
  if (candidate.platform === 'youtube') {
    return { available: true, isVideo: candidate.isVideo !== false, candidate };
  }
  if (candidate.platform === 'tiktok') {
    // The blind path left `thumbnail: ''` on every profile-discovery candidate, so
    // describeEvidence returned '' and a source post with an empty caption had NO evidence at
    // all — scored null, filed as similarity_unavailable, then dropped. postShape is memoized
    // per run, so probing 30 candidates costs one warm wave, not thirty roundtrips.
    const shape = (deps.postShape ?? postShape)(candidate.url);
    if (!shape.ok) {
      // Fail open: a dead probe is missing information, not a rejection.
      return { available: true, isVideo: candidate.isVideo !== false, candidate };
    }
    const slide = shape.slides.find((s) => s.kind === 'video') ?? shape.slides[0];
    return {
      available: true,
      // Discovery only ever yields video entries here; a photo-shape misread must not veto them.
      isVideo: candidate.isVideo !== false,
      candidate: {
        ...candidate,
        caption: candidate.caption || shape.caption || '',
        thumbnail: candidate.thumbnail || shape.thumbnail || '',
        uploader: shape.uploader || candidate.uploader || '',
        pageUrl: shape.webpageUrl || candidate.pageUrl || candidate.url,
        ...(shape.time ? { publishedAt: shape.time } : {}),
        ...(slide?.duration ? { durationSec: slide.duration } : {}),
      },
    };
  }
  if (candidate.platform === 'instagram' || candidate.platform === 'facebook') {
    const shape = (deps.postShape ?? postShape)(candidate.url);
    const isVideo = Boolean(shape.ok && shape.slides.some((slide) => slide.kind === 'video'));
    return {
      available: shape.ok,
      isVideo,
      candidate: {
        ...candidate,
        caption: candidate.caption || shape.caption || '',
        uploader: shape.uploader || candidate.uploader || '',
        pageUrl: shape.webpageUrl || candidate.pageUrl || candidate.url,
      },
    };
  }
  const probed = (deps.probeVideo ?? probeVideo)(candidate.url);
  return {
    available: true,
    isVideo: probed.isVideo,
    candidate: {
      ...candidate,
      caption: probed.caption || candidate.caption || '',
      thumbnail: probed.thumbnail || candidate.thumbnail || '',
      uploader: probed.uploader || candidate.uploader || '',
      pageUrl: probed.webpageUrl || candidate.pageUrl || '',
    },
  };
}

type Ranker = (
  query: string,
  items: Array<{ text: string }>,
  getText: (item: { text: string }) => string,
  // Only `sim` is read. Requiring the ranked text back would constrain nothing in
  // production — `rankBySimilarity` comes from untyped `embed.ts` — while forcing
  // every test double to carry candidate text this module has no reason to hold.
) => Promise<Array<{ sim: number }>>;

export async function scoreMainCandidateSimilarity(
  storyText: string,
  evidence: string,
  ranker: Ranker = rankBySimilarity,
): Promise<number | null> {
  const ranked = await ranker(storyText, [{ text: evidence }], (item) => item.text);
  const score = ranked[0]?.sim || 0;
  return score > 0 ? score : null;
}

export async function resolveMainCandidateMedia(
  candidate: MainCandidate,
  env: Record<string, string | undefined> = process.env,
  deps: {
    directStream?: (pageUrl: string) => string;
    slides?: (postUrl: string) => Array<{ index: number; kind: string }>;
    slideStream?: (postUrl: string, index: number) => string;
  } = {},
): Promise<MediaResolutionResult | null> {
  const input = String(candidate.videoSrc || candidate.url);

  // Whole-post resolution (`-g -f best[ext=mp4]/best` over slides 1-5) prints one url per slide and
  // the caller keeps the FIRST. On a photo-first carousel that is the cover JPEG: the `/best` half
  // of the selector matches an image, and --ignore-no-formats-error only skips a slide with NO
  // format at all. The gate then graded the cover — a title card — which the visual rubric calls
  // 'commentary', so every IG carousel was rejected while reporting `[media] resolved`. Pick a
  // slide yt-dlp itself reports as video, the same helpers build_footage harvests slides with.
  // postShape is memoized per run, so enumeration costs no extra probe after probeMainCandidateVideo.
  if (CAROUSEL_PLATFORMS.has(String(candidate.platform)) && !candidate.videoSrc) {
    const listSlides = deps.slides ?? igCarouselSlides;
    const resolveSlide = deps.slideStream ?? igSlideDirectUrl;
    // No dropCoverSlide here: that rule keeps footage from duplicating the main video. The main
    // gate wants the first VIDEO slide whatever its index — the kind filter already drops covers.
    for (const slide of listSlides(candidate.url).filter((s) => s.kind === 'video')) {
      const direct = resolveSlide(candidate.url, slide.index);
      if (direct) return resolveOcrMedia(direct, { env });
    }
    // Fall through on failure: whole-post resolution is still better than nothing.
  }

  if (candidate.platform !== 'tiktok') return resolveOcrMedia(input, { env });

  // resolveOcrMedia rejects TikTok *page* URLs as 'unsupported' (they have a dedicated path). Left
  // at null, the gate grades TikTok on `candidate.thumbnail` — the cover — and a cover is a title
  // card, which the visual rubric classifies as 'commentary'. That rejected every TikTok
  // replacement outright. Resolve to a signed CDN mp4 so a real mid-video frame is classified.
  // An already-direct videoSrc resolves on the first call and never hits yt-dlp.
  const resolved = await resolveOcrMedia(input, { env });
  if (resolved.status === 'resolved') return resolved;
  const direct = (deps.directStream ?? directStreamUrl)(input);
  // Fail open: null keeps the old thumbnail fallback rather than a hard media_unavailable reject.
  return direct ? resolveOcrMedia(direct, { env }) : null;
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
  }) as Promise<MainCandidate & import('./ocr_contract.ts').PersistedOcrFields>;
}

export function createMainCandidateRuntimeDeps(
  visual: {
    describeEvidence: (candidate: MainCandidate) => Promise<string>;
    classifyImage: (image: string) => Promise<MainVisualKind>;
  },
  env: Record<string, string | undefined> = process.env,
): MainCandidateEvaluatorDeps {
  const configuredFloor = Number.parseFloat(env.THOTH_SOURCE_STORY_MIN || '0.33');
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
