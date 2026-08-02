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
console.log('ok network_capture');
