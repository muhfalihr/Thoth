// legacy_cdp.ts — supervise the sidecar's Chromium and its CDP relay as one unit.
//
// WHY: Chromium serves DevTools on loopback only, so the container cannot simply
// `exec` it and expose the port. It runs the browser on a private loopback port and
// publishes the relay (see cdp_relay.ts) on the container network instead. Both
// processes are then a single failure domain: if the browser dies, or the relay
// cannot bind, the sidecar exits nonzero so the orchestrator restarts it rather than
// leaving a reachable port with no debugger behind it.
//
// tini remains PID 1; this process only forwards TERM/INT and force-kills after a
// bounded grace period. Browser output is never copied into the container log.

import { type RelayHandle, startCdpRelay } from './cdp_relay.ts';

export const CHROMIUM_DEVTOOLS_BASE = new URL('http://127.0.0.1:18801');
export const RELAY_ADVERTISED_BASE = new URL('http://legacy-cdp:18800');
export const RELAY_BIND_HOSTNAME = '0.0.0.0';
export const LAUNCHER_TARGET_URL = 'https://www.tiktok.com/';
export const OFFLINE_SMOKE_TARGET_URL = 'about:blank';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const READY_POLL_INTERVAL_MS = 250;
const READY_PROBE_TIMEOUT_MS = 2_000;

export interface LegacyCdpArgs {
  chromium: string;
  profile: string;
  offlineSmoke: boolean;
}

export interface ChildLike {
  exited: Promise<number>;
  kill(signal?: string): void;
}

export interface SupervisorDeps {
  spawn: (command: string[]) => ChildLike;
  startRelay: (options: {
    upstreamBase: URL;
    advertisedBase: URL;
    hostname: string;
    port: number;
  }) => RelayHandle;
  probeReady: (base: URL, deadlineMs: number) => Promise<boolean>;
}

export interface SuperviseOptions extends LegacyCdpArgs {
  shutdown: AbortSignal;
  startupTimeoutMs?: number;
  killGraceMs?: number;
}

/** Accept the sidecar's own arguments only; never a pass-through to Chromium. */
export function parseLegacyCdpArgs(argv: string[]): LegacyCdpArgs {
  let chromium: string | null = null;
  let profile: string | null = null;
  let offlineSmoke = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--offline-smoke') {
      if (offlineSmoke) throw new Error('usage: legacy_cdp --chromium PATH --profile PATH');
      offlineSmoke = true;
      continue;
    }
    if (argument !== '--chromium' && argument !== '--profile') {
      throw new Error('usage: legacy_cdp --chromium PATH --profile PATH [--offline-smoke]');
    }
    const value = argv[index + 1];
    index += 1;
    if (!value || value.startsWith('--')) {
      throw new Error('usage: legacy_cdp --chromium PATH --profile PATH [--offline-smoke]');
    }
    if (argument === '--chromium') {
      if (chromium !== null) throw new Error('--chromium given more than once');
      chromium = value;
    } else {
      if (profile !== null) throw new Error('--profile given more than once');
      profile = value;
    }
  }
  if (!chromium || !profile) {
    throw new Error('usage: legacy_cdp --chromium PATH --profile PATH [--offline-smoke]');
  }
  return { chromium, profile, offlineSmoke };
}

export function chromiumArguments({ chromium, profile, offlineSmoke }: LegacyCdpArgs): string[] {
  return [
    chromium,
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${CHROMIUM_DEVTOOLS_BASE.port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    offlineSmoke ? OFFLINE_SMOKE_TARGET_URL : LAUNCHER_TARGET_URL,
  ];
}

async function pollDevtools(base: URL, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/json/version', base), {
        signal: AbortSignal.timeout(READY_PROBE_TIMEOUT_MS),
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

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

async function terminate(child: ChildLike, graceMs: number): Promise<void> {
  let running = true;
  const exited = child.exited.then(() => {
    running = false;
  });
  child.kill('SIGTERM');
  await Promise.race([exited, Bun.sleep(graceMs)]);
  if (!running) return;
  child.kill('SIGKILL');
  await Promise.race([exited, Bun.sleep(graceMs)]);
}

/**
 * Run the browser and the relay until one of them stops.
 *
 * Returns the process exit status: 0 only for a requested shutdown.
 */
export async function superviseLegacyCdp(
  options: SuperviseOptions,
  deps: SupervisorDeps,
): Promise<number> {
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  const child = deps.spawn(chromiumArguments(options));
  const browserExit = child.exited.then((code) => ({ kind: 'browser' as const, code }));

  const ready = await Promise.race([
    deps
      .probeReady(CHROMIUM_DEVTOOLS_BASE, startupTimeoutMs)
      .then((value) => (value ? 'ready' : 'unready')),
    browserExit.then(() => 'gone' as const),
    Bun.sleep(startupTimeoutMs).then(() => 'unready' as const),
  ]);
  if (ready !== 'ready') {
    await terminate(child, killGraceMs);
    return 1;
  }

  let relay: RelayHandle;
  try {
    relay = deps.startRelay({
      upstreamBase: CHROMIUM_DEVTOOLS_BASE,
      advertisedBase: RELAY_ADVERTISED_BASE,
      hostname: RELAY_BIND_HOSTNAME,
      port: Number(RELAY_ADVERTISED_BASE.port),
    });
  } catch {
    await terminate(child, killGraceMs);
    return 1;
  }

  const reason = await Promise.race([
    browserExit,
    aborted(options.shutdown).then(() => ({ kind: 'shutdown' as const, code: 0 })),
  ]);
  await relay.stop();
  if (reason.kind === 'browser') return reason.code === 0 ? 1 : reason.code;
  await terminate(child, killGraceMs);
  return 0;
}

async function main(): Promise<void> {
  let args: LegacyCdpArgs;
  try {
    args = parseLegacyCdpArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(64);
  }

  const shutdown = new AbortController();
  const request = () => shutdown.abort();
  process.on('SIGTERM', request);
  process.on('SIGINT', request);

  const status = await superviseLegacyCdp(
    { ...args, shutdown: shutdown.signal },
    {
      spawn: (command) =>
        Bun.spawn(command, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }),
      startRelay: startCdpRelay,
      probeReady: pollDevtools,
    },
  );
  process.exit(status);
}

if (import.meta.main) await main();
