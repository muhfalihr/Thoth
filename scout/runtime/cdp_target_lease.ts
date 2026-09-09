import {
  CDP_BASE,
  httpGetJSON,
  listTargets,
  sleep,
  type CdpTarget,
} from '../lib/cdp.ts';
import { isCdpTargetId, parseDevtoolsTargetPath } from '../lib/cdp_target.ts';

const COMMAND_TIMEOUT_MS = 5_000;
const DISCOVERY_ATTEMPTS = 20;
const DISCOVERY_INTERVAL_MS = 50;

export interface BrowserTargetSession {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface CdpTargetLease {
  readonly targetId: string;
  close(): Promise<void>;
}

export interface CdpTargetLeaseDeps {
  discoverBrowser(): Promise<{ webSocketDebuggerUrl: string }>;
  discoverPages(): Promise<readonly CdpTarget[]>;
  openBrowserSession(url: string): Promise<BrowserTargetSession>;
  sleep(ms: number): Promise<void>;
}

export interface CdpTargetLeaseOptions {
  discoveryAttempts?: number;
  discoveryIntervalMs?: number;
}

function fixed(code: string): Error {
  return new Error(code);
}

export function relayBrowserWebSocketUrl(
  discoveredUrl: string,
  relayBase: string = CDP_BASE,
): string {
  let discovered: URL;
  let relay: URL;
  try {
    discovered = new URL(discoveredUrl);
    relay = new URL(relayBase);
  } catch {
    throw fixed('cdp_browser_discovery_failed');
  }
  if (
    !['ws:', 'wss:'].includes(discovered.protocol) ||
    discovered.username ||
    discovered.password ||
    discovered.search ||
    discovered.hash ||
    parseDevtoolsTargetPath(discovered.pathname)?.kind !== 'browser' ||
    !['http:', 'https:'].includes(relay.protocol) ||
    relay.username ||
    relay.password ||
    relay.search ||
    relay.hash
  ) {
    throw fixed('cdp_browser_discovery_failed');
  }
  discovered.protocol = relay.protocol === 'https:' ? 'wss:' : 'ws:';
  discovered.host = relay.host;
  return discovered.href;
}

async function openBrowserSession(url: string): Promise<BrowserTargetSession> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(fixed('cdp_browser_session_failed')), COMMAND_TIMEOUT_MS);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(fixed('cdp_browser_session_failed'));
    }, { once: true });
  });
  let nextId = 1;
  return {
    command(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          ws.removeEventListener('message', receive);
          reject(fixed('cdp_browser_command_failed'));
        }, COMMAND_TIMEOUT_MS);
        const receive = (event: MessageEvent) => {
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (message.id !== id) return;
          clearTimeout(timer);
          ws.removeEventListener('message', receive);
          if (message.error) reject(fixed('cdp_browser_command_failed'));
          else resolve(message.result);
        };
        ws.addEventListener('message', receive);
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

const productionDeps: CdpTargetLeaseDeps = {
  async discoverBrowser() {
    const value = await httpGetJSON(`${CDP_BASE}/json/version`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw fixed('cdp_browser_discovery_failed');
    }
    const webSocketDebuggerUrl = Reflect.get(value, 'webSocketDebuggerUrl');
    if (typeof webSocketDebuggerUrl !== 'string') throw fixed('cdp_browser_discovery_failed');
    return { webSocketDebuggerUrl: relayBrowserWebSocketUrl(webSocketDebuggerUrl) };
  },
  discoverPages: listTargets,
  openBrowserSession,
  sleep,
};

export async function acquireCdpTargetLease(
  deps: CdpTargetLeaseDeps = productionDeps,
  options: CdpTargetLeaseOptions = {},
): Promise<CdpTargetLease> {
  let session: BrowserTargetSession | undefined;
  let targetId: string | undefined;
  try {
    const browser = await deps.discoverBrowser();
    session = await deps.openBrowserSession(browser.webSocketDebuggerUrl);
    const created = await session.command('Target.createTarget', { url: 'about:blank' });
    const candidate =
      created && typeof created === 'object' && !Array.isArray(created)
        ? Reflect.get(created, 'targetId')
        : undefined;
    if (!isCdpTargetId(candidate)) throw fixed('cdp_target_create_failed');
    targetId = candidate;

    const attempts = options.discoveryAttempts ?? DISCOVERY_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const targets = await deps.discoverPages();
      if (
        targets.some(
          (target) =>
            target.id === targetId &&
            target.type === 'page' &&
            typeof target.webSocketDebuggerUrl === 'string',
        )
      ) {
        let closePromise: Promise<void> | undefined;
        return {
          targetId,
          close() {
            closePromise ??= (async () => {
              try {
                const result = await session?.command('Target.closeTarget', { targetId });
                if (!result || typeof result !== 'object' || Reflect.get(result, 'success') !== true) {
                  throw fixed('cdp_target_cleanup_failed');
                }
              } catch {
                throw fixed('cdp_target_cleanup_failed');
              } finally {
                session?.close();
              }
            })();
            return closePromise;
          },
        };
      }
      await deps.sleep(options.discoveryIntervalMs ?? DISCOVERY_INTERVAL_MS);
    }
    try {
      await session.command('Target.closeTarget', { targetId });
    } catch {}
    throw fixed('cdp_target_unavailable');
  } catch (error) {
    session?.close();
    if (error instanceof Error && /^cdp_[a-z_]+$/.test(error.message)) throw error;
    throw fixed('cdp_target_create_failed');
  }
}
