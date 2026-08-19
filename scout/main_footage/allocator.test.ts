import assert from 'node:assert/strict';
import type { AllocationInput, ExternalCandidate } from './allocator.ts';
import {
  allocateTimeline,
  MAX_CUT_SEC,
  MIN_CUT_SEC,
  MIN_REUSE_GAP_SEC,
  reallocateBeat,
} from './allocator.ts';
import type { RankedCandidate } from './candidates.ts';
import type { MatchLevel, NarrationBeatV1 } from './contracts.ts';

const cases: Array<[string, () => Promise<void>]> = [];
function testCase(name: string, fn: () => Promise<void>): void {
  cases.push([name, fn]);
}

const EPS = 1e-6;

function beat(id: string, start_sec: number, end_sec: number): NarrationBeatV1 {
  return { id, start_sec, end_sec, text: `narration for ${id}` };
}

function cand(
  beat_id: string,
  source_id: string,
  scene_id: string,
  overrides: Partial<RankedCandidate> = {},
): RankedCandidate {
  return {
    beat_id,
    scene_id,
    source_id,
    source_in_sec: 0,
    source_out_sec: 6,
    match_level: 'exact',
    embedding_score: 0.9,
    visual_quality_score: 0.8,
    planner_rank: 1,
    reason: 'evidence',
    ...overrides,
  };
}

function external(
  beat_id: string,
  id: string,
  overrides: Partial<ExternalCandidate> = {},
): ExternalCandidate {
  return {
    id,
    beat_id,
    source_id: `ext-${id}`,
    source_path: `enrichment/${id}.mp4`,
    source_in_sec: 0,
    source_out_sec: 6,
    ...overrides,
  };
}

function input(
  beats: NarrationBeatV1[],
  candidates: Record<string, RankedCandidate[]>,
  overrides: Partial<AllocationInput> = {},
): AllocationInput {
  return { beats, candidates, coverageTarget: 0.6, ...overrides };
}

function durationOf(item: { timeline_start_sec: number; timeline_end_sec: number }): number {
  return item.timeline_end_sec - item.timeline_start_sec;
}

testCase('the timeline is gap-free, ordered, and uniquely identified', async () => {
  const beats = [beat('beat-1', 0, 3), beat('beat-2', 3, 7), beat('beat-3', 7, 10)];
  const result = allocateTimeline(
    input(beats, {
      'beat-1': [cand('beat-1', 'source-1', 'scene-a', { source_in_sec: 0, source_out_sec: 4 })],
      'beat-2': [cand('beat-2', 'source-1', 'scene-b', { source_in_sec: 10, source_out_sec: 15 })],
      'beat-3': [cand('beat-3', 'source-2', 'scene-c', { source_in_sec: 0, source_out_sec: 4 })],
    }),
  );
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.ok(result.timeline.length >= 3);
  assert.equal(result.timeline[0]?.timeline_start_sec, 0);
  assert.equal(result.timeline.at(-1)?.timeline_end_sec, 10);
  for (let i = 1; i < result.timeline.length; i += 1) {
    assert.equal(
      result.timeline[i]?.timeline_start_sec,
      result.timeline[i - 1]?.timeline_end_sec,
      `gap or overlap before item ${i}`,
    );
  }
  for (const item of result.timeline) {
    assert.ok(durationOf(item) > 0, 'every item must occupy time');
    assert.ok(
      item.timeline_end_sec - item.timeline_start_sec <=
        item.source_out_sec - item.source_in_sec + EPS,
      'a cut may never outlast the source range it reads from',
    );
  }
  const ids = result.timeline.map((item) => item.item_id);
  assert.equal(new Set(ids).size, ids.length, 'item ids must be unique');
  // Beat order drives timeline order.
  assert.deepEqual(
    [...new Set(result.timeline.map((item) => item.beat_id))],
    ['beat-1', 'beat-2', 'beat-3'],
  );
});

testCase('an exact candidate outranks a better-scored topic_only candidate', async () => {
  const result = allocateTimeline(
    input([beat('beat-1', 0, 3)], {
      'beat-1': [
        cand('beat-1', 'source-1', 'scene-topic', {
          match_level: 'topic_only',
          planner_rank: 1,
          embedding_score: 0.99,
          visual_quality_score: 0.99,
        }),
        cand('beat-1', 'source-1', 'scene-exact', {
          match_level: 'exact',
          planner_rank: 9,
          embedding_score: 0.1,
          visual_quality_score: 0.1,
          source_in_sec: 20,
          source_out_sec: 26,
        }),
      ],
    }),
  );
  assert.equal(result.timeline.length, 1);
  assert.equal(result.timeline[0]?.match_level, 'exact');
  assert.equal(result.timeline[0]?.source_in_sec, 20);
});

