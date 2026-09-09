import { isCdpTargetId } from '../lib/cdp_target.ts';
import { acquireCdpTargetLease, type CdpTargetLease } from './cdp_target_lease.ts';

const CLEANUP_FAILURE = 70;
const KILL_GRACE_MS = 5_000;

export type LegacyFallbackArgs =
  | { kind: 'production'; url: string; out: string }
  | { kind: 'offline-smoke' }
  | { kind: 'offline-smoke-failure' };

interface OwnedChild {
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export interface LegacyFallbackDeps {
  acquireLease(): Promise<CdpTargetLease>;
  spawn(command: string[], env: Record<string, string | undefined>): OwnedChild;
  sleep(ms: number): Promise<void>;
}

function invalid(): never {
  throw new Error('invalid_arguments');
}

export function parseLegacyFallbackArgs(argv: string[]): LegacyFallbackArgs {
  if (argv.length === 1 && argv[0] === '--offline-smoke') return { kind: 'offline-smoke' };
  if (argv.length === 1 && argv[0] === '--offline-smoke-failure') {
    return { kind: 'offline-smoke-failure' };
  }
  if (argv.length !== 4 || argv[0] !== '--url' || argv[2] !== '--out') invalid();
  let parsed: URL;
  try {
    parsed = new URL(argv[1]);
  } catch {
    invalid();
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) invalid();
  if (!argv[3].startsWith('/')) invalid();
  return { kind: 'production', url: parsed.href, out: argv[3] };
}

export function legacyFallbackCommand(args: LegacyFallbackArgs): string[] {
  if (args.kind === 'offline-smoke') {
    return ['bun', 'scout/runtime/legacy_fallback_smoke.ts'];
  }
  if (args.kind === 'offline-smoke-failure') {
    return ['bun', 'scout/runtime/legacy_fallback_smoke.ts', '--fail'];
  }
  return [
    'bun',
    'scout/cli.ts',
    'run',
    args.url,
    '--out',
    args.out,
    '--source-reference-only',
  ];
}

function aborted(signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.resolve(String(signal.reason));
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(String(signal.reason)), { once: true }),
  );
}

export async function runLegacyFallback(
  args: LegacyFallbackArgs,
  shutdown: AbortSignal,
  deps: LegacyFallbackDeps,
): Promise<number> {
  let lease: CdpTargetLease | undefined;
  let status = CLEANUP_FAILURE;
  try {
    lease = await deps.acquireLease();
    if (!isCdpTargetId(lease.targetId)) throw new Error('owned_cdp_target_invalid');
    const child = deps.spawn(legacyFallbackCommand(args), {
      ...process.env,
      THOTH_CDP_TARGET_ID: lease.targetId,
    });
    const outcome = await Promise.race([
      child.exited.then((code) => ({ kind: 'exit' as const, code })),
      aborted(shutdown).then((reason) => ({ kind: 'signal' as const, reason })),
    ]);
    if (outcome.kind === 'exit') {
      status = outcome.code;
    } else {
      const signal = outcome.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM';
      child.kill(signal);
      const stopped = await Promise.race([
        child.exited.then(() => true),
        deps.sleep(KILL_GRACE_MS).then(() => false),
      ]);
      if (!stopped) {
        child.kill('SIGKILL');
        await child.exited;
      }
      status = signal === 'SIGINT' ? 130 : 143;
    }
  } catch {
    status = CLEANUP_FAILURE;
  }
  try {
    await lease?.close();
  } catch {
    return CLEANUP_FAILURE;
  }
  return status;
}

function productionDeps(): LegacyFallbackDeps {
  return {
    acquireLease: acquireCdpTargetLease,
    spawn(command, env) {
      const child = Bun.spawn(command, {
        cwd: '/opt/thoth',
        env,
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      return { exited: child.exited, kill: (signal) => child.kill(signal) };
    },
    sleep: Bun.sleep,
  };
}

async function main(): Promise<void> {
  let args: LegacyFallbackArgs;
  try {
    args = parseLegacyFallbackArgs(Bun.argv.slice(2));
  } catch {
    console.error('invalid_arguments');
    process.exit(64);
  }
  const shutdown = new AbortController();
  process.on('SIGTERM', () => shutdown.abort('SIGTERM'));
  process.on('SIGINT', () => shutdown.abort('SIGINT'));
  process.exit(await runLegacyFallback(args, shutdown.signal, productionDeps()));
}

if (import.meta.main) await main();
