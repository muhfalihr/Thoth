// allocator.ts — deterministic global timeline allocation for forced main footage.
//
// Narration beats plus the ranked candidates of candidates.ts become one ordered, gap-free
// timeline of cuts. Nothing here reads the filesystem or a provider: the allocator only
// rearranges facts the source package and the scene index already published, so the same
// input always serializes to the same bytes.
//
// The result is structurally complete but deliberately carries no `cut_path` and no
// checksum — materialization (Task 10) is what turns a decision into a file.
import { candidateId, type RankedCandidate } from './candidates.ts';
import type { AssetKind, MainFootageWarningCode, MatchLevel, NarrationBeatV1 } from './contracts.ts';
import { assertArtifactPath } from './paths.ts';

/** Shortest cut the renderer accepts; below this a shot reads as a flicker. */
export const MIN_CUT_SEC = 1.5;
/** Longest cut before a beat must be split across several shots. */
export const MAX_CUT_SEC = 6;
/** An identical source range may only return this many output seconds after its last use. */
export const MIN_REUSE_GAP_SEC = 8;

const EPS = 1e-9;

/**
 * External b-roll already materialized inside the job. `source_path` must be a job-local
 * artifact path: a remote enrichment entry is never eligible in planned mode, because the
 * allocator commits to a timeline that materialization must be able to cut without network.
 */
export interface ExternalCandidate {
  id: string;
  beat_id: string;
  source_id: string;
  source_path: string;
  source_in_sec: number;
  source_out_sec: number;
}

export interface AllocatedItemV1 {
  item_id: string;
  beat_id: string;
  timeline_start_sec: number;
  timeline_end_sec: number;
  asset_kind: AssetKind;
  /** Stable candidate identity. Task 10 bans it on a failed cut; it is not a path. */
  candidate_key: string;
  source_id: string;
  source_in_sec: number;
  source_out_sec: number;
  match_level: MatchLevel;
  reuse_count: number;
}

export interface AllocationCoverage {
  target: number;
  actual: number;
  main_sec: number;
  total_sec: number;
}

export interface AllocationError {
  code: 'cut_planning_failed' | 'cut_materialization_exhausted';
  /** Safe identifiers only — never a path, a timecode, or raw narration text. */
  beat_id?: string;
  item_id?: string;
}

export interface AllocationResult {
  timeline: AllocatedItemV1[];
  coverage: AllocationCoverage;
  candidate_count: number;
  warnings: MainFootageWarningCode[];
  error?: AllocationError;
}

export interface AllocationInput {
  beats: readonly NarrationBeatV1[];
  candidates:
    | ReadonlyMap<string, readonly RankedCandidate[]>
    | Readonly<Record<string, readonly RankedCandidate[]>>;
  coverageTarget: number;
  externals?: readonly ExternalCandidate[];
}

interface Entry {
  kind: AssetKind;
  key: string;
  source_id: string;
  source_in_sec: number;
  natural_sec: number;
  match_level: MatchLevel;
  planner_rank: number;
  embedding_score: number;
  visual_quality_score: number;
}

/** Six decimals: enough for frame-accurate seconds, few enough to serialize identically. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** `source_id:scene_id`, the same identity the planner shortlist already spoke. */
function mainKey(candidate: RankedCandidate): string | null {
  try {
    return candidateId(candidate.source_id, candidate.scene_id);
  } catch {
    return null;
  }
}

function toMainEntry(beatId: string, candidate: RankedCandidate): Entry | null {
  if (candidate.beat_id !== beatId) return null;
  if (candidate.match_level !== 'exact' && candidate.match_level !== 'topic_only') return null;
  if (!candidate.source_id || !candidate.scene_id) return null;
  if (!finite(candidate.source_in_sec) || !finite(candidate.source_out_sec)) return null;
  const natural = candidate.source_out_sec - candidate.source_in_sec;
  if (natural <= 0) return null;
  const key = mainKey(candidate);
  if (!key) return null;
  return {
    kind: 'main_cut',
    key,
    source_id: candidate.source_id,
    source_in_sec: candidate.source_in_sec,
    natural_sec: natural,
    match_level: candidate.match_level,
    planner_rank: finite(candidate.planner_rank) ? candidate.planner_rank : Number.MAX_SAFE_INTEGER,
    embedding_score: finite(candidate.embedding_score) ? candidate.embedding_score : 0,
    visual_quality_score: finite(candidate.visual_quality_score)
      ? candidate.visual_quality_score
      : 0,
  };
}

