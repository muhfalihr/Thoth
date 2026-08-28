import assert from 'node:assert/strict';
import { OCR_ANALYZER_VERSION, OcrAnalysisError } from './ocr_contract.ts';
import {
  formatMediaDropSummary,
  selectCarouselFootageVideoCandidate,
  selectFootageVideoCandidate,
  selectTikTokFootageVideoCandidate,
} from './footage_candidate_selection.ts';

const record = {
  url: 'https://example.test/video',
  platform: 'youtube',
  is_video: true as const,
};
const analyzed = {
  ...record,
  ocr_schema_version: 1,
  ocr_status: 'analyzed' as const,
  ocr_model: 'deepseek/deepseek-ocr',
  ocr_analyzer_version: OCR_ANALYZER_VERSION,
  ocr_analyzed_at: '2026-07-27T00:00:00.000Z',
  ocr_requested_frames: 12,
  ocr_valid_frames: 12,
  ocr_outcome: 'clean' as const,
  trim_start: 0,
  mute_audio: false,
  subtitle_blur: [],
};

const retained: typeof analyzed[] = [];
let quota = 0;
let mediaDropped = 0;
for (const candidate of ['unavailable', 'accepted']) {
  const selected = await selectFootageVideoCandidate(
    { ...record, url: `https://example.test/${candidate}` },
    async (value) => {
      if (candidate === 'unavailable') {
        throw new OcrAnalysisError('media_access_failed', 'safe');
      }
      return { ...analyzed, url: value.url };
    },
  );
  mediaDropped += selected.mediaDropped;
  if (selected.result.status === 'unavailable') continue;
  retained.push(selected.result.entry);
  quota++;
}
assert.equal(mediaDropped, 1);
assert.equal(quota, 1);
assert.deepEqual(retained.map((entry) => entry.url), ['https://example.test/accepted']);

// preAdmit gates BEFORE resolveDirect/attach — a candidate the caller's non-media gates already
// rejected must never trigger the direct-url resolver (a real network fetch) or OCR's downloader.
let gatedAttachCalls = 0;
const gated = await selectFootageVideoCandidate(
  { ...record, url: 'https://example.test/gated' },
  async (value) => {
    gatedAttachCalls++;
    return { ...analyzed, url: value.url };
  },
  () => false,
);
assert.equal(gated.result.status, 'unavailable');
assert.equal(gatedAttachCalls, 0);

let gatedResolverCalls = 0;
let gatedTiktokAttachCalls = 0;
const gatedTiktok = await selectTikTokFootageVideoCandidate(
  { ...record, platform: 'tiktok', url: 'https://www.tiktok.com/@user/video/999' },
  async () => {
    gatedResolverCalls++;
    return { url: 'https://cdn.example.test/999.mp4' };
  },
  async (value) => {
    gatedTiktokAttachCalls++;
    return { ...analyzed, ...value };
  },
  () => false,
);
assert.equal(gatedTiktok.result.status, 'unavailable');
assert.equal(gatedResolverCalls, 0);
assert.equal(gatedTiktokAttachCalls, 0);

let tiktokResolverCalls = 0;
let tiktokAttachCalls = 0;
const tiktok = await selectTikTokFootageVideoCandidate(
  { ...record, platform: 'tiktok', url: 'https://www.tiktok.com/@user/video/123' },
  async () => {
    tiktokResolverCalls++;
    return null;
  },
  async (value) => {
    tiktokAttachCalls++;
    return { ...analyzed, ...value };
  },
);
assert.equal(tiktok.result.status, 'unavailable');
assert.equal(tiktok.mediaDropped, 1);
assert.equal(tiktokResolverCalls, 1);
assert.equal(tiktokAttachCalls, 0);

let carouselResolverCalls = 0;
const carousel = await selectCarouselFootageVideoCandidate(
  { ...record, platform: 'instagram', url: 'https://example.test/post' },
  () => {
    carouselResolverCalls++;
    return '';
  },
  async (value) => ({ ...analyzed, ...value }),
);
assert.equal(carousel.result.status, 'unavailable');
assert.equal(carousel.mediaDropped, 1);
assert.equal(carouselResolverCalls, 1);

const summary = formatMediaDropSummary(2);
assert.equal(summary, ' (2 drop media tak dapat diakses)');
assert.doesNotMatch(summary, /example\.test|secret-token/);

await assert.rejects(
  () =>
    selectFootageVideoCandidate(record, async () => {
      throw new OcrAnalysisError('missing_api_key', 'safe');
    }),
  (error: unknown) => error instanceof OcrAnalysisError && error.code === 'missing_api_key',
);

console.log('ok footage_candidate_selection');
