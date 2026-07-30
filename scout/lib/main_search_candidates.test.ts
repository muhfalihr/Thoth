import assert from 'node:assert/strict';
import { admitSearchCandidates } from './main_search_candidates.ts';

const entries = [
  { url: 'https://x.com/user/status/1', platform: 'twitter' },
  { url: 'https://x.com/user/status/2', platform: 'twitter' },
  { url: 'https://www.youtube.com/watch?v=3', platform: 'youtube' },
  { url: 'https://example.test/page', platform: 'web' },
];
const candidates = await admitSearchCandidates(entries, {
  downloadablePlatforms: new Set(['twitter', 'youtube']),
  probeGeneric: async (entry) => ({
    isVideo: !entry.url.endsWith('/2'),
    caption: entry.url.endsWith('/1') ? 'incident caption' : '',
    thumbnail: 'https://img.example.test/cover.jpg',
    uploader: 'user',
    webpageUrl: entry.url,
  }),
  youtubeMeta: async () => ({
    title: 'youtube incident',
    thumbnail: 'https://img.example.test/youtube.jpg',
  }),
  tiktokMeta: async () => null,
  threadsVideoSrc: async () => '',
});
assert.deepEqual(
  candidates.map((candidate) => candidate.url),
  ['https://x.com/user/status/1', 'https://www.youtube.com/watch?v=3'],
);
assert.equal(candidates[0].caption, 'incident caption');
assert.equal(candidates[1].caption, 'youtube incident');

const carousel = await admitSearchCandidates(
  [{ url: 'https://www.instagram.com/p/CAROUSEL/', platform: 'instagram' }],
  {
    downloadablePlatforms: new Set(['instagram']),
    probeGeneric: async () => ({
      isVideo: false,
      caption: 'carousel incident',
      thumbnail: 'https://img.example.test/carousel.jpg',
      uploader: 'creator',
      webpageUrl: 'https://www.instagram.com/creator/p/CAROUSEL/',
    }),
    youtubeMeta: async () => null,
    tiktokMeta: async () => null,
    threadsVideoSrc: async () => '',
  },
);
assert.equal(carousel.length, 1);
assert.equal(carousel[0].isVideo, true);

const orderedUrls = Array.from(
  { length: 11 },
  (_, index) => `https://www.youtube.com/watch?v=${index + 1}`,
);
const limited = await admitSearchCandidates(
  [
    { url: orderedUrls[0], platform: 'youtube' },
    { url: orderedUrls[0], platform: 'youtube' },
    ...orderedUrls.slice(1).map((url) => ({ url, platform: 'youtube' })),
  ],
  {
    downloadablePlatforms: new Set(['youtube']),
    probeGeneric: async () => {
      throw new Error('youtube entries must not use the generic probe');
    },
    youtubeMeta: async (url) => ({ title: url, thumbnail: '' }),
    tiktokMeta: async () => null,
    threadsVideoSrc: async () => '',
  },
);
assert.deepEqual(
  limited.map((candidate) => candidate.url),
  orderedUrls.slice(0, 10),
);

console.log('ok main_search_candidates');
