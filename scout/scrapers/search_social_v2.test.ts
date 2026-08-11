// search_social_v2.test.ts — regression test for searchPlatform(): keyword search must return
// a NON-EMPTY, correctly-shaped, CANONICALIZED result set, routed through context.browse() +
// context.inspectPost() (never a raw connect()).
//
// This guards Finding 1 (Task 13 review): the prior implementation called
// service.discover({kind:'query'}), which every adapter throws AcquisitionError(reason:
// 'unsupported') for — search silently returned [] on every platform. A test that merely
// checks "no throw" or "returns an array" would still pass against that bug (empty array is a
// valid array). This test instead asserts a specific non-empty count, specific canonicalized
// values (proving inspectPost() ran, not a raw echo), a rejected shape-mismatch, and that each
// candidate got a DISTINCT normalization (the fake never returns the same object twice — see
// note below on why that matters).
import assert from 'node:assert';
import type { AcquisitionIntent, Platform, PostRecord } from '../acquisition/types.ts';
import type { CdpClient } from '../lib/cdp.ts';
import type { SearchContext } from './search_social_v2.ts';
import { searchPlatform } from './search_social_v2.ts';

// Fake CdpClient: evaluate() is content-addressed by which JS snippet searchPlatform() sends,
// not by call order — matches how the real client is used (one login-wall probe, one link
// extraction) without hard-coding "1st call / 2nd call".
function fakeClient(rawLinksJson: string): CdpClient {
  return {
    evaluate: async (js: string) => {
      // Real CdpClient.evaluate() uses Runtime.evaluate({returnByValue:true}), so a JS boolean
      // expression like LOGGED_OUT_JS's `.test(...)` yields a real boolean, not a string — the
      // fake must match, since searchPlatform() now branches on this value's truthiness.
      if (js.includes('log in')) return false;
      return rawLinksJson;
    },
  } as unknown as CdpClient;
}

function makeContext(rawLinksJson: string) {
  const browseCalls: { platform: Platform; url: string }[] = [];
  const registeredIntents: { url: string; intent: AcquisitionIntent }[] = [];
  const inspectCalls: string[] = [];
  let inspectCallCount = 0;

  const context: SearchContext = {
    async browse<T>(platform: Platform, url: string, acquire: (client: CdpClient) => Promise<T>) {
      browseCalls.push({ platform, url });
      return acquire(fakeClient(rawLinksJson));
    },
    registerIntent(url: string, intent: AcquisitionIntent) {
      registeredIntents.push({ url, intent });
    },
    async inspectPost(url: string): Promise<PostRecord> {
      inspectCalls.push(url);
      inspectCallCount += 1;
      // ponytail: real inspectPost() strips a trailing slash + canonicalizes the host; this
      // fake does the same minimal transform so the test can prove "canonicalization
      // happened" without depending on the real adapter network path. A fresh object literal
      // is returned on EVERY call (never a cached/shared reference) — a fake that returned the
      // same object each time would make "was inspectPost called per-candidate, not once for
      // all" unfalsifiable, which is exactly the vacuity trap this test must avoid.
      return {
        canonical_url: url.replace(/\/$/, ''),
        platform: 'instagram',
        post_id: `post-${inspectCallCount}`,
        owner_handle: 'someone',
        text: '',
        media: [],
        outcome: { status: 'resolved', attempts: 1, elapsed_ms: 1 },
      };
    },
  };
  return { context, browseCalls, registeredIntents, inspectCalls };
}

{
  // --- two shape-valid IG links + one shape-invalid link on the search-results page.
  const rawLinks = JSON.stringify([
    'https://www.instagram.com/reel/AAA11111/',
    'https://www.instagram.com/reel/BBB22222/',
    'https://www.instagram.com/explore/not-a-post/',
  ]);
  const { context, browseCalls, registeredIntents, inspectCalls } = makeContext(rawLinks);

  const result = await searchPlatform(context, 'ig', 'korupsi BGN MBG', 10);

  // NON-EMPTY, specific count — not just "an array, possibly []".
  assert.equal(result.urls.length, 2, `expected 2 canonical URLs, got ${result.urls.length}`);
  // Canonicalized values (trailing slash stripped by inspectPost), not raw echoes.
  assert.deepEqual(result.urls, [
    'https://www.instagram.com/reel/AAA11111',
    'https://www.instagram.com/reel/BBB22222',
  ]);
  // Shape-invalid link never reached inspectPost(); it's reported as rejected instead.
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0], 'https://www.instagram.com/explore/not-a-post/');

  // Routed through context.browse() — never a raw connect(): correct platform + a search URL
  // carrying the encoded query.
  assert.equal(browseCalls.length, 1);
  assert.equal(browseCalls[0].platform, 'instagram');
  assert.ok(browseCalls[0].url.includes(encodeURIComponent('korupsi BGN MBG')));

  // registerIntent('inspect') fired once per surviving candidate (not per raw link, not once
  // for the whole batch).
  assert.equal(registeredIntents.length, 2);
  assert.ok(registeredIntents.every((r) => r.intent === 'inspect'));

  // inspectPost() actually called per-candidate (proves distinct normalization, not a single
  // shared result reused for both).
  assert.equal(inspectCalls.length, 2);
  assert.notEqual(inspectCalls[0], inspectCalls[1]);
}

{
  // --- max caps how many candidates get inspected (bounds real navigations).
  const rawLinks = JSON.stringify([
    'https://www.instagram.com/reel/AAA11111/',
    'https://www.instagram.com/reel/BBB22222/',
    'https://www.instagram.com/reel/CCC33333/',
  ]);
  const { context, inspectCalls } = makeContext(rawLinks);
  const result = await searchPlatform(context, 'ig', 'q', 2);
  assert.equal(result.urls.length, 2);
  assert.equal(inspectCalls.length, 2);
}

{
  // --- a candidate inspectPost() can't resolve is dropped, never fabricated into urls[].
  const rawLinks = JSON.stringify(['https://www.instagram.com/reel/AAA11111/']);
  const { context } = makeContext(rawLinks);
  context.inspectPost = async () => {
    throw new Error('not-found');
  };
  const result = await searchPlatform(context, 'ig', 'q', 10);
  assert.equal(result.urls.length, 0);
}

console.log('ok search_social_v2');
