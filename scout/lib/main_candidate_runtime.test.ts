import assert from 'node:assert/strict';
import {
  classifyMainCandidateVisual,
  createMainCandidateRuntimeDeps,
  probeMainCandidateVideo,
  resolveMainCandidateMedia,
  scoreMainCandidateSimilarity,
} from './main_candidate_runtime.ts';
import { parseShape } from './verify.ts';

const photoFirstCarousel = await probeMainCandidateVideo(
  {
    url: 'https://www.instagram.com/p/PHOTO_FIRST/',
    platform: 'instagram',
  },
  {
    postShape: () => ({
      ok: true,
      shape: 'carousel',
      slides: [
        { index: 1, kind: 'photo', duration: 0 },
        { index: 2, kind: 'video', duration: 0 },
      ],
      caption: 'carousel caption',
      uploader: 'dagelan',
      webpageUrl: 'https://www.instagram.com/dagelan/p/PHOTO_FIRST/',
    }),
  },
);
assert.equal(photoFirstCarousel.isVideo, true);
assert.equal(photoFirstCarousel.candidate.caption, 'carousel caption');
assert.equal(photoFirstCarousel.candidate.uploader, 'dagelan');

const freshOwner = await probeMainCandidateVideo(
  {
    url: 'https://www.instagram.com/p/FRESH_OWNER/',
    platform: 'instagram',
    uploader: 'stale_creator',
    pageUrl: 'https://www.instagram.com/p/FRESH_OWNER/',
  },
  {
    postShape: () => ({
      ok: true,
      shape: 'video',
      slides: [{ index: 1, kind: 'video', duration: 1 }],
      uploader: 'dagelan',
      webpageUrl: 'https://www.instagram.com/dagelan/p/FRESH_OWNER/',
    }),
  },
);
assert.equal(freshOwner.candidate.uploader, 'dagelan');
assert.equal(freshOwner.candidate.pageUrl, 'https://www.instagram.com/dagelan/p/FRESH_OWNER/');
const runtimeDeps = createMainCandidateRuntimeDeps({
  describeEvidence: async () => '',
  classifyImage: async () => 'unknown',
});
assert.equal(
  runtimeDeps.isCurated(freshOwner.candidate),
  true,
  'the freshly probed owner must drive the curated-account predicate',
);
assert.equal(
  runtimeDeps.isCurated({ ...freshOwner.candidate, uploader: '@DaGeLaN' }),
  true,
  'curated owner matching remains case-insensitive and tolerates a leading @',
);

const displayOwnerShape = parseShape(
  JSON.stringify({
    uploader: 'Post by dagelan',
    uploader_id: '367005646',
    channel: 'dagelan',
    webpage_url: 'https://www.instagram.com/p/DISPLAY_OWNER/',
    entries: [
      {
        uploader: 'Post by dagelan',
        uploader_id: '367005646',
        channel: 'dagelan',
        webpage_url: 'https://www.instagram.com/dagelan/p/DISPLAY_OWNER/',
        ext: 'mp4',
      },
    ],
  }),
);
assert.equal(displayOwnerShape.uploader, 'dagelan', 'display labels are not public owner handles');
const displayOwnerProbe = await probeMainCandidateVideo(
  {
    url: 'https://www.instagram.com/p/DISPLAY_OWNER/',
    platform: 'instagram',
  },
  {
    postShape: () => displayOwnerShape,
  },
);
assert.equal(displayOwnerProbe.candidate.uploader, 'dagelan');
assert.equal(runtimeDeps.isCurated(displayOwnerProbe.candidate), true);

const photoOnly = await probeMainCandidateVideo(
  {
    url: 'https://www.instagram.com/p/PHOTO_ONLY/',
    platform: 'instagram',
  },
  {
    postShape: () => ({
      ok: true,
      shape: 'photo',
      slides: [{ index: 1, kind: 'photo', duration: 0 }],
      caption: 'photo',
      uploader: 'creator',
      webpageUrl: 'https://www.instagram.com/creator/p/PHOTO_ONLY/',
    }),
  },
);
assert.equal(photoOnly.isVideo, false);

