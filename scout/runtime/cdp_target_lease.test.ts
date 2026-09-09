import { expect, test } from 'bun:test';

import {
  acquireCdpTargetLease,
  relayBrowserWebSocketUrl,
  type BrowserTargetSession,
  type CdpTargetLeaseDeps,
} from './cdp_target_lease.ts';

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
