// parity_reference_smoke.ts — offline proof that the reference owns a usable browser.
//
// This runs in place of Scout when the entrypoint is given --offline-smoke. It is
// deliberately not a smaller Scout: it uses the same lib/cdp.ts client every scraper
// uses, because a browser that answers HTTP but that the real client cannot drive
// would still fail every reference.
//
// It proves three things and only three: the owned browser on loopback is reachable,
// the Scout client can navigate it to a page, and the profile it was given is empty.
// The page is served by this process on an ephemeral loopback port, so no name is
// resolved and no packet leaves the container. Nothing here is a run, parity
// evidence, or evidence about the legacy fallback path.
//
// It deliberately never contacts the relay authority a deployment sidecar answers
// on. The smoke stack aliases a synthetic sentinel there and asserts it was never
// called; a probe that dialled it to prove absence would destroy that evidence.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from '../lib/cdp.ts';
import { REFERENCE_CDP_BASE, REFERENCE_PROFILE_DIR } from './parity_reference.ts';

export const PROBE_TIMEOUT_MS = 10_000;
export const LOCAL_PAGE_TITLE = 'parity-local';
export const PROFILE_MARKER_NAME = 'parity-smoke.marker';

/** A live loopback page, owned by this process. */
export interface LocalPage {
  url: string;
  stop(): Promise<void>;
}

/**
 * Serve one fixed page on an ephemeral loopback port.
 *
 * Port 0 is the point: a fixed port would make two concurrent smoke containers
 * collide, and a reachable address would make this something other than a probe.
 */
export function serveLocalPage(): LocalPage {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(`<title>${LOCAL_PAGE_TITLE}</title>`, {
        headers: { 'content-type': 'text/html' },
      }),
  });
  return {
    url: `http://127.0.0.1:${server.port}/reference`,
    stop: () => server.stop(true),
  };
}

/**
 * Assert the profile is empty, then mark it, failing if the mark did not persist.
 *
 * The marker is what makes "fresh profile" falsifiable across runs: a second
 * container that finds it has been handed a profile the first one used, which is
 * exactly the sharing this container exists to avoid.
 */
export function claimFreshProfile(profileDir: string = REFERENCE_PROFILE_DIR): void {
  const marker = `${profileDir}/${PROFILE_MARKER_NAME}`;
  if (existsSync(marker)) throw new Error('profile_not_fresh');
  writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' });
  if (!readFileSync(marker, 'utf8').trim()) throw new Error('profile_marker_unwritable');
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

/**
 * The real Scout client, navigating the owned browser to the local page.
 *
 * The page is left loaded on purpose: a reference ends wherever its source trail
 * led, and a shared sidecar could not survive that. This one is discarded.
 */
export async function probeLocalNavigation(page: LocalPage): Promise<void> {
  const client = await withTimeout(connect({ navigate: page.url, waitMs: 500 }), 'scout_connect');
  try {
    const answer = await withTimeout(client.evaluate('6 * 7'), 'scout_evaluate');
    if (Number(answer) !== 42) throw new Error('local_cdp_failed');
    const title = await withTimeout(client.evaluate('document.title'), 'scout_title');
    if (String(title) !== LOCAL_PAGE_TITLE) throw new Error('local_navigation_failed');
  } finally {
    client.close();
  }
}

async function main(): Promise<void> {
  let freshProfile = false;
  let ownedPass = false;
  let navigationPass = false;

  try {
    claimFreshProfile();
    freshProfile = true;
  } catch {
    /* the printed booleans are the result; a message could carry a profile path */
  }

  try {
    await probeOwnedBrowser();
    ownedPass = true;
  } catch {
    /* the printed booleans are the result; a message could carry browser payload */
  }

  if (ownedPass) {
    const page = serveLocalPage();
    try {
      await probeLocalNavigation(page);
      navigationPass = true;
    } catch {
      /* same */
    } finally {
      await page.stop();
    }
  }

  await Bun.write(
    Bun.stdout,
    `fresh_profile=${freshProfile}\nowned_cdp_pass=${ownedPass}\nlocal_navigation_pass=${navigationPass}\n`,
  );
  process.exit(freshProfile && ownedPass && navigationPass ? 0 : 1);
}

if (import.meta.main) await main();
