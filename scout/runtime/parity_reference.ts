// parity_reference.ts — run one Scout parity reference against a browser this
// container owns, so a reference can never disturb the production sidecar.
//
// WHY: a reference run drives the browser wherever the source trail leads. When it
// shares the deployment's single sidecar it also shares that sidecar's only page,
// and the production healthcheck asserts a qualifying TikTok page. One reference
// therefore leaves a healthy CDP endpoint attached to a container Docker reports as
// unhealthy, which blocks any worker restart until an operator intervenes. The fix
// is ownership, not restoration: this entrypoint starts its own Chromium on a fresh
// throwaway profile and points only its own Scout child at it.
//
// The profile is anonymous by design. Nothing here copies, mounts, or seeds the
// production profile or its cookies, so an authentication wall during a reference is
// a recorded stop rather than a prompt to import a session.
//
// Both children are owned: every exit path stops and reaps them, and a child that
// outlives SIGKILL is reported as a cleanup failure rather than quietly ignored.
// A lifecycle that ends cleanly still says nothing about artifact validity or
// parity; those verdicts belong to the operator comparison, not to this process.

import { SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS } from '../lib/parity_reference_contract.ts';

const OUTPUT_ROOT = '/opt/thoth/scout/output/legacy-scout';
const REFERENCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** The reference browser is loopback-only and never the production relay. */
export const REFERENCE_CDP_BASE = new URL('http://127.0.0.1:18801');
/** A throwaway profile: a fresh tmpfs per container, never production storage. */
export const REFERENCE_PROFILE_DIR = '/var/lib/thoth/parity-profile';

// sysexits: an internal failure, distinct from a bad invocation (64) and from
// Scout's own nonzero result, which is preserved as evidence rather than remapped.
const UNEXPECTED_FAILURE_EXIT = 70;
const DEADLINE_EXIT = 124;
const SIGINT_EXIT = 130;
const SIGTERM_EXIT = 143;

const DEFAULT_KILL_GRACE_MS = 5_000;

export interface ReferenceOptions {
  chromium: string;
  referenceId: string;
  offlineSmoke: boolean;
  shutdown: AbortSignal;
  deadlineMs?: number;
  killGraceMs?: number;
}

export interface OwnedChild {
  exited: Promise<number>;
  kill(signal?: string): void;
}

export interface ReferenceResult {
  referenceExit: number | null;
  browserExit: number | null;
  cleanupPassed: boolean;
  timedOut: boolean;
  interrupted: boolean;
}

export interface ReferenceDeps {
  startBrowser(options: ReferenceOptions): OwnedChild;
  waitReady(signal: AbortSignal): Promise<boolean>;
  startReference(options: ReferenceOptions): OwnedChild;
  writeResult(result: ReferenceResult): Promise<void>;
}

/** A reference identifier names a directory, so it may not escape its parent. */
export function validateReferenceId(value: string): string {
  if (!REFERENCE_ID_PATTERN.test(value)) throw new Error('invalid_reference_id');
  return value;
}

/** The report location is fixed by the identifier; callers never choose a path. */
export function referenceOutputPath(id: string): string {
  return `${OUTPUT_ROOT}/${validateReferenceId(id)}/source-report.json`;
}

// The canonicalizer's exact hosts. Shorteners are excluded on purpose: resolving one
// is a network redirect, so it cannot be validated before the browser is running.
const FIXTURE_HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
const FIXTURE_PATH_PATTERN = /^\/@[^/]+\/(video|photo)\/[0-9]+$/;

export interface ParityArgs {
  chromium: string;
  offlineSmoke: boolean;
}

/** The launcher passes a fixed argument shape; anything else is a caller mistake. */
export function parseParityArgs(argv: string[]): ParityArgs {
  let chromium = '';
  let offlineSmoke = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--chromium') {
      index += 1;
      if (chromium || !argv[index]) throw new Error('invalid_arguments');
      chromium = argv[index];
    } else if (flag === '--offline-smoke') {
      if (offlineSmoke) throw new Error('invalid_arguments');
      offlineSmoke = true;
    } else {
      throw new Error('invalid_arguments');
    }
  }
  if (!chromium) throw new Error('invalid_arguments');
  return { chromium, offlineSmoke };
}

