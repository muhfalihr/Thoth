import assert from 'node:assert/strict';
import { createYouTubeAdapter } from './youtube.ts';
import { AcquisitionError } from '../types.ts';

function fakeContext(): any {
  return {
    intents: () => new Set(),
    now: () => 0,
    visit: async (_platform: string, _url: string, acquire: any) => acquire({} as any, new Set()),
  };
}

const adapter = createYouTubeAdapter({
  oembed: async () => ({ title: 'Video title', author: 'Channel', thumbnail: 'https://cdn.test/y.jpg' }),
});
const post = await adapter.inspect('https://www.youtube.com/watch?v=ABC123', fakeContext());
assert.equal(post.post_id, 'ABC123');
assert.equal(post.owner_handle, 'Channel');
assert.equal(post.media[0].kind, 'video');
assert.equal(post.outcome.source, 'public-metadata');
console.log('ok youtube_adapter');

// --- inspect(): oEmbed unavailable maps to AcquisitionError.
{
  const nullAdapter = createYouTubeAdapter({ oembed: async () => null });
  try {
    await nullAdapter.inspect('https://www.youtube.com/watch?v=ABC123', fakeContext());
    assert.fail('expected inspect() to throw');
  } catch (error) {
    assert.ok(error instanceof AcquisitionError);
    assert.equal(error.outcome.reason, 'invalid-response');
  }
}
console.log('ok youtube_oembed_unavailable_maps_to_acquisition_error');

// --- captureSocialCard(): a fetchBytes() failure must surface as an
// AcquisitionError, never a bare throw (service.ts's failUrlOperation()
// propagates non-AcquisitionError throws untouched, bypassing outcome
// recording/negative caching). The mapped reason must never be one of
// CIRCUIT_OPENING_REASONS, and nothing from the fetch (signed thumbnail URL,
// body) may leak into the message or outcome.
{
  const failAdapter = createYouTubeAdapter({
    oembed: async () => ({ title: 't', author: 'a', thumbnail: 'https://cdn.test/thumb.jpg?sig=SECRET_TOKEN' }),
    fetchBytes: async () => {
      throw new Error('fetch failed: 404');
    },
  });
  try {
    await failAdapter.captureSocialCard('https://www.youtube.com/watch?v=ABC123', 'post', fakeContext());
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
console.log('ok youtube_social_card_fetch_failure_maps_to_acquisition_error');
