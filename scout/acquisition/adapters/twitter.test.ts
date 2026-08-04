// scout/acquisition/adapters/twitter.test.ts
import assert from 'node:assert/strict';
import { parseTwitterPost, createTwitterAdapter } from './twitter.ts';
import { AcquisitionError } from '../types.ts';
import { Materializer } from '../materialize.ts';
import { readAcquisitionConfig } from '../config.ts';
import { EXTRACT_JS, COUNT_JS } from '../../scrapers/scrape_comments_x.ts';

const body = JSON.stringify({
  data: {
    tweetResult: {
      result: {
        rest_id: '123',
        legacy: { full_text: 'tweet text', favorite_count: 42 },
        core: { user_results: { result: { legacy: { screen_name: 'owner' } } } },
        extended_entities: {
          media: [
            { id_str: 'm1', type: 'photo', media_url_https: 'https://cdn.test/photo.jpg' },
            {
              id_str: 'm2',
              type: 'video',
              video_info: { variants: [{ bitrate: 832000, url: 'https://cdn.test/video.mp4?tag=1' }] },
            },
          ],
        },
      },
    },
  },
});
const post = parseTwitterPost(body, 'https://x.com/owner/status/123');
assert.equal(post?.post_id, '123');
assert.equal(post?.owner_handle, 'owner');
assert.equal(post?.engagement?.likes, 42);
assert.deepEqual(post?.media.map((item) => item.kind), ['image', 'video']);

// --- Strengthen: malformed/irrelevant JSON must yield null, never throw.
assert.equal(parseTwitterPost('not json at all', 'https://x.com/owner/status/123'), null);
assert.equal(
  parseTwitterPost(JSON.stringify({ data: { unrelated: true } }), 'https://x.com/owner/status/123'),
  null,
);

// --- Strengthen: a tombstone (deleted/unavailable tweet) matching the target
// id has no `legacy.full_text` — must be skipped, not mistaken for a real post.
const tombstoneBody = JSON.stringify({
  data: {
    tweetResult: {
      result: {
        __typename: 'TweetTombstone',
        rest_id: '123',
        tombstone: { text: { text: 'This post is unavailable.' } },
      },
    },
  },
});
assert.equal(parseTwitterPost(tombstoneBody, 'https://x.com/owner/status/123'), null);

// --- Strengthen: a tombstone that ALSO carries a stale cached `legacy.full_text`
// (a real X GraphQL pattern for a since-deleted/edited tweet whose entry still
// holds old text) must still be rejected. This shape sails past the
// `!legacy || typeof legacy.full_text !== 'string'` structural guard, so only
// isTombstone()'s `__typename === 'TweetTombstone'` fast-path can catch it —
// this pins that mechanism specifically, unlike the fixture above.
const staleLegacyTombstoneBody = JSON.stringify({
  data: {
    tweetResult: {
      result: {
        __typename: 'TweetTombstone',
        rest_id: '123',
        legacy: { full_text: 'stale cached text from before deletion', favorite_count: 42 },
        tombstone: { text: { text: 'This post is unavailable.' } },
      },
    },
  },
});
assert.equal(parseTwitterPost(staleLegacyTombstoneBody, 'https://x.com/owner/status/123'), null);

// --- Strengthen: a promoted entry sharing the target id must be skipped in
// favor of the real (non-promoted) result found later in the same tree.
const promotedBody = JSON.stringify({
  data: {
    ad: {
      tweetResult: {
        result: {
          rest_id: '123',
          promotedMetadata: { advertiser_name: 'Acme' },
          legacy: { full_text: 'promoted text', favorite_count: 0 },
        },
      },
    },
    real: {
      tweetResult: {
        result: {
          rest_id: '123',
          legacy: { full_text: 'real tweet text', favorite_count: 7 },
          core: { user_results: { result: { legacy: { screen_name: 'owner' } } } },
        },
      },
    },
  },
});
const promotedSkipped = parseTwitterPost(promotedBody, 'https://x.com/owner/status/123');
assert.equal(promotedSkipped?.text, 'real tweet text');
assert.equal(promotedSkipped?.engagement?.likes, 7);

