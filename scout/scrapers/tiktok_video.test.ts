import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  downloadTiktok,
  fetchWithDeadline,
  tiktokDirectUrl,
} from './tiktok_video.ts';

function stalledFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as typeof fetch;
}

let cdpCalls = 0;
await assert.rejects(
  () =>
    fetchWithDeadline(
      stalledFetch(),
      'https://stalled.example.test/video',
      {},
      5,
    ),
  (error: unknown) => error instanceof Error && error.name === 'AbortError',
);
const started = performance.now();
const timedOut = await tiktokDirectUrl('https://www.tiktok.com/@u/video/1', {
  fetch: stalledFetch(),
  timeoutMs: 5,
  cdpResolver: async () => {
    cdpCalls++;
    return null;
  },
});
assert.equal(timedOut, null);
assert.equal(cdpCalls, 1);
assert.ok(performance.now() - started < 250);

const descriptor = {
  code: 0,
  data: {
    play: 'https://cdn.example.test/video.mp4',
    title: 'clip',
    duration: 12,
  },
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-tiktok-deadline-'));
try {
  const stalledOutput = path.join(tempDir, 'stalled.mp4');
  const stalledCdnFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('tikwm.com/api/')) {
      return { ok: true, json: async () => descriptor } as Response;
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  }) as typeof fetch;
  assert.equal(
    await downloadTiktok('https://www.tiktok.com/@u/video/2', stalledOutput, {
      fetch: stalledCdnFetch,
      timeoutMs: 5,
    }),
    '',
  );
  assert.equal(fs.existsSync(stalledOutput), false);

  const successfulOutput = path.join(tempDir, 'success.mp4');
  const body = new Uint8Array(10_001).buffer;
  const successfulFetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('tikwm.com/api/')) {
      return { ok: true, json: async () => descriptor } as Response;
    }
    return { ok: true, arrayBuffer: async () => body } as Response;
  }) as typeof fetch;
  assert.equal(
    await downloadTiktok('https://www.tiktok.com/@u/video/3', successfulOutput, {
      fetch: successfulFetch,
      timeoutMs: 5,
    }),
    successfulOutput,
  );
  assert.equal(fs.statSync(successfulOutput).size, 10_001);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('ok tiktok_video');
