import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserCoordinator } from './browser_coordinator.ts';
import { AcquisitionCache } from './cache.ts';
import { AcquisitionService, visitWithFocus } from './service.ts';
import { AcquisitionError } from './types.ts';
import { canonicalizeUrl } from './url.ts';

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

// Regression (Task 13 review, Important 3): browse() must feed failures to the coordinator's
// circuit breaker and negative cache via failUrlOperation(), same as inspectPost/collectComments/
// captureSocialCard — previously it swallowed a thrown AcquisitionError's signal entirely
// (recordOutcome/setNegative never ran for it), so a challenge/rate-limit hit while browsing a
// search-results page never opened that platform's breaker.
{
  const coordinator = new BrowserCoordinator();
  const cache = new AcquisitionCache({
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-acq-browse-test-')),
  });
  const browseService = AcquisitionService.createForTest({
    adapters: [],
    coordinator,
    cache,
    context: {
      intents: (u) => coordinator.intents(u),
      now: () => Date.now(),
      visit: async (_platform, url, run) => run({} as never, coordinator.intents(url)),
    },
  });

  // Success path: acquire()'s return value passes through untouched.
  const ok = await browseService.browse(
    'twitter',
    'https://x.com/search?q=ok',
    async () => 'value',
  );
  assert.equal(ok, 'value');
  assert.equal(coordinator.isBlocked('twitter'), false);

  // Failure path: an AcquisitionError raised inside acquire() (e.g. search_social_v2.ts's
  // logged-out/challenge DOM sniff) must reach the coordinator + negative cache, not just
  // rethrow silently.
  const searchUrl = 'https://x.com/search?q=blocked';
  await assert.rejects(
    browseService.browse('twitter', searchUrl, async () => {
      throw new AcquisitionError('search: logged-out/challenge page for twitter', {
        status: 'blocked',
        reason: 'auth-required',
        attempts: 1,
        elapsed_ms: 0,
      });
    }),
    /logged-out\/challenge/,
  );
  assert.equal(
    coordinator.isBlocked('twitter'),
    true,
    'browse() failure must open the platform circuit breaker',
  );
  assert.ok(
    cache.getNegative(canonicalizeUrl(searchUrl)),
    'browse() failure must write a negative-cache entry for the canonical URL',
  );
}

console.log('ok acquisition_service');

// ── Regression guard: the browse()/adapter navigation path must force tab focus BEFORE
// navigating (many SPAs only mount the detail view — comments, search results, etc. — when the
// tab is focused; a backgrounded relay tab renders just a shell). The fake client below records
// every cmd()/navigate() call in order, and the fake acquire() records when IT was called, so we
// can prove the full sequence: bringToFront → setFocusEmulationEnabled → navigate → acquire.
{
  const calls: string[] = [];
  const fakeClient: any = {
    cmd: async (method: string) => {
      calls.push(`cmd:${method}`);
    },
    navigate: async (url: string) => {
      calls.push(`navigate:${url}`);
    },
    close: () => {
      calls.push('close');
    },
  };
  const fakeConnect = async () => fakeClient;

  let acquireCalledAt = -1;
  const result = await visitWithFocus(
    'https://reddit.com/r/x/comments/1',
    async (client) => {
      acquireCalledAt = calls.length;
      assert.equal(client, fakeClient, 'acquire must receive the connected client');
      return 'acquired';
    },
    new Set(),
    fakeConnect,
  );

  assert.equal(result, 'acquired');
  assert.deepEqual(calls.slice(0, 3), [
    'cmd:Page.bringToFront',
    'cmd:Emulation.setFocusEmulationEnabled',
    'navigate:https://reddit.com/r/x/comments/1',
  ]);
  assert.equal(
    acquireCalledAt,
    3,
    'acquire() must run only after both focus commands and navigate — not before',
  );
  console.log('ok service focus-before-navigate ordering');
}

// ── A browser that doesn't support one of the focus commands must not fail the whole visit.
// The fake genuinely throws (not just returns) for BOTH focus commands, proving the try/catch
// pair actually swallows a real rejection rather than this being vacuously true because the
// fake never throws.
{
  const calls: string[] = [];
  const fakeClient: any = {
    cmd: async (method: string) => {
      calls.push(`cmd:${method}`);
      throw new Error(`${method} not supported on this browser`);
    },
    navigate: async (url: string) => {
      calls.push(`navigate:${url}`);
    },
    close: () => {},
  };
  const fakeConnect = async () => fakeClient;

  let acquireRan = false;
  const result = await visitWithFocus(
    'https://youtube.com/watch?v=1',
    async () => {
      acquireRan = true;
      return 'ok despite focus failure';
    },
    new Set(),
    fakeConnect,
  );

  assert.equal(result, 'ok despite focus failure');
  assert.equal(acquireRan, true, 'acquire() must still run when both focus commands throw');
  assert.deepEqual(calls, [
    'cmd:Page.bringToFront',
    'cmd:Emulation.setFocusEmulationEnabled',
    'navigate:https://youtube.com/watch?v=1',
  ]);
  console.log('ok service focus-commands-tolerate-unsupported-browser');
}
