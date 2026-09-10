import { expect, test } from 'bun:test';

import {
  legacyFallbackChildOptions,
  legacyFallbackCommand,
  parseLegacyFallbackArgs,
  runLegacyFallback,
  type LegacyFallbackDeps,
} from './legacy_fallback.ts';

test('production child streams are suppressed at the supervisor boundary', () => {
  expect(legacyFallbackChildOptions({ THOTH_CDP_TARGET_ID: 'leased-1' })).toEqual({
    cwd: '/opt/thoth',
    env: { THOTH_CDP_TARGET_ID: 'leased-1' },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
});

test('production command is source-only and has one fixed shape', () => {
  const args = parseLegacyFallbackArgs([
    '--url',
    'https://example.test/post/1',
    '--out',
    '/tmp/source-report.json',
  ]);
  expect(legacyFallbackCommand(args)).toEqual([
    'bun',
    'scout/cli.ts',
    'run',
    'https://example.test/post/1',
    '--out',
    '/tmp/source-report.json',
    '--source-reference-only',
  ]);
  for (const invalid of [[], ['--url', 'secret'], ['--offline-smoke', 'extra']]) {
    expect(() => parseLegacyFallbackArgs(invalid)).toThrow('invalid_arguments');
  }
});

function fixture(childCode: number, cleanupFails = false) {
  const order: string[] = [];
  let environment: Record<string, string | undefined> = {};
  const deps: LegacyFallbackDeps = {
    acquireLease: async () => ({
      targetId: 'leased-1',
      async close() {
        order.push('close');
        if (cleanupFails) throw new Error('private-cleanup-canary');
      },
    }),
    spawn(command, env) {
      order.push(`spawn:${command.at(-1)}`);
      environment = env;
      return { exited: Promise.resolve(childCode), kill() {} };
    },
    sleep: async () => {},
  };
  return { deps, order, environment: () => environment };
}

test('returns child status only after target cleanup', async () => {
  const state = fixture(17);
  const status = await runLegacyFallback(
    parseLegacyFallbackArgs(['--url', 'https://example.test/post/1', '--out', '/tmp/report.json']),
    new AbortController().signal,
    state.deps,
  );
  expect(status).toBe(17);
  expect(state.order).toEqual(['spawn:--source-reference-only', 'close']);
  expect(state.environment().THOTH_CDP_TARGET_ID).toBe('leased-1');
});

test('cleanup failure outranks child success', async () => {
  const state = fixture(0, true);
  expect(
    await runLegacyFallback(
      parseLegacyFallbackArgs(['--url', 'https://example.test/post/1', '--out', '/tmp/report.json']),
      new AbortController().signal,
      state.deps,
    ),
  ).toBe(70);
});

test('shutdown forwards signal, reaps child, and closes target', async () => {
  let finish = (_code: number) => {};
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const signals: string[] = [];
  const controller = new AbortController();
  const deps: LegacyFallbackDeps = {
    acquireLease: async () => ({ targetId: 'leased-1', close: async () => signals.push('closed') }),
    spawn: () => ({
      exited,
      kill(signal = 'SIGTERM') {
        signals.push(String(signal));
        finish(143);
      },
    }),
    sleep: async () => {},
  };
  const running = runLegacyFallback({ kind: 'offline-smoke' }, controller.signal, deps);
  controller.abort('SIGTERM');
  expect(await running).toBe(143);
  expect(signals).toEqual(['SIGTERM', 'closed']);
});

test('an invalid lease is still closed before failing', async () => {
  let closed = false;
  const state = fixture(0);
  state.deps.acquireLease = async () => ({
    targetId: '../invalid',
    async close() {
      closed = true;
    },
  });
  expect(
    await runLegacyFallback(
      { kind: 'offline-smoke' },
      new AbortController().signal,
      state.deps,
    ),
  ).toBe(70);
  expect(closed).toBe(true);
});

test('a child launch failure still closes the leased target', async () => {
  let closed = false;
  const deps: LegacyFallbackDeps = {
    acquireLease: async () => ({
      targetId: 'leased-1',
      async close() {
        closed = true;
      },
    }),
    spawn() {
      throw new Error('private-launch-canary');
    },
    sleep: async () => {},
  };

  expect(
    await runLegacyFallback(
      { kind: 'offline-smoke' },
      new AbortController().signal,
      deps,
    ),
  ).toBe(70);
  expect(closed).toBe(true);
});

test('SIGINT is forwarded before the child is reaped and the target is closed', async () => {
  let finish = (_code: number) => {};
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const order: string[] = [];
  const controller = new AbortController();
  const deps: LegacyFallbackDeps = {
    acquireLease: async () => ({
      targetId: 'leased-1',
      async close() {
        order.push('closed');
      },
    }),
    spawn: () => ({
      exited,
      kill(signal = 'SIGTERM') {
        order.push(String(signal));
        finish(130);
      },
    }),
    sleep: async () => {},
  };

  const running = runLegacyFallback({ kind: 'offline-smoke' }, controller.signal, deps);
  controller.abort('SIGINT');
  expect(await running).toBe(130);
  expect(order).toEqual(['SIGINT', 'closed']);
});

test('an unresponsive child is force-killed before target cleanup', async () => {
  let finish = (_code: number) => {};
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const order: string[] = [];
  const controller = new AbortController();
  const deps: LegacyFallbackDeps = {
    acquireLease: async () => ({
      targetId: 'leased-1',
      async close() {
        order.push('closed');
      },
    }),
    spawn: () => ({
      exited,
      kill(signal = 'SIGTERM') {
        order.push(String(signal));
        if (signal === 'SIGKILL') finish(137);
      },
    }),
    sleep: async () => {},
  };

  const running = runLegacyFallback({ kind: 'offline-smoke' }, controller.signal, deps);
  controller.abort('SIGTERM');
  expect(await running).toBe(143);
  expect(order).toEqual(['SIGTERM', 'SIGKILL', 'closed']);
});
