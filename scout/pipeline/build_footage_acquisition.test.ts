import assert from 'node:assert/strict';
import { admitAndMaterializeFootage, shouldSkipForcedCarouselPool } from './build_footage.ts';

let materialized = 0;
const rejected = await admitAndMaterializeFootage(
  {
    canonical_url: 'https://x.com/owner/status/1',
    platform: 'twitter',
    post_id: '1',
    owner_handle: 'owner',
    text: 'unrelated advertisement',
    media: [
      { id: '1:1', kind: 'image', index: 1, canonical_post_url: 'https://x.com/owner/status/1' },
    ],
    outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 1 },
  } as any,
  {
    query: 'specific event',
    isRelevant: () => false,
    isMain: () => false,
    looksReaction: () => false,
    materialize: async () => {
      materialized++;
      throw new Error('must not run');
    },
  },
);
assert.equal(rejected.status, 'rejected');
assert.equal(materialized, 0);

// Non-vacuity: prove the accepted path IS exercised and DOES materialize, so "never
// materializes" above isn't trivially true for an unrelated reason (e.g. a broken import).
let acceptedMaterialized = 0;
const accepted = await admitAndMaterializeFootage(
  {
    canonical_url: 'https://x.com/owner/status/2',
    platform: 'twitter',
    post_id: '2',
    owner_handle: 'owner',
    text: 'specific event unfolds downtown',
    media: [
      { id: '2:1', kind: 'image', index: 1, canonical_post_url: 'https://x.com/owner/status/2' },
    ],
    outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 1 },
  } as any,
  {
    query: 'specific event',
    isRelevant: () => true,
    isMain: () => false,
    looksReaction: () => false,
    materialize: async () => {
      acceptedMaterialized++;
      return { path: '/tmp/footage-2.jpg', kind: 'image', source: 'direct-http', bytes: 123 };
    },
  },
);
assert.equal(accepted.status, 'accepted');
assert.equal(acceptedMaterialized, 1);
if (accepted.status === 'accepted') {
  assert.equal(accepted.entry.image_path, '/tmp/footage-2.jpg');
}

assert.equal(
  shouldSkipForcedCarouselPool({ platform: 'instagram', url: 'https://www.instagram.com/p/forced/' }, ['forced:1']),
  true,
  'authoritative forced media must not return as carousel enrichment',
);
assert.equal(
  shouldSkipForcedCarouselPool({ platform: 'instagram', url: 'https://www.instagram.com/p/legacy/' }, []),
  false,
  'legacy carousel behavior remains available',
);

console.log('ok build_footage_acquisition');
