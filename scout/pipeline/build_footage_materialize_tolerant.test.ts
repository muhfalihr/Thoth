import assert from 'node:assert/strict';
import { admitAndMaterializeFootageTolerant } from './build_footage.ts';

// Regression for: unhandled materialize() throw truncates the twitter-card loop.
// admitAndMaterializeFootageTolerant() is the exact per-candidate seam the twitter-card loop
// in runBuildFootage() (build_footage.ts) now calls. Proving it never rethrows here proves the
// production `for (const e of cands)` loop cannot be aborted by one candidate's materialize()
// failure — the loop's own `for` is standard JS and cannot skip an iteration on a non-throw.

const post = (id: string, text: string) => ({
  canonical_url: `https://x.com/owner/status/${id}`,
  platform: 'twitter',
  post_id: id,
  owner_handle: 'owner',
  text,
  media: [
    {
      id: `${id}:1`,
      kind: 'image',
      index: 1,
      canonical_post_url: `https://x.com/owner/status/${id}`,
    },
  ],
  outcome: { status: 'resolved', source: 'network', attempts: 1, elapsed_ms: 1 },
});

// tweetA: photo, transient network blip in materialize(). tweetB/tweetC: photo, healthy.
const candidates = [
  post('A', 'story unfolds A'),
  post('B', 'story unfolds B'),
  post('C', 'story unfolds C'),
];

let materializeCalls = 0;
const outcomes = [];
for (const p of candidates) {
  outcomes.push(
    await admitAndMaterializeFootageTolerant(p as any, {
      query: 'story',
      isRelevant: () => true,
      isMain: () => false,
      looksReaction: () => false,
      materialize: async () => {
        materializeCalls++;
        if (p.post_id === 'A') throw new Error('transient network blip');
        return {
          path: `/tmp/footage-${p.post_id}.jpg`,
          kind: 'image',
          source: 'direct-http',
          bytes: 1,
        };
      },
    }),
  );
}

// tweetA's genuine throw is tolerated (caught, not rethrown) ...
assert.equal(outcomes[0].status, 'error');
assert.equal((outcomes[0] as any).error.message, 'transient network blip');

// ... and tweetB + tweetC were still genuinely reached and materialized (not skipped).
assert.equal(outcomes[1].status, 'ok');
assert.equal((outcomes[1] as any).result.status, 'accepted');
assert.equal((outcomes[1] as any).result.entry.image_path, '/tmp/footage-B.jpg');
assert.equal(outcomes[2].status, 'ok');
assert.equal((outcomes[2] as any).result.status, 'accepted');
assert.equal((outcomes[2] as any).result.entry.image_path, '/tmp/footage-C.jpg');

// Proves each candidate's materialize() was actually invoked (not vacuously "processed"
// on a path that never reaches materialize).
assert.equal(materializeCalls, 3);

console.log('ok build_footage_materialize_tolerant');
