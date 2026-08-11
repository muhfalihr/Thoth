import assert from 'node:assert/strict';
import { canonicalizeUrl, platformForUrl } from './url.ts';

assert.equal(
  canonicalizeUrl(
    'https://www.instagram.com/p/DbgARkAjHPS/?utm_source=ig_web_copy_link&igsh=secret',
  ),
  'https://www.instagram.com/p/DbgARkAjHPS/',
);
assert.equal(
  canonicalizeUrl('https://x.com/user/status/123?s=20#fragment'),
  'https://x.com/user/status/123',
);
assert.equal(
  canonicalizeUrl('https://www.youtube.com/watch?v=ABC123&utm_source=test'),
  'https://www.youtube.com/watch?v=ABC123',
);
assert.equal(
  canonicalizeUrl('https://www.facebook.com/story.php?story_fbid=9&id=7&utm_source=x'),
  'https://www.facebook.com/story.php?id=7&story_fbid=9',
);
assert.equal(platformForUrl('https://www.reddit.com/r/test/comments/abc/post/'), 'reddit');
assert.throws(() => canonicalizeUrl('not a URL'), /unsupported URL/i);

// --- Threads is served on BOTH threads.net and threads.com (Meta serves
// both; scrapers/threads_video.ts and scrapers/crop_post.ts both match
// `.com`) — both hosts, with and without `www.`, must resolve to the
// `threads` platform and canonicalize (strip tracking params/fragment)
// identically.
assert.equal(platformForUrl('https://www.threads.net/@owner/post/ABC123'), 'threads');
assert.equal(platformForUrl('https://threads.net/@owner/post/ABC123'), 'threads');
assert.equal(platformForUrl('https://www.threads.com/@owner/post/ABC123'), 'threads');
assert.equal(platformForUrl('https://threads.com/@owner/post/ABC123'), 'threads');
assert.equal(
  canonicalizeUrl('https://www.threads.net/@owner/post/ABC123?utm_source=ig_web_copy_link#frag'),
  'https://www.threads.net/@owner/post/ABC123',
);
assert.equal(
  canonicalizeUrl('https://www.threads.com/@owner/post/ABC123?utm_source=ig_web_copy_link#frag'),
  'https://www.threads.com/@owner/post/ABC123',
);

console.log('ok acquisition_url');
