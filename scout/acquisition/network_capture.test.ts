import assert from 'node:assert/strict';
import { observeNetworkResponses } from './network_capture.ts';

class FakeSocket {
  private listeners = new Set<(event: { data: string }) => void>();
  addEventListener(_type: string, listener: (event: { data: string }) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: (event: { data: string }) => void): void {
    this.listeners.delete(listener);
  }
  dispatchMessage(data: string): void {
    for (const listener of this.listeners) listener({ data });
  }
  listenerCount(): number {
    return this.listeners.size;
  }
}
const ws = new FakeSocket();
const commands: string[] = [];
const client = {
  ws,
  cmd: async (method: string) => {
    commands.push(method);
    if (method === 'Network.getResponseBody') return { body: '{"data":{"id":"ABC"}}' };
    return {};
  },
} as any;

const result = observeNetworkResponses(client, {
  deadlineMs: 100,
  matchers: [
    {
      id: 'instagram-post',
      matches: (event) => event.url.includes('/graphql/query'),
      parse: (body) => JSON.parse(body).data.id,
    },
  ],
  action: async () => {
    ws.dispatchMessage(
      JSON.stringify({
        method: 'Network.responseReceived',
        params: {
          requestId: '1',
          response: { url: 'https://www.instagram.com/graphql/query', status: 200 },
        },
      }),
    );
    ws.dispatchMessage(
      JSON.stringify({ method: 'Network.loadingFinished', params: { requestId: '1' } }),
    );
  },
});

assert.deepEqual(await result, { 'instagram-post': 'ABC' });
assert.deepEqual(commands, ['Network.enable', 'Network.getResponseBody', 'Network.disable']);
assert.equal(ws.listenerCount(), 0);

const timeoutSocket = new FakeSocket();
const timedOut = await observeNetworkResponses(
  { ws: timeoutSocket, cmd: async () => ({}) } as any,
  {
    deadlineMs: 1,
    matchers: [{ id: 'missing', matches: () => false, parse: () => null }],
    action: async () => {},
  },
);
assert.deepEqual(timedOut, {});
assert.equal(timeoutSocket.listenerCount(), 0);

// Regression: a throwing matches() predicate must be swallowed like any other
// per-response failure — never an unhandled rejection (matches() used to run
// outside the try/catch guarding getResponseBody/parse).
let unhandledRejection: unknown = null;
const onUnhandledRejection = (reason: unknown) => {
  unhandledRejection = reason;
};
process.on('unhandledRejection', onUnhandledRejection);

const throwSocket = new FakeSocket();
const throwResult = await observeNetworkResponses(
  { ws: throwSocket, cmd: async () => ({}) } as any,
  {
    deadlineMs: 20,
    matchers: [
      {
        id: 'boom',
        matches: () => {
          throw new Error('matches() must not escape observeNetworkResponses');
        },
        parse: () => null,
      },
    ],
    action: async () => {
      throwSocket.dispatchMessage(
        JSON.stringify({
          method: 'Network.responseReceived',
          params: {
            requestId: '1',
            response: { url: 'https://www.instagram.com/graphql/query', status: 200 },
          },
        }),
      );
      throwSocket.dispatchMessage(
        JSON.stringify({ method: 'Network.loadingFinished', params: { requestId: '1' } }),
      );
    },
  },
);
assert.deepEqual(throwResult, {});
assert.equal(throwSocket.listenerCount(), 0);
// Give any (incorrectly) unhandled rejection a chance to surface before asserting.
await new Promise((r) => setTimeout(r, 20));
process.off('unhandledRejection', onUnhandledRejection);
assert.equal(unhandledRejection, null);

// Regression: if the deadline fires while a Network.getResponseBody call is
// still in flight, the already-resolved result object must not be mutated
// afterward, and no further Network.getResponseBody may be issued once
// Network.disable has been sent.
const slowSocket = new FakeSocket();
const slowCommands: string[] = [];
let resolveBody!: (value: { body: string }) => void;
const bodyPromise = new Promise<{ body: string }>((resolve) => {
  resolveBody = resolve;
});
const slowResultPromise = observeNetworkResponses(
  {
    ws: slowSocket,
    cmd: async (method: string) => {
      slowCommands.push(method);
      if (method === 'Network.getResponseBody') return bodyPromise;
      return {};
    },
  } as any,
  {
    deadlineMs: 10,
    matchers: [
      {
        id: 'slow',
        matches: (event) => event.url.includes('/graphql/query'),
        parse: (body) => JSON.parse(body).data.id,
      },
    ],
    action: async () => {
      slowSocket.dispatchMessage(
        JSON.stringify({
          method: 'Network.responseReceived',
          params: {
            requestId: '1',
            response: { url: 'https://www.instagram.com/graphql/query', status: 200 },
          },
        }),
      );
      slowSocket.dispatchMessage(
        JSON.stringify({ method: 'Network.loadingFinished', params: { requestId: '1' } }),
      );
    },
  },
);

const slowResult = await slowResultPromise;
assert.deepEqual(slowResult, {});
assert.deepEqual(slowCommands, ['Network.enable', 'Network.getResponseBody', 'Network.disable']);
assert.equal(slowSocket.listenerCount(), 0);

// Now let the in-flight getResponseBody resolve, well after the deadline
// already fired and the promise already resolved.
resolveBody({ body: '{"data":{"id":"TOO-LATE"}}' });
await new Promise((r) => setTimeout(r, 20));

assert.deepEqual(slowResult, {}); // untouched post-resolution
assert.deepEqual(slowCommands, ['Network.enable', 'Network.getResponseBody', 'Network.disable']); // no extra call after disable

console.log('ok network_capture');
