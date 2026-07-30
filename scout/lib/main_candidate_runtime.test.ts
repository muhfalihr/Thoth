import assert from 'node:assert/strict';
import {
  classifyMainCandidateVisual,
  createMainCandidateRuntimeDeps,
  probeMainCandidateVideo,
  scoreMainCandidateSimilarity,
} from './main_candidate_runtime.ts';

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

console.log('ok main_candidate_runtime');
