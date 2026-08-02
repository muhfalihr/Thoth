import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcquisitionCache } from './cache.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-acquisition-cache-'));
let clock = 1_000;
try {
  const cache = new AcquisitionCache({ root, now: () => clock });
  const post = {
    canonical_url: 'https://www.instagram.com/p/ABC/',
    platform: 'instagram' as const,
    post_id: 'ABC',
    owner_handle: 'owner',
    text: 'caption',
    media: [
      {
        id: 'ABC:1',
        kind: 'image' as const,
        index: 1,
        canonical_post_url: 'https://www.instagram.com/p/ABC/',
        ephemeral_url: 'https://cdn.test/image.jpg?sig=secret',
      },
    ],
    outcome: {
      status: 'resolved' as const,
      source: 'network' as const,
      attempts: 1,
      elapsed_ms: 2,
    },
  };
  cache.setPost(post, 100);
  assert.equal(cache.getPost(post.canonical_url)?.text, 'caption');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'records.json'), 'utf8'), /cdn\.test|secret/);
  clock += 101;
  assert.equal(cache.getPost(post.canonical_url), null);

  let calls = 0;
  const one = cache.memoize('same', async () => {
    calls++;
    return 'value';
  });
  const two = cache.memoize('same', async () => 'wrong');
  assert.equal(await one, 'value');
  assert.equal(await two, 'value');
  assert.equal(cache.getRun('same'), 'value');
  assert.equal(calls, 1);
  console.log('ok acquisition_cache');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
