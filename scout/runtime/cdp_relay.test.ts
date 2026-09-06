// cdp_relay.test.ts — the relay is the only reachable CDP surface in the container.
//
// Chromium binds its DevTools port to loopback regardless of
// --remote-debugging-address, so a sibling container can resolve `legacy-cdp` and
// still be refused at TCP. The relay listens on the shared network and forwards to
// the loopback browser. Because that turns a private debugger into a reachable
// service, every test below also pins what the relay must REFUSE to forward.

import { afterAll, expect, test } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';
import { isAllowedDiscoveryPath, rewriteDiscovery, startCdpRelay } from './cdp_relay.ts';

test('discovery advertises the sibling-reachable authority', () => {
  const target = {
    type: 'page',
    url: 'about:blank',
    webSocketDebuggerUrl: 'ws://127.0.0.1:18801/devtools/page/test-id',
  };
  expect(rewriteDiscovery([target], new URL('http://legacy-cdp:18800'))).toEqual([
    { ...target, webSocketDebuggerUrl: 'ws://legacy-cdp:18800/devtools/page/test-id' },
  ]);
});

test('discovery rewrite covers the browser endpoint and leaves other fields intact', () => {
  const version = {
    Browser: 'HeadlessChrome/140.0.0.0',
    'Protocol-Version': '1.3',
    webSocketDebuggerUrl: 'ws://127.0.0.1:18801/devtools/browser/abc-123',
  };
  expect(rewriteDiscovery(version, new URL('http://legacy-cdp:18800'))).toEqual({
    ...version,
    webSocketDebuggerUrl: 'ws://legacy-cdp:18800/devtools/browser/abc-123',
  });
});

test('discovery rewrite tolerates targets without a debugger url', () => {
  const target = { type: 'service_worker', url: 'about:blank' };
  expect(rewriteDiscovery([target], new URL('http://legacy-cdp:18800'))).toEqual([target]);
});

test('relay is not an arbitrary proxy', () => {
  expect(isAllowedDiscoveryPath('/json/version')).toBe(true);
  expect(isAllowedDiscoveryPath('/json/list')).toBe(true);
  expect(isAllowedDiscoveryPath('/json')).toBe(true);
  expect(isAllowedDiscoveryPath('/json/new?https://example.invalid')).toBe(false);
  expect(isAllowedDiscoveryPath('http://example.invalid/json')).toBe(false);
  expect(isAllowedDiscoveryPath('/json/close/abc')).toBe(false);
  expect(isAllowedDiscoveryPath('/json/protocol')).toBe(false);
  expect(isAllowedDiscoveryPath('/json/../etc/passwd')).toBe(false);
  expect(isAllowedDiscoveryPath('//json')).toBe(false);
  expect(isAllowedDiscoveryPath('/devtools/page/known-id')).toBe(false);
});

// ---------------------------------------------------------------------------
// Fake upstream: stands in for Chromium's DevTools endpoint on loopback.
// ---------------------------------------------------------------------------

interface UpstreamState {
  server: Server;
  base: URL;
  requests: string[];
  received: string[];
  sockets: ServerWebSocket<{ id: string }>[];
  bodyOverride?: string;
  delayMs?: number;
}

function startUpstream(): UpstreamState {
  const state: Partial<UpstreamState> = { requests: [], received: [], sockets: [] };
  const server = Bun.serve<{ id: string }, Record<never, never>>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, self) {
      const url = new URL(request.url);
      state.requests!.push(`${request.method} ${url.pathname}`);
      if (url.pathname.startsWith('/devtools/')) {
        const id = url.pathname.split('/').pop() ?? '';
        if (self.upgrade(request, { data: { id } })) return undefined as unknown as Response;
        return new Response('expected websocket', { status: 400 });
      }
      if (state.delayMs) await Bun.sleep(state.delayMs);
      if (state.bodyOverride !== undefined) {
        return new Response(state.bodyOverride, {
          headers: { 'content-type': 'application/json' },
        });
      }
      const port = state.server!.port;
      if (url.pathname === '/json/version') {
        return Response.json({
          Browser: 'HeadlessChrome/140.0.0.0',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/browser-id`,
        });
      }
      return Response.json([
        {
          id: 'page-id',
          type: 'page',
          url: 'about:blank',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-id`,
        },
      ]);
    },
    websocket: {
      maxPayloadLength: 1 << 24,
      open(socket) {
        state.sockets!.push(socket);
      },
      message(socket, message) {
        state.received!.push(String(message));
        socket.send(JSON.stringify({ id: JSON.parse(String(message)).id, result: { ok: true } }));
      },
      close() {},
    },
  });
  state.server = server;
  state.base = new URL(`http://127.0.0.1:${server.port}`);
  return state as UpstreamState;
}

