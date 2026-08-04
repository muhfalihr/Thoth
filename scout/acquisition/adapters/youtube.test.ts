import assert from 'node:assert/strict';
import { createYouTubeAdapter } from './youtube.ts';

const adapter = createYouTubeAdapter({
  oembed: async () => ({ title: 'Video title', author: 'Channel', thumbnail: 'https://cdn.test/y.jpg' }),
});
const post = await adapter.inspect('https://www.youtube.com/watch?v=ABC123', {} as any);
assert.equal(post.post_id, 'ABC123');
assert.equal(post.owner_handle, 'Channel');
assert.equal(post.media[0].kind, 'video');
assert.equal(post.outcome.source, 'public-metadata');
console.log('ok youtube_adapter');
