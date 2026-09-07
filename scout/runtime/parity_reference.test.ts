// parity_reference.test.ts — the reference container owns its browser, so its
// boundaries are the only thing standing between a parity sample and the
// production sidecar.
//
// The reference identifier names a directory that the container creates and the
// operator later reads as evidence. An identifier that escapes its parent would
// let one sample overwrite another, or write outside the mounted sample root
// entirely, so containment is asserted before any lifecycle behaviour.
//
// Every test here drives injected stubs; no Chromium and no Scout are launched.

import { expect, test } from 'bun:test';
import {
  parseParityArgs,
  referenceOutputPath,
  resolveReferenceEnvironment,
  validateFixtureUrl,
  validateReferenceId,
} from './parity_reference.ts';

test('reference output is contained and independently named', () => {
  expect(referenceOutputPath('ref-p3')).toBe(
    '/opt/thoth/scout/output/legacy-scout/ref-p3/source-report.json',
  );
  for (const id of ['../p3', '/p3', 'a/b', 'A', '']) {
    expect(() => validateReferenceId(id)).toThrow();
  }
});

// --- lifecycle -------------------------------------------------------------
//
// The supervisor owns two children and must return a code that tells an operator
// what actually happened. The cases below are the ones where a plausible
// implementation reports success wrongly: a browser that dies while Scout is still
// running, a browser death that lands in the same tick as a Scout success, a child
// that ignores SIGTERM, and a result file that cannot be written.

import type { OwnedChild, ReferenceDeps, ReferenceOptions } from './parity_reference.ts';
import { runReference } from './parity_reference.ts';

interface StubChild extends OwnedChild {
  finish: (code: number) => void;
  signals: string[];
}

/** A child that exits only when the test says so, recording every signal it got. */
function deferredChild(stopsOn: string | null = 'SIGTERM'): StubChild {
  let finish!: (code: number) => void;
  const signals: string[] = [];
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  return {
    exited,
    kill: (signal = 'SIGTERM') => {
      signals.push(signal);
      if (stopsOn !== null && signal === stopsOn) finish(0);
    },
    finish,
    signals,
  };
}

function exitedChild(code: number): StubChild {
  const child = deferredChild();
  child.finish(code);
  return child;
}

function options(overrides: Partial<ReferenceOptions> = {}): ReferenceOptions {
  return {
    chromium: '/test/chrome',
    referenceId: 'ref-p3',
    offlineSmoke: true,
    shutdown: new AbortController().signal,
    killGraceMs: 10,
    deadlineMs: 5_000,
    ...overrides,
  };
}

interface Recorded {
  referenceExit: number | null;
  browserExit: number | null;
  cleanupPassed: boolean;
  timedOut: boolean;
  interrupted: boolean;
}

function deps(overrides: Partial<ReferenceDeps> = {}): ReferenceDeps & { recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  return {
    startBrowser: () => deferredChild(),
    waitReady: async () => true,
    startReference: () => exitedChild(0),
    writeResult: async (result) => {
      recorded.push(result);
    },
    recorded,
    ...overrides,
  };
}

test('a browser that never becomes ready stops before Scout is started', async () => {
  const browser = deferredChild();
  let started = 0;
  const dependencies = deps({
    startBrowser: () => browser,
    waitReady: async () => false,
    startReference: () => {
      started += 1;
      return exitedChild(0);
    },
  });

  expect(await runReference(options(), dependencies)).toBe(70);
  expect(started).toBe(0);
  expect(browser.signals).toContain('SIGTERM');
  expect(dependencies.recorded[0].cleanupPassed).toBe(true);
});

test('Scout success stops and reaps the owned browser', async () => {
  const browser = deferredChild();
  const dependencies = deps({ startBrowser: () => browser });

  expect(await runReference(options(), dependencies)).toBe(0);
  expect(browser.signals).toContain('SIGTERM');
  expect(dependencies.recorded[0]).toMatchObject({
    referenceExit: 0,
    cleanupPassed: true,
    timedOut: false,
    interrupted: false,
  });
});

test('a failed reference keeps its own exit code', async () => {
  const dependencies = deps({ startReference: () => exitedChild(1) });

  expect(await runReference(options(), dependencies)).toBe(1);
  expect(dependencies.recorded[0].referenceExit).toBe(1);
});

test('a browser that dies mid-run fails the reference whatever its code', async () => {
  for (const browserCode of [0, 9]) {
    const browser = deferredChild();
    const dependencies = deps({
      startBrowser: () => browser,
      startReference: () => deferredChild(null),
    });
    const pending = runReference(options(), dependencies);
    browser.finish(browserCode);

    expect(await pending).toBe(70);
    expect(dependencies.recorded[0].browserExit).toBe(browserCode);
  }
});

test('a browser death in the same tick defeats a nominal Scout success', async () => {
  const browser = exitedChild(0);
  const dependencies = deps({
    startBrowser: () => browser,
    startReference: () => exitedChild(0),
  });

  expect(await runReference(options(), dependencies)).toBe(70);
});

