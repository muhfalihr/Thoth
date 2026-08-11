// run_all_tests.ts — single entry point for `bun run test:acquisition`. Imports every
// acquisition-kernel test in deterministic foundation-to-adapter order (leaf utilities first,
// adapters next, boundary enforcement last) so one failing import aborts the whole run instead of
// silently skipping ahead — each test file asserts on import via node:assert/strict.
//
// The kernel's own tests are ORDERED explicitly below. Every other *.test.ts under scout/ is
// DISCOVERED, not listed. A hand-maintained list is what let this gate rot: it was written against
// the plan before tasks 9-16 added ~10 more test files, so `bun run test:acquisition` kept printing
// `ok acquisition_suite` while never importing them — breaking any one of those files would still
// have reported green. Discovery means a new test file is covered the moment it lands.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const posix = (p: string) => p.split(path.sep).join('/');

const ordered = [
  'acquisition/url.test.ts',
  'acquisition/cache.test.ts',
  'acquisition/browser_coordinator.test.ts',
  'acquisition/network_capture.test.ts',
  'acquisition/policy.test.ts',
  'acquisition/materialize.test.ts',
  'acquisition/service.test.ts',
  'acquisition/adapters/instagram.test.ts',
  'acquisition/adapters/twitter.test.ts',
  'acquisition/adapters/tiktok.test.ts',
  'acquisition/adapters/youtube.test.ts',
  'acquisition/adapters/facebook.test.ts',
  'acquisition/adapters/threads.test.ts',
  'acquisition/adapters/reddit.test.ts',
];
// Boundary enforcement runs last: it is the spec, and its failure should be the
// final word rather than something that aborts the suite before anything else ran.
const boundary = 'acquisition/boundary.test.ts';

const discovered = fs
  .readdirSync(root, { recursive: true, encoding: 'utf8' })
  .map(posix)
  .filter((f) => f.endsWith('.test.ts') && !f.startsWith('node_modules/'));

// A rename that orphans an ordered entry must fail loudly, not quietly skip it —
// otherwise this file rots the same way the old list did, just less visibly.
for (const f of [...ordered, boundary]) {
  if (!discovered.includes(f)) throw new Error(`run_all_tests: missing ordered test ${f}`);
}

const rest = discovered.filter((f) => !ordered.includes(f) && f !== boundary).sort();

for (const test of [...ordered, ...rest, boundary]) {
  await import(pathToFileURL(path.join(root, test)).href);
}
console.log(`ok acquisition_suite (${ordered.length + rest.length + 1} files)`);
