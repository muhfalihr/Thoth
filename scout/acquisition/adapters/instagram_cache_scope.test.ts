// Regression test for Fix 1a (2026-08-03 review round): socialCardCache must
// be scoped per-adapter-instance, not module-scope. Two independently
// created adapters (as two AcquisitionService.create() calls would produce)
// must never see each other's stashed social-card entries.
//
// cropPost is mocked (bun:test's mock.module, imported dynamically so this
// file's own static-import order doesn't race the real module load — see
// note below) so this test never opens a real browser or hits the network.
// Each mocked call writes a small real file and returns its path, so the
// Fix 2 existsSync guard in captureSocialCard sees a real, present file.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AdapterContext, PlatformAdapter } from '../types.ts';

// `import()` with a non-literal specifier makes tsc skip module resolution
// for 'bun:test' (no @types/bun-test in this repo) while Bun's runtime still
// resolves it normally.
const bunTestModuleName: string = 'bun:test';
const { mock } = await import(bunTestModuleName);

let cropCalls = 0;
const tmpFiles: string[] = [];
mock.module('../../scrapers/crop_post.ts', () => ({
  cropPost: async () => {
    cropCalls += 1;
    const p = path.join(os.tmpdir(), `instagram-cache-scope-test-${process.pid}-${cropCalls}.png`);
    fs.writeFileSync(p, 'fake-png-bytes');
    tmpFiles.push(p);
    return { ok: true, image_path: p, bytes: 14 };
  },
}));

// Must be a dynamic import AFTER mock.module — a static top-of-file import
// would already have bound instagram.ts's crop_post.ts dependency to the
// real module before the mock is installed.
const { createInstagramAdapter } = await import('./instagram.ts');

function fakeContext(onVisit: () => void): AdapterContext {
  return {
    intents: () => new Set(),
    now: () => 0,
    visit: async (_platform, _url, acquire) => {
      onVisit();
      return acquire({} as never, new Set());
    },
  };
}

const url = 'https://www.instagram.com/p/CacheScopeTest/';

// --- Same adapter, same url: second call must hit its own cache (no visit). ---
let visitsA = 0;
const adapterA: PlatformAdapter = createInstagramAdapter();
const contextA = fakeContext(() => {
  visitsA += 1;
});

const firstA = await adapterA.captureSocialCard(url, 'post', contextA);
assert.equal(visitsA, 1, 'first capture on a fresh adapter must visit (cache miss)');

const secondA = await adapterA.captureSocialCard(url, 'post', contextA);
assert.equal(
  visitsA,
  1,
  'second capture on the SAME adapter+url must hit its own cache (no re-visit)',
);
assert.equal(secondA.path, firstA.path);

// --- Fix 1a: an independently created adapter must NOT see adapter A's cache. ---
let visitsB = 0;
const adapterB: PlatformAdapter = createInstagramAdapter();
const contextB = fakeContext(() => {
  visitsB += 1;
});

const firstB = await adapterB.captureSocialCard(url, 'post', contextB);
assert.equal(
  visitsB,
  1,
  'a second, independently created adapter must visit for the SAME url — proves it does not share cache state with adapter A',
);
assert.notEqual(
  firstB.path,
  firstA.path,
  'independently created adapters must not resolve to the same stashed social-card asset',
);

// --- Fix 2: a cache entry whose file has been deleted must be re-cropped, not returned stale. ---
fs.unlinkSync(firstA.path);
const thirdA = await adapterA.captureSocialCard(url, 'post', contextA);
assert.equal(
  visitsA,
  2,
  'a cache hit whose file no longer exists on disk must fall through and re-crop',
);
assert.notEqual(thirdA.path, firstA.path);

for (const f of tmpFiles) {
  try {
    fs.unlinkSync(f);
  } catch {
    // already removed above / best-effort cleanup
  }
}

console.log('ok instagram_cache_scope');
