// scout/pipeline/comments_acquisition.test.ts
import assert from 'node:assert/strict';
import { collectNormalizedComments, collectFor } from './collect_comments.ts';

const calls: string[] = [];
const comments = await collectNormalizedComments(
  [{ url: 'https://x.com/owner/status/1', platform: 'twitter' }],
  {
    perSource: 3,
    cap: 2,
    collect: async () => [
      { id: 'a', author: 'one', text: 'first', likes: 10 },
      { id: 'b', author: 'two', text: 'second', likes: 5 },
      { id: 'c', author: 'three', text: 'third', likes: 1 },
    ],
    capture: async (_url, comment) => {
      calls.push(comment.id);
      return { path: `${comment.id}.png`, kind: 'social-card', source: 'dom', bytes: 1 };
    },
  },
);
assert.deepEqual(comments.map((item) => item.image_path), ['a.png', 'b.png']);
assert.deepEqual(calls, ['a', 'b']);
console.log('ok comments_acquisition');

// ── Regression guard for the Critical finding: per-comment image_path must NOT collapse into
// one shared post-level screenshot. Each comment record here carries its OWN distinct
// image_path (genuinely different objects/values, not the same reference) — exactly what
// scrapeCommentsOnPage() now produces. deps.capture() is wired to return the SAME path for
// every call, simulating the old bug (captureSocialCard memoized on source URL) — so if the
// implementation stops preferring the record's own image_path, this test collapses to
// ['shared.png','shared.png','shared.png'] and fails.
const identityCaptureCalls: string[] = [];
const identityComments = await collectNormalizedComments(
  [{ url: 'https://x.com/owner/status/2', platform: 'twitter' }],
  {
    perSource: 5,
    cap: 5,
    collect: async () => [
      { id: 'p1', author: 'alice', text: 'alpha comment', likes: 30, image_path: 'crops/alice.png' },
      { id: 'p2', author: 'bob', text: 'bravo comment', likes: 20, image_path: 'crops/bob.png' },
      { id: 'p3', author: 'carol', text: 'charlie comment', likes: 10, image_path: 'crops/carol.png' },
    ],
    capture: async (_url, comment) => {
      identityCaptureCalls.push(comment.id);
      return { path: 'shared.png', kind: 'social-card', source: 'dom', bytes: 1 };
    },
  },
);
const identityPaths = identityComments.map((item) => item.image_path);
assert.deepEqual(identityPaths, ['crops/alice.png', 'crops/bob.png', 'crops/carol.png']);
assert.equal(new Set(identityPaths).size, 3, 'each comment must keep its own distinct image_path');
assert.deepEqual(
  identityCaptureCalls,
  [],
  'deps.capture() must not be called when the record already carries its own image_path',
);
console.log('ok comments_acquisition per-comment identity');

// ── Junk filtering: sticker-only and link-spam comments are dropped uniformly (even from the
// deps.collect() fallback path, which has no filtering of its own), while a normal comment
// with real audience content survives. Exercises the positive case (normal survives) alongside
// the negative ones so a guard that merely rejects everything can't pass vacuously.
const junkComments = await collectNormalizedComments(
  [{ url: 'https://reddit.com/r/x/comments/1', platform: 'reddit' }],
  {
    perSource: 5,
    cap: 5,
    collect: async () => [
      { id: 'sticker', author: 'dana', text: '[Sticker]', likes: 40 },
      { id: 'spam', author: 'erin', text: 'http://spamsite.example/article', likes: 99 },
      { id: 'real', author: 'frank', text: 'this is a genuine reaction', likes: 2 },
    ],
    capture: async (_url, comment) => ({
      path: `${comment.id}.png`,
      kind: 'social-card',
      source: 'dom',
      bytes: 1,
    }),
  },
);
assert.deepEqual(
  junkComments.map((item) => item.text),
  ['this is a genuine reaction'],
  'sticker-only and link-spam comments must be dropped while a real comment survives',
);
console.log('ok comments_acquisition junk filtering');

// ── Reddit/youtube must route through service.browse() (crop-capable), not the collapsing
// service.collectComments() fallback. Regression guard for the follow-up finding: CROP_CAPABLE
// originally covered only tiktok/instagram/twitter/facebook, silently leaving reddit and youtube
// on the fallback that collapses every comment onto one shared post-level card. The fake browse()
// below returns genuinely distinct per-comment image_path values (not the same object/reference);
// the fake collectComments() returns records with NO image_path, mirroring the real collapsing
// fallback shape — so if a platform is missing from CROP_CAPABLE, this test's distinctness
// assertion fails instead of silently passing.
for (const [platform, url] of [
  ['reddit', 'https://reddit.com/r/x/comments/2'],
  ['youtube', 'https://youtube.com/watch?v=abc123'],
] as const) {
  const browseCalls: string[] = [];
  const fakeService = {
    browse: async (p: string) => {
      browseCalls.push(p);
      return [
        { id: '1', author: 'g', text: 'nice', likes: 4, image_path: `crops/${platform}-1.png` },
        { id: '2', author: 'h', text: 'wow', likes: 3, image_path: `crops/${platform}-2.png` },
      ];
    },
    collectComments: async () => [
      { id: '1', author: 'g', text: 'nice', likes: 4 },
      { id: '2', author: 'h', text: 'wow', likes: 3 },
    ],
  };
  const got = await collectFor(url, 10, fakeService as any);
  assert.deepEqual(
    browseCalls,
    [platform],
    `${platform} must route through service.browse(), not the collapsing service.collectComments() fallback`,
  );
  const paths = got.map((c) => c.image_path);
  assert.deepEqual(paths, [`crops/${platform}-1.png`, `crops/${platform}-2.png`]);
  assert.equal(new Set(paths).size, 2, `${platform} comments must keep distinct per-comment image_path`);
}
console.log('ok comments_acquisition reddit/youtube crop-capable routing');