/**
 * Accept only a fixture already in canonical form: https, an exact TikTok host, no
 * credentials, port, query, or fragment. A query string would carry a session or
 * tracking token into the browser and into Scout's argv, and the canonicalizer
 * never emits one, so rejecting it costs no legitimate fixture.
 *
 * The rejection never quotes the value: this input is operator evidence and may
 * carry a token, and the console is not a restricted channel.
 */
export function validateFixtureUrl(raw: string): string {
  const value = raw.trim();
  let parsed: URL;
  try {
    // Whitespace or a control character means the mount holds more than one bare URL,
    // or something that would be silently reshaped by the URL parser.
    const printable = Array.from(value).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x20 && code !== 0x7f;
    });
    if (!value || !printable) throw new Error('invalid_fixture_url');
    parsed = new URL(value);
  } catch {
    throw new Error('invalid_fixture_url');
  }
  const canonical =
    parsed.protocol === 'https:' &&
    FIXTURE_HOSTS.has(parsed.hostname) &&
    parsed.host === parsed.hostname &&
    !parsed.username &&
    !parsed.password &&
    !parsed.search &&
    !parsed.hash &&
    FIXTURE_PATH_PATTERN.test(parsed.pathname);
  if (!canonical) throw new Error('invalid_fixture_url');
  return value;
}

interface Tracked {
  promise: Promise<number>;
  settled: boolean;
  code: number | null;
}

/** Remember a child exit so a death in the same tick as success is still visible. */
function track(source: Promise<number>): Tracked {
  const state: Tracked = { promise: Promise.resolve(0), settled: false, code: null };
  state.promise = source.then((code) => {
    state.settled = true;
    state.code = code;
    return code;
  });
  return state;
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

/** SIGTERM, then SIGKILL after the grace period. False means it outlived both. */
async function stop(child: OwnedChild, exit: Tracked, graceMs: number): Promise<boolean> {
  if (exit.settled) return true;
  child.kill('SIGTERM');
  await Promise.race([exit.promise, Bun.sleep(graceMs)]);
  if (exit.settled) return true;
  child.kill('SIGKILL');
  await Promise.race([exit.promise, Bun.sleep(graceMs)]);
  return exit.settled;
}

type Outcome =
  | { kind: 'ready' }
  | { kind: 'unready' }
  | { kind: 'failed' }
  | { kind: 'browser' }
  | { kind: 'reference'; code: number }
  | { kind: 'interrupted'; signal: unknown }
  | { kind: 'deadline' };

/**
 * Supervise the owned browser and the Scout reference until one of them stops.
 *
 * Returns the Scout exit code when the lifecycle is clean, and otherwise the code
 * for what actually went wrong: an operator signal, the supervised acquisition
 * deadline, or an unexpected browser death or failed cleanup. A nominal Scout
 * success never outranks an observed browser death.
 *
 * The deadline bounds acquisition only — browser startup and readiness through
 * the browser/reference outcome. Once an outcome is selected the timer is
 * cleared, and owned-child teardown plus attempt finalization run to completion
 * outside it. That post-outcome work is mandatory, not something a deadline may
 * skip: a timed-out reference is still reaped and still finalized before 124 is
 * returned.
 */
export async function runReference(
  options: ReferenceOptions,
  deps: ReferenceDeps,
): Promise<number> {
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(),
    options.deadlineMs ?? SOURCE_REFERENCE_SUPERVISOR_DEADLINE_MS,
  );

  let browser: OwnedChild | null = null;
  let browserExit: Tracked | null = null;
  let reference: OwnedChild | null = null;
  let referenceExit: Tracked | null = null;

  const interrupt = aborted(options.shutdown).then(
    () => ({ kind: 'interrupted', signal: options.shutdown.reason }) as Outcome,
  );
  const expired = aborted(deadline.signal).then(() => ({ kind: 'deadline' }) as Outcome);

  // Startup lives inside the same block as the run: a dependency that throws
  // must not carry the exception past teardown, or an owned Chromium survives
  // with nobody left to reap it and no record that it was ever started.
  let outcome: Outcome = { kind: 'failed' };
  try {
    browser = deps.startBrowser(options);
    browserExit = track(browser.exited);
    outcome = await Promise.race([
      deps
        .waitReady(AbortSignal.any([options.shutdown, deadline.signal]))
        .then((value) => ({ kind: value ? 'ready' : 'unready' }) as Outcome),
      browserExit.promise.then(() => ({ kind: 'browser' }) as Outcome),
      interrupt,
      expired,
    ]);

    if (outcome.kind === 'ready') {
      reference = deps.startReference(options);
      referenceExit = track(reference.exited);
      outcome = await Promise.race([
        referenceExit.promise.then((code) => ({ kind: 'reference', code }) as Outcome),
        browserExit.promise.then(() => ({ kind: 'browser' }) as Outcome),
        interrupt,
        expired,
      ]);
      // A browser death and a Scout success can settle in the same tick, so both
      // handlers are allowed to run before the outcome is judged.
      await Promise.resolve();
    }
  } catch {
    // A dependency failure is a failed attempt, not an escaping exception. Its
    // text is never echoed: it can name the fixture path or the environment.
    outcome = { kind: 'failed' };
  } finally {
    clearTimeout(timer);
  }

  // Snapshot the browser before teardown: after it, every path shows a stopped
  // browser, and a normal shutdown would be indistinguishable from an early death.
  const browserDiedEarly = browserExit?.settled ?? false;

  let cleanupPassed = true;
  if (reference && referenceExit) {
    cleanupPassed = (await stop(reference, referenceExit, killGraceMs)) && cleanupPassed;
  }
  if (browser && browserExit) {
    cleanupPassed = (await stop(browser, browserExit, killGraceMs)) && cleanupPassed;
  }

  const timedOut = outcome.kind === 'deadline';
  const interrupted = outcome.kind === 'interrupted';
  try {
    await deps.writeResult({
      referenceExit: referenceExit?.code ?? null,
      browserExit: browserExit?.code ?? null,
      cleanupPassed,
      timedOut,
      interrupted,
    });
  } catch {
    // The attempt record is the only durable trace of this run, so a reference that
    // cannot be recorded is not a reference that succeeded.
    return UNEXPECTED_FAILURE_EXIT;
  }

  // A child that outlived SIGKILL outranks every other verdict. It is the leak
  // this entrypoint exists to prevent, and neither a cancellation nor a deadline
  // explains it away: reporting 143 there would claim a clean stop that did not
  // happen, and CI would accept broken reaping as a pass.
  if (!cleanupPassed) return UNEXPECTED_FAILURE_EXIT;
  if (outcome.kind === 'interrupted') {
    return outcome.signal === 'SIGINT' ? SIGINT_EXIT : SIGTERM_EXIT;
  }
  if (timedOut) return DEADLINE_EXIT;
  if (outcome.kind !== 'reference') return UNEXPECTED_FAILURE_EXIT;
  if (browserDiedEarly) return UNEXPECTED_FAILURE_EXIT;
  return outcome.code;
}

