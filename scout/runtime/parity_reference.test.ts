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
  // The child stops on SIGTERM: a signal code is only reported when the stop it
  // claims actually happened, which the leaked-child case below asserts directly.
  const dependencies = deps({ startReference: () => deferredChild() });
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

// --- failure-safe lifecycle -------------------------------------------------
//
// The cases above all reach teardown because every dependency resolves. A
// dependency that *throws* is the interesting one: a supervisor that lets the
// exception escape leaves an owned Chromium running with nobody to reap it, and
// writes no record of the attempt that leaked it. Ownership has to survive the
// failure of the very code that establishes it.

test('a readiness probe that throws still stops the browser it was probing', async () => {
  const browser = deferredChild();
  let started = 0;
  const dependencies = deps({
    startBrowser: () => browser,
    waitReady: async () => {
      throw new Error('probe_failed');
    },
    startReference: () => {
      started += 1;
      return exitedChild(0);
    },
  });

  expect(await runReference(options(), dependencies)).toBe(70);
  expect(started).toBe(0);
  expect(browser.signals).toContain('SIGTERM');
  expect(dependencies.recorded[0]).toMatchObject({ cleanupPassed: true, referenceExit: null });
});

test('a reference that cannot be spawned still stops the browser it was given', async () => {
  const browser = deferredChild();
  const dependencies = deps({
    startBrowser: () => browser,
    startReference: () => {
      throw new Error('spawn_failed');
    },
  });

  expect(await runReference(options(), dependencies)).toBe(70);
  expect(browser.signals).toContain('SIGTERM');
  expect(dependencies.recorded).toHaveLength(1);
});

test('a browser that cannot be spawned is still a recorded attempt', async () => {
  let started = 0;
  const dependencies = deps({
    startBrowser: () => {
      throw new Error('spawn_failed');
    },
    startReference: () => {
      started += 1;
      return exitedChild(0);
    },
  });

  expect(await runReference(options(), dependencies)).toBe(70);
  expect(started).toBe(0);
  expect(dependencies.recorded[0]).toMatchObject({ browserExit: null, referenceExit: null });
});

test('a leaked child outranks the cancellation that was supposed to reap it', async () => {
  const controller = new AbortController();
  const browser = deferredChild(null);
  const dependencies = deps({
    startBrowser: () => browser,
    startReference: () => deferredChild(null),
  });
  const pending = runReference(options({ shutdown: controller.signal }), dependencies);
  controller.abort('SIGTERM');

  // 143 would say "cancelled, and everything was cleaned up". It was not.
  expect(await pending).toBe(70);
  expect(dependencies.recorded[0]).toMatchObject({ interrupted: true, cleanupPassed: false });
});

test('a leaked child outranks the deadline that was supposed to reap it', async () => {
  const dependencies = deps({
    startBrowser: () => deferredChild(null),
    startReference: () => deferredChild(null),
  });

  expect(await runReference(options({ deadlineMs: 5 }), dependencies)).toBe(70);
  expect(dependencies.recorded[0]).toMatchObject({ timedOut: true, cleanupPassed: false });
});

// --- attempt evidence -------------------------------------------------------
//
// The attempt record is the only structured trace a reference leaves. Creating it
// after acquisition means a container can drive a real browser through a real
// Scout run and then discover it has nowhere to say so. It is therefore reserved
// exclusively before the browser starts: main() cannot reach runReference without
// a workspace, so a reservation that fails is a run that never acquires anything.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReferenceResult } from './parity_reference.ts';
import { finalizeAttempt, prepareWorkspace, readFixture } from './parity_reference.ts';

function evidenceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'parity-evidence-'));
}

test('the attempt record is reserved before anything can be acquired', () => {
  const workspace = prepareWorkspace('ref-p3', evidenceRoot());

  expect(existsSync(workspace.attemptPath)).toBe(true);
  expect(JSON.parse(readFileSync(workspace.attemptPath, 'utf8'))).toMatchObject({
    status: 'pending',
    browser_isolation: 'fresh_ephemeral',
  });
});