testCase('topic_only main cuts are forced to reach the coverage target', async () => {
  const beats = [
    beat('beat-1', 0, 3),
    beat('beat-2', 3, 6),
    beat('beat-3', 6, 9),
    beat('beat-4', 9, 12),
  ];
  const candidates: Record<string, RankedCandidate[]> = {};
  const externals: ExternalCandidate[] = [];
  for (const [n, entry] of beats.entries()) {
    candidates[entry.id] = [
      cand(entry.id, `source-${n}`, 'scene-a', {
        match_level: 'topic_only',
        source_in_sec: 0,
        source_out_sec: 4,
      }),
    ];
    externals.push(external(entry.id, `ext-${n}`));
  }
  const result = allocateTimeline(input(beats, candidates, { externals, coverageTarget: 0.75 }));
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  const forced = result.timeline.filter(
    (item) => item.asset_kind === 'main_cut' && item.match_level === 'topic_only',
  );
  assert.ok(forced.length > 0, 'topic_only main cuts must be forced in when nothing else covers');
  assert.ok(
    result.coverage.actual >= 0.75 - EPS,
    `coverage ${result.coverage.actual} must reach the target`,
  );
  assert.ok(result.warnings.includes('topic_only_match'));
});

testCase('external cuts cannot push the main share below the target', async () => {
  const beats = [
    beat('beat-1', 0, 3),
    beat('beat-2', 3, 6),
    beat('beat-3', 6, 9),
    beat('beat-4', 9, 12),
    beat('beat-5', 12, 15),
  ];
  const candidates: Record<string, RankedCandidate[]> = {};
  const externals: ExternalCandidate[] = [];
  for (const [n, entry] of beats.entries()) {
    candidates[entry.id] = [
      cand(entry.id, `source-${n}`, 'scene-a', {
        match_level: 'topic_only',
        source_in_sec: 0,
        source_out_sec: 4,
      }),
    ];
    externals.push(external(entry.id, `ext-${n}`));
  }
  const result = allocateTimeline(input(beats, candidates, { externals, coverageTarget: 0.6 }));
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  const externalSec = result.timeline
    .filter((item) => item.asset_kind === 'external_cut')
    .reduce((sum, item) => sum + durationOf(item), 0);
  assert.ok(externalSec > 0, 'eligible external b-roll must actually be used');
  assert.ok(externalSec <= 15 * 0.4 + EPS, `external ${externalSec}s exceeded the 40% allowance`);
  assert.ok(result.coverage.actual >= 0.6 - EPS, `coverage ${result.coverage.actual}`);
  assert.equal(result.coverage.main_sec + externalSec, result.coverage.total_sec);
});

testCase('a remote external candidate is never eligible in planned mode', async () => {
  const beats = [beat('beat-1', 0, 3), beat('beat-2', 3, 6), beat('beat-3', 6, 9)];
  const candidates = Object.fromEntries(
    beats.map((entry, n) => [
      entry.id,
      [
        cand(entry.id, `source-${n}`, 'scene-a', {
          match_level: 'topic_only',
          source_in_sec: 0,
          source_out_sec: 4,
        }),
      ],
    ]),
  );
  // Same shape as the accepted case below, but the paths are not job-local artifacts.
  for (const path of ['https://cdn.example/clip.mp4', '/abs/clip.mp4', '../outside/clip.mp4']) {
    const result = allocateTimeline(
      input(beats, candidates, {
        coverageTarget: 0.6,
        externals: beats.map((entry, n) => external(entry.id, `ext-${n}`, { source_path: path })),
      }),
    );
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    assert.equal(
      result.timeline.filter((item) => item.asset_kind === 'external_cut').length,
      0,
      `remote/absolute external path must be ignored: ${path}`,
    );
    assert.equal(result.coverage.actual, 1, 'main candidates cover the slot instead');
  }
  const accepted = allocateTimeline(
    input(beats, candidates, {
      coverageTarget: 0.6,
      externals: beats.map((entry, n) => external(entry.id, `ext-${n}`)),
    }),
  );
  assert.ok(
    accepted.timeline.some((item) => item.asset_kind === 'external_cut'),
    'a job-local external path must remain eligible',
  );
});

