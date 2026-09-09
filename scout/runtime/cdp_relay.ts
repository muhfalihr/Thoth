// cdp_relay.ts — expose exactly as much of a loopback DevTools endpoint as a
// sibling container needs, and nothing else.
//
// WHY: Chromium binds its DevTools port to loopback even when it is started with
// --remote-debugging-address=0.0.0.0, so `legacy-cdp:18800` resolves by DNS and is
// still refused at TCP. A sidecar healthcheck that probes 127.0.0.1 from inside the
// same container cannot see that. The relay listens on the container network and
// forwards to the browser over loopback.
//
// A DevTools endpoint is a full remote-code surface, so this is deliberately not a
// proxy: only the three read-only discovery routes are forwarded, only target ids the
// relay itself observed during discovery may be opened, and the upstream authority is
// always the configured one — never an authority read back out of browser output.
// Nothing here logs a page url, a target id, or a protocol frame.

// Each discovery route is authoritative for exactly one kind of target: `/json` and
// `/json/list` enumerate pages, `/json/version` describes the browser. Keeping the
// scopes apart is what lets a poll REPLACE what it reported without a browser-level
// poll silently retiring live pages, or a page poll retiring the browser endpoint.
import { parseDevtoolsTargetPath } from '../lib/cdp_target.ts';

const DISCOVERY_SCOPES = new Map<string, TargetKind>([
  ['/json', 'page'],
  ['/json/list', 'page'],
  ['/json/version', 'browser'],
]);
const DISCOVERY_TIMEOUT_MS = 5_000;
const DISCOVERY_MAX_BYTES = 1024 * 1024;
const UPGRADE_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
// FOLLOW-UP (local, unfiled): the limit is checked before the upgrade and the session
// is recorded when the socket opens, so concurrent upgrades can overshoot it by the
// number in flight. Scout drives one client, so the ceiling is not reachable today;
// closing it means re-checking inside `open` and closing over the limit.
const MAX_SESSIONS = 32;
const LIVENESS_INTERVAL_MS = 5_000;
const LIVENESS_TIMEOUT_MS = 2_000;
// One missed probe can be a scheduling hiccup; two in a row is a socket that stopped
// answering. Restarting a healthy sidecar is worse than noticing a dead one a beat late.
const LIVENESS_STRIKES = 2;

type TargetKind = 'page' | 'browser';

export type RelayHandle = {
  port: number;
  /**
   * Resolves when the relay stops answering on its own socket. A `stop()` cancels the
   * watch instead of resolving it, so a requested shutdown is never a failure.
   */
  failed: Promise<void>;
  stop(): Promise<void>;
};

export interface LivenessWatchOptions {
  intervalMs?: number;
  timeoutMs?: number;
  strikes?: number;
  /** Overridden only by tests; the default probes the socket over real HTTP. */
  probe?: (url: string, timeoutMs: number) => Promise<boolean>;
}

export interface CdpRelayOptions {
  upstreamBase: URL;
  advertisedBase: URL;
  hostname: string;
  port: number;
  liveness?: LivenessWatchOptions;
}

interface SessionData {
  path: string;
  upstream: WebSocket | null;
  queue: (string | Uint8Array)[];
  queuedBytes: number;
  upgradeTimer: ReturnType<typeof setTimeout> | null;
}

export function isAllowedDiscoveryPath(path: string): boolean {
  return DISCOVERY_SCOPES.has(path);
}

function devtoolsKind(pathname: string): TargetKind | null {
  return parseDevtoolsTargetPath(pathname)?.kind ?? null;
}

/**
 * Bun.serve reports no event when a listener stops serving, so liveness is observed
 * the same way a sibling container would: a bounded request against the socket. The
 * probe asks for a path the relay refuses locally, which keeps a stalled browser from
 * reading as a dead relay.
 */
