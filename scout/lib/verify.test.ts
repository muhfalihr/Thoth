import assert from 'node:assert/strict';
import { directStreamArgs, shapeArgs, parseShape } from './verify.ts';

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

// The reported photo-first IG carousel. yt-dlp reports NO duration for ANY Instagram carousel
// entry (verified with and without --flat-playlist), so `kind` must come from `ext` — keying it
// off `duration` marked all five slides 'photo' and the multi-video carousel branch never fired.
{
  const args = shapeArgs('https://www.instagram.com/p/DbQoG9IjzGX');
  assert.ok(
    args.includes('--ignore-no-formats-error'),
    'a leading photo slide must not abort the probe',
  );

  const fixture = JSON.stringify({
    title: 'Post by dagelan',
    entries: [
      { duration: null },
      { ext: 'mp4', duration: null },
      { ext: 'mp4', duration: null },
      { ext: 'mp4', duration: null },
      { ext: 'mp4', duration: null },
    ],
  });
  const shape = parseShape(fixture);
  assert.equal(shape.ok, true);
  assert.equal(shape.shape, 'carousel');
  assert.deepEqual(
    shape.slides.map((s) => s.kind),
    ['photo', 'video', 'video', 'video', 'video'],
    'slide 1 is the photo cover; slides 2-5 are mp4 videos',
  );
}

// A single-media post keeps its one slide (index 1) — callers rely on this to harvest a plain
// /p/ video post, so the wrapper must not collapse it to an empty list.
{
  const one = parseShape(JSON.stringify({ ext: 'mp4', duration: 12.5 }));
  assert.equal(one.shape, 'video');
  assert.deepEqual(one.slides, [{ index: 1, kind: 'video', duration: 12.5 }]);
}

console.log('ok verify');
