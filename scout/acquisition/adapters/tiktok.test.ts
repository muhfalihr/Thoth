import assert from 'node:assert/strict';
import { createTikTokAdapter } from './tiktok.ts';

const adapter = createTikTokAdapter({
  oembed: async () => ({ title: 'TikTok caption', author: 'creator', thumbnail: 'https://cdn.test/t.jpg' }),
  directUrl: async () => 'https://cdn.test/video.mp4?sig=secret',
  profileVideos: async () => [],
});
const post = await adapter.inspect('https://www.tiktok.com/@creator/video/123', {} as any);
assert.equal(post.post_id, '123');
assert.equal(post.owner_handle, 'creator');
assert.equal(post.text, 'TikTok caption');
assert.equal(post.media[0].kind, 'video');
assert.equal(post.outcome.source, 'public-metadata');
console.log('ok tiktok_adapter');
