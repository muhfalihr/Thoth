// scout/pipeline/trace_source.test.ts
// Regression for FIX 1: profile-discovery PostRecords always have media: [] (adapters don't
// populate media there), so isVideo must not be derived from record.media in that path.
import assert from 'node:assert/strict';
import { candidateFromDiscovery, findOriginalInstagramCandidates } from './trace_source.ts';
import type { PostRecord } from '../acquisition/index.ts';

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
const candidate = candidateFromDiscovery(profileRecord(), 'somecreator');
assert.equal(candidate.isVideo, true, 'candidateFromDiscovery must mark profile-discovery posts as video');

// findOriginalInstagramCandidates must actually return candidates for an account with reels.
const context = {
  runId: 'test',
  service: {
    discover: async () => ({
      items: [profileRecord(), profileRecord({ canonical_url: 'https://www.instagram.com/reel/def456/', post_id: 'def456' })],
      outcome: { status: 'resolved', attempts: 1, elapsed_ms: 1 },
    }),
  },
} as any;

const candidates = await findOriginalInstagramCandidates('somecreator', context);
assert.equal(candidates.length, 2, 'findOriginalInstagramCandidates must return a non-empty list for an account with reels');
assert.ok(candidates.every((c) => c.isVideo === true));

console.log('trace_source.test.ts OK');
