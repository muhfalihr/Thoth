// parity_sentinel.test.ts — the sentinel's only job is to be a truthful witness.
//
// It stands in for the deployment relay on the smoke network. If it under-counted
// a request, an isolation failure would read as a pass, so the counter is what is
// pinned here: identity reads must be free, and everything else must be counted.

import { expect, test } from 'bun:test';
import {
  IDENTITY_PATH,
  SENTINEL_HEALTH,
  SENTINEL_IDENTITY,
  serveSentinel,
} from './parity_sentinel.ts';

test('the sentinel counts every request except the reading of its own identity', async () => {
  const sentinel = serveSentinel(0);
  const identityUrl = `http://127.0.0.1:${sentinel.port}${IDENTITY_PATH}`;
  try {
    const untouched = await (await fetch(identityUrl)).json();
    expect(untouched).toEqual({
      identity: SENTINEL_IDENTITY,
      health: SENTINEL_HEALTH,
      requests: 0,
    });

    await fetch(`http://127.0.0.1:${sentinel.port}/json/version`);
    await fetch(`http://127.0.0.1:${sentinel.port}/`);

    const touched = await (await fetch(identityUrl)).json();
    expect(touched.requests).toBe(2);
    // Identity and health are fixed, so a swapped container cannot pass as this one.
    expect(touched.identity).toBe(SENTINEL_IDENTITY);
    expect(touched.health).toBe(SENTINEL_HEALTH);
  } finally {
    await sentinel.stop();
  }
});
