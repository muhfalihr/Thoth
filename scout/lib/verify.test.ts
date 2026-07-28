import assert from 'node:assert/strict';
import { directStreamArgs } from './verify.ts';

// A photo-first IG/FB carousel (slide 1 photo, slide 2+ video) must still resolve to a video
// stream. Pinning slide 1 made yt-dlp error, directStreamUrl fell open to the page URL, and
// ffprobe reported an HTML page as 0-duration media — surfacing as `duration_probe_failed`.
{
  const args = directStreamArgs('https://www.instagram.com/p/DbQoG9IjzGX');
  assert.ok(args.includes('--ignore-no-formats-error'), 'photo slides must not abort resolution');
  const range = args[args.indexOf('--playlist-items') + 1];
  assert.equal(range, '1-5', 'must scan past a leading photo slide, not pin slide 1');
  assert.ok(args.includes('-g'), 'still resolves to a direct stream url');
  assert.equal(args.at(-1), 'https://www.instagram.com/p/DbQoG9IjzGX');
}

console.log('ok verify');
