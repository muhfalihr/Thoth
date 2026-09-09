// parity_reference_contract.test.ts — the parity budget is one arithmetic
// relationship, and p5 is what happens when it stops holding.
//
// The reference supervisor owned a 15-minute outer deadline while the retained
// source stage owned 30 minutes, so a source resolution that used its budget was
// killed from the outside and could never be credited. These assertions lock the
// outer deadline to the retained inner stage plus a named reserve, so it cannot
// silently become the shorter of the two again.

import { expect, test } from 'bun:test';
import {
  SOURCE_REFERENCE_OVERHEAD_RESERVE_MS,
  SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS,
  SOURCE_REFERENCE_TRACE_TIMEOUT_MS,
} from '../lib/parity_reference_contract.ts';

test('the retained source stage keeps its measured budget', () => {
  expect(SOURCE_REFERENCE_TRACE_TIMEOUT_MS).toBe(30 * 60_000);
});

// Pre-outcome only: teardown and attempt finalization run after the timer is cleared, so a
// description that folds them into this reserve would legitimize skipping them on a timeout.
test('the reserve provides pre-outcome acquisition headroom', () => {
  expect(SOURCE_REFERENCE_OVERHEAD_RESERVE_MS).toBe(5 * 60_000);
});

test('the acquisition deadline is the sum, never shorter than the stage it supervises', () => {
  expect(SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS).toBe(35 * 60_000);
  expect(SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS).toBe(
    SOURCE_REFERENCE_TRACE_TIMEOUT_MS + SOURCE_REFERENCE_OVERHEAD_RESERVE_MS,
  );
  expect(SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS).toBeGreaterThan(SOURCE_REFERENCE_TRACE_TIMEOUT_MS);
});
