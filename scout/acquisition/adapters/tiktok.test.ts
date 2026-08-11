import assert from 'node:assert/strict';
import { createTikTokAdapter } from './tiktok.ts';
import { AcquisitionError } from '../types.ts';
import { EXTRACT_JS } from '../../scrapers/scrape_comments.ts';

function fakeContext(intents: string[] = []): any {
  return {
    intents: () => new Set(intents),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire({} as any, new Set(intents)),
  };
}

// --- inspect(): no `media` intent registered — directUrl() must never be called
// and ephemeral_url must stay unset.
{
  let directUrlCalls = 0;
  const adapter = createTikTokAdapter({
    oembed: async () => ({ title: 'TikTok caption', author: 'creator', thumbnail: 'https://cdn.test/t.jpg' }),
    directUrl: async () => {
      directUrlCalls += 1;
      return 'https://cdn.test/video.mp4?sig=secret';
    },
    profileVideos: async () => [],
  });
  const post = await adapter.inspect('https://www.tiktok.com/@creator/video/123', fakeContext());
  assert.equal(post.post_id, '123');
  assert.equal(post.owner_handle, 'creator');
  assert.equal(post.text, 'TikTok caption');
  assert.equal(post.media[0].kind, 'video');
  assert.equal(post.media[0].ephemeral_url, undefined);
  assert.equal(post.outcome.source, 'public-metadata');
  assert.equal(directUrlCalls, 0);
}
console.log('ok tiktok_adapter');

// --- inspect(): `media` intent registered — ephemeral_url resolved via the
// injected directUrl() fake.
{
  let directUrlCalls = 0;
  const adapter = createTikTokAdapter({
    oembed: async () => ({ title: 'cap', author: 'creator', thumbnail: 'https://cdn.test/t.jpg' }),
    directUrl: async () => {
      directUrlCalls += 1;
      return 'https://cdn.test/video.mp4?sig=secret';
    },
    profileVideos: async () => [],
  });
  const post = await adapter.inspect('https://www.tiktok.com/@creator/video/123', fakeContext(['media']));
  assert.equal(post.media[0].ephemeral_url, 'https://cdn.test/video.mp4?sig=secret');
  assert.equal(directUrlCalls, 1);
}
console.log('ok tiktok_media_intent_resolves_ephemeral_url');

// --- inspect(): oEmbed unavailable maps to AcquisitionError.
{
  const adapter = createTikTokAdapter({
    oembed: async () => null,
    directUrl: async () => null,
    profileVideos: async () => [],
  });
  try {
    await adapter.inspect('https://www.tiktok.com/@creator/video/123', fakeContext());
    assert.fail('expected inspect() to throw');
  } catch (error) {
    assert.ok(error instanceof AcquisitionError);
    assert.equal(error.outcome.reason, 'invalid-response');
  }
}
console.log('ok tiktok_oembed_unavailable_maps_to_acquisition_error');

// --- captureSocialCard(): a fetchBytes() failure must surface as an
// AcquisitionError, never a bare throw (service.ts's failUrlOperation()
// propagates non-AcquisitionError throws untouched, bypassing outcome
// recording/negative caching). The mapped reason must never be one of
// CIRCUIT_OPENING_REASONS, and nothing from the fetch (signed thumbnail URL,
// body) may leak into the message or outcome.
{
  const adapter = createTikTokAdapter({
    oembed: async () => ({
      title: 'cap',
      author: 'creator',
      thumbnail: 'https://cdn.test/thumb.jpg?sig=SECRET_TOKEN',
    }),
    directUrl: async () => null,
    profileVideos: async () => [],
    fetchBytes: async () => {
      throw new Error('fetch failed: 404');
    },
  });
  try {
    await adapter.captureSocialCard('https://www.tiktok.com/@creator/video/123', 'post', fakeContext());
    assert.fail('expected captureSocialCard() to throw');
  } catch (error) {
    assert.ok(error instanceof AcquisitionError);
    assert.equal(error.outcome.reason, 'invalid-response');
    assert.notEqual(error.outcome.reason, 'rate-limited');
    assert.notEqual(error.outcome.reason, 'auth-required');
    assert.notEqual(error.outcome.reason, 'challenge');
    assert.ok(!error.message.includes('SECRET_TOKEN'));
    assert.ok(!JSON.stringify(error.outcome).includes('SECRET_TOKEN'));
  }
}
console.log('ok tiktok_social_card_fetch_failure_maps_to_acquisition_error');

// --- collectComments(): reuses EXTRACT_JS from scrape_comments.ts verbatim
// (checked by reference equality below) against a fake CdpClient, applying
// normalizeLikes and de-duplicating by author:text.
{
  const rawComments = [
    { idx: 0, author: 'alice', text: 'nice', likes_raw: '1.2K', avatar_url: '' },
    { idx: 1, author: 'bob', text: 'cool', likes_raw: '3,261', avatar_url: '' },
  ];
  const fakeClient: any = {
    evaluate: async (expr: string) => {
      if (expr === EXTRACT_JS) return JSON.stringify(rawComments);
      return 2; // any other evaluate call (comment-count checks) reports comments already present
    },
  };
  const context: any = {
    intents: () => new Set(),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire(fakeClient, new Set()),
  };
  const adapter = createTikTokAdapter();
  const comments = await adapter.collectComments(
    'https://www.tiktok.com/@creator/video/123',
    { max: 2 },
    context,
  );
  assert.equal(comments.length, 2);
  assert.equal(comments[0].author, 'alice');
  assert.equal(comments[0].likes, 1200);
  assert.equal(comments[1].author, 'bob');
  assert.equal(comments[1].likes, 3261);
}
console.log('ok tiktok_collect_comments');