export function watchRelayLiveness(
  url: string,
  options: LivenessWatchOptions = {},
): { failed: Promise<void>; cancel(): void } {
  const intervalMs = options.intervalMs ?? LIVENESS_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? LIVENESS_TIMEOUT_MS;
  const allowedStrikes = options.strikes ?? LIVENESS_STRIKES;
  const probe = options.probe ?? defaultLivenessProbe;

  let cancelled = false;
  let inFlight = false;
  let strikes = 0;
  let report: () => void = () => {};
  const failed = new Promise<void>((resolve) => {
    report = resolve;
  });

  const timer = setInterval(() => {
    if (cancelled || inFlight) return;
    inFlight = true;
    void (async () => {
      let alive: boolean;
      try {
        alive = await probe(url, timeoutMs);
      } catch {
        alive = false;
      }
      inFlight = false;
      if (cancelled) return;
      strikes = alive ? 0 : strikes + 1;
      if (strikes >= allowedStrikes) {
        cancelled = true;
        clearInterval(timer);
        report();
      }
    })();
  }, intervalMs);

  return {
    failed,
    cancel() {
      cancelled = true;
      clearInterval(timer);
    },
  };
}

/** Any HTTP answer proves the listener accepted a connection and ran the handler. */
async function defaultLivenessProbe(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await response.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

function websocketProtocol(base: URL): string {
  return base.protocol === 'https:' ? 'wss:' : 'ws:';
}

function rewriteEntry(entry: unknown, advertisedBase: URL): unknown {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  const record = entry as Record<string, unknown>;
  const advertised = record.webSocketDebuggerUrl;
  if (typeof advertised !== 'string') return entry;
  let parsed: URL;
  try {
    parsed = new URL(advertised);
  } catch {
    return entry;
  }
  const rewritten = `${websocketProtocol(advertisedBase)}//${advertisedBase.host}${parsed.pathname}`;
  return { ...record, webSocketDebuggerUrl: rewritten };
}

/** Replace only the debugger authority; every other discovery field is passed through. */
export function rewriteDiscovery(value: unknown, advertisedBase: URL): unknown {
  if (Array.isArray(value)) return value.map((entry) => rewriteEntry(entry, advertisedBase));
  return rewriteEntry(value, advertisedBase);
}

/**
 * The targets of one kind that a discovery response reports, as a fresh set. A route
 * may only speak for its own scope, so a page listing can never introduce a browser
 * endpoint and the reverse cannot happen either.
 */
function collectTargetPaths(value: unknown, scope: TargetKind): Set<string> {
  const found = new Set<string>();
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const advertised = (entry as Record<string, unknown>).webSocketDebuggerUrl;
    if (typeof advertised !== 'string') continue;
    try {
      const { pathname } = new URL(advertised);
      if (devtoolsKind(pathname) === scope) found.add(pathname);
    } catch {
      /* an unparseable debugger url simply never becomes reachable */
    }
  }
  return found;
}