test('finalizing replaces the reservation and leaves no partial record behind', async () => {
  const workspace = prepareWorkspace('ref-p3', evidenceRoot());

  await finalizeAttempt(workspace, {
    referenceExit: 0,
    browserExit: 0,
    cleanupPassed: true,
    timedOut: false,
    interrupted: false,
  });

  expect(JSON.parse(readFileSync(workspace.attemptPath, 'utf8'))).toMatchObject({
    status: 'complete',
    browser_isolation: 'fresh_ephemeral',
    cleanupPassed: true,
  });
  expect(readdirSync(workspace.directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});

test('a workspace cannot be prepared twice, or without a mounted evidence root', () => {
  const root = evidenceRoot();
  prepareWorkspace('ref-p3', root);

  expect(() => prepareWorkspace('ref-p3', root)).toThrow();
  expect(() => prepareWorkspace('ref-p3', join(root, 'absent'))).toThrow(/^missing_output_mount$/);
});

test('an unreadable fixture raises a fixed code, not a filesystem error', () => {
  expect(() => readFixture(join(evidenceRoot(), 'absent', 'url'))).toThrow(/^fixture_unreadable$/);
});

// --- diagnostic preservation ------------------------------------------------
//
// p3 and p4 proved a nonzero Scout exit and clean teardown, but the cause survived
// only as free-form log text nobody may quote. Scout now emits allowlisted frames on
// the stderr this workspace already owns, and finalization lifts the validated ones
// into the record. Everything else in that stream stays where it is: the frames are
// reconstructed from the allowlist, never copied out of the file.

import {
  formatSafeRuntimeDiagnostic,
  type SafeRuntimeDiagnostic,
} from '../lib/safe_runtime_diagnostic.ts';

const DISCOVERY_SIGNAL: SafeRuntimeDiagnostic = {
  schema_version: 1,
  kind: 'signal',
  stage: 'trace_source',
  category: 'media_candidate_discovery',
  code: 'profile_discovery_exception',
};

const TERMINAL_EVENT: SafeRuntimeDiagnostic = {
  schema_version: 1,
  kind: 'terminal',
  stage: 'trace_source',
  category: 'unknown',
  code: 'required_stage_failed',
};

const CLEAN_RESULT: ReferenceResult = {
  referenceExit: 1,
  browserExit: 0,
  cleanupPassed: true,
  timedOut: false,
  interrupted: false,
};

// Everything an operator must never find in structured evidence, in the one stream
// that legitimately contains such values.
const CANARIES = [
  'https://www.tiktok.com/@private.handle/video/7677137235434687752',
  '/opt/thoth/scout/output/legacy-scout/ref-p3/source-report.json',
  '7677137235434687752',
  'sessionid=private-session-value',
  'Bearer private-token',
  'reference.stderr.log',
  'TypeError: cannot read properties of undefined',
];

async function finalizeWith(stderrText: string | null): Promise<Record<string, unknown>> {
  const workspace = prepareWorkspace('ref-p3', evidenceRoot());
  if (stderrText === null) rmSync(workspace.stderrPath);
  else writeFileSync(workspace.stderrPath, stderrText);
  await finalizeAttempt(workspace, CLEAN_RESULT);
  return JSON.parse(readFileSync(workspace.attemptPath, 'utf8'));
}

test('the reservation carries no diagnostic claim at all', () => {
  const workspace = prepareWorkspace('ref-p3', evidenceRoot());
  const reserved = JSON.parse(readFileSync(workspace.attemptPath, 'utf8'));

  expect(reserved.status).toBe('pending');
  // Absent, not false: a pending record has made no diagnostic observation, and a
  // `false` here would read as one that failed.
  expect('diagnostics_valid' in reserved).toBe(false);
  expect('diagnostic_events' in reserved).toBe(false);
});

test('validated frames reach the complete record in emission order', async () => {
  const finalized = await finalizeWith(
    `${formatSafeRuntimeDiagnostic(DISCOVERY_SIGNAL)}\n` +
      `some ordinary scout log line\n` +
      `${formatSafeRuntimeDiagnostic(TERMINAL_EVENT)}\n`,
  );

  expect(finalized).toMatchObject({
    status: 'complete',
    diagnostics_valid: true,
    diagnostic_events: [DISCOVERY_SIGNAL, TERMINAL_EVENT],
  });
});

test('a clean stream with no frames is a valid empty observation', async () => {
  expect(await finalizeWith('')).toMatchObject({
    diagnostics_valid: true,
    diagnostic_events: [],
  });
  expect(await finalizeWith('scout ran and said ordinary things\n')).toMatchObject({
    diagnostics_valid: true,
    diagnostic_events: [],
  });
});

test('an untrustworthy stream records invalid diagnostics and no events', async () => {
  const oversized = `${'x'.repeat(1024 * 1024 + 1)}\n${formatSafeRuntimeDiagnostic(TERMINAL_EVENT)}\n`;
  const duplicated = `${formatSafeRuntimeDiagnostic(TERMINAL_EVENT)}\n`.repeat(2);
  const malformed = `THOTH_DIAGNOSTIC {"schema_version":1,"kind":"signal","stage":"trace_source",${''}"category":"media_candidate_discovery","code":"profile_discovery_empty","note":"free form"}\n`;

  for (const stream of [malformed, oversized, duplicated, 'THOTH_DIAGNOSTIC not-json\n', null]) {
    expect(await finalizeWith(stream)).toMatchObject({
      status: 'complete',
      diagnostics_valid: false,
      diagnostic_events: [],
    });
  }
});

test('no value from the stderr stream can reach the attempt record', async () => {
  const hostile =
    CANARIES.map((canary) => `error: ${canary}`).join('\n') +
    '\n' +
    CANARIES.map(
      (canary) =>
        `THOTH_DIAGNOSTIC {"schema_version":1,"kind":"signal","stage":"trace_source",` +
        `"category":"media_candidate_discovery","code":"profile_discovery_empty","leak":"${canary}"}`,
    ).join('\n') +
    `\n${formatSafeRuntimeDiagnostic(TERMINAL_EVENT)}\n`;

  const serialized = JSON.stringify(await finalizeWith(hostile));
  for (const canary of CANARIES) {
    expect(serialized).not.toContain(canary);
  }
});

test('a malformed stream cannot change the lifecycle verdict', async () => {
  const workspace = prepareWorkspace('ref-p3', evidenceRoot());
  writeFileSync(workspace.stderrPath, 'THOTH_DIAGNOSTIC {"kind":"signal"}\n');
  const reference = exitedChild(1);

  const status = await runReference(
    options(),
    deps({
      startReference: () => reference,
      writeResult: (result) => finalizeAttempt(workspace, result),
    }),
  );

  // The Scout exit code, the cleanup verdict, and the record's own lifecycle fields
  // are the same as they would be with a pristine stream.
  expect(status).toBe(1);
  expect(JSON.parse(readFileSync(workspace.attemptPath, 'utf8'))).toMatchObject({
    status: 'complete',
    referenceExit: 1,
    cleanupPassed: true,
    diagnostics_valid: false,
    diagnostic_events: [],
  });
});
