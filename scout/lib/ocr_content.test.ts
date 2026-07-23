import assert from 'node:assert';
import {
  DEFAULT_OCR_MODEL,
  OcrAnalysisError,
  OCR_ANALYZER_VERSION,
  OCR_SCHEMA_VERSION,
  type OcrAnalysis,
} from './ocr_contract.ts';
import {
  attachVideoOcr,
  shouldAttachVideoOcr,
} from './ocr_content.ts';

assert.equal(shouldAttachVideoOcr({ url: 'https://example.test/legacy.mp4' }), true);
assert.equal(
  shouldAttachVideoOcr({ url: 'https://example.test/video.mp4', is_video: true }),
  true,
);
assert.equal(
  shouldAttachVideoOcr({ url: 'https://example.test/still', is_video: false }),
  false,
);

const analyzed: OcrAnalysis = {
  schema_version: OCR_SCHEMA_VERSION,
  ocr_status: 'analyzed',
  provider: 'novita',
  model: DEFAULT_OCR_MODEL,
  analyzer_version: OCR_ANALYZER_VERSION,
  requested_frames: 2,
  valid_frames: 2,
  analyzed_at: '2026-07-23T00:00:00.000Z',
  verdict: {
    outcome: 'cover',
    trim_start: 3,
    mute_audio: false,
    subtitle_blur: [],
  },
};

{
  const record = { url: 'https://example.test/still', is_video: false };
  let calls = 0;
  await attachVideoOcr(record, {
    analyze: async () => {
      calls++;
      return analyzed;
    },
  });
  assert.equal(calls, 0);
  assert.equal('ocr_status' in record, false);
}

{
  const record: Record<string, unknown> = {
    url: 'https://example.test/video.mp4',
    is_video: true,
  };
  await attachVideoOcr(record, {
    resolve: () => 'C:/local/video.mp4',
    analyze: async (source) => {
      assert.equal(source, 'C:/local/video.mp4');
      return analyzed;
    },
  });
  assert.equal(record.ocr_schema_version, OCR_SCHEMA_VERSION);
  assert.equal(record.ocr_status, 'analyzed');
  assert.equal(record.ocr_outcome, 'cover');
  assert.equal(record.trim_start, 3);
}

await assert.rejects(
  () =>
    attachVideoOcr(
      { url: 'https://example.test/video.mp4', is_video: true },
      {
        analyze: async () => {
          throw new Error('ordinary failure with Bearer private-token');
        },
      },
    ),
  (error: unknown) =>
    error instanceof OcrAnalysisError &&
    error.code === 'analysis_exception' &&
    !error.message.includes('private-token'),
);

await assert.rejects(
  () =>
    attachVideoOcr(
      { url: 'https://example.test/video.mp4', is_video: true },
      {
        analyze: async () => analyzed,
        project: () => {
          throw new Error('projection failure with Bearer projection-token');
        },
      },
    ),
  (error: unknown) =>
    error instanceof OcrAnalysisError &&
    error.code === 'analysis_exception' &&
    !error.message.includes('projection-token'),
);
