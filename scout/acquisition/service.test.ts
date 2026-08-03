import assert from 'node:assert/strict';
import { AcquisitionService } from './service.ts';
import { AcquisitionError } from './types.ts';

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
    const hasMedia = url.includes('/p/XYZ/');
    return {
      canonical_url: url,
      platform: 'instagram' as const,
      post_id: hasMedia ? 'XYZ' : 'ABC',
      owner_handle: 'owner',
      text: 'caption',
      media: hasMedia
        ? [{ id: 'm1', kind: 'image' as const, index: 0, canonical_post_url: url }]
        : [],
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

// Regression: hostnameOf() must not echo raw caller input into the thrown
// error when the URL is unparseable. Only a fixed placeholder may appear.
const marker = 'MARKER-9f3c2b1a-do-not-leak';
const malformedUrl = `not a valid url ::: ${marker}`;
let malformedError: unknown;
try {
  await service.inspectPost(malformedUrl);
  assert.fail('expected inspectPost to reject for a malformed url');
} catch (error) {
  malformedError = error;
}
assert.ok(malformedError instanceof AcquisitionError);
assert.match((malformedError as AcquisitionError).message, /unsupported platform/i);
assert.ok(!(malformedError as AcquisitionError).message.includes(marker));
assert.ok(!JSON.stringify((malformedError as AcquisitionError).outcome).includes(marker));

// Regression: withCacheSource() must deep-clone so a caller mutating a
// cached PostRecord's nested fields (media[]) cannot corrupt the value
// held in cache.runValues / the live durable record.
const urlWithMedia = 'https://www.instagram.com/p/XYZ/';
service.registerIntent(urlWithMedia, 'inspect');
await service.inspectPost(urlWithMedia); // populates cache.runValues
const cachedWithMedia = await service.inspectPost(urlWithMedia); // cache hit -> cloned
assert.equal(cachedWithMedia.outcome.source, 'cache');
assert.equal(cachedWithMedia.media.length, 1);
cachedWithMedia.media[0]!.id = 'TAMPERED-ID';
cachedWithMedia.media.push({
  id: 'INJECTED',
  kind: 'image',
  index: 99,
  canonical_post_url: 'tampered',
});
const cachedWithMediaAgain = await service.inspectPost(urlWithMedia);
assert.equal(cachedWithMediaAgain.media.length, 1);
assert.equal(cachedWithMediaAgain.media[0]!.id, 'm1');

console.log('ok acquisition_service');