testCase('the same source is allowed on separated beats through distinct ranges', async () => {
  const pool = [
    cand('beat-1', 'source-1', 'scene-a', { source_in_sec: 0, source_out_sec: 4 }),
    cand('beat-1', 'source-1', 'scene-b', { source_in_sec: 30, source_out_sec: 34 }),
  ];
  const result = allocateTimeline(
    input([beat('beat-1', 0, 3), beat('beat-2', 3, 6)], {
      'beat-1': pool,
      'beat-2': pool.map((entry) => ({ ...entry, beat_id: 'beat-2' })),
    }),
  );
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.timeline.length, 2);
  assert.deepEqual(
    result.timeline.map((item) => item.source_id),
    ['source-1', 'source-1'],
    'reusing one source across beats is allowed',
  );
  assert.notDeepEqual(
    result.timeline[0]?.source_in_sec,
    result.timeline[1]?.source_in_sec,
    'a fresh range must be preferred over repeating the identical one',
  );
  assert.ok(!result.warnings.includes('exact_scene_reused'));
});

testCase('an identical range inside the eight-second gap is rejected', async () => {
  const only = [cand('beat-1', 'source-1', 'scene-a', { source_in_sec: 0, source_out_sec: 4 })];
  const result = allocateTimeline(
    input([beat('beat-1', 0, 3), beat('beat-2', 3, 6)], {
      'beat-1': only,
      'beat-2': only.map((entry) => ({ ...entry, beat_id: 'beat-2' })),
    }),
  );
  assert.equal(result.error?.code, 'cut_planning_failed');
  assert.equal(result.error?.beat_id, 'beat-2');
  assert.deepEqual(result.timeline, []);
});

testCase('an identical range past the eight-second gap is legal and warns', async () => {
  const reused = cand('beat-1', 'source-1', 'scene-a', { source_in_sec: 0, source_out_sec: 4 });
  const beats = [beat('beat-1', 0, 3), beat('beat-2', 3, 9), beat('beat-3', 9, 12)];
  const result = allocateTimeline(
    input(beats, {
      'beat-1': [reused],
      'beat-2': [
        cand('beat-2', 'source-2', 'scene-filler', { source_in_sec: 0, source_out_sec: 8 }),
      ],
      'beat-3': [{ ...reused, beat_id: 'beat-3' }],
    }),
  );
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  const last = result.timeline.at(-1);
  assert.equal(last?.source_id, 'source-1');
  assert.equal(last?.source_in_sec, 0);
  assert.equal(last?.reuse_count, 1);
  assert.ok(last!.timeline_start_sec - result.timeline[0]!.timeline_start_sec >= MIN_REUSE_GAP_SEC);
  assert.ok(result.warnings.includes('exact_scene_reused'));
});

testCase('a long beat splits into 1.5-6 second cuts at natural bounds', async () => {
  const result = allocateTimeline(
    input([beat('beat-1', 0, 10)], {
      'beat-1': [
        cand('beat-1', 'source-1', 'scene-a', {
          planner_rank: 1,
          source_in_sec: 0,
          source_out_sec: 4,
        }),
        cand('beat-1', 'source-1', 'scene-b', {
          planner_rank: 2,
          source_in_sec: 20,
          source_out_sec: 23,
        }),
        cand('beat-1', 'source-2', 'scene-c', {
          planner_rank: 3,
          source_in_sec: 30,
          source_out_sec: 33,
        }),
      ],
    }),
  );
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.ok(result.timeline.length > 1, 'a 10s beat must not become one stretched cut');
  for (const item of result.timeline) {
    assert.equal(item.beat_id, 'beat-1');
    assert.ok(
      durationOf(item) >= MIN_CUT_SEC - EPS && durationOf(item) <= MAX_CUT_SEC + EPS,
      `cut duration ${durationOf(item)} is outside [${MIN_CUT_SEC}, ${MAX_CUT_SEC}]`,
    );
  }
  assert.deepEqual(
    result.timeline.map((item) => [item.source_in_sec, item.source_out_sec]),
    [
      [0, 4],
      [20, 23],
      [30, 33],
    ],
    'each cut must sit on its own natural scene bounds',
  );
  assert.deepEqual(
    result.timeline.map((item) => [item.timeline_start_sec, item.timeline_end_sec]),
    [
      [0, 4],
      [4, 7],
      [7, 10],
    ],
  );
});

