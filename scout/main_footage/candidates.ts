// candidates.ts — narration-beat -> scene candidate tiering and ranking.
//
// One narration beat plus the published scene indexes of a source package produce a
// bounded, ordered shortlist of RankedCandidate. Everything a candidate asserts —
// scene id, source id, time range, scores — is copied from the scene index; the
// planner LLM only reorders known candidate ids and supplies an editorial reason.
// It can never introduce a timecode, path, transition, or source.
//
// Ports (`embedText`, `loadEmbedding`, `rankShortlist`) follow the injection convention
// of source_package.ts / scene_index.ts so tests stay free of network and disk.
import fs from 'node:fs';
import type { MatchLevel, NarrationBeatV1, SceneEvidenceV1, SceneIndexV1 } from './contracts.ts';
import { resolveContained } from './paths.ts';

/** Longest editorial reason persisted for a candidate. */
export const MAX_REASON_CHARS = 200;

/** Sentinel scene_index.ts writes when a scene overlaps no transcript segment. */
const NO_SPEECH = '(no speech detected)';

export interface RankedCandidate {
  beat_id: string;
  scene_id: string;
  source_id: string;
  source_in_sec: number;
  source_out_sec: number;
  match_level: MatchLevel;
  embedding_score: number;
  visual_quality_score: number;
  planner_rank: number;
  reason: string;
}

export interface CandidatePolicy {
  /** Hard bound on the shortlist handed to the planner and returned to the caller. */
  maxCandidatesPerBeat: number;
  /** Only this many embedding-scored scenes survive the similarity cut. */
  embeddingTopK: number;
  /** Post-level caption/title shared by every source; the topic_only tier's evidence. */
  packageTopic?: string;
}

/** What the planner LLM is allowed to see. No paths, no timecodes, no provider text. */
export interface ShortlistEntry {
  candidate_id: string;
  evidence: string;
  match_level: MatchLevel;
  embedding_score: number;
  visual_quality_score: number;
}

/** What the planner LLM is allowed to return. Anything else is discarded. */
export interface PlannerRanking {
  candidate_id: string;
  reason?: string;
}

export interface CandidateDeps {
  embedText(text: string): Promise<number[] | null>;
  loadEmbedding(scene: SceneEvidenceV1): Promise<number[] | null>;
  rankShortlist(beat: NarrationBeatV1, shortlist: ShortlistEntry[]): Promise<PlannerRanking[]>;
}

export function candidateId(sourceId: string, sceneId: string): string {
  return `${sourceId}:${sceneId}`;
}

// ponytail: bag-of-words overlap with a tiny stopword list stands in for real lexical
// scoring. Upgrade to an embedding-similarity threshold if false `exact` tiers appear.
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'into',
  'onto',
  'over',
  'its',
  'was',
  'were',
  'are',
  'has',
  'had',
  'his',
  'her',
  'their',
  'they',
  'you',
  'not',
  'dan',
  'yang',
  'itu',
  'ini',
  'untuk',
  'dari',
  'dengan',
  'pada',
  'adalah',
  'akan',
]);

function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length >= 3 && !STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const token of a) if (b.has(token)) return true;
  return false;
}

/**
 * Flattens a scene's own evidence into plain text. `vision_description` is persisted as a
 * JSON VisionDescription; an unparseable one still contributes as raw text rather than
 * silently discarding the scene's only evidence.
 */
function sceneEvidenceText(scene: SceneEvidenceV1): string {
  const parts: string[] = [];
  if (scene.vision_description) {
    let described = scene.vision_description;
    try {
      const parsed = JSON.parse(scene.vision_description) as Record<string, unknown>;
      described = Object.values(parsed)
        .filter((value): value is string => typeof value === 'string')
        .join(' ');
    } catch {
      // Not JSON — keep the raw description as evidence.
    }
    parts.push(described);
  }
  if (scene.transcript_evidence && scene.transcript_evidence !== NO_SPEECH) {
    parts.push(scene.transcript_evidence);
  }
  return parts.join(' ').trim();
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * Local, deterministic shot quality: motion plus how far the exposure sits from a flat
 * black/blown frame. scene_change_score is left out — scene_index.ts derives it from the
 * same frame-difference pass as motion_score, so counting it would double-weight motion.
 */
function visualQuality(scene: SceneEvidenceV1): number {
  const exposure = 1 - Math.min(1, Math.abs(clamp01(scene.visual_metrics.brightness) - 0.5) * 2);
  return clamp01(0.5 * clamp01(scene.visual_metrics.motion_score) + 0.5 * exposure);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return clamp01(dot / Math.sqrt(normA * normB));
}

/** Bounded plain text. Raw provider payloads never reach an artifact through here. */
export function normalizeReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  return (
    value
      .normalize('NFC')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_REASON_CHARS)
      .trim()
  );
}

function defaultReason(matchLevel: MatchLevel): string {
  return matchLevel === 'exact'
    ? 'exact match on the scene own visual and spoken evidence'
    : 'topic_only match through the shared package topic';
}

interface Eligible {
  candidate_id: string;
  scene: SceneEvidenceV1;
  source_id: string;
  match_level: MatchLevel;
  evidence: string;
  embedding_score: number;
  visual_quality_score: number;
  has_embedding: boolean;
}

/** Stable total order: exact first, then similarity, then local quality, then id. */
function byRank(a: Eligible, b: Eligible): number {
  if (a.match_level !== b.match_level) return a.match_level === 'exact' ? -1 : 1;
  if (a.embedding_score !== b.embedding_score) return b.embedding_score - a.embedding_score;
  if (a.visual_quality_score !== b.visual_quality_score) {
    return b.visual_quality_score - a.visual_quality_score;
  }
  return a.candidate_id < b.candidate_id ? -1 : a.candidate_id > b.candidate_id ? 1 : 0;
}

