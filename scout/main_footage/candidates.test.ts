import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CandidateDeps,
  CandidatePolicy,
  PlannerRanking,
  ShortlistEntry,
} from './candidates.ts';
import {
  buildBeatCandidates,
  candidateId,
  fileEmbeddingLoader,
  MAX_EVIDENCE_CHARS,
  MAX_REASON_CHARS,
} from './candidates.ts';
import type { NarrationBeatV1, SceneEvidenceV1, SceneIndexV1 } from './contracts.ts';

const cases: Array<[string, () => Promise<void>]> = [];
function testCase(name: string, fn: () => Promise<void>): void {
  cases.push([name, fn]);
}

const beat: NarrationBeatV1 = {
  id: 'beat-1',
  start_sec: 0,
  end_sec: 3,
  text: 'the excavator lifts the concrete slab',
};

const PACKAGE_TOPIC = 'excavator construction site';

function scene(id: string, overrides: Partial<SceneEvidenceV1> = {}): SceneEvidenceV1 {
  return {
    id,
    start_sec: 0,
    end_sec: 2,
    representative_frame: `scene-index/source-1/key/v001/frames/${id}-mid.jpg`,
    transcript_evidence: '(no speech detected)',
    visual_metrics: { motion_score: 0.5, brightness: 0.5, scene_change_score: 0.5 },
    ...overrides,
  };
}

function index(
  source_id: string,
  scenes: SceneEvidenceV1[],
  planning_mode: SceneIndexV1['planning_mode'] = 'vision',
): SceneIndexV1 {
  return {
    source_id,
    path: `scene-index/${source_id}/key/v001/index.json`,
    checksum: `sha256:${source_id}`,
    planning_mode,
    scenes,
  };
}

function vision(text: string): string {
  return JSON.stringify({
    subject: text,
    action: '',
    setting: '',
    composition: '',
    motion: '',
    topic: '',
  });
}

const policy: CandidatePolicy = {
  maxCandidatesPerBeat: 5,
  embeddingTopK: 5,
  packageTopic: PACKAGE_TOPIC,
};

function makeDeps(
  overrides: Partial<CandidateDeps> = {},
  embeddings: Record<string, number[]> = {},
): CandidateDeps {
  return {
    embedText: async () => [1, 0],
    loadEmbedding: async (evidence: SceneEvidenceV1) => embeddings[evidence.id] ?? null,
    rankShortlist: async () => [],
    ...overrides,
  };
}

testCase('direct visual evidence yields exact', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', { vision_description: vision('an excavator lifting a concrete slab') }),
    ]),
  ];
  const ranked = await buildBeatCandidates(beat, scenes, policy, makeDeps());
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.match_level, 'exact');
  assert.equal(ranked[0]?.beat_id, 'beat-1');
  assert.equal(ranked[0]?.scene_id, 'scene-0001');
  assert.equal(ranked[0]?.source_id, 'source-1');
});

testCase('direct transcript evidence yields exact', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', { transcript_evidence: 'watch the excavator lift that slab' }),
    ]),
  ];
  const ranked = await buildBeatCandidates(beat, scenes, policy, makeDeps());
  assert.equal(ranked[0]?.match_level, 'exact');
});

testCase('shared package topic yields topic_only', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', {
        vision_description: vision('heavy machinery at the construction site'),
      }),
    ]),
  ];
  const ranked = await buildBeatCandidates(beat, scenes, policy, makeDeps());
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.match_level, 'topic_only');
});

testCase('unrelated evidence is excluded', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', { vision_description: vision('a cat sleeping on a sofa') }),
    ]),
  ];
  assert.deepEqual(await buildBeatCandidates(beat, scenes, policy, makeDeps()), []);
});

testCase('embeddings pass only the configured top-K', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', {
        vision_description: vision('excavator slab close up'),
        embedding_path: 'scene-index/source-1/key/v001/embeddings/scene-0001.json',
      }),
      scene('scene-0002', {
        vision_description: vision('excavator slab wide shot'),
        embedding_path: 'scene-index/source-1/key/v001/embeddings/scene-0002.json',
      }),
      scene('scene-0003', {
        vision_description: vision('excavator slab from behind'),
        embedding_path: 'scene-index/source-1/key/v001/embeddings/scene-0003.json',
      }),
    ]),
  ];
  const deps = makeDeps(
    {},
    {
      'scene-0001': [1, 0],
      'scene-0002': [1, 1],
      'scene-0003': [0, 1],
    },
  );
  const ranked = await buildBeatCandidates(beat, scenes, { ...policy, embeddingTopK: 2 }, deps);
  assert.deepEqual(
    ranked.map((candidate) => candidate.scene_id),
    ['scene-0001', 'scene-0002'],
  );
});

