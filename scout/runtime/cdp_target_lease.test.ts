import { expect, test } from 'bun:test';

import {
  acquireCdpTargetLease,
  relayBrowserWebSocketUrl,
  waitForWebSocketOpen,
  type BrowserTargetSession,
  type CdpTargetLeaseDeps,
} from './cdp_target_lease.ts';

class OpeningSocket extends EventTarget {
  closed = 0;
  readonly removed: string[] = [];

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
    this.removed.push(type);
    super.removeEventListener(type, callback);
  }

  close() {
    this.closed += 1;
  }
}

test('a WebSocket open error closes the socket and removes both listeners', async () => {
  const socket = new OpeningSocket();
  const waiting = waitForWebSocketOpen(socket, 100);
  socket.dispatchEvent(new Event('error'));

  await expect(waiting).rejects.toThrow('cdp_browser_session_failed');
  expect(socket.closed).toBe(1);
  expect(socket.removed).toEqual(['open', 'error']);
});

test('a WebSocket open timeout closes the socket and removes both listeners', async () => {
  const socket = new OpeningSocket();

  await expect(waitForWebSocketOpen(socket, 1)).rejects.toThrow('cdp_browser_session_failed');
  expect(socket.closed).toBe(1);
  expect(socket.removed).toEqual(['open', 'error']);
});

test('browser discovery keeps only the path and uses the configured relay authority', () => {
  expect(
    relayBrowserWebSocketUrl(
      'ws://private-browser-canary:9222/devtools/browser/browser-1',
      'http://legacy-cdp:18800',
    ),
  ).toBe('ws://legacy-cdp:18800/devtools/browser/browser-1');
  expect(() =>
    relayBrowserWebSocketUrl(
      'ws://private-browser-canary:9222/devtools/page/page-1',
      'http://legacy-cdp:18800',
    ),
  ).toThrow('cdp_browser_discovery_failed');
});

function fixture(overrides: Partial<CdpTargetLeaseDeps> = {}) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  let closed = 0;
  const session: BrowserTargetSession = {
    async command(method, params) {
      calls.push([method, params]);
      if (method === 'Target.createTarget') return { targetId: 'leased-1' };
      if (method === 'Target.closeTarget') return { success: true };
      throw new Error('unexpected');
    },
    close() {
      closed += 1;
    },
  };
  const deps: CdpTargetLeaseDeps = {
    discoverBrowser: async () => ({
      webSocketDebuggerUrl: 'ws://legacy-cdp:18800/devtools/browser/browser-1',
    }),
    discoverPages: async () => [
      {
        id: 'leased-1',
        type: 'page',
        url: 'about:blank',
        webSocketDebuggerUrl: 'ws://legacy-cdp:18800/devtools/page/leased-1',
      },
    ],
    openBrowserSession: async () => session,
    sleep: async () => {},
    ...overrides,
  };
  return { deps, calls, closed: () => closed };
}

test('creates, discovers, and closes one owned page', async () => {
  const state = fixture();
  const lease = await acquireCdpTargetLease(state.deps);
  expect(lease.targetId).toBe('leased-1');
  expect(state.calls[0]).toEqual(['Target.createTarget', { url: 'about:blank' }]);
  await lease.close();
  await lease.close();
  expect(state.calls.filter(([method]) => method === 'Target.closeTarget')).toEqual([
    ['Target.closeTarget', { targetId: 'leased-1' }],
  ]);
  expect(state.closed()).toBe(1);
});

test('closes an allocated page when discovery never exposes it', async () => {
  const state = fixture({ discoverPages: async () => [] });
  await expect(acquireCdpTargetLease(state.deps, { discoveryAttempts: 2 })).rejects.toThrow(
    'cdp_target_unavailable',
  );
  expect(state.calls.at(-1)).toEqual(['Target.closeTarget', { targetId: 'leased-1' }]);
  expect(state.closed()).toBe(1);
});

test('rejects malformed create response without leaking it', async () => {
  const canary = 'private-target/canary';
  const state = fixture({
    openBrowserSession: async () => ({
      command: async () => ({ targetId: canary }),
      close() {},
    }),
  });
  await expect(acquireCdpTargetLease(state.deps)).rejects.toThrow('cdp_target_create_failed');
  try {
    await acquireCdpTargetLease(state.deps);
  } catch (error) {
    expect(String(error)).not.toContain(canary);
  }
});

test('cleanup failure is fixed and closes the browser session', async () => {
  const state = fixture({
    openBrowserSession: async () => ({
      command: async (method) =>
        method === 'Target.createTarget' ? { targetId: 'leased-1' } : { success: false },
      close() {},
    }),
  });
  const lease = await acquireCdpTargetLease(state.deps);
  await expect(lease.close()).rejects.toThrow('cdp_target_cleanup_failed');
});

test('a discovery exception closes an already allocated target', async () => {
  const state = fixture({
    discoverPages: async () => {
      throw new Error('private-discovery-canary');
    },
  });

  await expect(acquireCdpTargetLease(state.deps)).rejects.toThrow('cdp_target_create_failed');
  expect(state.calls.at(-1)).toEqual(['Target.closeTarget', { targetId: 'leased-1' }]);
  expect(state.closed()).toBe(1);
});

test('a readiness wait exception closes an already allocated target', async () => {
  const state = fixture({
    discoverPages: async () => [],
    sleep: async () => {
      throw new Error('private-sleep-canary');
    },
  });

  await expect(acquireCdpTargetLease(state.deps)).rejects.toThrow('cdp_target_create_failed');
  expect(state.calls.at(-1)).toEqual(['Target.closeTarget', { targetId: 'leased-1' }]);
  expect(state.closed()).toBe(1);
});

test('failed post-allocation cleanup outranks the discovery error', async () => {
  const calls: string[] = [];
  const state = fixture({
    discoverPages: async () => {
      throw new Error('private-discovery-canary');
    },
    openBrowserSession: async () => ({
      async command(method) {
        calls.push(method);
        if (method === 'Target.createTarget') return { targetId: 'leased-1' };
        return { success: false };
      },
      close() {},
    }),
  });

  await expect(acquireCdpTargetLease(state.deps)).rejects.toThrow(
    'cdp_target_cleanup_failed',
  );
  expect(calls).toEqual(['Target.createTarget', 'Target.closeTarget']);
});
