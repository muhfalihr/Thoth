// cdp_smoke.ts — offline proof that a sibling container can drive the browser.
//
// The failure this exists to catch is silent: Chromium binds DevTools to loopback
// whatever address it is given, so `legacy-cdp` resolves by DNS, the sidecar's own
// healthcheck passes from inside, and every other container is refused at TCP. Only a
// probe running in a second container can tell the difference.
//
// It therefore checks the whole transport, in the order a caller depends on it:
// discovery over HTTP, a browser-level WebSocket session, and finally a page session
// opened by the real Scout client rather than a hand-rolled one — a rewrite that looks
// right but that `lib/cdp.ts` cannot use would still fail every scraper.
//
// The page is `about:blank`. Nothing here contacts a site, so the probe proves
// transport only: it is not evidence about a live run, parity, or fallback behaviour.

import { connect } from '../lib/cdp.ts';

export const DEFAULT_CDP_BASE = 'http://legacy-cdp:18800';
export const SMOKE_TARGET_URL = 'about:blank';
export const PROBE_TIMEOUT_MS = 10_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

/** A debugger URL is usable by a sibling only when it names the relay's own authority. */
export function isSiblingReachable(webSocketDebuggerUrl: unknown, base: URL): boolean {
  if (typeof webSocketDebuggerUrl !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(webSocketDebuggerUrl);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'ws:' &&
    !LOOPBACK_HOSTS.has(parsed.hostname) &&
    parsed.hostname === base.hostname &&
    parsed.port === base.port
  );
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

async function fetchJson(url: string, label: string): Promise<unknown> {
  const response = await withTimeout(fetch(url), label);
  if (!response.ok) throw new Error(`${label}_status_${response.status}`);
  return response.json();
}

/** Discovery must advertise a sibling-reachable browser endpoint and a blank page. */
export async function probeDiscovery(base: URL): Promise<string> {
  const version = (await fetchJson(new URL('/json/version', base).href, 'version')) as Record<
    string,
    unknown
  >;
  const targets = (await fetchJson(new URL('/json', base).href, 'targets')) as Record<
    string,
    unknown
  >[];
  if (!isSiblingReachable(version.webSocketDebuggerUrl, base)) {
    throw new Error('browser_endpoint_not_sibling_reachable');
  }
  const page = targets.find(
    (target) =>
      target.type === 'page' &&
      String(target.url) === SMOKE_TARGET_URL &&
      isSiblingReachable(target.webSocketDebuggerUrl, base),
  );
  if (!page) throw new Error('no_sibling_reachable_blank_page');
  return version.webSocketDebuggerUrl as string;
}

/** One browser-level session: correlate the response id, then close. */
export async function probeBrowserSession(webSocketDebuggerUrl: string): Promise<void> {
  const socket = new WebSocket(webSocketDebuggerUrl);
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve());
        socket.addEventListener('error', () => reject(new Error('browser_socket_error')));
        socket.addEventListener('close', () => reject(new Error('browser_socket_closed')));
      }),
      'browser_open',
    );
    const identifier = 1;
    const product = await withTimeout(
      new Promise<string>((resolve, reject) => {
        socket.addEventListener('message', (event: MessageEvent) => {
          try {
            const message = JSON.parse(String(event.data));
            if (message.id !== identifier) return;
            if (message.error) reject(new Error('browser_command_error'));
            else resolve(String(message.result?.product ?? ''));
          } catch {
            /* a non-JSON frame is not this command's reply */
          }
        });
        socket.send(JSON.stringify({ id: identifier, method: 'Browser.getVersion', params: {} }));
      }),
      'browser_command',
    );
    if (!product) throw new Error('browser_version_empty');
  } finally {
    socket.close();
  }
}

/** The same client every scraper uses, against the same relay. */
export async function probeScoutPageSession(): Promise<void> {
  const client = await withTimeout(
    connect({ match: SMOKE_TARGET_URL, requireMatch: true }),
    'scout_connect',
  );
  try {
    if ((await withTimeout(client.evaluate('6 * 7'), 'scout_evaluate')) !== 42) {
      throw new Error('page_cdp_check_failed');
    }
  } finally {
    client.close();
  }
}

async function main(): Promise<void> {
  const base = new URL(process.env.THOTH_CDP || DEFAULT_CDP_BASE);
  let browserEndpoint = '';
  let httpPass = false;
  let browserPass = false;
  let pagePass = false;

  try {
    browserEndpoint = await probeDiscovery(base);
    httpPass = true;
  } catch {
    /* the printed booleans are the result; a message could carry browser payload */
  }
  if (httpPass) {
    try {
      await probeBrowserSession(browserEndpoint);
      browserPass = true;
    } catch {
      /* same */
    }
    try {
      await probeScoutPageSession();
      pagePass = true;
    } catch {
      /* same */
    }
  }

  await Bun.write(
    Bun.stdout,
    `http_pass=${httpPass}\nbrowser_ws_pass=${browserPass}\nscout_page_ws_pass=${pagePass}\n`,
  );
  process.exit(httpPass && browserPass && pagePass ? 0 : 1);
}

if (import.meta.main) await main();
