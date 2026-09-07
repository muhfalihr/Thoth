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

const DEFAULT_DEADLINE_MS = 15 * 60_000;
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
  | { kind: 'browser' }
  | { kind: 'reference'; code: number }
  | { kind: 'interrupted'; signal: unknown }
  | { kind: 'deadline' };

/**
 * Supervise the owned browser and the Scout reference until one of them stops.
 *
 * Returns the Scout exit code when the lifecycle is clean, and otherwise the code
 * for what actually went wrong: an operator signal, the overall deadline, or an
 * unexpected browser death or failed cleanup. A nominal Scout success never
 * outranks an observed browser death.
 */
export async function runReference(
  options: ReferenceOptions,
  deps: ReferenceDeps,
): Promise<number> {
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.deadlineMs ?? DEFAULT_DEADLINE_MS);

  const browser = deps.startBrowser(options);
  const browserExit = track(browser.exited);
  let reference: OwnedChild | null = null;
  let referenceExit: Tracked | null = null;

  const interrupt = aborted(options.shutdown).then(
    () => ({ kind: 'interrupted', signal: options.shutdown.reason }) as Outcome,
  );
  const expired = aborted(deadline.signal).then(() => ({ kind: 'deadline' }) as Outcome);

  let outcome: Outcome;
  try {
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
  } finally {
    clearTimeout(timer);
  }

  // Snapshot the browser before teardown: after it, every path shows a stopped
  // browser, and a normal shutdown would be indistinguishable from an early death.
  const browserDiedEarly = browserExit.settled;

  let cleanupPassed = true;
  if (reference && referenceExit) {
    cleanupPassed = (await stop(reference, referenceExit, killGraceMs)) && cleanupPassed;
  }
  cleanupPassed = (await stop(browser, browserExit, killGraceMs)) && cleanupPassed;

  const timedOut = outcome.kind === 'deadline';
  const interrupted = outcome.kind === 'interrupted';
  try {
    await deps.writeResult({
      referenceExit: referenceExit?.code ?? null,
      browserExit: browserExit.code,
      cleanupPassed,
      timedOut,
      interrupted,
    });
  } catch {
    // The attempt record is the only durable trace of this run, so a reference that
    // cannot be recorded is not a reference that succeeded.
    return UNEXPECTED_FAILURE_EXIT;
  }

  if (outcome.kind === 'interrupted') {
    return outcome.signal === 'SIGINT' ? SIGINT_EXIT : SIGTERM_EXIT;
  }
  if (timedOut) return DEADLINE_EXIT;
  if (outcome.kind !== 'reference') return UNEXPECTED_FAILURE_EXIT;
  if (browserDiedEarly || !cleanupPassed) return UNEXPECTED_FAILURE_EXIT;
  return outcome.code;
}

// --- production wiring ------------------------------------------------------
//
// Everything below touches the filesystem, the environment, or real subprocesses.
// It is deliberately thin: the decisions live in the pure boundaries and in
// runReference above, which the tests drive with injected children.

import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
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

interface ReferenceWorkspace {
  directory: string;
  reportPath: string;
  stdout: number;
  stderr: number;
  browserLog: number;
}

/**
 * Create the evidence directory and open every restricted stream before anything
 * is acquired, so a run that cannot be recorded never starts.
 *
 * The directory is created non-recursively on purpose: EEXIST means this reference
 * id already produced evidence, and silently reusing it would overwrite the record
 * of an earlier attempt.
 */
function prepareWorkspace(referenceId: string): ReferenceWorkspace {
  if (!existsSync(OUTPUT_MOUNT)) throw new Error('missing_output_mount');
  const directory = `${OUTPUT_MOUNT}/legacy-scout/${validateReferenceId(referenceId)}`;
  mkdirSync(`${OUTPUT_MOUNT}/legacy-scout`, { recursive: true, mode: RESTRICTED_DIR_MODE });
  mkdirSync(directory, { mode: RESTRICTED_DIR_MODE });
  return {
    directory,
    reportPath: referenceOutputPath(referenceId),
    stdout: openSync(`${directory}/reference.stdout.log`, 'wx', RESTRICTED_FILE_MODE),
    stderr: openSync(`${directory}/reference.stderr.log`, 'wx', RESTRICTED_FILE_MODE),
    browserLog: openSync(`${directory}/browser.log`, 'wx', RESTRICTED_FILE_MODE),
  };
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

function productionDeps(workspace: ReferenceWorkspace, fixtureUrl: string): ReferenceDeps {
  const startedAt = new Date().toISOString();
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
          options.offlineSmoke
            ? ['bun', 'scout/runtime/parity_reference_smoke.ts']
            : ['bun', 'scout/cli.ts', 'run', fixtureUrl, '--out', workspace.reportPath],
          {
            cwd: '/opt/thoth',
            env: { ...process.env, THOTH_CDP: REFERENCE_CDP_BASE.origin },
            stdin: 'ignore',
            stdout: workspace.stdout,
            stderr: workspace.stderr,
          },
        ),
      ),
    writeResult: async (result) => {
      writeFileSync(
        `${workspace.directory}/reference-attempt.json`,
        `${JSON.stringify(
          {
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            browser_isolation: 'fresh_ephemeral',
            ...result,
          },
          null,
          2,
        )}\n`,
        { mode: RESTRICTED_FILE_MODE, flag: 'wx' },
      );
    },
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
    if (!args.offlineSmoke) fixtureUrl = validateFixtureUrl(readFileSync(FIXTURE_PATH, 'utf8'));
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
