import { listTargets, type CdpTarget } from '../lib/cdp.ts';

interface TargetIsolationResult {
  initial_target_preserved: true;
  temporary_target_observed: true;
  temporary_target_removed: true;
}

function pages(targets: readonly CdpTarget[]): CdpTarget[] {
  return targets.filter(
    (target) => target.type === 'page' && typeof target.id === 'string' && typeof target.url === 'string',
  );
}

export function compareTargetSnapshots(
  beforeInput: readonly CdpTarget[],
  duringInput: readonly CdpTarget[],
  afterInput: readonly CdpTarget[],
): TargetIsolationResult {
  const before = pages(beforeInput);
  const during = pages(duringInput);
  const after = pages(afterInput);
  const preserved = before.every((original) =>
    after.some((candidate) => candidate.id === original.id && candidate.url === original.url),
  );
  const temporary = during.some(
    (candidate) => !before.some((original) => original.id === candidate.id),
  );
  const removed = after.every((candidate) =>
    before.some((original) => original.id === candidate.id && original.url === candidate.url),
  );
  if (!preserved || !temporary || !removed) throw new Error('target_isolation_failed');
  return {
    initial_target_preserved: true,
    temporary_target_observed: true,
    temporary_target_removed: true,
  };
}

async function runOne(mode: '--offline-smoke' | '--offline-smoke-failure', expected: number) {
  const before = await listTargets();
  const child = Bun.spawn(['bun', 'scout/runtime/legacy_fallback.ts', mode], {
    cwd: '/opt/thoth',
    env: { ...process.env, THOTH_LEGACY_FALLBACK_SMOKE_HOLD_MS: '1000' },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  let during: CdpTarget[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    during = await listTargets();
    if (pages(during).length > pages(before).length) break;
    await Bun.sleep(50);
  }
  const status = await child.exited;
  if (status !== expected) throw new Error('supervisor_status_failed');
  await Bun.sleep(100);
  return compareTargetSnapshots(before, during, await listTargets());
}

async function main(): Promise<void> {
  try {
    const success = await runOne('--offline-smoke', 0);
    const failure = await runOne('--offline-smoke-failure', 17);
    console.log(
      JSON.stringify({
        initial_target_preserved:
          success.initial_target_preserved && failure.initial_target_preserved,
        temporary_target_observed:
          success.temporary_target_observed && failure.temporary_target_observed,
        success_target_removed: success.temporary_target_removed,
        failure_target_removed: failure.temporary_target_removed,
      }),
    );
  } catch {
    console.error('legacy_fallback_harness_failed');
    process.exit(1);
  }
}

if (import.meta.main) await main();
