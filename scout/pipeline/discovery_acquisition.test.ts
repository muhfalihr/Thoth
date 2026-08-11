// scout/pipeline/discovery_acquisition.test.ts
import assert from 'node:assert/strict';
import { mapDiscoveryPosts } from './discover_reels.ts';

const rows = mapDiscoveryPosts('curator', [
  {
    canonical_url: 'https://www.instagram.com/reel/ABC/',
    platform: 'instagram',
    post_id: 'ABC',
    owner_handle: 'curator',
    text: 'topic caption',
    published_at: '2026-08-02T00:00:00.000Z',
    engagement: { views: 1200 },
    media: [
      {
        id: 'ABC:1',
        kind: 'video',
        index: 1,
        canonical_post_url: 'https://www.instagram.com/reel/ABC/',
      },
    ],
    outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 1 },
  },
] as any);
assert.deepEqual(rows[0], {
  account: 'curator',
  kind: 'reel',
  url: 'https://www.instagram.com/reel/ABC/',
  views: '1200',
  time: '2026-08-02T00:00:00.000Z',
  caption: 'topic caption',
});
console.log('ok discovery_acquisition');
