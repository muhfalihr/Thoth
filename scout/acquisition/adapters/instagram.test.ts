import assert from 'node:assert/strict';
import { parseInstagramPost } from './instagram.ts';
import { findFirstObject } from './json_walk.ts';

// --- Brief's verbatim fixture: xdt_shortcode_media carousel (image + video) ---
const body = JSON.stringify({
  data: {
    xdt_shortcode_media: {
      shortcode: 'DbgARkAjHPS',
      owner: { username: 'creator' },
      edge_media_to_caption: { edges: [{ node: { text: 'post caption' } }] },
      edge_sidecar_to_children: {
        edges: [
          { node: { id: 'image-1', is_video: false, display_url: 'https://cdn.test/1.jpg?sig=x' } },
          { node: { id: 'video-2', is_video: true, video_url: 'https://cdn.test/2.mp4?sig=y' } },
        ],
      },
    },
  },
});
const post = parseInstagramPost(body, 'https://www.instagram.com/p/DbgARkAjHPS/');
assert.equal(post?.post_id, 'DbgARkAjHPS');
assert.equal(post?.owner_handle, 'creator');
assert.equal(post?.text, 'post caption');
assert.deepEqual(
  post?.media.map((item) => item.kind),
  ['image', 'video'],
);
assert.deepEqual(
  post?.media.map((item) => item.index),
  [1, 2],
);
assert.equal(post?.outcome.source, 'network');

// Strengthen: verify the ephemeral CDN url landed on the RIGHT slide (guards
// against an image/video field swap) and that canonical_post_url is threaded
// through every media item.
assert.equal(post?.media[0]?.ephemeral_url, 'https://cdn.test/1.jpg?sig=x');
assert.equal(post?.media[1]?.ephemeral_url, 'https://cdn.test/2.mp4?sig=y');
assert.ok(post?.media.every((item) => item.canonical_post_url === post.canonical_url));

// --- Strengthen: old-style `shortcode_media` key (no `xdt_` prefix), single
// (non-carousel) media directly on the media node -- must still parse.
const singleBody = JSON.stringify({
  data: {
    shortcode_media: {
      shortcode: 'CabcXYZ12',
      owner: { username: 'solo-creator' },
      caption: { text: 'solo caption' },
      is_video: true,
      video_url: 'https://cdn.test/solo.mp4?sig=z',
      video_duration: 12.5,
    },
  },
});
const singlePost = parseInstagramPost(singleBody, 'https://www.instagram.com/reel/CabcXYZ12/');
assert.equal(singlePost?.post_id, 'CabcXYZ12');
assert.equal(singlePost?.owner_handle, 'solo-creator');
assert.equal(singlePost?.text, 'solo caption');
assert.deepEqual(
  singlePost?.media.map((item) => item.kind),
  ['video'],
);
assert.deepEqual(
  singlePost?.media.map((item) => item.index),
  [1],
);
assert.equal(singlePost?.media[0]?.duration_sec, 12.5);

// --- Strengthen: malformed/irrelevant JSON must yield null, never throw.
assert.equal(parseInstagramPost('not json at all', 'https://www.instagram.com/p/X/'), null);
assert.equal(
  parseInstagramPost(
    JSON.stringify({ data: { unrelated: true } }),
    'https://www.instagram.com/p/X/',
  ),
  null,
);

// --- json_walk.ts is generic and bounded: a cyclic graph must terminate
// (never stack-overflow / infinite-loop), and a maxNodes budget must cut
// traversal short instead of scanning an unbounded structure.
const cyclic: Record<string, unknown> = { marker: 'deep', self: null };
cyclic.self = cyclic;
const foundInCycle = findFirstObject<{ marker: string }>(cyclic, (node) => node.marker === 'deep');
assert.equal(foundInCycle?.marker, 'deep');

const wide: Record<string, unknown> = {};
for (let i = 0; i < 100; i += 1) wide[`k${i}`] = { n: i };
const boundedMiss = findFirstObject(wide, (node) => node.n === 99, 5);
assert.equal(boundedMiss, null);
const boundedHit = findFirstObject(wide, (node) => node.n === 99, 20_000);
assert.deepEqual(boundedHit, { n: 99 });

console.log('ok instagram_adapter');