testCase('shortlist is bounded by maxCandidatesPerBeat', async () => {
  const scenes = [
    index(
      'source-1',
      [1, 2, 3, 4].map((n) =>
        scene(`scene-000${n}`, { vision_description: vision(`excavator slab take ${n}`) }),
      ),
    ),
  ];
  const ranked = await buildBeatCandidates(
    beat,
    scenes,
    { ...policy, maxCandidatesPerBeat: 2 },
    makeDeps(),
  );
  assert.equal(ranked.length, 2);
});

testCase('degraded scenes remain eligible on transcript and local evidence', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', {
        vision_description: vision('excavator slab close up'),
        embedding_path: 'scene-index/source-1/key/v001/embeddings/scene-0001.json',
      }),
    ]),
    index(
      'source-2',
      [scene('scene-0009', { transcript_evidence: 'the excavator drops the slab' })],
      'degraded',
    ),
  ];
  const deps = makeDeps({}, { 'scene-0001': [1, 0] });
  const ranked = await buildBeatCandidates(beat, scenes, { ...policy, embeddingTopK: 1 }, deps);
  assert.deepEqual(
    ranked.map((candidate) => candidate.source_id).sort(),
    ['source-1', 'source-2'],
    'an embedding-less degraded scene must survive the top-K embedding cut',
  );
  const degraded = ranked.find((candidate) => candidate.source_id === 'source-2');
  assert.equal(degraded?.match_level, 'exact');
  assert.equal(degraded?.embedding_score, 0);
});

testCase('planner ranking reorders known candidate ids', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', {
        vision_description: vision('excavator slab close up'),
        embedding_path: 'a.json',
      }),
      scene('scene-0002', {
        vision_description: vision('excavator slab wide shot'),
        embedding_path: 'b.json',
      }),
    ]),
  ];
  const deps = makeDeps(
    {
      rankShortlist: async () => [
        { candidate_id: candidateId('source-1', 'scene-0002'), reason: 'better framing' },
        { candidate_id: candidateId('source-1', 'scene-0001') },
      ],
    },
    { 'scene-0001': [1, 0], 'scene-0002': [1, 1] },
  );
  const ranked = await buildBeatCandidates(beat, scenes, policy, deps);
  assert.deepEqual(
    ranked.map((candidate) => candidate.scene_id),
    ['scene-0002', 'scene-0001'],
  );
  assert.deepEqual(
    ranked.map((candidate) => candidate.planner_rank),
    [1, 2],
  );
  assert.equal(ranked[0]?.reason, 'better framing');
});

testCase('unknown planner candidate id falls back to deterministic order', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', {
        vision_description: vision('excavator slab close up'),
        embedding_path: 'a.json',
      }),
      scene('scene-0002', {
        vision_description: vision('excavator slab wide shot'),
        embedding_path: 'b.json',
      }),
    ]),
  ];
  const deps = makeDeps(
    {
      rankShortlist: async () => [
        { candidate_id: candidateId('source-9', 'scene-9999') },
        { candidate_id: candidateId('source-1', 'scene-0002') },
      ],
    },
    { 'scene-0001': [1, 0], 'scene-0002': [1, 1] },
  );
  const ranked = await buildBeatCandidates(beat, scenes, policy, deps);
  assert.deepEqual(
    ranked.map((candidate) => candidate.scene_id),
    ['scene-0001', 'scene-0002'],
  );
});

testCase('duplicate planner candidate id falls back to deterministic order', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', {
        vision_description: vision('excavator slab close up'),
        embedding_path: 'a.json',
      }),
      scene('scene-0002', {
        vision_description: vision('excavator slab wide shot'),
        embedding_path: 'b.json',
      }),
    ]),
  ];
  const duplicate = candidateId('source-1', 'scene-0002');
  const deps = makeDeps(
    { rankShortlist: async () => [{ candidate_id: duplicate }, { candidate_id: duplicate }] },
    { 'scene-0001': [1, 0], 'scene-0002': [1, 1] },
  );
  const ranked = await buildBeatCandidates(beat, scenes, policy, deps);
  assert.deepEqual(
    ranked.map((candidate) => candidate.scene_id),
    ['scene-0001', 'scene-0002'],
  );
});

