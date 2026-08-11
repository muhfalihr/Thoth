import assert from 'node:assert/strict';
import { EXTRACT_JS } from '../../scrapers/scrape_comments_fb.ts';
import { AcquisitionError } from '../types.ts';
import { createFacebookAdapter, parseFacebookPost } from './facebook.ts';

function fakeContext(intents: string[] = []): any {
  return {
    intents: () => new Set(intents),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire({} as any, new Set(intents)),
  };
}

// --- pinned: parseFacebookPost() extracts post_id/owner/text/media from a
// captured GraphQL body (brief's exact fixture).
{
  const post = parseFacebookPost(
    JSON.stringify({
      data: {
        post_id: 'f1',
        actors: [{ name: 'Owner' }],
        message: { text: 'message' },
        attachments: [{ media: { image: { uri: 'https://cdn.test/f.jpg' } } }],
      },
    }),
    'https://www.facebook.com/owner/posts/f1',
  );
  assert.equal(post?.post_id, 'f1');
  assert.equal(post?.owner_handle, 'Owner');
  assert.equal(post?.text, 'message');
  assert.equal(post?.media[0].kind, 'image');
}
console.log('ok facebook_adapter');

// --- pinned: a body with no matching post node returns null, never throws.
{
  const post = parseFacebookPost('{"data":{"unrelated":true}}', 'https://www.facebook.com/owner/posts/f1');
  assert.equal(post, null);
}
console.log('ok facebook_parse_returns_null_when_absent');

// --- pinned: collectComments() drives EXTRACT_JS (reference-identical to
// scrape_comments_fb.ts's export — no re-implemented selector) through
// context.visit(), normalizes likes, and truncates to limits.max. Fixture has
// 3 raw comments against max=2 so the final slice guard is actually exercised
// (Ruling 2's "fixture size == max never proves the guard" concern).
{
  const raw = [
    { idx: 0, author: 'alice', text: 'nice', likes_raw: '', avatar_url: '' },
    { idx: 1, author: 'bob', text: 'cool', likes_raw: '', avatar_url: '' },
    { idx: 2, author: 'carol', text: 'love it', likes_raw: '', avatar_url: '' },
  ];
  const fakeClient: any = {
    evaluate: async (expr: string) => {
      if (expr === EXTRACT_JS) return JSON.stringify(raw);
      return 3;
    },
  };
  const context: any = {
    intents: () => new Set(),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire(fakeClient, new Set()),
  };
  const adapter = createFacebookAdapter();
  const comments = await adapter.collectComments(
    'https://www.facebook.com/owner/posts/f1',
    { max: 2 },
    context,
  );
  assert.equal(comments.length, 2);
  assert.equal(comments[0].author, 'alice');
  assert.equal(comments[1].author, 'bob');
}
console.log('ok facebook_collect_comments_truncates_to_max');

// --- pinned: discover() throws AcquisitionError(reason:'unsupported'),
// never a bare Error, for the kinds this adapter does not implement.
{
  const adapter = createFacebookAdapter();
  try {
    await adapter.discover({ platform: 'facebook', kind: 'query', value: 'x', limit: 5 }, fakeContext());
    assert.fail('expected discover() to throw');
  } catch (error) {
    assert.ok(error instanceof AcquisitionError);
    assert.equal((error as AcquisitionError).outcome.reason, 'unsupported');
  }
}
console.log('ok facebook_discover_unsupported');

// Minimal, inert CDP transport stub for the DOM-fallback path below:
// observeNetworkResponses() only needs ws.addEventListener/removeEventListener
// + cmd('Network.enable'/'disable') to complete — it never emits a message,
// so inspect() always falls through to the DOM-crop path being pinned.
function fakeWs() {
  return { addEventListener: () => {}, removeEventListener: () => {} };
}

// Shrink the network-capture deadline via createFacebookAdapter({ captureMs })
// (same DI pattern threads.ts established, per this fix round's Fix 1) so the
// DOM-fallback test below doesn't block on the config default (15s) waiting
// for a capture that will never arrive.
const TEST_CAPTURE_MS = 20;