testCase('no single cut may exceed the maximum cut length', async () => {
  // Both scenes are long enough to swallow the whole beat, so only the cut ceiling can
  // stop this beat from becoming one 10-second stare.
  const result = allocateTimeline(
    input([beat('beat-1', 0, 10)], {
      'beat-1': [
        cand('beat-1', 'source-1', 'scene-a', {
          planner_rank: 1,
          source_in_sec: 0,
          source_out_sec: 20,
        }),
        cand('beat-1', 'source-1', 'scene-b', {
          planner_rank: 2,
          source_in_sec: 30,
          source_out_sec: 50,
        }),
      ],
    }),
  );
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.ok(result.timeline.length > 1, 'one long scene must not stretch across the whole beat');
  for (const item of result.timeline) {
    assert.ok(
      durationOf(item) <= MAX_CUT_SEC + EPS,
      `cut duration ${durationOf(item)} exceeded ${MAX_CUT_SEC}`,
    );
  }
  assert.deepEqual(
    result.timeline.map((item) => [item.timeline_start_sec, item.timeline_end_sec]),
    [
      [0, 6],
      [6, 10],
    ],
  );
});

testCase('a beat that would leave a sub-minimum tail is rebalanced', async () => {
  // 7s against a 6s ceiling naively leaves a 1s stub. The split must borrow from the first
  // cut instead of emitting a flicker.
  const result = allocateTimeline(
    input([beat('beat-1', 0, 7)], {
      'beat-1': [
        cand('beat-1', 'source-1', 'scene-a', {
          planner_rank: 1,
          source_in_sec: 0,
          source_out_sec: 20,
        }),
        cand('beat-1', 'source-1', 'scene-b', {
          planner_rank: 2,
          source_in_sec: 30,
          source_out_sec: 50,
        }),
      ],
    }),
  );
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  for (const item of result.timeline) {
    assert.ok(
      durationOf(item) >= MIN_CUT_SEC - EPS,
      `cut duration ${durationOf(item)} is below ${MIN_CUT_SEC}`,
    );
  }
  assert.deepEqual(
    result.timeline.map((item) => [item.timeline_start_sec, item.timeline_end_sec]),
    [
      [0, 5.5],
      [5.5, 7],
    ],
  );
});

testCase('off-topic, empty, and broken candidates are excluded', async () => {
  const good = cand('beat-1', 'source-9', 'scene-good', { source_in_sec: 5, source_out_sec: 11 });
  const result = allocateTimeline(
    input([beat('beat-1', 0, 3)], {
      'beat-1': [
        cand('beat-1', 'source-1', 'scene-offtopic', {
          match_level: 'off_topic' as MatchLevel,
          planner_rank: 0,
        }),
        cand('beat-1', 'source-2', 'scene-empty', { source_in_sec: 4, source_out_sec: 4 }),
        cand('beat-1', 'source-3', 'scene-inverted', { source_in_sec: 9, source_out_sec: 2 }),
        cand('beat-1', 'source-4', 'scene-nan', {
          source_in_sec: Number.NaN,
          source_out_sec: 5,
        }),
        cand('beat-1', '', 'scene-nosource'),
        cand('beat-1', 'source-6', ''),
        cand('other-beat', 'source-7', 'scene-wrongbeat'),
        good,
      ],
    }),
  );
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.timeline.length, 1);
  assert.equal(result.timeline[0]?.source_id, 'source-9');
  assert.equal(result.candidate_count, 1, 'only usable candidates are counted');
});

testCase('output is stable regardless of input iteration order', async () => {
  const beats = [beat('beat-1', 0, 3), beat('beat-2', 3, 7), beat('beat-3', 7, 10)];
  const pools: Record<string, RankedCandidate[]> = {
    'beat-1': [
      cand('beat-1', 'source-1', 'scene-a', { planner_rank: 1, source_out_sec: 4 }),
      cand('beat-1', 'source-1', 'scene-b', {
        planner_rank: 2,
        source_in_sec: 8,
        source_out_sec: 12,
      }),
    ],
    'beat-2': [
      cand('beat-2', 'source-2', 'scene-c', { planner_rank: 1, source_out_sec: 5 }),
      cand('beat-2', 'source-2', 'scene-d', {
        planner_rank: 2,
        source_in_sec: 9,
        source_out_sec: 14,
      }),
    ],
    'beat-3': [
      cand('beat-3', 'source-3', 'scene-e', { planner_rank: 1, source_out_sec: 4 }),
      cand('beat-3', 'source-3', 'scene-f', {
        planner_rank: 2,
        source_in_sec: 8,
        source_out_sec: 12,
      }),
    ],
  };
  const forward = allocateTimeline(input(beats, pools));
  const reversedMap = new Map<string, RankedCandidate[]>();
  for (const entry of [...beats].reverse()) {
    reversedMap.set(entry.id, [...pools[entry.id]!].reverse());
  }
  const shuffled = allocateTimeline({
    beats,
    candidates: reversedMap,
    coverageTarget: 0.6,
  });
  assert.equal(JSON.stringify(shuffled), JSON.stringify(forward));
  // And re-running the identical input serializes byte-identically.
  assert.equal(JSON.stringify(allocateTimeline(input(beats, pools))), JSON.stringify(forward));
});