test('an interruption during startup reports the operator signal', async () => {
  const controller = new AbortController();
  const dependencies = deps({
    waitReady: () => new Promise<boolean>(() => {}),
  });
  const pending = runReference(options({ shutdown: controller.signal }), dependencies);
  controller.abort('SIGTERM');

  expect(await pending).toBe(143);
  expect(dependencies.recorded[0].interrupted).toBe(true);
});

test('an interruption during the run reports SIGINT distinctly', async () => {
  const controller = new AbortController();
  const dependencies = deps({ startReference: () => deferredChild(null) });
  const pending = runReference(options({ shutdown: controller.signal }), dependencies);
  controller.abort('SIGINT');

  expect(await pending).toBe(130);
  expect(dependencies.recorded[0].interrupted).toBe(true);
});

test('the overall deadline stops both children', async () => {
  const browser = deferredChild();
  const dependencies = deps({
    startBrowser: () => browser,
    startReference: () => deferredChild('SIGTERM'),
  });

  expect(await runReference(options({ deadlineMs: 5 }), dependencies)).toBe(124);
  expect(dependencies.recorded[0].timedOut).toBe(true);
  expect(browser.signals).toContain('SIGTERM');
});

test('a child that ignores SIGTERM is escalated to SIGKILL', async () => {
  const browser = deferredChild('SIGKILL');
  const dependencies = deps({ startBrowser: () => browser });

  await runReference(options(), dependencies);

  expect(browser.signals).toEqual(['SIGTERM', 'SIGKILL']);
});

test('a child that survives SIGKILL is a cleanup failure, not a success', async () => {
  const browser = deferredChild(null);
  const dependencies = deps({ startBrowser: () => browser });

  expect(await runReference(options(), dependencies)).toBe(70);
  expect(dependencies.recorded[0].cleanupPassed).toBe(false);
});

test('an unwritable attempt result fails the reference', async () => {
  const dependencies = deps({
    writeResult: async () => {
      throw new Error('result_write_failed');
    },
  });

  expect(await runReference(options(), dependencies)).toBe(70);
});

test('only the launcher-supplied argument shape is accepted', () => {
  expect(parseParityArgs(['--chromium', '/ms-playwright/chromium-1/chrome-linux/chrome'])).toEqual({
    chromium: '/ms-playwright/chromium-1/chrome-linux/chrome',
    offlineSmoke: false,
  });
  expect(parseParityArgs(['--chromium', '/c', '--offline-smoke'])).toEqual({
    chromium: '/c',
    offlineSmoke: true,
  });
  for (const argv of [
    [],
    ['--chromium'],
    ['--chromium', ''],
    ['--offline-smoke'],
    ['--chromium', '/c', '--out', '/tmp/x'],
    ['--chromium', '/c', '--offline-smoke', '--offline-smoke'],
  ]) {
    expect(() => parseParityArgs(argv)).toThrow();
  }
});

test('the fixture must be a bare https URL on a canonical TikTok host', () => {
  expect(validateFixtureUrl('https://www.tiktok.com/@creator/video/7123\n')).toBe(
    'https://www.tiktok.com/@creator/video/7123',
  );
  for (const host of ['tiktok.com', 'm.tiktok.com']) {
    expect(validateFixtureUrl(`https://${host}/@creator/video/7123`)).toContain(host);
  }
  for (const fixture of [
    '',
    '   ',
    'http://www.tiktok.com/@creator/video/7123',
    'https://vm.tiktok.com/ZSABC/',
    'https://www.tiktok.com.evil.test/@creator/video/7123',
    'https://user:pass@www.tiktok.com/@creator/video/7123',
    'https://www.instagram.com/p/abc/',
    'https://www.tiktok.com/@a/video/1\nhttps://www.tiktok.com/@b/video/2',
  ]) {
    expect(() => validateFixtureUrl(fixture)).toThrow();
  }
});

test('a rejected fixture never appears in the failure it raises', () => {
  const secret = 'https://www.tiktok.com/@leaked-handle/video/999?token=canary';
  expect(() => validateFixtureUrl(secret)).toThrow(/^invalid_fixture_url$/);
});

test('the reference refuses to run against a CDP endpoint it does not own', () => {
  expect(resolveReferenceEnvironment({ THOTH_PARITY_REFERENCE_ID: 'ref-p3' })).toEqual({
    referenceId: 'ref-p3',
  });
  expect(
    resolveReferenceEnvironment({
      THOTH_PARITY_REFERENCE_ID: 'ref-p3',
      THOTH_CDP: 'http://127.0.0.1:18801',
    }),
  ).toEqual({ referenceId: 'ref-p3' });
  for (const env of [
    {},
    { THOTH_PARITY_REFERENCE_ID: '../escape' },
    { THOTH_PARITY_REFERENCE_ID: 'ref-p3', THOTH_CDP: 'http://legacy-cdp:18800' },
    { THOTH_PARITY_REFERENCE_ID: 'ref-p3', THOTH_CDP: 'http://127.0.0.1:18800' },
  ]) {
    expect(() => resolveReferenceEnvironment(env)).toThrow();
  }
});

test('the module exposes boundaries without acting on import', async () => {
  const source = await Bun.file(new URL('./parity_reference.ts', import.meta.url)).text();
  expect(source).toContain('if (import.meta.main)');
});
