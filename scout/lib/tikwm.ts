// lib/tikwm.ts — the ONE gate to tikwm.com's free mirror API.
//
// tikwm answers an over-rate request with HTTP 200 and a body that reads
// {"code":-1,"msg":"Free Api Limit: 1 request/second."} — indistinguishable from "no such
// video" to a caller that only checks `code !== 0`. A single trace_source run queries tikwm
// more than once (CDN resolution for the main, then again to localize the media the REQUIRED
// OCR stage needs), so the second call within the same second came back null and aborted the
// whole pipeline with an opaque `media_access_failed`.
//
// Every in-process caller goes through one queue here: calls are spaced to the documented
// limit and retried when the limit answers anyway, so adding a new tikwm caller can no longer
// starve an existing one.
//
//   import { tikwmLookup } from './tikwm.ts';
//   const data = await tikwmLookup(pageUrl);   // → { play, hdplay, title, duration } | null

export type TikwmData = {
  play?: string;
  hdplay?: string;
  wmplay?: string;
  title?: string;
  duration?: number;
};

export type TikwmDeps = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  minGapMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
};

const DEFAULT_TIMEOUT_MS = 15_000;
// The documented limit is 1 request/second; the margin absorbs clock and network skew.
const DEFAULT_MIN_GAP_MS = 1_200;
const DEFAULT_ATTEMPTS = 3;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

// A rate-limited answer is a RETRYABLE failure; anything else (private video, dead id) is not,
// and retrying it would only burn the caller's budget.
function isRateLimited(payload: { code?: number; msg?: string } | null): boolean {
  return !!payload && payload.code !== 0 && /limit/i.test(String(payload.msg ?? ''));
}

async function lookupNow(pageUrl: string, deps: TikwmDeps): Promise<TikwmData | null> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const minGapMs = deps.minGapMs ?? DEFAULT_MIN_GAP_MS;
  const attempts = Math.max(1, deps.attempts ?? DEFAULT_ATTEMPTS);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const wait = lastCallAt + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    let payload: { code?: number; msg?: string; data?: TikwmData } | null = null;
    // An explicit controller, not AbortSignal.timeout(): under Bun the latter never fires here,
    // so a stalled connection would hang the run forever instead of failing at the deadline.
    // The same signal also bounds the body read — tikwm has answered with headers and then
    // stalled mid-JSON before.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetchImpl(
        `https://www.tikwm.com/api/?url=${encodeURIComponent(pageUrl)}&hd=1`,
        {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          signal: controller.signal,
        },
      );
      if (!response.ok) return null;
      payload = await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (payload?.code === 0 && payload.data) return payload.data;
    if (!isRateLimited(payload)) return null;
  }
  (deps.warn ?? ((message: string) => console.warn(message)))(
    `[tikwm] batas rate bertahan setelah ${attempts} percobaan — media TikTok tak teresolusi.`,
  );
  return null;
}

// Serialized: concurrent callers queue instead of racing into the rate limit.
export async function tikwmLookup(
  pageUrl: string,
  deps: TikwmDeps = {},
): Promise<TikwmData | null> {
  const run = () => lookupNow(pageUrl, deps);
  const queued = queue.then(run, run);
  queue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}