// --- production wiring ------------------------------------------------------
//
// Everything below touches the filesystem, the environment, or real subprocesses.
// It is deliberately thin: the decisions live in the pure boundaries and in
// runReference above, which the tests drive with injected children.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {
  parseSafeRuntimeDiagnostics,
  type SafeRuntimeDiagnostic,
} from '../lib/safe_runtime_diagnostic.ts';
import { chromiumArguments } from './legacy_cdp.ts';

/** The sample evidence mount. Absent means the container was started wrongly. */
const OUTPUT_MOUNT = '/opt/thoth/scout/output';
/** The fixture is read from the mount, never from argv or the environment. */
const FIXTURE_PATH = '/run/parity/url';

const READY_BUDGET_MS = 30_000;
const READY_PROBE_TIMEOUT_MS = 2_000;
const READY_POLL_INTERVAL_MS = 250;
const RESTRICTED_FILE_MODE = 0o600;
const RESTRICTED_DIR_MODE = 0o700;
/** The diagnostic contract's own input limit, enforced before the file is read. */
const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;

export interface ReferenceEnvironment {
  referenceId: string;
}

/**
 * Read the two environment inputs this container accepts.
 *
 * A supplied THOTH_CDP is refused rather than overridden: it means the caller
 * believes this reference should drive a browser it does not own, and the whole
 * point of this entrypoint is that it never can.
 */
export function resolveReferenceEnvironment(
  env: Record<string, string | undefined>,
): ReferenceEnvironment {
  const referenceId = validateReferenceId(env.THOTH_PARITY_REFERENCE_ID ?? '');
  const supplied = env.THOTH_CDP?.trim();
  const own = REFERENCE_CDP_BASE.origin;
  if (supplied && supplied !== own && supplied !== `${own}/`) {
    throw new Error('foreign_cdp_endpoint');
  }
  return { referenceId };
}

