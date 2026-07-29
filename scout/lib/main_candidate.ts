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
  scoreSimilarity: (storyText: string, candidateEvidence: string) => Promise<number | null>;
  resolveMedia: (candidate: MainCandidate) => Promise<MediaResolutionResult | null>;
  classifyResolvedVisual: (
    candidate: MainCandidate,
    resolvedMedia: string | null,
  ) => Promise<MainVisualKind>;
  attachOcr: (
    candidate: MainCandidate,
    resolvedMedia: string | null,
  ) => Promise<MainCandidate & PersistedOcrFields>;
};

function candidateEvidence(candidate: MainCandidate, visualDescription: string): string {
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
