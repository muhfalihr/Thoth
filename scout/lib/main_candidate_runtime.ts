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
  if (candidate.platform === 'instagram' || candidate.platform === 'facebook') {
    const shape = (deps.postShape ?? postShape)(candidate.url);
    const isVideo = Boolean(shape.ok && shape.slides.some((slide) => slide.kind === 'video'));
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
) {
  if (candidate.platform === 'tiktok') return null;
  return resolveOcrMedia(String(candidate.videoSrc || candidate.url), { env });
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
