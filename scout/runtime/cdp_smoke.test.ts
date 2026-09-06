// cdp_smoke.test.ts — the probe is only useful if it fails when transport is broken.
//
// The bug it guards against produces a browser that answers perfectly on loopback, so
// a probe that accepts a loopback debugger URL, or that treats an unreachable endpoint
// as "skip", would have passed the very deployment that was broken. Both cases below
// therefore require a nonzero exit from the real executable.

import { afterAll, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { isSiblingReachable } from './cdp_smoke.ts';

const servers: Server[] = [];

afterAll(() => {
  for (const server of servers) server.stop(true);
});

function serve(handler: (request: Request) => Response): URL {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  servers.push(server);
  return new URL(`http://127.0.0.1:${server.port}`);
}

async function runProbe(base: URL): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn(['bun', 'scout/runtime/cdp_smoke.ts'], {
    cwd: Bun.fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, THOTH_CDP: base.href },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(child.stdout).text();
  return { exitCode: await child.exited, stdout };
}

test('a loopback debugger url is not sibling reachable', () => {
  const base = new URL('http://legacy-cdp:18800');

  expect(isSiblingReachable('ws://legacy-cdp:18800/devtools/browser/abc', base)).toBe(true);
  expect(isSiblingReachable('ws://127.0.0.1:18800/devtools/browser/abc', base)).toBe(false);
  expect(isSiblingReachable('ws://localhost:18800/devtools/browser/abc', base)).toBe(false);
  expect(isSiblingReachable('ws://legacy-cdp:18801/devtools/browser/abc', base)).toBe(false);
  expect(isSiblingReachable('http://legacy-cdp:18800/devtools/browser/abc', base)).toBe(false);
  expect(isSiblingReachable(undefined, base)).toBe(false);
});

test('an endpoint that advertises loopback sockets fails instead of passing', async () => {
  const base = serve((request) => {
    const loopback = `ws://${new URL(request.url).host}/devtools`;
    if (new URL(request.url).pathname === '/json/version') {
      return Response.json({ Browser: 'HeadlessChrome/140.0.0.0', webSocketDebuggerUrl: `${loopback}/browser/abc` });
    }
    return Response.json([
      { type: 'page', url: 'about:blank', webSocketDebuggerUrl: `${loopback}/page/abc` },
    ]);
  });

  const result = await runProbe(base);

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe('http_pass=false\nbrowser_ws_pass=false\nscout_page_ws_pass=false\n');
});

test('an unreachable endpoint fails instead of being skipped', async () => {
  const base = serve(() => new Response('not found', { status: 404 }));

  const result = await runProbe(base);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('http_pass=false\nbrowser_ws_pass=false\nscout_page_ws_pass=false\n');
});

test('the probe prints only the three transport results', async () => {
  const source = await Bun.file(new URL('./cdp_smoke.ts', import.meta.url)).text();
  const printed = [...source.matchAll(/Bun\.write\(|console\.(log|error|warn)/g)];

  expect(printed).toHaveLength(1);
});
