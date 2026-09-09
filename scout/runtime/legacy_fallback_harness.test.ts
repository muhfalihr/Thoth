import { expect, test } from 'bun:test';

import { compareTargetSnapshots } from './legacy_fallback_harness.ts';

const health = { id: 'health-1', type: 'page', url: 'about:blank' };
const leased = { id: 'leased-1', type: 'page', url: 'about:blank#legacy-fallback-smoke' };

test('accepts one observed temporary target and unchanged health target', () => {
  expect(compareTargetSnapshots([health], [health, leased], [health])).toEqual({
    initial_target_preserved: true,
    temporary_target_observed: true,
    temporary_target_removed: true,
  });
});

test('fails when the initial page changes or temporary page remains', () => {
  expect(() => compareTargetSnapshots([health], [leased], [leased])).toThrow(
    'target_isolation_failed',
  );
});
