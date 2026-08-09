// scout/pipeline/comments_acquisition.test.ts
import assert from 'node:assert/strict';
import { collectNormalizedComments } from './collect_comments.ts';

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