testCase('malformed planner output falls back to deterministic order', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', {
        vision_description: vision('excavator slab close up'),
        embedding_path: 'a.json',
      }),
      scene('scene-0002', {
        vision_description: vision('excavator slab wide shot'),
        embedding_path: 'b.json',
      }),
    ]),
  ];
  const embeddings = { 'scene-0001': [1, 0], 'scene-0002': [1, 1] };
  for (const malformed of [
    async () => 'not an array' as unknown as PlannerRanking[],
    async () => [{ nope: true }] as unknown as PlannerRanking[],
    async () => {
      throw new Error('planner exploded');
    },
    // One bad entry poisons the whole ranking — the guard rejects, it does not skip.
    // Were it `continue`, the surviving scene-0002 reference would order this
    // ['scene-0002', 'scene-0001'] instead.
    async () =>
      [
        { candidate_id: candidateId('source-1', 'scene-0002') },
        { nope: true },
      ] as unknown as PlannerRanking[],
  ]) {
    const ranked = await buildBeatCandidates(
      beat,
      scenes,
      policy,
      makeDeps({ rankShortlist: malformed as CandidateDeps['rankShortlist'] }, embeddings),
    );
    assert.deepEqual(
      ranked.map((candidate) => candidate.scene_id),
      ['scene-0001', 'scene-0002'],
    );
  }

  // Same partial reference, this time well-formed: it IS honoured, and the candidate the
  // planner never named is appended rather than dropped.
  const partial = await buildBeatCandidates(
    beat,
    scenes,
    policy,
    makeDeps(
      { rankShortlist: async () => [{ candidate_id: candidateId('source-1', 'scene-0002') }] },
      embeddings,
    ),
  );
  assert.deepEqual(
    partial.map((candidate) => candidate.scene_id),
    ['scene-0002', 'scene-0001'],
  );
  assert.deepEqual(
    partial.map((candidate) => candidate.planner_rank),
    [1, 2],
  );
});

testCase('planner cannot invent timecodes, paths, or sources', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', {
        start_sec: 4,
        end_sec: 9,
        vision_description: vision('excavator slab close up'),
      }),
    ]),
  ];
  const deps = makeDeps({
    rankShortlist: async () =>
      [
        {
          candidate_id: candidateId('source-1', 'scene-0001'),
          source_in_sec: 999,
          source_out_sec: 1000,
          source_id: 'source-evil',
          cut_path: '../../etc/passwd',
          transition: { kind: 'wipe' },
        },
      ] as unknown as PlannerRanking[],
  });
  const ranked = await buildBeatCandidates(beat, scenes, policy, deps);
  assert.equal(ranked.length, 1);
  assert.deepEqual(Object.keys(ranked[0] ?? {}).sort(), [
    'beat_id',
    'embedding_score',
    'match_level',
    'planner_rank',
    'reason',
    'scene_id',
    'source_id',
    'source_in_sec',
    'source_out_sec',
    'visual_quality_score',
  ]);
  assert.equal(ranked[0]?.source_id, 'source-1');
  assert.equal(ranked[0]?.source_in_sec, 4);
  assert.equal(ranked[0]?.source_out_sec, 9);
});

testCase('planner reasons are normalized to bounded plain text', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', { vision_description: vision('excavator slab close up') }),
    ]),
  ];
  const deps = makeDeps({
    rankShortlist: async () => [
      {
        candidate_id: candidateId('source-1', 'scene-0001'),
        reason: `\u0000raw\tprovider\n\n  payload  ${'x'.repeat(5000)}`,
      },
    ],
  });
  const reason = (await buildBeatCandidates(beat, scenes, policy, deps))[0]?.reason ?? '';
  assert.ok(
    reason.length > 0 && reason.length <= MAX_REASON_CHARS,
    `reason length ${reason.length}`,
  );
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they are stripped
  assert.ok(!/[\u0000-\u001f\u007f]/.test(reason), 'reason must not carry control characters');
  assert.match(reason, /^raw provider payload x+$/);
});