const unavailablePost = await probeMainCandidateVideo(
  {
    url: 'https://www.instagram.com/p/UNAVAILABLE/',
    platform: 'instagram',
  },
  {
    postShape: () => ({
      ok: false,
      shape: '',
      slides: [],
    }),
  },
);
assert.deepEqual(unavailablePost, {
  available: false,
  isVideo: false,
  candidate: {
    url: 'https://www.instagram.com/p/UNAVAILABLE/',
    platform: 'instagram',
    caption: '',
    uploader: '',
    pageUrl: 'https://www.instagram.com/p/UNAVAILABLE/',
  },
});

const threads = await probeMainCandidateVideo(
  {
    url: 'https://www.threads.net/@creator/post/ABC',
    platform: 'threads',
    videoSrc: 'https://cdn.example.test/threads.mp4',
  },
  {
    postShape: () => {
      throw new Error('must not run');
    },
  },
);
assert.equal(threads.isVideo, true);

const genericFreshMetadata = await probeMainCandidateVideo(
  {
    url: 'https://x.com/stale/status/1',
    platform: 'twitter',
    caption: 'stale caption',
    thumbnail: 'https://img.example.test/stale.jpg',
    uploader: 'stale_owner',
    pageUrl: 'https://x.com/stale/status/1',
  },
  {
    probeVideo: () => ({
      isVideo: true,
      caption: 'fresh caption',
      thumbnail: 'https://img.example.test/fresh.jpg',
      uploader: 'fresh_owner',
      webpageUrl: 'https://x.com/fresh_owner/status/1',
    }),
  },
);
assert.equal(genericFreshMetadata.candidate.caption, 'fresh caption');
assert.equal(genericFreshMetadata.candidate.thumbnail, 'https://img.example.test/fresh.jpg');
assert.equal(genericFreshMetadata.candidate.uploader, 'fresh_owner');
assert.equal(genericFreshMetadata.candidate.pageUrl, 'https://x.com/fresh_owner/status/1');

const genericEmptyMetadata = await probeMainCandidateVideo(
  {
    url: 'https://x.com/original/status/2',
    platform: 'twitter',
    caption: 'preserved caption',
    thumbnail: 'https://img.example.test/preserved.jpg',
    uploader: 'preserved_owner',
    pageUrl: 'https://x.com/preserved_owner/status/2',
  },
  {
    probeVideo: () => ({
      isVideo: true,
      caption: '',
      thumbnail: '',
      uploader: '',
      webpageUrl: '',
    }),
  },
);
assert.equal(genericEmptyMetadata.candidate.caption, 'preserved caption');
assert.equal(genericEmptyMetadata.candidate.thumbnail, 'https://img.example.test/preserved.jpg');
assert.equal(genericEmptyMetadata.candidate.uploader, 'preserved_owner');
assert.equal(genericEmptyMetadata.candidate.pageUrl, 'https://x.com/preserved_owner/status/2');

const tiktok = await probeMainCandidateVideo(
  {
    url: 'https://www.tiktok.com/@creator/video/1',
    platform: 'tiktok',
    uploader: 'creator',
  },
  {
    probeVideo: () => {
      throw new Error('TikTok must retain its existing no-probe path');
    },
  },
);
assert.equal(tiktok.isVideo, true);
assert.equal(tiktok.candidate.uploader, 'creator');

const score = await scoreMainCandidateSimilarity(
  'actor selling food',
  'actor selling fried snacks',
  async () => [{ sim: 0.61 }],
);
assert.equal(score, 0.61);

const unavailableScore = await scoreMainCandidateSimilarity(
  'actor selling food',
  'actor selling fried snacks',
  async () => [{ sim: 0 }],
);
assert.equal(unavailableScore, null);

