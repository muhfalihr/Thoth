// async_pool.ts — bounded-concurrency map. Runs `fn` over `items` with at most `n` in flight.
//
// Why bounded (not Promise.all over everything): the callers here fan out to yt-dlp child
// processes / network probes that platforms rate-limit. Unbounded parallelism trades a serial
// stall for a 429 / IP throttle, which is slower. `n` caps the blast radius.
//
// Preserves input order in the result (out[k] ← fn(items[k])), so callers can zip results back
// to their candidates by index. `fn` should swallow its own errors (return a sentinel) — a throw
// rejects the whole pool.
export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, n), items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}
