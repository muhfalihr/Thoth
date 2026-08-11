// network_capture.ts — generic passive CDP network observer.
//
// Platform adapters (Instagram/TikTok/X/etc.) need to read the platform JSON
// responses the page ITSELF already fetched (GraphQL, XHR API calls) rather
// than replaying requests or scraping the DOM. This module is the one place
// that speaks the Network.* CDP domain: it enables network events, watches
// responseReceived/loadingFinished pairs, matches them against caller-supplied
// matchers, pulls bodies via Network.getResponseBody, and cleans up (removes
// its own listener + Network.disable) no matter how it exits.
//
// Deliberately narrow: read-only observation. No request interception, no
// replay, no header/body persistence — see CapturedResponse below for exactly
// what is retained.

import type { CdpClient } from '../lib/cdp.ts';

export interface CapturedResponse {
  requestId: string;
  url: string;
  status: number;
  mimeType?: string;
}

export interface NetworkMatcher<T> {
  id: string;
  matches(response: CapturedResponse): boolean;
  parse(body: string, response: CapturedResponse): T | null;
}

interface ObserveOptions<T> {
  deadlineMs: number;
  matchers: NetworkMatcher<T>[];
  action: () => Promise<void>;
}

/**
 * Passively observe CDP `Network.*` events while `action()` runs, extracting
 * one value per matcher from the first matching response whose parsed body is
 * non-null. Resolves as soon as every matcher has a value, or when
 * `deadlineMs` elapses — either way it resolves with whatever was collected,
 * it never rejects on timeout. A single response failing to fetch/parse is
 * skipped; it never aborts the whole observation.
 */
export function observeNetworkResponses<T>(
  client: Pick<CdpClient, 'ws' | 'cmd'>,
  options: ObserveOptions<T>,
): Promise<Record<string, T>> {
  const { deadlineMs, matchers, action } = options;
  const { ws, cmd } = client;

  return new Promise((resolve) => {
    const results: Record<string, T> = {};
    const pending = new Map<string, CapturedResponse>();
    const remaining = new Set(matchers.map((m) => m.id));
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = async () => {
      if (settled) return;
      settled = true;
      ws.removeEventListener('message', onMessage);
      if (timer) clearTimeout(timer);
      try {
        await cmd('Network.disable');
      } catch {
        // best-effort cleanup only
      }
      resolve(results);
    };

    const maybeFinish = () => {
      if (remaining.size === 0) void finish();
    };

    const onMessage = (event: { data: string }) => {
      let message: any;
      try {
        message = JSON.parse(event.data);
      } catch {
        return; // non-JSON frame
      }

      if (message.method === 'Network.responseReceived') {
        const requestId = message.params?.requestId;
        const response = message.params?.response;
        if (!requestId || !response) return;
        pending.set(requestId, {
          requestId,
          url: response.url,
          status: response.status,
          mimeType: response.mimeType,
        });
        return;
      }

      if (message.method === 'Network.loadingFinished') {
        const requestId = message.params?.requestId;
        const captured = requestId ? pending.get(requestId) : undefined;
        if (!captured) return;
        pending.delete(requestId);
        void handleFinished(captured);
      }
    };

    const handleFinished = async (response: CapturedResponse) => {
      for (const matcher of matchers) {
        // Gate re-entry BEFORE issuing any more work for this matcher: once
        // finish() has run (deadline fired, or another matcher's in-flight
        // call already completed the set), stop touching results/remaining
        // and stop issuing further CDP commands — settled means
        // Network.disable is already sent (or about to be).
        if (settled) return;
        if (!remaining.has(matcher.id)) continue;
        try {
          // matches() is caller-supplied and may throw (e.g. a matcher that
          // assumes `mimeType` is always defined) — keep it inside the same
          // try/catch as the body fetch/parse so a throwing predicate is
          // just a skipped match, never an unhandled rejection (Ruling 4).
          if (!matcher.matches(response)) continue;
          const result = await cmd('Network.getResponseBody', { requestId: response.requestId });
          // The deadline may have fired while the above await was in
          // flight — don't mutate the already-resolved `results` object or
          // shrink `remaining` after the fact.
          if (settled) return;
          const body: string =
            result?.base64Encoded && typeof result.body === 'string'
              ? Buffer.from(result.body, 'base64').toString('utf8')
              : (result?.body ?? '');
          const value = matcher.parse(body, response);
          if (value !== null && value !== undefined) {
            results[matcher.id] = value;
            remaining.delete(matcher.id);
          }
        } catch {
          // per-response failure: skip this matcher for this response and
          // keep observing (Ruling 4) — never let one bad predicate/body
          // reject the call.
        }
      }
      maybeFinish();
    };

    ws.addEventListener('message', onMessage);
    timer = setTimeout(() => void finish(), deadlineMs);

    void (async () => {
      try {
        await cmd('Network.enable');
        await action();
      } catch {
        // action() failures still resolve with whatever was captured so far;
        // the deadline timer (or an already-satisfied matcher set) finishes us.
      }
    })();
  });
}
