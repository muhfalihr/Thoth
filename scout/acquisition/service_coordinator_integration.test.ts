// Integration: AcquisitionService driven through a REAL BrowserCoordinator.
//
// Every other test in this suite either drives the coordinator directly with synthetic
// URLs, or drives a pipeline stage against a hand-written fake service. Nothing covered
// the seam between them — so three separate defects shipped in which one pipeline stage
// inspected a URL and a second stage's browse() of that SAME URL was refused by the
// coordinator, losing the seed post's comments and all Instagram curator discovery. Both
// callers sit in required:false stages, so the failures were silent.
//
// This test reproduces the real sequence: inspect a post, then perform the other browser
// operations the pipeline performs on that same post.
import assert from 'node:assert/strict';
import type { AdapterContext, CdpClient, PlatformAdapter } from './types.ts';
import { BrowserCoordinator } from './browser_coordinator.ts';
import { AcquisitionError } from './types.ts';
import { AcquisitionService } from './service.ts';

const SEED = 'https://www.instagram.com/p/SEED123/';

const coordinator = new BrowserCoordinator();
// Distinct object per call so a "same result handed to two purposes" bug cannot hide
// behind reference equality — deepEqual on a shared reference would pass vacuously.
const client = () => ({ send: async () => ({}) }) as unknown as CdpClient;

const navigations: string[] = [];
const context: AdapterContext = {
  intents: (url) => coordinator.intents(url),
  now: () => Date.now(),
  // `purpose` is optional in AdapterContext because frozen adapters call visit() with
  // 3 args; the real service supplies it per operation via contextFor(). Here the only
  // 3-arg caller is the adapter's own inspect(), so that is the default.
  visit: (platform, url, acquire, purpose = 'inspect') =>
    coordinator.visitOnce(platform, url, purpose, () => {
      navigations.push(`${url}::${purpose}`);
      return acquire(client(), coordinator.intents(url));
    }),
};

let inspectVisits = 0;
const adapter: PlatformAdapter = {
  platform: 'instagram',
  supports: (url: string) => url.includes('instagram.com'),
  discover: async () => {
    throw new Error('not used');
  },
  // Navigates, exactly like the real instagram/twitter/facebook/threads/reddit adapters.
  inspect: async (url, ctx) =>
    ctx.visit('instagram', url, async () => {
      inspectVisits++;
      return {
        canonical_url: url,
        platform: 'instagram' as const,
        post_id: 'SEED123',
        owner_handle: 'owner',
        text: 'seed caption',
        media: [],
        outcome: { status: 'resolved' as const, attempts: 1, elapsed_ms: 1 },
      };
    }),
  collectComments: async () => [],
  // Mirrors reddit.ts: a permanently-unsupported capability, throwing on every call.
  captureSocialCard: async () => {
    throw new AcquisitionError('instagram: social-card capture is unsupported', {
      status: 'unavailable',
      reason: 'unsupported',
      attempts: 0,
      elapsed_ms: 0,
    });
  },
};

const service = AcquisitionService.createForTest({ adapters: [adapter], coordinator, context });

// 1. run_pipeline's inspectSeed(): declare intents, then inspect. This opens the URL's
//    first visit, under purpose 'inspect'.
for (const intent of ['inspect', 'comments', 'media', 'social-card'] as const) {
  service.registerIntent(SEED, intent);
}
const record = await service.inspectPost(SEED);
assert.equal(record.post_id, 'SEED123');
assert.equal(inspectVisits, 1);

// 2. collect_comments' collectFor() browses the SAME URL for a different purpose. This is
//    the exact call that used to be refused, taking every comment source down with it.
const comments = await service.browse(
  'instagram',
  SEED,
  async () => [{ author: 'a', text: 'nice', likes: 1 }],
  'comments',
);
assert.deepEqual(comments, [{ author: 'a', text: 'nice', likes: 1 }], 'seed comments were lost');

// 3. build_footage's carousel crop, same URL again, third purpose. Previously this call
//    bypassed the coordinator entirely (cropPost opening its own CDP connection), so it
//    neither collided nor was counted.
const crop = await service.browse(
  'instagram',
  SEED,
  async () => ({ slides: ['a.png', 'b.png'] }),
  'footage-crop',
);
assert.deepEqual(crop, { slides: ['a.png', 'b.png'] }, 'footage crop was lost');

// Each purpose navigated exactly once, and the inspect result was never aliased into the
// other two — the shapes differ, so a URL-keyed memo would fail the deepEquals above.
assert.deepEqual(navigations, [
  `${SEED}::inspect`,
  `${SEED}::comments`,
  `${SEED}::footage-crop`,
]);

// Repeating a purpose still dedupes: that is the half of the budget that actually keeps
// the pipeline from re-loading the same page.
await service.browse('instagram', SEED, async () => ({ slides: ['SHOULD-NOT-RUN'] }), 'footage-crop');
assert.equal(navigations.length, 3, 'a repeated (url, purpose) navigated again');

// A failed operation must not poison unrelated operations on the same post: reddit's
// captureSocialCard throws `unsupported` by design on every call, and a URL-keyed negative
// cache turned that into "this post is unavailable" for inspect() too — durably, aborting
// the next run's pipeline before its first stage.
const POISON = 'https://www.instagram.com/p/POISON1/';
service.registerIntent(POISON, 'inspect');
await assert.rejects(service.captureSocialCard(POISON, 'post'), /social-card/i);
const stillWorks = await service.inspectPost(POISON);
assert.equal(stillWorks.post_id, 'SEED123', 'a social-card failure blocked inspect on the same URL');

console.log('ok service_coordinator_integration');