testCase('an empty planner reason falls back to a deterministic reason', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', { vision_description: vision('excavator slab close up') }),
    ]),
  ];
  const deps = makeDeps({
    rankShortlist: async () => [
      { candidate_id: candidateId('source-1', 'scene-0001'), reason: '     ' },
    ],
  });
  const ranked = await buildBeatCandidates(beat, scenes, policy, deps);
  assert.match(ranked[0]?.reason ?? '', /exact/);
});

testCase('candidate scores are deterministic and bounded', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', {
        vision_description: vision('excavator slab close up'),
        embedding_path: 'a.json',
        visual_metrics: { motion_score: 1, brightness: 0.5, scene_change_score: 0.2 },
      }),
    ]),
  ];
  const deps = makeDeps({}, { 'scene-0001': [1, 0] });
  const first = await buildBeatCandidates(beat, scenes, policy, deps);
  const second = await buildBeatCandidates(beat, scenes, policy, deps);
  assert.deepEqual(first, second);
  assert.equal(first[0]?.embedding_score, 1);
  assert.equal(first[0]?.visual_quality_score, 1);
});

/** Real package root on disk: fileEmbeddingLoader is the one dep that must touch the FS. */
async function withPackageRoot(
  run: (root: string, outside: string) => Promise<void>,
): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'candidates-'));
  const root = path.join(base, 'package');
  fs.mkdirSync(root);
  try {
    await run(root, base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

testCase('the file embedding loader refuses a path outside the package root', async () => {
  await withPackageRoot(async (root, outside) => {
    // A well-formed vector: a null result can only mean the read never happened.
    fs.writeFileSync(path.join(outside, 'outside.json'), '[1, 0]');
    const load = fileEmbeddingLoader(root);
    assert.equal(await load(scene('scene-0001', { embedding_path: '../outside.json' })), null);
  });
});

testCase('the file embedding loader rejects malformed vectors', async () => {
  await withPackageRoot(async (root) => {
    const load = fileEmbeddingLoader(root);
    const malformed: Array<[string, string]> = [
      ['object.json', '{"0": 1}'],
      ['mixed.json', '[1, "x"]'],
      ['infinite.json', '[1, 1e999]'],
    ];
    for (const [name, body] of malformed) {
      fs.writeFileSync(path.join(root, name), body);
      assert.equal(await load(scene('scene-0001', { embedding_path: name })), null, name);
    }
  });
});

testCase('the file embedding loader returns the published vector', async () => {
  await withPackageRoot(async (root) => {
    fs.mkdirSync(path.join(root, 'embeddings'));
    fs.writeFileSync(path.join(root, 'embeddings', 'scene-0001.json'), '[1, 0, -0.5]');
    const load = fileEmbeddingLoader(root);
    assert.deepEqual(
      await load(scene('scene-0001', { embedding_path: 'embeddings/scene-0001.json' })),
      [1, 0, -0.5],
    );
  });
});

testCase('the planner sees only the shortlist projection', async () => {
  const scenes = [
    index('source-1', [
      scene('scene-0001', {
        start_sec: 137,
        end_sec: 149,
        vision_description: vision('excavator slab close up'),
      }),
    ]),
  ];
  const seen: ShortlistEntry[][] = [];
  const deps = makeDeps({
    rankShortlist: async (_beat, shortlist) => {
      seen.push(shortlist);
      return [];
    },
  });
  await buildBeatCandidates(beat, scenes, policy, deps);
  assert.equal(seen.length, 1, 'the planner must be called once');
  assert.equal(seen[0]?.length, 1);
  for (const entry of seen[0] ?? []) {
    assert.deepEqual(Object.keys(entry).sort(), [
      'candidate_id',
      'embedding_score',
      'evidence',
      'match_level',
      'visual_quality_score',
    ]);
  }
  const wire = JSON.stringify(seen[0]);
  assert.ok(!wire.includes('frames/'), `frame paths must not reach the planner: ${wire}`);
  assert.ok(!wire.includes('137'), `scene timecodes must not reach the planner: ${wire}`);
  assert.ok(!wire.includes('149'), `scene timecodes must not reach the planner: ${wire}`);
});

for (const [name, run] of cases) {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

console.log('ok candidates');