testCase('an affected-beat replan leaves every other item unchanged', async () => {
  const beats = [beat('beat-1', 0, 3), beat('beat-2', 3, 7), beat('beat-3', 7, 10)];
  const beat2Pool = [
    cand('beat-2', 'source-2', 'scene-c', { planner_rank: 1, source_in_sec: 0, source_out_sec: 5 }),
    cand('beat-2', 'source-2', 'scene-d', {
      planner_rank: 2,
      source_in_sec: 9,
      source_out_sec: 14,
    }),
  ];
  const prior = allocateTimeline(
    input(beats, {
      'beat-1': [cand('beat-1', 'source-1', 'scene-a', { source_in_sec: 0, source_out_sec: 4 })],
      'beat-2': beat2Pool,
      'beat-3': [cand('beat-3', 'source-3', 'scene-e', { source_in_sec: 0, source_out_sec: 4 })],
    }),
  );
  assert.equal(prior.error, undefined, JSON.stringify(prior.error));
  const failed = prior.timeline.find((item) => item.beat_id === 'beat-2');
  assert.ok(failed, 'beat-2 must have produced an item');
  const replanned = reallocateBeat(prior, failed.item_id, beat2Pool);
  assert.equal(replanned.error, undefined, JSON.stringify(replanned.error));
  assert.deepEqual(
    replanned.timeline.filter((item) => item.beat_id !== 'beat-2'),
    prior.timeline.filter((item) => item.beat_id !== 'beat-2'),
    'items outside the affected beat must be byte-identical',
  );
  const replacement = replanned.timeline.filter((item) => item.beat_id === 'beat-2');
  assert.equal(replacement.length, 1);
  assert.equal(replacement[0]?.timeline_start_sec, failed.timeline_start_sec);
  assert.equal(replacement[0]?.timeline_end_sec, failed.timeline_end_sec);
  assert.notEqual(
    replacement[0]?.source_in_sec,
    failed.source_in_sec,
    'the failed candidate range is banned for this plan attempt',
  );
  // The whole timeline is still gap-free and ordered.
  for (let i = 1; i < replanned.timeline.length; i += 1) {
    assert.equal(
      replanned.timeline[i]?.timeline_start_sec,
      replanned.timeline[i - 1]?.timeline_end_sec,
    );
  }
});

testCase('an exhausted replan reports cut_materialization_exhausted with safe ids', async () => {
  const beats = [beat('beat-1', 0, 3)];
  const pool = [cand('beat-1', 'source-1', 'scene-a', { source_in_sec: 0, source_out_sec: 4 })];
  const prior = allocateTimeline(input(beats, { 'beat-1': pool }));
  const failed = prior.timeline[0];
  assert.ok(failed);
  const replanned = reallocateBeat(prior, failed.item_id, pool);
  assert.equal(replanned.error?.code, 'cut_materialization_exhausted');
  assert.equal(replanned.error?.beat_id, 'beat-1');
  assert.equal(replanned.error?.item_id, failed.item_id);
  const wire = JSON.stringify(replanned.error);
  assert.ok(!wire.includes('/') && !wire.includes('\\'), `no paths may leak: ${wire}`);
  assert.ok(!wire.includes('narration for'), `no raw beat text may leak: ${wire}`);
});

testCase('a beat with no usable candidate fails planning with its beat id', async () => {
  const result = allocateTimeline(
    input([beat('beat-1', 0, 3), beat('beat-2', 3, 6)], {
      'beat-1': [cand('beat-1', 'source-1', 'scene-a', { source_in_sec: 0, source_out_sec: 4 })],
      'beat-2': [],
    }),
  );
  assert.equal(result.error?.code, 'cut_planning_failed');
  assert.equal(result.error?.beat_id, 'beat-2');
  assert.equal(result.error?.item_id, undefined);
  assert.deepEqual(result.timeline, []);
});

for (const [name, run] of cases) {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

console.log('ok allocator');
