// parity_reference_smoke.ts — offline proof that the reference owns a usable browser.
//
// This runs in place of Scout when the entrypoint is given --offline-smoke. It is
// deliberately not a smaller Scout: it uses the same lib/cdp.ts client every scraper
// uses, because a browser that answers HTTP but that the real client cannot drive
// would still fail every reference.
//
// It proves three things and only three: the owned browser on loopback is reachable,
// the Scout client can navigate it to a page, and the production relay authority is
// not reachable from here. Navigation goes to an explicit local sentinel, never to a
// site, so this is transport and isolation evidence — not a run, not parity, and not
// evidence about the legacy fallback path.

import { connect } from '../lib/cdp.ts';
import { REFERENCE_CDP_BASE } from './parity_reference.ts';

/** The production relay authority, checked for absence rather than used. */
export const PRODUCTION_CDP_BASE = 'http://legacy-cdp:18800';
export const PROBE_TIMEOUT_MS = 10_000;

const FORBIDDEN_SENTINEL_HOSTS = /(^|\.)tiktok\.com$/;

/**
 * The sentinel must be named explicitly and must be plain HTTP to a host that is not
 * TikTok. There is no default: a probe that silently picks its own target is one
 * network policy change away from contacting a real site.
 */
export function sentinelTarget(env: Record<string, string | undefined>): string {
  const value = (env.THOTH_PARITY_SENTINEL_URL ?? '').trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('invalid_sentinel_url');
  }
  if (parsed.protocol !== 'http:' || FORBIDDEN_SENTINEL_HOSTS.test(parsed.hostname)) {
    throw new Error('invalid_sentinel_url');
  }
  return value;
}

async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Discovery against the browser this container started, on loopback only. */
export async function probeOwnedBrowser(): Promise<void> {
  const response = await withTimeout(
    fetch(new URL('/json/version', REFERENCE_CDP_BASE)),
    'owned_version',
  );
  if (!response.ok) throw new Error('owned_browser_unavailable');
  await response.arrayBuffer();
}

/** The real Scout client, navigating the owned browser to the local sentinel. */
export async function probeSentinelNavigation(target: string): Promise<void> {
  const client = await withTimeout(connect({ navigate: target, waitMs: 500 }), 'scout_connect');
  try {
    const href = await withTimeout(client.evaluate('location.href'), 'scout_evaluate');
    if (String(href) !== target) throw new Error('sentinel_navigation_failed');
  } finally {
    client.close();
  }
}

/** Absence evidence: the production relay must not answer from inside a reference. */
export async function productionCdpUnreachable(): Promise<boolean> {
  try {
    const response = await fetch(new URL('/json/version', PRODUCTION_CDP_BASE), {
      signal: AbortSignal.timeout(2_000),
    });
    await response.arrayBuffer();
    return false;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  let target = '';
  let ownedPass = false;
  let navigationPass = false;

  try {
    target = sentinelTarget(process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(64);
  }

  try {
    await probeOwnedBrowser();
    ownedPass = true;
  } catch {
    /* the printed booleans are the result; a message could carry browser payload */
  }
  if (ownedPass) {
    try {
      await probeSentinelNavigation(target);
      navigationPass = true;
    } catch {
      /* same */
    }
  }
  const isolated = await productionCdpUnreachable();

  await Bun.write(
    Bun.stdout,
    `owned_cdp_pass=${ownedPass}\nsentinel_navigation_pass=${navigationPass}\nproduction_cdp_unreachable=${isolated}\n`,
  );
  process.exit(ownedPass && navigationPass && isolated ? 0 : 1);
}

if (import.meta.main) await main();
