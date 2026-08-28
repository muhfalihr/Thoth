// lib/tikwm.test.ts — the rate gate in front of tikwm.com.
//
// What this guards: tikwm answers an over-rate call with HTTP 200 and code -1, so a caller that
// reads that as "video unavailable" aborts a pipeline stage for a video that is perfectly fine.
// That is exactly how a trace_source run died — the second tikwm call of the run landed inside
// the same second as the first.
import assert from 'node:assert/strict';
import { tikwmLookup } from './tikwm.ts';

const RATE_LIMITED = { code: -1, msg: 'Free Api Limit: 1 request/second.' };
const OK = { code: 0, data: { play: 'https://cdn.test/a.mp4', title: 'clip', duration: 12 } };

const jsonFetch = (bodies: unknown[]) => {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return { ok: true, json: async () => bodies[calls.length - 1] ?? OK } as Response;
  }) as typeof fetch;
  return { impl, calls };
};

// Rate-limit is retried, not reported as "no such video".
{
  const { impl, calls } = jsonFetch([RATE_LIMITED, RATE_LIMITED, OK]);
  const waits: number[] = [];
  const data = await tikwmLookup('https://www.tiktok.com/@u/video/1', {
    fetch: impl,
    minGapMs: 5,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.equal(data?.play, OK.data.play);
  assert.equal(calls.length, 3);
  assert.ok(waits.every((ms) => ms <= 5));
  console.log('ok tikwm_retries_rate_limit');
}

// A genuine failure must NOT burn retries — only the limit message is retryable.
{
  const { impl, calls } = jsonFetch([{ code: -1, msg: 'Url parsing is failed!' }]);
  assert.equal(
    await tikwmLookup('https://www.tiktok.com/@u/video/2', { fetch: impl, minGapMs: 0 }),
    null,
  );
  assert.equal(calls.length, 1);
  console.log('ok tikwm_permanent_failure_not_retried');
}

// Giving up says why. A silent null is what made the original failure unreadable downstream.
{
  const { impl } = jsonFetch([RATE_LIMITED, RATE_LIMITED, RATE_LIMITED]);
  const warnings: string[] = [];
  assert.equal(
    await tikwmLookup('https://www.tiktok.com/@u/video/3', {
      fetch: impl,
      minGapMs: 0,
      sleep: async () => {},
      warn: (message) => warnings.push(message),
    }),
    null,
  );
  assert.match(warnings.join('\n'), /rate|limit/i);
  console.log('ok tikwm_reports_exhausted_limit');
}

// Concurrent callers queue instead of racing into the limit: the second request is only issued
// after the first one is answered, and never sooner than the gap.
{
  const order: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const id = String(input).includes('video%2FA') ? 'A' : 'B';
    order.push(`start-${id}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(`end-${id}`);
    return { ok: true, json: async () => OK } as Response;
  }) as typeof fetch;
  const gaps: number[] = [];
  const deps = {
    fetch: impl,
    minGapMs: 30,
    sleep: async (ms: number) => {
      gaps.push(ms);
    },
  };
  await Promise.all([
    tikwmLookup('https://www.tiktok.com/@u/video/A', deps),
    tikwmLookup('https://www.tiktok.com/@u/video/B', deps),
  ]);
  assert.deepEqual(order, ['start-A', 'end-A', 'start-B', 'end-B']);
  assert.ok(
    gaps.some((ms) => ms > 0),
    'panggilan kedua harus menunggu jeda, bukan langsung menembak',
  );
  console.log('ok tikwm_serializes_callers');
}