function toExternalEntry(candidate: ExternalCandidate): Entry | null {
  if (!candidate.id || !candidate.source_id) return null;
  if (!finite(candidate.source_in_sec) || !finite(candidate.source_out_sec)) return null;
  const natural = candidate.source_out_sec - candidate.source_in_sec;
  if (natural <= 0) return null;
  try {
    // Remote enrichment and anything outside the job root is not materialized locally, so
    // it can never back a planned cut. This is the same guard the artifact writers use.
    assertArtifactPath(candidate.source_path);
  } catch {
    return null;
  }
  if (candidate.id.includes(':')) return null;
  return {
    kind: 'external_cut',
    key: `ext:${candidate.id}`,
    source_id: candidate.source_id,
    source_in_sec: candidate.source_in_sec,
    natural_sec: natural,
    match_level: 'topic_only',
    planner_rank: 0,
    embedding_score: 0,
    visual_quality_score: 0,
  };
}

/**
 * Match tier, planner rank, similarity, local quality, lower reuse, then the stable identity.
 *
 * `reuseDelta` is `uses(a) - uses(b)`; callers that do not track reuse pass nothing. It sits
 * fifth exactly as the brief orders it, so a twice-used exact scene still outranks a
 * once-used topic-only one. `key` alone is `source_id:scene_id`, which two shortlist entries
 * can share, so the source range breaks that tie before it can fall back to input order.
 */
