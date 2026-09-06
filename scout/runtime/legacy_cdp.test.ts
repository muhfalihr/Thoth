// legacy_cdp.test.ts — the sidecar is a supervisor, not a browser.
//
// The container used to `exec` Chromium directly, so its PID 1 process was the only
// thing that could fail. Now a relay and a browser must live and die together: if
// either one is gone the sidecar must exit nonzero so the container restarts instead
// of advertising a port that answers with nothing behind it.
//
// Every test drives a harmless stub child; no Chromium is launched here.

import { expect, test } from 'bun:test';
import type { RelayHandle } from './cdp_relay.ts';
import {
  CHROMIUM_DEVTOOLS_BASE,
  chromiumArguments,
  parseLegacyCdpArgs,
  RELAY_ADVERTISED_BASE,
  superviseLegacyCdp,
} from './legacy_cdp.ts';

interface StubChild {
  exited: Promise<number>;
  signals: string[];
  kill(signal?: string): void;
  finish(code: number): void;
}

function stubChild(): StubChild {
  let settle: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });
  return {
    exited,
    signals: [],
    kill(signal = 'SIGTERM') {
      this.signals.push(signal);
      if (signal === 'SIGKILL') settle(137);
    },
    finish: (code: number) => settle(code),
  };
}

function stubRelay(): RelayHandle & { stopped: boolean } {
  return {
    port: 18800,
    stopped: false,
    async stop() {
      this.stopped = true;
    },
  };
}

test('the launcher accepts only its own fixed arguments', () => {
  expect(parseLegacyCdpArgs(['--chromium', '/c/chrome', '--profile', '/p'])).toEqual({
    chromium: '/c/chrome',
    profile: '/p',
    offlineSmoke: false,
  });
  expect(
    parseLegacyCdpArgs(['--chromium', '/c/chrome', '--profile', '/p', '--offline-smoke']),
  ).toEqual({ chromium: '/c/chrome', profile: '/p', offlineSmoke: true });

  for (const argv of [
    [],
    ['--chromium', '/c/chrome'],
    ['--profile', '/p'],
    ['--chromium', '/c/chrome', '--profile'],
    ['--chromium', '/c/chrome', '--profile', '/p', '--no-sandbox'],
    ['--chromium', '/c/chrome', '--profile', '/p', 'https://www.tiktok.com/'],
    ['--chromium', '/c/chrome', '--chromium', '/other', '--profile', '/p'],
    ['--offline-smoke'],
  ]) {
    expect(() => parseLegacyCdpArgs(argv)).toThrow();
  }
});

test('chromium is bound to loopback and keeps its sandbox', () => {
  const args = chromiumArguments({ chromium: '/c/chrome', profile: '/p', offlineSmoke: false });
  expect(args[0]).toBe('/c/chrome');
  expect(args).toContain('--headless=new');
  expect(args).toContain('--remote-debugging-address=127.0.0.1');
  expect(args).toContain(`--remote-debugging-port=${CHROMIUM_DEVTOOLS_BASE.port}`);
  expect(args).toContain('--user-data-dir=/p');
  expect(args).toContain('https://www.tiktok.com/');
  expect(args.join(' ')).not.toContain('--no-sandbox');
  expect(args.join(' ')).not.toContain('--remote-allow-origins');
  expect(CHROMIUM_DEVTOOLS_BASE.hostname).toBe('127.0.0.1');
  expect(RELAY_ADVERTISED_BASE.href).toBe('http://legacy-cdp:18800/');
});

test('offline smoke opens a blank page instead of the live launcher target', () => {
  const args = chromiumArguments({ chromium: '/c/chrome', profile: '/p', offlineSmoke: true });
  expect(args).toContain('about:blank');
  expect(args.join(' ')).not.toContain('tiktok.com');
});

test('a signal stops the relay and the browser and exits cleanly', async () => {
  const child = stubChild();
  const relay = stubRelay();
  const shutdown = new AbortController();
  const supervision = superviseLegacyCdp(
    { chromium: '/c/chrome', profile: '/p', offlineSmoke: true, shutdown: shutdown.signal },
    {
      spawn: () => child,
      startRelay: () => relay,
      probeReady: async () => true,
    },
  );
  await Bun.sleep(10);
  shutdown.abort();
  await Bun.sleep(10);
  child.finish(0);
  expect(await supervision).toBe(0);
  expect(relay.stopped).toBe(true);
  expect(child.signals[0]).toBe('SIGTERM');
});

test('a browser that will not stop is force killed after the grace period', async () => {
  const child = stubChild();
  const shutdown = new AbortController();
  const supervision = superviseLegacyCdp(
    {
      chromium: '/c/chrome',
      profile: '/p',
      offlineSmoke: true,
      shutdown: shutdown.signal,
      killGraceMs: 30,
    },
    { spawn: () => child, startRelay: stubRelay, probeReady: async () => true },
  );
  await Bun.sleep(10);
  shutdown.abort();
  expect(await supervision).toBe(0);
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
});

test('a browser that exits first fails the sidecar even with a zero status', async () => {
  const child = stubChild();
  const relay = stubRelay();
  const supervision = superviseLegacyCdp(
    {
      chromium: '/c/chrome',
      profile: '/p',
      offlineSmoke: false,
      shutdown: new AbortController().signal,
    },
    { spawn: () => child, startRelay: () => relay, probeReady: async () => true },
  );
  await Bun.sleep(10);
  child.finish(0);
  expect(await supervision).not.toBe(0);
  expect(relay.stopped).toBe(true);
});

test('a relay that cannot bind takes the browser down with it', async () => {
  const child = stubChild();
  const supervision = superviseLegacyCdp(
    {
      chromium: '/c/chrome',
      profile: '/p',
      offlineSmoke: true,
      shutdown: new AbortController().signal,
      killGraceMs: 30,
    },
    {
      spawn: () => child,
      startRelay: () => {
        throw new Error('EADDRINUSE 0.0.0.0:18800');
      },
      probeReady: async () => true,
    },
  );
  expect(await supervision).not.toBe(0);
  expect(child.signals).toContain('SIGTERM');
});

test('a browser that never serves devtools is not left running', async () => {
  const child = stubChild();
  let relayStarted = false;
  const supervision = superviseLegacyCdp(
    {
      chromium: '/c/chrome',
      profile: '/p',
      offlineSmoke: true,
      shutdown: new AbortController().signal,
      startupTimeoutMs: 40,
      killGraceMs: 30,
    },
    {
      spawn: () => child,
      startRelay: () => {
        relayStarted = true;
        return stubRelay();
      },
      probeReady: async (_base, deadlineMs) => {
        await Bun.sleep(deadlineMs + 20);
        return false;
      },
    },
  );
  expect(await supervision).not.toBe(0);
  expect(relayStarted).toBe(false);
  expect(child.signals).toContain('SIGTERM');
});

test('the relay is never started for a browser that already died', async () => {
  const child = stubChild();
  let relayStarted = false;
  const supervision = superviseLegacyCdp(
    {
      chromium: '/c/chrome',
      profile: '/p',
      offlineSmoke: true,
      shutdown: new AbortController().signal,
      killGraceMs: 30,
    },
    {
      spawn: () => child,
      startRelay: () => {
        relayStarted = true;
        return stubRelay();
      },
      probeReady: async () => {
        await Bun.sleep(50);
        return true;
      },
    },
  );
  await Bun.sleep(10);
  child.finish(1);
  expect(await supervision).not.toBe(0);
  expect(relayStarted).toBe(false);
});