// --- pinned: inspect() resolves via the network-capture path when a matching
// GraphQL response is observed — asserts the resulting PostRecord fields and
// that outcome.source is honestly 'network'. cropPost is stubbed to throw so
// a call to it here (which should never happen without a social-card intent)
// fails loudly instead of silently.
{
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
  }
  const ws = new FakeSocket();
  const networkBody = JSON.stringify({
    data: {
      post_id: 'f42',
      actors: [{ name: 'Network Owner' }],
      message: { text: 'network message' },
      attachments: [{ media: { image: { uri: 'https://cdn.test/net.jpg' } } }],
    },
  });
  const fakeClient: any = {
    ws,
    cmd: async (method: string) => {
      if (method === 'Network.enable') {
        ws.dispatchMessage(
          JSON.stringify({
            method: 'Network.responseReceived',
            params: {
              requestId: '1',
              response: { url: 'https://www.facebook.com/api/graphql/', status: 200 },
            },
          }),
        );
        ws.dispatchMessage(
          JSON.stringify({ method: 'Network.loadingFinished', params: { requestId: '1' } }),
        );
        return {};
      }
      if (method === 'Network.getResponseBody') return { body: networkBody };
      return {};
    },
  };
  const deps = {
    captureMs: TEST_CAPTURE_MS,
    cropPost: async () => {
      throw new Error('cropPost must not be called on the network-capture success path');
    },
  };
  const context: any = {
    intents: () => new Set(),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire(fakeClient, new Set()),
  };
  const adapter = createFacebookAdapter(deps);
  const post = await adapter.inspect('https://www.facebook.com/owner/posts/f42', context);
  assert.equal(post.outcome.source, 'network');
  assert.equal(post.post_id, 'f42');
  assert.equal(post.owner_handle, 'Network Owner');
  assert.equal(post.text, 'network message');
  assert.equal(post.media[0]?.kind, 'image');
}
console.log('ok facebook_inspect_resolves_via_network_capture');

// --- pinned: inspect() falls back to the DOM crop (cropPost) when no
// matching network response arrives within the deadline, asserting
// outcome.source is honestly 'dom' (not 'network').
{
  const fakeClient: any = { ws: fakeWs(), cmd: async () => ({}) };
  let cropCalls = 0;
  let capturedOpts: any;
  const deps = {
    captureMs: TEST_CAPTURE_MS,
    cropPost: async (opts: any) => {
      cropCalls += 1;
      capturedOpts = opts;
      return { ok: true, text: 'dom fallback text', image_path: null, bytes: 0 };
    },
  };
  const context: any = {
    intents: () => new Set(),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire(fakeClient, new Set()),
  };
  const adapter = createFacebookAdapter(deps);
  const post = await adapter.inspect('https://www.facebook.com/owner/posts/f99', context);
  assert.equal(cropCalls, 1);
  assert.equal(capturedOpts.client, fakeClient);
  assert.equal(capturedOpts.navigate, false);
  assert.equal(post.outcome.source, 'dom');
  assert.equal(post.text, 'dom fallback text');
  assert.equal(post.post_id, 'f99');
}
console.log('ok facebook_inspect_falls_back_to_dom');

// --- pinned: captureSocialCard() on its success path reuses the visit's own
// client (navigate:false) rather than opening a second CDP session — only
// ONE context.visit() call happens for the whole captureSocialCard() call.
{
  const fakeClient: any = { marker: 'the-one-client' };
  let visitCalls = 0;
  let capturedOpts: any;
  const deps = {
    cropPost: async (opts: any) => {
      capturedOpts = opts;
      return { ok: true, image_path: '/tmp/card.png', bytes: 321 };
    },
  };
  const context: any = {
    intents: () => new Set(),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => {
      visitCalls += 1;
      return acquire(fakeClient, new Set());
    },
  };
  const adapter = createFacebookAdapter(deps);
  const asset = await adapter.captureSocialCard(
    'https://www.facebook.com/owner/posts/f7',
    'post',
    context,
  );
  assert.equal(visitCalls, 1);
  assert.equal(capturedOpts.client, fakeClient);
  assert.equal(capturedOpts.navigate, false);
  assert.deepEqual(asset, {
    path: '/tmp/card.png',
    kind: 'social-card',
    source: 'dom',
    bytes: 321,
  });
}
console.log('ok facebook_capture_social_card_reuses_visit_client');