function byRank(a: Entry, b: Entry, reuseDelta = 0): number {
  if (a.match_level !== b.match_level) return a.match_level === 'exact' ? -1 : 1;
  if (a.planner_rank !== b.planner_rank) return a.planner_rank - b.planner_rank;
  if (a.embedding_score !== b.embedding_score) return b.embedding_score - a.embedding_score;
  if (a.visual_quality_score !== b.visual_quality_score) {
    return b.visual_quality_score - a.visual_quality_score;
  }
  if (reuseDelta !== 0) return reuseDelta;
  if (a.source_in_sec !== b.source_in_sec) return a.source_in_sec - b.source_in_sec;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * How much of `remaining` this candidate can carry without stretching its own footage and
 * without leaving a sub-minimum stub behind. Returns null when the scene is simply too
 * short to open a legal cut here.
 */
function fitDuration(remaining: number, natural: number): number | null {
  const ceiling = Math.min(MAX_CUT_SEC, natural);
  let duration = Math.min(remaining, ceiling);
  const rest = remaining - duration;
  if (rest > EPS && rest < MIN_CUT_SEC) {
    duration = remaining <= ceiling + EPS ? remaining : remaining - MIN_CUT_SEC;
  }
  const floor = Math.min(MIN_CUT_SEC, remaining);
  if (duration < floor - EPS || duration > ceiling + EPS) return null;
  return duration;
}

/** Every output start at which one identical source range has already been placed. */
type Ledger = Map<string, number[]>;

function rangeKey(sourceId: string, inSec: number, outSec: number): string {
  return `${sourceId}@${round6(inSec)}-${round6(outSec)}`;
}

function reuseAllowed(ledger: Ledger, key: string, start: number): boolean {
  const starts = ledger.get(key);
  if (!starts) return true;
  // Symmetric so a mid-timeline replan cannot create an illegal pair behind itself.
  return starts.every((existing) => Math.abs(start - existing) >= MIN_REUSE_GAP_SEC - EPS);
}

function noteUse(ledger: Ledger, key: string, start: number): void {
  const starts = ledger.get(key);
  if (starts) starts.push(start);
  else ledger.set(key, [start]);
}

interface Choice {
  entry: Entry;
  duration: number;
  range_key: string;
  reuse_count: number;
}

interface SlotContext {
  /** How many times each candidate has already been placed. Drives the reuse ordering. */
  uses: Map<string, number>;
  ledger: Ledger;
  externalBudgetSec: number;
}

function useCount(ctx: SlotContext, key: string): number {
  return ctx.uses.get(key) ?? 0;
}

function tryEntry(
  entry: Entry,
  cursor: number,
  remaining: number,
  ctx: SlotContext,
): Choice | null {
  const duration = fitDuration(remaining, entry.natural_sec);
  if (duration === null) return null;
  const key = rangeKey(entry.source_id, entry.source_in_sec, entry.source_in_sec + duration);
  if (!reuseAllowed(ctx.ledger, key, cursor)) return null;
  const prior = ctx.ledger.get(key) ?? [];
  return {
    entry,
    duration,
    range_key: key,
    reuse_count: prior.filter((start) => start < cursor).length,
  };
}

/**
 * Preference order for one slot. Fresh exact main footage first, then external b-roll while
 * the coverage target still has room for it, then fresh topic-only main footage — which is
 * what forces topic-only cuts in once the external allowance is spent. Everything after
 * that is fallback reuse of an already-placed range.
 */
function pickSlot(
  mains: readonly Entry[],
  externals: readonly Entry[],
  cursor: number,
  remaining: number,
  ctx: SlotContext,
): Choice | null {
  const freshFirst = (entries: readonly Entry[]): Entry[] =>
    [...entries].sort((a, b) => byRank(a, b, useCount(ctx, a.key) - useCount(ctx, b.key)));
  const tiers: Array<{ entries: Entry[]; fresh: boolean; exact: boolean; budgeted: boolean }> = [
    { entries: freshFirst(mains), fresh: true, exact: true, budgeted: false },
    { entries: freshFirst(externals), fresh: true, exact: false, budgeted: true },
    { entries: freshFirst(mains), fresh: true, exact: false, budgeted: false },
    { entries: freshFirst(externals), fresh: false, exact: false, budgeted: true },
    { entries: freshFirst(mains), fresh: false, exact: false, budgeted: false },
    // No unbudgeted external tier: it could only fire once every main is spent, and by then
    // the external total already breaks the coverage target, which `validate` rejects without
    // a beat id. Returning null here fails with the beat id instead.
  ];
  for (const tier of tiers) {
    for (const entry of tier.entries) {
      if (tier.exact && entry.match_level !== 'exact') continue;
      if (tier.fresh && useCount(ctx, entry.key) > 0) continue;
      const choice = tryEntry(entry, cursor, remaining, ctx);
      if (!choice) continue;
      if (tier.budgeted && choice.duration > ctx.externalBudgetSec + EPS) continue;
      return choice;
    }
  }
  return null;
}

function commit(
  choice: Choice,
  itemId: string,
  beatId: string,
  cursor: number,
  end: number,
  ctx: SlotContext,
): AllocatedItemV1 {
  ctx.uses.set(choice.entry.key, useCount(ctx, choice.entry.key) + 1);
  noteUse(ctx.ledger, choice.range_key, cursor);
  if (choice.entry.kind === 'external_cut') ctx.externalBudgetSec -= choice.duration;
  return {
    item_id: itemId,
    beat_id: beatId,
    timeline_start_sec: round6(cursor),
    timeline_end_sec: round6(end),
    asset_kind: choice.entry.kind,
    candidate_key: choice.entry.key,
    source_id: choice.entry.source_id,
    source_in_sec: round6(choice.entry.source_in_sec),
    source_out_sec: round6(choice.entry.source_in_sec + (end - cursor)),
    match_level: choice.entry.match_level,
    reuse_count: choice.reuse_count,
  };
}

/** Fills [start, end) with consecutive cuts. Returns null the moment nothing legal fits. */
function fillWindow(
  beatId: string,
  start: number,
  end: number,
  mains: readonly Entry[],
  externals: readonly Entry[],
  ctx: SlotContext,
  nextId: () => string,
): AllocatedItemV1[] | null {
  const items: AllocatedItemV1[] = [];
  let cursor = start;
  while (end - cursor > EPS) {
    const remaining = end - cursor;
    const choice = pickSlot(mains, externals, cursor, remaining, ctx);
    if (!choice) return null;
    // The final cut snaps to the window edge so rounding can never open a gap.
    const stop = end - (cursor + choice.duration) <= EPS ? end : cursor + choice.duration;
    items.push(commit(choice, nextId(), beatId, cursor, stop, ctx));
    cursor = stop;
  }
  return items.length ? items : null;
}

function summarize(timeline: readonly AllocatedItemV1[], target: number): AllocationCoverage {
  let main = 0;
  let total = 0;
  for (const item of timeline) {
    const duration = item.timeline_end_sec - item.timeline_start_sec;
    total += duration;
    // Handles and overlays are not timeline items, so neither sum can see them.
    if (item.asset_kind === 'main_cut') main += duration;
  }
  return {
    target: round6(target),
    actual: total > 0 ? round6(main / total) : 0,
    main_sec: round6(main),
    total_sec: round6(total),
  };
}

const WARNING_ORDER: readonly MainFootageWarningCode[] = ['topic_only_match', 'exact_scene_reused'];

function collectWarnings(timeline: readonly AllocatedItemV1[]): MainFootageWarningCode[] {
  const seen = new Set<MainFootageWarningCode>();
  for (const item of timeline) {
    if (item.asset_kind === 'main_cut' && item.match_level === 'topic_only') {
      seen.add('topic_only_match');
    }
    if (item.reuse_count > 0) seen.add('exact_scene_reused');
  }
  return WARNING_ORDER.filter((code) => seen.has(code));
}

/** Whole-timeline validation. Runs on a first plan and on every replan alike. */
function validate(
  timeline: readonly AllocatedItemV1[],
  coverage: AllocationCoverage,
): AllocationError | null {
  const ledger: Ledger = new Map();
  let cursor = 0;
  for (const item of timeline) {
    if (Math.abs(item.timeline_start_sec - cursor) > 1e-6) {
      return { code: 'cut_planning_failed', beat_id: item.beat_id, item_id: item.item_id };
    }
    const duration = item.timeline_end_sec - item.timeline_start_sec;
    if (duration <= 0 || duration > item.source_out_sec - item.source_in_sec + 1e-6) {
      return { code: 'cut_planning_failed', beat_id: item.beat_id, item_id: item.item_id };
    }
    const key = rangeKey(item.source_id, item.source_in_sec, item.source_out_sec);
    if (!reuseAllowed(ledger, key, item.timeline_start_sec)) {
      return { code: 'cut_planning_failed', beat_id: item.beat_id, item_id: item.item_id };
    }
    noteUse(ledger, key, item.timeline_start_sec);
    cursor = item.timeline_end_sec;
  }
  if (coverage.actual < coverage.target - 1e-6) return { code: 'cut_planning_failed' };
  return null;
}

function failed(error: AllocationError, target: number, candidateCount: number): AllocationResult {
  return {
    timeline: [],
    coverage: { target: round6(target), actual: 0, main_sec: 0, total_sec: 0 },
    candidate_count: candidateCount,
    warnings: [],
    error,
  };
}

function candidatesFor(
  candidates: AllocationInput['candidates'],
  beatId: string,
): readonly RankedCandidate[] {
  if (candidates instanceof Map) return candidates.get(beatId) ?? [];
  return (candidates as Record<string, readonly RankedCandidate[]>)[beatId] ?? [];
}

/**
 * Allocates the whole narration timeline in one deterministic pass.
 *
 * Beat order is the only iteration order that matters: the candidate container is indexed by
 * beat id, never walked, so a Map built in reverse and a shuffled candidate array produce
 * byte-identical output.
 */
export function allocateTimeline(input: AllocationInput): AllocationResult {
  const target = input.coverageTarget;
  const mainsByBeat = new Map<string, Entry[]>();
  let candidateCount = 0;
  for (const beat of input.beats) {
    const entries: Entry[] = [];
    for (const candidate of candidatesFor(input.candidates, beat.id)) {
      const entry = toMainEntry(beat.id, candidate);
      if (entry) entries.push(entry);
    }
    candidateCount += entries.length;
    mainsByBeat.set(beat.id, entries);
  }

  const externalsByBeat = new Map<string, Entry[]>();
  for (const candidate of input.externals ?? []) {
    const entry = toExternalEntry(candidate);
    if (!entry) continue;
    const bucket = externalsByBeat.get(candidate.beat_id);
    if (bucket) bucket.push(entry);
    else externalsByBeat.set(candidate.beat_id, [entry]);
  }

  const totalSec = input.beats.reduce((sum, beat) => sum + (beat.end_sec - beat.start_sec), 0);
  const ctx: SlotContext = {
    uses: new Map(),
    ledger: new Map(),
    // External b-roll may never eat into the reserved main share.
    externalBudgetSec: Math.max(0, totalSec * (1 - target)),
  };

  const timeline: AllocatedItemV1[] = [];
  let sequence = 0;
  const nextId = (): string => {
    sequence += 1;
    return `item-${String(sequence).padStart(3, '0')}`;
  };
  for (const beat of input.beats) {
    const items = fillWindow(
      beat.id,
      beat.start_sec,
      beat.end_sec,
      mainsByBeat.get(beat.id) ?? [],
      externalsByBeat.get(beat.id) ?? [],
      ctx,
      nextId,
    );
    if (!items)
      return failed({ code: 'cut_planning_failed', beat_id: beat.id }, target, candidateCount);
    timeline.push(...items);
  }

  const coverage = summarize(timeline, target);
  const error = validate(timeline, coverage);
  if (error) return failed(error, target, candidateCount);
  return {
    timeline,
    coverage,
    candidate_count: candidateCount,
    warnings: collectWarnings(timeline),
  };
}

/**
 * Replaces exactly one item whose cut could not be materialized.
 *
 * Only the failed item moves: its candidate key is banned for this plan attempt and the
 * replacement is allocated inside the very same output window, so every other item — and
 * therefore every cut already on disk — stays byte-identical.
 */
export function reallocateBeat(
  prior: AllocationResult,
  failedItemId: string,
  candidates: readonly RankedCandidate[],
): AllocationResult {
  const index = prior.timeline.findIndex((item) => item.item_id === failedItemId);
  const target = prior.coverage.target;
  if (index < 0) {
    return failed(
      { code: 'cut_materialization_exhausted', item_id: failedItemId },
      target,
      prior.candidate_count,
    );
  }
  const failedItem = prior.timeline[index]!;
  const survivors = prior.timeline.filter((_, position) => position !== index);

  const banned = new Set<string>([failedItem.candidate_key]);
  const ctx: SlotContext = {
    // Banned keys are dropped from `mains` outright below, so seeding them here would never
    // be consulted; only the survivors' own reuse counts matter.
    uses: new Map(),
    ledger: new Map(),
    // A replan allocates from main candidates only, so no external budget is ever spent.
    externalBudgetSec: 0,
  };
  for (const item of survivors) {
    ctx.uses.set(item.candidate_key, useCount(ctx, item.candidate_key) + 1);
    noteUse(
      ctx.ledger,
      rangeKey(item.source_id, item.source_in_sec, item.source_out_sec),
      item.timeline_start_sec,
    );
  }

  const taken = new Set(prior.timeline.map((item) => item.item_id));
  let suffix = 0;
  const nextId = (): string => {
    let id: string;
    do {
      suffix += 1;
      id = `${failedItemId}-r${suffix}`;
    } while (taken.has(id));
    taken.add(id);
    return id;
  };

  const mains = candidates
    .map((candidate) => toMainEntry(failedItem.beat_id, candidate))
    .filter((entry): entry is Entry => entry !== null && !banned.has(entry.key));

  const replacement = fillWindow(
    failedItem.beat_id,
    failedItem.timeline_start_sec,
    failedItem.timeline_end_sec,
    mains,
    [],
    ctx,
    nextId,
  );
  if (!replacement) {
    return failed(
      {
        code: 'cut_materialization_exhausted',
        beat_id: failedItem.beat_id,
        item_id: failedItemId,
      },
      target,
      prior.candidate_count,
    );
  }

  const timeline = [...survivors.slice(0, index), ...replacement, ...survivors.slice(index)];
  const coverage = summarize(timeline, target);
  const error = validate(timeline, coverage);
  if (error) return failed(error, target, prior.candidate_count);
  return {
    timeline,
    coverage,
    candidate_count: prior.candidate_count,
    warnings: collectWarnings(timeline),
  };
}