/**
 * Applies the planner's ordering, or reports that it is unusable. Unknown or duplicated
 * candidate ids reject the whole ranking — a planner that hallucinated one id has not
 * earned partial trust. A strict subset is accepted; the remainder keeps its
 * deterministic order behind it.
 */
function applyPlannerOrder(
  shortlist: readonly Eligible[],
  ranking: unknown,
): { order: Eligible[]; reasons: Map<string, string> } | null {
  if (!Array.isArray(ranking)) return null;
  const known = new Map(shortlist.map((entry) => [entry.candidate_id, entry]));
  const order: Eligible[] = [];
  const reasons = new Map<string, string>();
  const seen = new Set<string>();
  for (const item of ranking) {
    if (!item || typeof item !== 'object') return null;
    const id = (item as { candidate_id?: unknown }).candidate_id;
    if (typeof id !== 'string') return null;
    const entry = known.get(id);
    if (!entry) return null;
    if (seen.has(id)) return null;
    seen.add(id);
    order.push(entry);
    const reason = normalizeReason((item as { reason?: unknown }).reason);
    if (reason) reasons.set(id, reason);
  }
  for (const entry of shortlist) if (!seen.has(entry.candidate_id)) order.push(entry);
  return { order, reasons };
}

/**
 * Ranks the scenes of a published source package against one narration beat.
 *
 * Tiering is evidence-driven: a scene whose own vision/transcript evidence shares content
 * with the beat is `exact`; a scene that only meets the beat through the package-level
 * topic is `topic_only`; a scene sharing neither is dropped. Embedding similarity then
 * keeps the best `policy.embeddingTopK` of the scenes that actually carry an embedding —
 * a scene without one (a degraded index, or evidence too thin to embed) bypasses that cut
 * and stays eligible on its lexical and local-metric evidence, because discarding it would
 * make a vision failure silently delete footage.
 *
 * Time ranges are the natural scene bounds and nothing else.
 */
export async function buildBeatCandidates(
  beat: NarrationBeatV1,
  indexes: readonly SceneIndexV1[],
  policy: CandidatePolicy,
  deps: CandidateDeps,
): Promise<RankedCandidate[]> {
  const beatTokens = contentTokens(beat.text);
  const topicTokens = contentTokens(policy.packageTopic ?? '');
  const beatMeetsTopic = intersects(beatTokens, topicTokens);
  const beatVector = await deps.embedText(beat.text);

  const eligible: Eligible[] = [];
  for (const index of indexes) {
    for (const scene of index.scenes) {
      const evidence = sceneEvidenceText(scene);
      const sceneTokens = contentTokens(evidence);
      let matchLevel: MatchLevel | null = null;
      if (intersects(beatTokens, sceneTokens)) matchLevel = 'exact';
      else if (beatMeetsTopic && intersects(sceneTokens, topicTokens)) matchLevel = 'topic_only';
      if (!matchLevel) continue;

      const vector = await deps.loadEmbedding(scene);
      eligible.push({
        candidate_id: candidateId(index.source_id, scene.id),
        scene,
        source_id: index.source_id,
        match_level: matchLevel,
        evidence,
        embedding_score: beatVector && vector ? cosine(beatVector, vector) : 0,
        visual_quality_score: visualQuality(scene),
        has_embedding: Boolean(vector),
      });
    }
  }

  const embedded = eligible.filter((entry) => entry.has_embedding).sort(byRank);
  const kept = new Set(
    embedded.slice(0, Math.max(0, policy.embeddingTopK)).map((entry) => entry.candidate_id),
  );
  const shortlist = eligible
    .filter((entry) => !entry.has_embedding || kept.has(entry.candidate_id))
    .sort(byRank)
    .slice(0, Math.max(0, policy.maxCandidatesPerBeat));

  let ranked: { order: Eligible[]; reasons: Map<string, string> } | null = null;
  if (shortlist.length) {
    try {
      ranked = applyPlannerOrder(
        shortlist,
        await deps.rankShortlist(
          beat,
          shortlist.map((entry) => ({
            candidate_id: entry.candidate_id,
            evidence: normalizeReason(entry.evidence),
            match_level: entry.match_level,
            embedding_score: entry.embedding_score,
            visual_quality_score: entry.visual_quality_score,
          })),
        ),
      );
    } catch {
      ranked = null;
    }
  }
  const order = ranked?.order ?? shortlist;
  const reasons = ranked?.reasons ?? new Map<string, string>();

  return order.map((entry, position) => ({
    beat_id: beat.id,
    scene_id: entry.scene.id,
    source_id: entry.source_id,
    source_in_sec: entry.scene.start_sec,
    source_out_sec: entry.scene.end_sec,
    match_level: entry.match_level,
    embedding_score: entry.embedding_score,
    visual_quality_score: entry.visual_quality_score,
    planner_rank: position + 1,
    reason: reasons.get(entry.candidate_id) || defaultReason(entry.match_level),
  }));
}

/** Production `loadEmbedding`: reads the vector scene_index.ts published in the package. */
export function fileEmbeddingLoader(packageRoot: string): CandidateDeps['loadEmbedding'] {
  return async (scene: SceneEvidenceV1) => {
    if (!scene.embedding_path) return null;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(resolveContained(packageRoot, scene.embedding_path), 'utf8'),
      );
      return Array.isArray(parsed) && parsed.every((n) => typeof n === 'number') ? parsed : null;
    } catch {
      return null;
    }
  };
}
