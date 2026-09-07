// parity_reference_smoke.test.ts — the smoke probe must stay offline.
//
// The probe drives a real browser with the real Scout client, so the only thing
// standing between it and a live site is the sentinel it is told to visit. That
// target is asserted here; the navigation itself is proven by the image test.

import { expect, test } from 'bun:test';
import { sentinelTarget } from './parity_reference_smoke.ts';

test('the smoke probe navigates only to an explicit local sentinel', () => {
  expect(sentinelTarget({ THOTH_PARITY_SENTINEL_URL: 'http://sentinel:8080/probe' })).toBe(
    'http://sentinel:8080/probe',
  );
  for (const env of [
    {},
    { THOTH_PARITY_SENTINEL_URL: '' },
    { THOTH_PARITY_SENTINEL_URL: 'https://www.tiktok.com/@creator/video/1' },
    { THOTH_PARITY_SENTINEL_URL: 'http://www.tiktok.com/' },
    { THOTH_PARITY_SENTINEL_URL: 'file:///etc/passwd' },
    { THOTH_PARITY_SENTINEL_URL: 'not-a-url' },
  ]) {
    expect(() => sentinelTarget(env)).toThrow();
  }
});
