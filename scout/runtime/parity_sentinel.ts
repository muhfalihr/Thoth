// parity_sentinel.ts — a synthetic stand-in for the deployment relay, used in smoke.
//
// The isolation claim is negative: a reference must never reach the relay authority
// a deployment sidecar answers on. Negative claims need a witness, so the smoke
// network aliases this process there. It is not a browser, holds no profile, and
// answers no DevTools protocol; it exists to record that nobody called.
//
// Its identity and health strings are fixed so a swapped or restarted container
// cannot be mistaken for this one, and identity reads are uncounted so the harness
// can ask the question without changing the answer.

export const SENTINEL_IDENTITY = 'stage1-parity-sentinel';
export const SENTINEL_HEALTH = 'sentinel-untouched';
export const IDENTITY_PATH = '/__identity';
export const SENTINEL_PORT = 18800;

export interface Sentinel {
  port: number;
  stop(): Promise<void>;
}

export function serveSentinel(port: number = SENTINEL_PORT): Sentinel {
  let requests = 0;
  const server = Bun.serve({
    hostname: '0.0.0.0',
    port,
    fetch: (request) => {
      if (new URL(request.url).pathname === IDENTITY_PATH) {
        return Response.json({
          identity: SENTINEL_IDENTITY,
          health: SENTINEL_HEALTH,
          requests,
        });
      }
      requests += 1;
      return new Response('sentinel', { status: 200 });
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

if (import.meta.main) {
  serveSentinel();
}