// --- Strengthen: highest-bitrate MP4 variant wins; HLS manifest variants
// (no numeric bitrate) must never be picked over a real MP4.
const multiVariantBody = JSON.stringify({
  data: {
    tweetResult: {
      result: {
        rest_id: '123',
        legacy: { full_text: 'video tweet' },
        extended_entities: {
          media: [
            {
              id_str: 'm1',
              type: 'video',
              video_info: {
                variants: [
                  { url: 'https://cdn.test/manifest.m3u8' }, // no bitrate -> HLS, skip
                  { bitrate: 256000, url: 'https://cdn.test/low.mp4' },
                  { bitrate: 2176000, url: 'https://cdn.test/high.mp4' },
                  { bitrate: 832000, url: 'https://cdn.test/mid.mp4' },
                ],
              },
            },
          ],
        },
      },
    },
  },
});
const multiVariantPost = parseTwitterPost(multiVariantBody, 'https://x.com/owner/status/123');
assert.equal(multiVariantPost?.media[0]?.ephemeral_url, 'https://cdn.test/high.mp4');

console.log('ok twitter_adapter');

// --- Ruling 8 pinning test: a 403 from a video CDN (or any materialization
// exhaustion) must surface as `materialization-failed`, never a browser
// circuit-opening reason (`rate-limited`/`auth-required`/`challenge`).
{
  const materializer = new Materializer(readAcquisitionConfig(), {
    run: async () => {
      throw new Error('yt-dlp: HTTP Error 403: Forbidden');
    },
    fetchBytes: async () => {
      throw new Error('403 Forbidden');
    },
    root: process.cwd(),
    capabilities: new Set(['direct-http', 'yt-dlp']),
  });
  try {
    await materializer.materialize(
      {
        id: 'm2',
        kind: 'video',
        index: 1,
        canonical_post_url: 'https://x.com/owner/status/123',
        ephemeral_url: 'https://cdn.test/video.mp4',
      },
      'main',
    );
    assert.fail('expected materialize() to throw on total exhaustion');
  } catch (error) {
    assert.ok(error instanceof AcquisitionError);
    assert.equal(error.outcome.reason, 'materialization-failed');
    assert.notEqual(error.outcome.reason, 'rate-limited');
    assert.notEqual(error.outcome.reason, 'auth-required');
    assert.notEqual(error.outcome.reason, 'challenge');
  }
}

console.log('ok twitter_materialization_403');

// --- collectComments(): reuses EXTRACT_JS/COUNT_JS from scrape_comments_x.ts
// verbatim (checked by reference equality below) against a fake CdpClient,
// applying normalizeLikes and de-duplicating by `key`.
{
  const rawComments = [
    { idx: 0, key: '111', author: 'alice', text: 'nice', likes_raw: '1.2K' },
    { idx: 1, key: '222', author: 'bob', text: 'cool', likes_raw: '3,261' },
  ];
  const fakeClient: any = {
    evaluate: async (expr: string) => {
      if (expr === COUNT_JS) return 5;
      if (expr === EXTRACT_JS) return JSON.stringify(rawComments);
      return null;
    },
  };
  const context: any = {
    intents: () => new Set(),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire(fakeClient, new Set()),
  };
  const adapter = createTwitterAdapter();
  const comments = await adapter.collectComments(
    'https://x.com/owner/status/123',
    { max: 2 },
    context,
  );
  assert.equal(comments.length, 2);
  assert.equal(comments[0].author, 'alice');
  assert.equal(comments[0].likes, 1200);
  assert.equal(comments[1].author, 'bob');
  assert.equal(comments[1].likes, 3261);
}

console.log('ok twitter_collect_comments');
