import assert from 'node:assert/strict';
import { AcquisitionError } from '../types.ts';
import { createThreadsAdapter, parseThreadsPost } from './threads.ts';

// Shrink the network-capture deadline so inspect() tests below (which never
// have a real CDP socket emitting responses) don't block on the config
// default (15s) waiting for a capture that will never arrive. Threaded
// through createThreadsAdapter({ captureMs }) instead of mutating
// process.env.THOTH_ACQUISITION_CAPTURE_MS — Bun batches multiple test files
// into one process, so a module-scope env mutation here would leak a 20ms
// capture deadline into any test file loaded after this one.
const TEST_CAPTURE_MS = 20;

// Minimal, inert CDP transport stub: observeNetworkResponses() only needs
// ws.addEventListener/removeEventListener + cmd('Network.enable'/'disable')
// to complete — it never emits a message, so inspect() always falls through
// to the Open Graph/video-materialization path being pinned below.
function fakeWs() {
  return { addEventListener: () => {}, removeEventListener: () => {} };
}

function fakeContext(intents: string[] = []): any {
  return {
    intents: () => new Set(intents),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire({} as any, new Set(intents)),
  };
}

// --- pinned: parseThreadsPost() extracts post_id/media from a captured
// Meta response body (brief's exact fixture).
{
  const post = parseThreadsPost(
    JSON.stringify({
      data: {
        post: {
          id: 'TH1',
          user: { username: 'owner' },
          text: 'thread text',
          image_url: 'https://cdn.test/a.jpg',
        },
      },
    }),
    'https://www.threads.net/@owner/post/TH1',
  );
  assert.equal(post?.post_id, 'TH1');
  assert.equal(post?.media[0].kind, 'image');
}
console.log('ok threads_adapter');

// --- pinned: a body with no matching post node returns null, never throws.
{
  const post = parseThreadsPost('{"data":{}}', 'https://www.threads.net/@owner/post/TH1');
  assert.equal(post, null);
}
console.log('ok threads_parse_returns_null_when_absent');

// --- pinned: inspect() only calls threadsVideoSrc() (video materialization)
// when the caller registered the `media` intent — never unconditionally,
// since a real call would resolve a signed/ephemeral fbcdn URL for every
// inspect(), including plain metadata lookups that never need it.
{
  let videoSrcCalls = 0;
  const deps = {
    videoSrc: async () => {
      videoSrcCalls += 1;
      return 'https://video.fbcdn.net/x.mp4';
    },
    captureMs: TEST_CAPTURE_MS,
  };
  const fakeClient: any = {
    ws: fakeWs(),
    cmd: async () => ({}),
    evaluate: async () => JSON.stringify({ title: 'og title', description: 'og desc', image: '' }),
  };
  const context: any = {
    intents: () => new Set(),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire(fakeClient, new Set()),
  };
  const adapter = createThreadsAdapter(deps);
  const post = await adapter.inspect('https://www.threads.net/@owner/post/TH1', context);
  assert.equal(videoSrcCalls, 0);
  assert.equal(post.media.some((m) => m.kind === 'video'), false);
}
console.log('ok threads_inspect_skips_video_without_media_intent');

// --- pinned: with a `media` intent, inspect() DOES call threadsVideoSrc()
// and folds a found video into the returned media list.
{
  let videoSrcCalls = 0;
  const deps = {
    videoSrc: async () => {
      videoSrcCalls += 1;
      return 'https://video.fbcdn.net/x.mp4';
    },
    captureMs: TEST_CAPTURE_MS,
  };
  const fakeClient: any = {
    ws: fakeWs(),
    cmd: async () => ({}),
    evaluate: async () => JSON.stringify({ title: 'og title', description: 'og desc', image: '' }),
  };
  const context: any = {
    intents: () => new Set(['media']),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire(fakeClient, new Set(['media'])),
  };
  const adapter = createThreadsAdapter(deps);
  const post = await adapter.inspect('https://www.threads.net/@owner/post/TH1', context);
  assert.equal(videoSrcCalls, 1);
  assert.equal(post.media[0].kind, 'video');
  assert.equal(post.media[0].ephemeral_url, 'https://video.fbcdn.net/x.mp4');
}
console.log('ok threads_inspect_resolves_video_with_media_intent');

// --- pinned: collectComments() throws AcquisitionError(reason:'unsupported')
// — grep of scout/scrapers confirms no scrape_comments_threads.ts (or any
// threads-named comment scraper) exists to reuse, unlike Facebook/Reddit.
{
  const adapter = createThreadsAdapter();
  try {
    await adapter.collectComments('https://www.threads.net/@owner/post/TH1', { max: 5 }, fakeContext());
    assert.fail('expected collectComments() to throw');
  } catch (error) {
    assert.ok(error instanceof AcquisitionError);
    assert.equal((error as AcquisitionError).outcome.reason, 'unsupported');
  }
}
console.log('ok threads_collect_comments_unsupported');

// --- pinned: discover() throws AcquisitionError(reason:'unsupported').
{
  const adapter = createThreadsAdapter();
  try {
    await adapter.discover({ platform: 'threads', kind: 'query', value: 'x', limit: 5 }, fakeContext());
    assert.fail('expected discover() to throw');
  } catch (error) {
    assert.ok(error instanceof AcquisitionError);
    assert.equal((error as AcquisitionError).outcome.reason, 'unsupported');
  }
}
console.log('ok threads_discover_unsupported');