/** Bounded discovery: the browser is either serving within the budget or it is not. */
async function waitForDevtools(signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + READY_BUDGET_MS;
  while (Date.now() < deadline && !signal.aborted) {
    try {
      const response = await fetch(new URL('/json/version', REFERENCE_CDP_BASE), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(READY_PROBE_TIMEOUT_MS)]),
      });
      if (response.ok) {
        await response.arrayBuffer();
        return true;
      }
    } catch {
      /* the browser is still starting */
    }
    await Bun.sleep(READY_POLL_INTERVAL_MS);
  }
  return false;
}

export interface ReferenceWorkspace {
  directory: string;
  reportPath: string;
  attemptPath: string;
  /** The same restricted stream `stderr` writes to, named so finalization can read it back. */
  stderrPath: string;
  startedAt: string;
  stdout: number;
  stderr: number;
  browserLog: number;
}

/**
 * Create the evidence directory, reserve the attempt record, and open every
 * restricted stream before anything is acquired, so a run that cannot be recorded
 * never starts.
 *
 * The attempt record is reserved rather than written at the end. Creating it last
 * would let a container drive a real browser through a real Scout run and only
 * then discover it has nowhere to say so, which is the one failure that leaves an
 * operator with an acquisition and no structured evidence of it. Reserving it here
 * also means `main` cannot reach `runReference` without one: the workspace is the
 * value it needs to build the production dependencies at all.
 *
 * The directory is created non-recursively on purpose: EEXIST means this reference
 * id already produced evidence, and silently reusing it would overwrite the record
 * of an earlier attempt.
 */
export function prepareWorkspace(
  referenceId: string,
  root: string = OUTPUT_MOUNT,
): ReferenceWorkspace {
  if (!existsSync(root)) throw new Error('missing_output_mount');
  const directory = `${root}/legacy-scout/${validateReferenceId(referenceId)}`;
  mkdirSync(`${root}/legacy-scout`, { recursive: true, mode: RESTRICTED_DIR_MODE });
  mkdirSync(directory, { mode: RESTRICTED_DIR_MODE });

  const startedAt = new Date().toISOString();
  const attemptPath = `${directory}/reference-attempt.json`;
  writeAttempt(attemptPath, { started_at: startedAt, status: 'pending' }, 'wx');
  const stderrPath = `${directory}/reference.stderr.log`;

  return {
    directory,
    reportPath: referenceOutputPath(referenceId),
    attemptPath,
    stderrPath,
    startedAt,
    stdout: openSync(`${directory}/reference.stdout.log`, 'wx', RESTRICTED_FILE_MODE),
    stderr: openSync(stderrPath, 'wx', RESTRICTED_FILE_MODE),
    browserLog: openSync(`${directory}/browser.log`, 'wx', RESTRICTED_FILE_MODE),
  };
}

/**
 * Lift the allowlisted frames out of the reference's own restricted stderr.
 *
 * At most one byte past the size limit is ever held: that is enough for the parser's
 * own guard to reject an oversized stream without this process reading it. A stream
 * that cannot be read at all is an unknown diagnostic state, not a lifecycle
 * failure, and the filesystem error behind it never becomes evidence.
 */