let extractedAt = -1;
const representativeKind = await classifyMainCandidateVisual(
  {
    url: 'https://www.instagram.com/p/CAROUSEL/',
    platform: 'instagram',
    thumbnail: 'data:image/png;base64,COVER',
  },
  'https://cdn.example.test/later-slide.mp4',
  {
    extractFrame: (_media, t) => {
      extractedAt = t;
      return 'data:image/jpeg;base64,VIDEO_FRAME';
    },
    classifyImage: async (image) => {
      assert.match(image, /VIDEO_FRAME/);
      return 'footage';
    },
  },
);
assert.equal(representativeKind, 'footage');
assert.equal(extractedAt, 0.5);

// A TikTok *page* URL is 'unsupported' to resolveOcrMedia, so the gate used to see media=null and
// grade the candidate on its COVER image — and a cover is a title card, which the visual rubric
// calls 'commentary'. Every TikTok replacement was therefore auto-rejected. Resolve the page to a
// signed CDN mp4 so a real frame gets classified instead.
const tiktokMedia = await resolveMainCandidateMedia(
  { url: 'https://www.tiktok.com/@creator/video/1', platform: 'tiktok' },
  {},
  { directStream: (pageUrl) => `https://cdn.tiktok.test/${encodeURIComponent(pageUrl)}.mp4` },
);
assert.equal(tiktokMedia?.status, 'resolved');
assert.match(String(tiktokMedia?.status === 'resolved' ? tiktokMedia.media : ''), /cdn\.tiktok\.test/);

// An already-direct CDN videoSrc needs no yt-dlp roundtrip.
const tiktokDirectSrc = await resolveMainCandidateMedia(
  {
    url: 'https://www.tiktok.com/@creator/video/2',
    platform: 'tiktok',
    videoSrc: 'https://cdn.tiktok.test/already-direct.mp4',
  },
  {},
  {
    directStream: () => {
      throw new Error('must not re-resolve an already-direct CDN url');
    },
  },
);
assert.equal(tiktokDirectSrc?.status, 'resolved');

// Fail-open: an unresolvable TikTok keeps the old null → thumbnail fallback rather than becoming a
// hard media_unavailable rejection.
const tiktokUnresolvable = await resolveMainCandidateMedia(
  { url: 'https://www.tiktok.com/@creator/video/3', platform: 'tiktok' },
  {},
  { directStream: () => '' },
);
assert.equal(tiktokUnresolvable, null);

// `-g -f best[ext=mp4]/best` prints one url per slide and the caller keeps the FIRST — on a
// photo-first carousel that is the cover JPEG, because the `/best` half of the selector matches an
// image (--ignore-no-formats-error only skips a slide with NO format at all). The gate then graded
// the cover — a title card — which the visual rubric calls 'commentary', rejecting every IG
// carousel. Resolve a slide yt-dlp itself reports as video, the way build_footage does.
{
  const asked: number[] = [];
  const media = await resolveMainCandidateMedia(
    { url: 'https://www.instagram.com/p/PHOTO_FIRST/', platform: 'instagram' },
    {},
    {
      slides: () => [
        { index: 1, kind: 'photo' },
        { index: 2, kind: 'video' },
      ],
      slideStream: (_postUrl, index) => {
        asked.push(index);
        return `https://cdn.ig.test/slide${index}.mp4`;
      },
    },
  );
  assert.deepEqual(asked, [2], 'the photo cover must never be resolved as the main video');
  assert.equal(media?.status, 'resolved');
  assert.match(String(media?.status === 'resolved' ? media.media : ''), /slide2\.mp4/);
}

// Fail-open: an un-enumerable carousel falls back to whole-post resolution (previous behavior)
// rather than becoming a hard media_unavailable rejection.
{
  const media = await resolveMainCandidateMedia(
    { url: 'https://cdn.direct.test/main.mp4', platform: 'instagram' },
    {},
    { slides: () => [], slideStream: () => '' },
  );
  assert.equal(media?.status, 'resolved', 'no video slide must fall back, not reject');
}

console.log('ok main_candidate_runtime');
