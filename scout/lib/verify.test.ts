import assert from 'node:assert/strict';
import { directStreamArgs, dropCoverSlide, parseShape, shapeArgs } from './verify.ts';

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
    uploader: 'dagelan',
    webpage_url: 'https://www.instagram.com/dagelan/p/DbQoG9IjzGX/',
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
  // The owning handle rides along so the main gate can reject curated aggregators without a
  // second probe. Carousels report it at the top level; single posts fall back to entries[0].
  assert.equal(shape.uploader, 'dagelan');
  assert.match(shape.webpageUrl, /dagelan/);
}

// The live IG shape returned the account identity through uploader_id/channel_id while its root
// webpage_url was only the shortcode URL. The owner must be normalized, and a handle-bearing entry
// URL is better evidence than the generic root URL.
{
  const shape = parseShape(
    JSON.stringify({
      uploader_id: '@root_owner',
      webpage_url: 'https://www.instagram.com/root_owner/p/ROOT_CANONICAL/',
      entries: [
        {
          channel_id: '@entry_owner',
          webpage_url: 'https://www.instagram.com/entry_owner/p/ROOT_CANONICAL/',
          ext: 'mp4',
        },
      ],
    }),
  );
  assert.equal(shape.uploader, 'root_owner', 'top-level uploader_id is the canonical owner');
  assert.equal(
    shape.webpageUrl,
    'https://www.instagram.com/root_owner/p/ROOT_CANONICAL/',
    'a handle-bearing root URL must not be replaced by entry metadata',
  );
}

// yt-dlp can expose an internal numeric account id beside the public channel handle. The numeric
// id cannot participate in curated-account matching and must not mask the public owner.
{
  const shape = parseShape(
    JSON.stringify({
      uploader_id: '367005646',
      channel: 'dagelan',
      webpage_url: 'https://www.instagram.com/p/NUMERIC_OWNER_ID/',
      entries: [
        {
          uploader_id: '367005646',
          channel: 'dagelan',
          webpage_url: 'https://www.instagram.com/dagelan/p/NUMERIC_OWNER_ID/',
          ext: 'mp4',
        },
      ],
    }),
  );
  assert.equal(shape.uploader, 'dagelan', 'a numeric internal id must not mask the public handle');
}

{
  const shape = parseShape(
    JSON.stringify({
      webpage_url: 'https://www.instagram.com/p/SHORTCODE_ONLY/',
      entries: [
        {
          channel_id: '@dagelan',
          webpage_url: 'https://www.instagram.com/dagelan/p/SHORTCODE_ONLY/',
          ext: 'mp4',
        },
      ],
    }),
  );
  assert.equal(shape.uploader, 'dagelan', 'entry channel_id is used when the root has no owner');
  assert.equal(
    shape.webpageUrl,
    'https://www.instagram.com/dagelan/p/SHORTCODE_ONLY/',
    'a handle-bearing entry URL must beat a generic shortcode-only root URL',
  );
}

{
  const shape = parseShape(
    JSON.stringify({
      webpage_url: 'https://www.instagram.com/reel/NO_OWNER_FIELDS/',
      entries: [
        {
          webpage_url: 'https://www.instagram.com/canonical_only/reel/NO_OWNER_FIELDS/',
          ext: 'mp4',
        },
      ],
    }),
  );
  assert.equal(shape.uploader, '');
  assert.equal(
    shape.webpageUrl,
    'https://www.instagram.com/canonical_only/reel/NO_OWNER_FIELDS/',
    'the canonical entry URL remains a fallback when no uploader fields exist',
  );
}

// A single-media post keeps its one slide (index 1) — callers rely on this to harvest a plain
// /p/ video post, so the wrapper must not collapse it to an empty list.
// Pins the `ext` half of the `duration || ext === 'mp4'` predicate: no duration reported (as
// Instagram never reports one), classification must still come from the extension alone.
{
  const one = parseShape(JSON.stringify({ ext: 'mp4' }));
  assert.equal(one.shape, 'video');
  assert.deepEqual(one.slides, [{ index: 1, kind: 'video', duration: 0 }]);
}

// Pins the `duration` half: no ext reported, must still classify as video — the fallback that
// keeps TikTok/X/FB/YT single-media posts (which always populate duration) working.
{
  const one = parseShape(JSON.stringify({ duration: 12.5 }));
  assert.equal(one.shape, 'video');
  assert.deepEqual(one.slides, [{ index: 1, kind: 'video', duration: 12.5 }]);
}

// Slide #1 of a carousel is conventionally a cover — and when the carousel is the MAIN post, the
// video ingest already consumed it (--no-playlist takes the first item). Never footage.
{
  assert.deepEqual(
    dropCoverSlide([{ index: 1 }, { index: 2 }, { index: 3 }]).map((s) => s.index),
    [2, 3],
  );
  // A single-media post has no cover to drop — stripping index 1 would leave it with nothing.
  assert.deepEqual(
    dropCoverSlide([{ index: 1 }]).map((s) => s.index),
    [1],
  );
  assert.deepEqual(dropCoverSlide([]), []);
}

console.log('ok verify');