function readDiagnostics(path: string): {
  events: SafeRuntimeDiagnostic[];
  valid: boolean;
} {
  let handle: number | undefined;
  try {
    handle = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(MAX_DIAGNOSTIC_BYTES + 1);
    const read = readSync(handle, buffer, 0, buffer.length, 0);
    return parseSafeRuntimeDiagnostics(buffer.subarray(0, read).toString('utf8'));
  } catch {
    return { events: [], valid: false };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function writeAttempt(path: string, body: Record<string, unknown>, flag: 'w' | 'wx'): void {
  writeFileSync(
    path,
    `${JSON.stringify({ browser_isolation: 'fresh_ephemeral', ...body }, null, 2)}\n`,
    { mode: RESTRICTED_FILE_MODE, flag },
  );
}

/**
 * Replace the reservation with the lifecycle result, atomically.
 *
 * The final record is written beside the reservation and renamed over it, so a
 * reader never sees a half-written attempt: the file is either the reservation or
 * the complete result, and `rename` on the same directory is the primitive that
 * guarantees it.
 *
 * Diagnostics are read here, after the Scout child has been reaped and before the
 * record exists, so they land in the same atomic write as the lifecycle result. They
 * are additive and advisory: an unreadable or untrustworthy stream marks itself
 * invalid and changes nothing else in this record.
 */
export async function finalizeAttempt(
  workspace: ReferenceWorkspace,
  result: ReferenceResult,
): Promise<void> {
  const diagnostics = readDiagnostics(workspace.stderrPath);
  const pending = `${workspace.attemptPath}.tmp`;
  writeAttempt(
    pending,
    {
      started_at: workspace.startedAt,
      finished_at: new Date().toISOString(),
      status: 'complete',
      ...result,
      diagnostics_valid: diagnostics.valid,
      diagnostic_events: diagnostics.events,
    },
    'w',
  );
  renameSync(pending, workspace.attemptPath);
}

/**
 * Read the fixture from its mount, mapping any filesystem failure to a fixed code.
 *
 * A raw `readFileSync` error carries a path and an errno string into the console,
 * and this entrypoint's contract is fixed codes only.
 */
export function readFixture(path: string = FIXTURE_PATH): string {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    throw new Error('fixture_unreadable');
  }
  return validateFixtureUrl(contents);
}

interface SpawnedChild {
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

function owned(child: SpawnedChild): OwnedChild {
  return {
    exited: child.exited,
    kill: (signal = 'SIGTERM') => child.kill(signal as NodeJS.Signals),
  };
}

/**
 * The reference argv, kept pure so the source boundary is assertable without
 * spawning anything. A real reference is bounded to source discovery; the offline
 * smoke child is a synthetic supervisor probe with no pipeline to bound.
 */
export function referenceCommand(
  offlineSmoke: boolean,
  fixtureUrl: string,
  reportPath: string,
): string[] {
  return offlineSmoke
    ? ['bun', 'scout/runtime/parity_reference_smoke.ts']
    : ['bun', 'scout/cli.ts', 'run', fixtureUrl, '--out', reportPath, '--source-reference-only'];
}

function productionDeps(workspace: ReferenceWorkspace, fixtureUrl: string): ReferenceDeps {
  return {
    // about:blank always: this browser exists to serve the reference, and the
    // production launcher target would be a page nobody asked for.
    startBrowser: (options) =>
      owned(
        Bun.spawn(
          chromiumArguments({
            chromium: options.chromium,
            profile: REFERENCE_PROFILE_DIR,
            offlineSmoke: true,
          }),
          { stdin: 'ignore', stdout: workspace.browserLog, stderr: workspace.browserLog },
        ),
      ),
    waitReady: waitForDevtools,
    startReference: (options) =>
      owned(
        Bun.spawn(
          referenceCommand(options.offlineSmoke, fixtureUrl, workspace.reportPath),
          {
            cwd: '/opt/thoth',
            env: { ...process.env, THOTH_CDP: REFERENCE_CDP_BASE.origin },
            stdin: 'ignore',
            stdout: workspace.stdout,
            stderr: workspace.stderr,
          },
        ),
      ),
    writeResult: (result) => finalizeAttempt(workspace, result),
  };
}

async function main(): Promise<void> {
  let args: ParityArgs;
  try {
    args = parseParityArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(64);
  }

  // Fixed codes only. The fixture, the environment, and the report are operator
  // evidence, so nothing from them is ever echoed to a console.
  let referenceId: string;
  let fixtureUrl = '';
  try {
    referenceId = resolveReferenceEnvironment(process.env).referenceId;
    if (!args.offlineSmoke) fixtureUrl = readFixture();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(64);
  }

  let workspace: ReferenceWorkspace;
  try {
    workspace = prepareWorkspace(referenceId);
  } catch {
    console.error('workspace_unavailable');
    process.exit(UNEXPECTED_FAILURE_EXIT);
  }

  const shutdown = new AbortController();
  process.on('SIGTERM', () => shutdown.abort('SIGTERM'));
  process.on('SIGINT', () => shutdown.abort('SIGINT'));

  const status = await runReference(
    {
      chromium: args.chromium,
      referenceId,
      offlineSmoke: args.offlineSmoke,
      shutdown: shutdown.signal,
    },
    productionDeps(workspace, fixtureUrl),
  );
  process.exit(status);
}

if (import.meta.main) await main();
