import assert from 'node:assert/strict';
import { AcquisitionService } from './service.ts';

let inspections = 0;
const fakeAdapter = {
  platform: 'instagram' as const,
  supports: (url: string) => url.includes('instagram.com'),
  discover: async () => ({
    items: [],
    outcome: {
      status: 'resolved' as const,
      source: 'network' as const,
      attempts: 1,
      elapsed_ms: 1,
    },
  }),
  inspect: async (url: string) => {
    inspections++;
    return {
      canonical_url: url,
      platform: 'instagram' as const,
      post_id: 'ABC',
      owner_handle: 'owner',
      text: 'caption',
      media: [],
      outcome: {
        status: 'resolved' as const,
        source: 'network' as const,
        attempts: 1,
        elapsed_ms: 1,
      },
    };
  },
  collectComments: async () => [],
  captureSocialCard: async () => ({
    path: 'card.png',
    kind: 'social-card' as const,
    source: 'dom' as const,
    bytes: 4,
  }),
};

const service = AcquisitionService.createForTest({ adapters: [fakeAdapter] });
const url = 'https://www.instagram.com/p/ABC/?utm_source=test';
service.registerIntent(url, 'inspect');
const [first, second] = await Promise.all([service.inspectPost(url), service.inspectPost(url)]);
assert.equal(first.canonical_url, 'https://www.instagram.com/p/ABC/');
assert.equal(second.post_id, 'ABC');
assert.equal(inspections, 1);
const cached = await service.inspectPost(url);
assert.equal(cached.outcome.source, 'cache');
assert.equal(inspections, 1);
await assert.rejects(service.inspectPost('https://example.com/post/1'), /unsupported platform/i);
console.log('ok acquisition_service');
