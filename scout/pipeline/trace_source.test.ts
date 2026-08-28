// scout/pipeline/trace_source.test.ts
// Regression for FIX 1: profile-discovery PostRecords always have media: [] (adapters don't
// populate media there), so isVideo must not be derived from record.media in that path.
import assert from 'node:assert/strict';
import type { PostRecord } from '../acquisition/index.ts';
import { candidateFromDiscovery, findOriginalInstagramCandidates } from './trace_source.ts';

function profileRecord(overrides: Partial<PostRecord> = {}): PostRecord {
  return {
    canonical_url: 'https://www.instagram.com/reel/abc123/',
    platform: 'instagram',
    post_id: 'abc123',
    owner_handle: 'somecreator',
    text: 'a reel',
    media: [], // profile-discovery PostRecords never populate media
    outcome: { status: 'resolved', attempts: 1, elapsed_ms: 1 },
    ...overrides,
  };
}

// candidateFromDiscovery must treat profile-discovery records as video even though media is empty.
const candidate = candidateFromDiscovery(profileRecord({ engagement: { views: 78000 } }), 'somecreator');
assert.equal(
  candidate.isVideo,
  true,
  'candidateFromDiscovery must mark profile-discovery posts as video',
);
assert.equal(candidate.views, 78000, 'candidateFromDiscovery must preserve discovered view counts');

const tiktokCandidate = candidateFromDiscovery(
  profileRecord({
    canonical_url: 'https://www.tiktok.com/@vincentius.christ76/video/7677137235434687752',
    platform: 'tiktok',
  }),
  'vincentius.christ76',
);
assert.equal(
  tiktokCandidate.publishedAt,
  1787472803,
  'TikTok profile discovery must infer a source time when the extractor provides none',
);

// findOriginalInstagramCandidates must actually return candidates for an account with reels.
const context = {
  runId: 'test',
  service: {
    discover: async () => ({
      items: [
        profileRecord(),
        profileRecord({
          canonical_url: 'https://www.instagram.com/reel/def456/',
          post_id: 'def456',
        }),
      ],
      outcome: { status: 'resolved', attempts: 1, elapsed_ms: 1 },
    }),
  },
} as any;

const candidates = await findOriginalInstagramCandidates('somecreator', context);
assert.equal(
  candidates.length,
  2,
  'findOriginalInstagramCandidates must return a non-empty list for an account with reels',
);
assert.ok(candidates.every((c) => c.isVideo === true));

console.log('trace_source.test.ts OK');