async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > DISCOVERY_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function safeError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function startCdpRelay(options: CdpRelayOptions): RelayHandle {
  const { upstreamBase, advertisedBase, hostname, port } = options;
  // A snapshot per scope, replaced wholesale by each successful poll: an id the
  // browser has forgotten stops being admissible instead of lingering for the life
  // of the container.
  const knownTargets: Record<TargetKind, Set<string>> = {
    page: new Set<string>(),
    browser: new Set<string>(),
  };
  const sessions = new Set<{ close(code?: number, reason?: string): void; data: SessionData }>();

  const upstreamWebSocketUrl = (path: string): string =>
    `${websocketProtocol(upstreamBase)}//${upstreamBase.host}${path}`;

  const releaseSession = (socket: { data: SessionData }): void => {
    const state = socket.data;
    if (state.upgradeTimer) clearTimeout(state.upgradeTimer);
    state.upgradeTimer = null;
    state.queue.length = 0;
    state.queuedBytes = 0;
    const upstream = state.upstream;
    state.upstream = null;
    if (upstream) {
      try {
        upstream.close();
      } catch {
        /* already gone */
      }
    }
    sessions.delete(socket as never);
  };

  const server = Bun.serve<SessionData, Record<never, never>>({
    hostname,
    port,
    idleTimeout: 0,
    async fetch(request, self) {
      const url = new URL(request.url);

      if (url.pathname.startsWith('/devtools/')) {
        if (request.method !== 'GET') return safeError(405, 'method_not_allowed');
        const kind = devtoolsKind(url.pathname);
        if (!kind || !knownTargets[kind].has(url.pathname)) {
          return safeError(404, 'unknown_target');
        }
        if (sessions.size >= MAX_SESSIONS) return safeError(503, 'session_limit_reached');
        const data: SessionData = {
          path: url.pathname,
          upstream: null,
          queue: [],
          queuedBytes: 0,
          upgradeTimer: null,
        };
        if (self.upgrade(request, { data })) return undefined as unknown as Response;
        return safeError(400, 'websocket_upgrade_required');
      }

      const scope = DISCOVERY_SCOPES.get(`${url.pathname}${url.search}`);
      if (scope === undefined) return safeError(404, 'not_found');
      if (request.method !== 'GET') return safeError(405, 'method_not_allowed');

      let body: string | null;
      try {
        const upstream = await fetch(new URL(url.pathname, upstreamBase), {
          headers: { host: upstreamBase.host, accept: 'application/json' },
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
        if (!upstream.ok) return safeError(502, 'upstream_status');
        body = await readCapped(upstream);
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name === 'TimeoutError' || name === 'AbortError')
          return safeError(504, 'upstream_timeout');
        return safeError(502, 'upstream_unreachable');
      }
      if (body === null) return safeError(502, 'upstream_body_rejected');

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return safeError(502, 'upstream_body_rejected');
      }
      knownTargets[scope] = collectTargetPaths(parsed, scope);
      return Response.json(rewriteDiscovery(parsed, advertisedBase));
    },
    websocket: {
      maxPayloadLength: MAX_MESSAGE_BYTES,
      backpressureLimit: MAX_BUFFERED_BYTES,
      closeOnBackpressureLimit: true,
      open(socket) {
        const state = socket.data;
        sessions.add(socket as never);
        let upstream: WebSocket;
        try {
          upstream = new WebSocket(upstreamWebSocketUrl(state.path));
        } catch {
          socket.close(1011, 'upstream_unreachable');
          return;
        }
        state.upstream = upstream;
        state.upgradeTimer = setTimeout(() => {
          if (upstream.readyState !== WebSocket.OPEN) socket.close(1011, 'upstream_timeout');
        }, UPGRADE_TIMEOUT_MS);
        upstream.addEventListener('open', () => {
          if (state.upgradeTimer) clearTimeout(state.upgradeTimer);
          state.upgradeTimer = null;
          for (const frame of state.queue) upstream.send(frame);
          state.queue.length = 0;
          state.queuedBytes = 0;
        });
        upstream.addEventListener('message', (event: MessageEvent) => {
          if (socket.getBufferedAmount() > MAX_BUFFERED_BYTES) {
            socket.close(1009, 'downstream_backpressure');
            return;
          }
          socket.send(event.data as string | Uint8Array);
        });
        upstream.addEventListener('close', () => socket.close(1001, 'upstream_closed'));
        upstream.addEventListener('error', () => socket.close(1011, 'upstream_error'));
      },
      message(socket, message) {
        const state = socket.data;
        const upstream = state.upstream;
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(message as string | Uint8Array);
          return;
        }
        // The client may send its first command before the browser socket is open;
        // dropping it would strand a session that never receives its reply.
        const size = typeof message === 'string' ? message.length : message.byteLength;
        if (state.queuedBytes + size > MAX_BUFFERED_BYTES) {
          socket.close(1009, 'upstream_backpressure');
          return;
        }
        state.queue.push(message as string | Uint8Array);
        state.queuedBytes += size;
      },
      close(socket) {
        releaseSession(socket);
      },
    },
  });

  // The watch probes the socket the way a sibling would. A wildcard bind is reachable
  // over loopback, which keeps the probe inside the container.
  const probeHost = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname;
  const watch = watchRelayLiveness(`http://${probeHost}:${server.port}/`, options.liveness);

  return {
    port: server.port,
    failed: watch.failed,
    async stop() {
      watch.cancel();
      for (const socket of [...sessions]) {
        releaseSession(socket);
        try {
          socket.close(1001, 'relay_stopping');
        } catch {
          /* already gone */
        }
      }
      await server.stop(true);
    },
  };
}
