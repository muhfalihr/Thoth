// discover_reels_recency.test.ts — regression test for isRowStale(): the per-account row loop
// in discover_reels.ts must apply the --hours recency cutoff to BOTH reels and posts, each as
// its own newest-first list (Task-13 review Finding "Important 1"). The prior (buggy) shape only
// gated `kind === 'reel'`, so a stale post (e.g. 40 days old under the default 48h window) rode
// straight into `found` and got shipped as a "fresh" topic candidate.
//
// The full per-account loop needs a live CDP client (itemFrame() navigates), so this tests the
// extracted pure decision function directly — feeding it the exact (kind, ts) sequence the loop
// would produce for a mixed reel+post fixture, in the same newest-first-per-list order.
import assert from 'node:assert/strict';
import { isRowStale } from './discover_reels.ts';

const HOUR = 3600 * 1000;
const now = Date.now();
const cutoff = now - 48 * HOUR;

// Fixture: reels newest-first (both fresh), then posts newest-first (1 fresh, 1 stale @ 40 days,
// 1 fresh appended AFTER the stale one — must still be excluded, proving per-list "once stale,
// always stale for the rest of that list", not just a single reject-and-continue).
const rows = [
  { kind: 'reel', ts: now - 1 * HOUR },
  { kind: 'reel', ts: now - 10 * HOUR },
  { kind: 'post', ts: now - 2 * HOUR },
  { kind: 'post', ts: now - 40 * 24 * HOUR }, // stale post — the bug let this through
  { kind: 'post', ts: now - 1 * HOUR }, // fresh timestamp, but appended after a stale post
];

{
  const staleFlags: Record<string, boolean> = {};
  const kept = rows.filter((r) => !isRowStale(r.kind, r.ts, cutoff, staleFlags));
  assert.deepEqual(
    kept.map((r) => r.ts),
    [rows[0].ts, rows[1].ts, rows[2].ts],
    'expected both fresh reels + the first fresh post, and NOTHING from/after the stale post',
  );
  assert.equal(staleFlags.post, true, 'stale post must mark the post list stale');
  assert.equal(staleFlags.reel, undefined, 'the reel list must be unaffected by post staleness');
}

{
  // Reel-stale-only must never suppress posts (the existing, already-correct half of the fix).
  const reelStaleRows = [
    { kind: 'reel', ts: now - 1 * HOUR },
    { kind: 'reel', ts: now - 60 * 24 * HOUR }, // stale reel
    { kind: 'post', ts: now - 1 * HOUR }, // must still come through
  ];
  const staleFlags: Record<string, boolean> = {};
  const kept = reelStaleRows.filter((r) => !isRowStale(r.kind, r.ts, cutoff, staleFlags));
  assert.deepEqual(
    kept.map((r) => r.kind),
    ['reel', 'post'],
  );
}

console.log('ok discover_reels_recency');
