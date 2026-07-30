import assert from 'node:assert/strict';
import {
  classifyMainCandidateVisual,
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
