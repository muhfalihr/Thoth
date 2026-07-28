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

// Carousel slide classification: yt-dlp never populates duration for IG carousel entries,
// so ext='mp4' is the reliable video signal. All slides with ext='mp4' → kind:'video'.
{
  const mockCarouselJson = JSON.stringify({
    entries: [
      { index: 1, ext: 'jpg', title: 'slide 1 photo' }, // no ext, no duration → photo
      { index: 2, ext: 'mp4', title: 'slide 2 video', duration: null }, // ext='mp4', no duration → video
      { index: 3, ext: 'mp4', title: 'slide 3 video', duration: null }, // ext='mp4' → video
    ],
    description: 'test carousel',
  });
  const result = parseShape(mockCarouselJson);
  assert.equal(result.shape, 'carousel', 'should detect carousel from multiple entries');
  assert.equal(result.slides.length, 3, 'should enumerate all 3 slides');
  assert.equal(result.slides[0].index, 1, 'slide indices must be 1-based');
  assert.equal(result.slides[0].kind, 'photo', 'slide 1 jpg → photo');
  assert.equal(result.slides[1].kind, 'video', 'slide 2 with ext=mp4 → video (not duration)');
  assert.equal(result.slides[2].kind, 'video', 'slide 3 with ext=mp4 → video');
}

console.log('ok verify');