const upstream = startUpstream();
const relay = startCdpRelay({
  upstreamBase: upstream.base,
  advertisedBase: new URL('http://legacy-cdp:18800'),
  hostname: '127.0.0.1',
  port: 0,
});
const relayBase = `http://127.0.0.1:${relay.port}`;

afterAll(async () => {
  await relay.stop();
  upstream.server.stop(true);
});

test('discovery is forwarded and re-advertised through the relay', async () => {
  const response = await fetch(`${relayBase}/json`);
  expect(response.status).toBe(200);
  const targets = (await response.json()) as { webSocketDebuggerUrl: string }[];
  expect(targets[0].webSocketDebuggerUrl).toBe('ws://legacy-cdp:18800/devtools/page/page-id');
  expect(upstream.requests).toContain('GET /json');
});

test('unlisted discovery routes and methods are refused without reaching the browser', async () => {
  const before = upstream.requests.length;
  expect((await fetch(`${relayBase}/json/new?https://example.invalid`)).status).toBe(404);
  expect((await fetch(`${relayBase}/`)).status).toBe(404);
  expect((await fetch(`${relayBase}/json`, { method: 'POST' })).status).toBe(405);
  expect((await fetch(`${relayBase}/json`, { method: 'PUT' })).status).toBe(405);
  expect(upstream.requests.length).toBe(before);
});

test('a websocket session is only opened for an id the relay itself discovered', async () => {
  await fetch(`${relayBase}/json`);
  await fetch(`${relayBase}/json/version`);

  const page = new WebSocket(`ws://127.0.0.1:${relay.port}/devtools/page/page-id`);
  const reply = await new Promise<string>((resolve, reject) => {
    page.addEventListener('open', () =>
      page.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: {} })),
    );
    page.addEventListener('message', (event) => resolve(String(event.data)));
    page.addEventListener('error', () => reject(new Error('relay refused a discovered target')));
    setTimeout(() => reject(new Error('relay session timed out')), 5000);
  });
  expect(JSON.parse(reply)).toEqual({ id: 7, result: { ok: true } });
  expect(upstream.received.length).toBeGreaterThan(0);
  page.close();
});

test('an undiscovered or traversing websocket target is rejected', async () => {
  for (const path of [
    '/devtools/page/not-discovered',
    '/devtools/browser/not-discovered',
    '/devtools/page/../../json',
    '/devtools/inspector.html',
  ]) {
    const status = await new Promise<number | string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${path}`);
      socket.addEventListener('open', () => {
        socket.close();
        resolve('opened');
      });
      socket.addEventListener('error', () => resolve('refused'));
      setTimeout(() => resolve('timeout'), 3000);
    });
    expect(status).toBe('refused');
  }
});

test('an oversized discovery body is refused instead of buffered', async () => {
  upstream.bodyOverride = `[{"padding":"${'x'.repeat(1024 * 1024 + 16)}"}]`;
  try {
    expect((await fetch(`${relayBase}/json`)).status).toBe(502);
  } finally {
    upstream.bodyOverride = undefined;
  }
});

test('unparseable upstream discovery fails closed with a safe body', async () => {
  upstream.bodyOverride = 'not json at all';
  try {
    const response = await fetch(`${relayBase}/json`);
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain('not json at all');
    expect(body).not.toContain(String(upstream.server.port));
  } finally {
    upstream.bodyOverride = undefined;
  }
});

test('a stalled browser does not hold the discovery request open', async () => {
  upstream.delayMs = 6500;
  try {
    const started = Date.now();
    const response = await fetch(`${relayBase}/json`);
    expect(response.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(6000);
  } finally {
    upstream.delayMs = undefined;
  }
}, 15000);

test('stop() releases the listener', async () => {
  const disposable = startCdpRelay({
    upstreamBase: upstream.base,
    advertisedBase: new URL('http://legacy-cdp:18800'),
    hostname: '127.0.0.1',
    port: 0,
  });
  expect((await fetch(`http://127.0.0.1:${disposable.port}/json`)).status).toBe(200);
  await disposable.stop();
  await expect(fetch(`http://127.0.0.1:${disposable.port}/json`)).rejects.toThrow();
});
