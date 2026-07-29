import assert from 'node:assert/strict';
import { OcrAnalysisError } from './ocr_contract.ts';
import { attachFootageOcrCandidate } from './footage_candidate_ocr.ts';

const record = {
  url: 'https://example.test/video',
  platform: 'youtube',
  is_video: true as const,
};

// An optional candidate is dropped, never fatal — and it reports the reason it
// was actually dropped for. `incomplete_frame_coverage` joined this list after
// live acceptance: one transient malformed OCR frame (11/12, retries exhausted)
// on one optional candidate was aborting the whole required build_footage stage.
for (const code of [
  'media_access_failed',
  'stream_resolution_failed',
  'incomplete_frame_coverage',
] as const) {
  const unavailable = await attachFootageOcrCandidate(record, async () => {
    throw new OcrAnalysisError(code, 'safe');
  });
  assert.deepEqual(unavailable, { status: 'unavailable', code });
}

for (const code of ['missing_api_key'] as const) {
  await assert.rejects(
    () =>
      attachFootageOcrCandidate(record, async () => {
        throw new OcrAnalysisError(code, 'safe');
      }),
    (error: unknown) => error instanceof OcrAnalysisError && error.code === code,
  );
}

await assert.rejects(
  () =>
    attachFootageOcrCandidate(record, async () => {
      throw new Error('unexpected');
    }),
  /unexpected/,
);

const analyzed = {
  ...record,
  ocr_schema_version: 1,
  ocr_status: 'analyzed' as const,
  ocr_model: 'deepseek/deepseek-ocr',
  ocr_analyzer_version: 'deepseek-ocr-v2',
  ocr_analyzed_at: '2026-07-27T00:00:00.000Z',
  ocr_requested_frames: 12,
  ocr_valid_frames: 12,
  ocr_outcome: 'clean' as const,
  trim_start: 0,
  mute_audio: false,
  subtitle_blur: [],
};
const accepted = await attachFootageOcrCandidate(record, async () => analyzed);
assert.deepEqual(accepted, { status: 'accepted', entry: analyzed });

const attempts: string[] = [];
const candidates = ['unavailable', 'accepted'];
const retained: typeof analyzed[] = [];
for (const candidate of candidates) {
  const result = await attachFootageOcrCandidate(
    { ...record, url: `https://example.test/${candidate}` },
    async (value) => {
      attempts.push(String(value.url));
      if (candidate === 'unavailable') {
        throw new OcrAnalysisError('media_access_failed', 'safe');
      }
      return { ...analyzed, url: value.url };
    },
  );
  if (result.status === 'unavailable') continue;
  retained.push(result.entry);
}
assert.equal(attempts.length, 2);
assert.equal(retained.length, 1);
assert.match(String(retained[0].url), /accepted$/);

console.log('ok footage_candidate_ocr');
