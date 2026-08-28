import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadTiktok, tiktokDirectUrl, withDeadline } from './tiktok_video.ts';

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

async function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('test deadline exceeded')), timeoutMs);
  });
  try {
    return await Promise.race([operation, guard]);
  } finally {
    clearTimeout(timer!);
  }
}

let cdpCalls = 0;
await assert.rejects(
  () =>
    withDeadline((signal) => stalledFetch()('https://stalled.example.test/video', { signal }), 5),
  (error: unknown) => error instanceof Error && error.name === 'AbortError',
);
const started = performance.now();
const timedOut = await tiktokDirectUrl('https://www.tiktok.com/@u/video/1', {
  fetch: stalledFetch(),
  timeoutMs: 5,
  minGapMs: 0,
  cdpResolver: async () => {
    cdpCalls++;
    return null;
  },
});
assert.equal(timedOut, null);
assert.equal(cdpCalls, 1);
assert.ok(performance.now() - started < 250);

let jsonBodyCdpCalls = 0;
const stalledJsonBodyFetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
  ({
    ok: true,
    json: () =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  }) as Response) as typeof fetch;
assert.equal(
  await within(
    tiktokDirectUrl('https://www.tiktok.com/@u/video/json-body-stall', {
      fetch: stalledJsonBodyFetch,
      timeoutMs: 5,
      minGapMs: 0,
      cdpResolver: async () => {
        jsonBodyCdpCalls++;
        return null;
      },
    }),
    250,
  ),
  null,
);
assert.equal(jsonBodyCdpCalls, 1);

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
      minGapMs: 0,
    }),
    '',
  );
  assert.equal(fs.existsSync(stalledOutput), false);

  const stalledBodyOutput = path.join(tempDir, 'stalled-body.mp4');
  const stalledCdnBodyFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('tikwm.com/api/')) {
      return { ok: true, json: async () => descriptor } as Response;
    }
    return {
      ok: true,
      arrayBuffer: () =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    } as Response;
  }) as typeof fetch;
  assert.equal(
    await within(
      downloadTiktok('https://www.tiktok.com/@u/video/cdn-body-stall', stalledBodyOutput, {
        fetch: stalledCdnBodyFetch,
        timeoutMs: 5,
        minGapMs: 0,
      }),
      250,
    ),
    '',
  );
  assert.equal(fs.existsSync(stalledBodyOutput), false);

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
      minGapMs: 0,
    }),
    successfulOutput,
  );
  assert.equal(fs.statSync(successfulOutput).size, 10_001);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('ok tiktok_video');
