// parity_reference_smoke.test.ts — the smoke probe must stay offline and disposable.
//
// The probe drives a real browser with the real Scout client, so the only thing
// standing between it and a live site is the page it is told to visit. That page
// is served by the probe itself, on loopback, and is asserted here. Navigation
// through Chromium is proven by the image harness, not by this file.

import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimFreshProfile, LOCAL_PAGE_TITLE, serveLocalPage } from './parity_reference_smoke.ts';

test('the local page is served on an ephemeral loopback port', async () => {
  const page = serveLocalPage();
  try {
    expect(page.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/reference$/);
    expect(page.url).not.toContain(':0/');

    const body = await (await fetch(page.url)).text();
    expect(body).toContain(LOCAL_PAGE_TITLE);
  } finally {
    await page.stop();
  }
});

test('a profile that already carries a marker is not a fresh profile', () => {
  const profile = mkdtempSync(join(tmpdir(), 'parity-profile-'));

  claimFreshProfile(profile);
  // Written and read back: a marker that was never persisted would make the
  // second run's absence check vacuous.
  expect(readFileSync(join(profile, 'parity-smoke.marker'), 'utf8')).toBeTruthy();

  expect(() => claimFreshProfile(profile)).toThrow('profile_not_fresh');
});

test('an unwritable profile is a failure, not a silent pass', () => {
  const profile = mkdtempSync(join(tmpdir(), 'parity-profile-'));
  writeFileSync(join(profile, 'parity-smoke.marker'), '');

  expect(() => claimFreshProfile(profile)).toThrow('profile_not_fresh');
});
