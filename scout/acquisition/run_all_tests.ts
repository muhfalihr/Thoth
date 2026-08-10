// run_all_tests.ts — single entry point for `bun run test:acquisition`. Imports every
// acquisition-kernel test in deterministic foundation-to-adapter order (leaf utilities first,
// adapters next, boundary enforcement last) so one failing import aborts the whole run instead of
// silently skipping ahead — each test file asserts on import via node:assert/strict.
const tests = [
  './url.test.ts',
  './cache.test.ts',
  './browser_coordinator.test.ts',
  './network_capture.test.ts',
  './policy.test.ts',
  './materialize.test.ts',
  './service.test.ts',
  './adapters/instagram.test.ts',
  './adapters/twitter.test.ts',
  './adapters/tiktok.test.ts',
  './adapters/youtube.test.ts',
  './adapters/facebook.test.ts',
  './adapters/threads.test.ts',
  './adapters/reddit.test.ts',
  './boundary.test.ts',
];
for (const test of tests) await import(test);
console.log('ok acquisition_suite');
