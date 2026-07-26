import assert from 'node:assert';
import {
  attachVideoOcr,
  carryCurrentOcrMetadata,
  clearVideoOcrMetadata,
  shouldAttachVideoOcr,
} from './ocr_content.ts';
import {
  type AnalyzedOcrAnalysis,
  analysisFields,
  DEFAULT_OCR_MODEL,
  OCR_ANALYZER_VERSION,
  OCR_SCHEMA_VERSION,
  OcrAnalysisError,
  type PersistedOcrFields,
} from './ocr_contract.ts';

assert.equal(shouldAttachVideoOcr({ url: 'https://example.test/legacy.mp4' }), true);
assert.equal(shouldAttachVideoOcr({ url: 'https://example.test/video.mp4', is_video: true }), true);
assert.equal(shouldAttachVideoOcr({ url: 'https://example.test/still', is_video: false }), false);

const analyzed: AnalyzedOcrAnalysis = {
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

{
  const currentRecord = {
    url: 'https://example.test/current.mp4',
    is_video: true as const,
    ...analysisFields(analyzed),
  };
  let calls = 0;
  const result = await attachVideoOcr(currentRecord, {
    analyze: async () => {
      calls++;
      return analyzed;
    },
  });
  const persisted: PersistedOcrFields = result;
  assert.equal(persisted.ocr_outcome, 'cover');
  assert.equal(calls, 0);
}

{
  const staleVariants = [
    { ocr_schema_version: 99 },
    { ocr_model: 'stale/model' },
    { ocr_analyzer_version: 'stale-analyzer' },
    { ocr_valid_frames: 1 },
    { trim_start: 0 },
  ];
  for (const stale of staleVariants) {
    const staleRecord = {
      url: 'https://example.test/stale.mp4',
      is_video: true as const,
      ...analysisFields(analyzed),
      ...stale,
    };
    let calls = 0;
    await attachVideoOcr(staleRecord, {
      analyze: async () => {
        calls++;
        return analyzed;
      },
    });
    assert.equal(calls, 1);
    assert.equal(staleRecord.ocr_valid_frames, analyzed.valid_frames);
  }
}

{
  const customAnalysis: AnalyzedOcrAnalysis = {
    ...analyzed,
    model: 'custom/current-ocr',
  };
  const customRecord = {
    url: 'https://example.test/custom.mp4',
    is_video: true as const,
    ...analysisFields(customAnalysis),
  };
  let calls = 0;
  await attachVideoOcr(customRecord, {
    env: { THOTH_SUBTITLE_OCR_MODEL: ' custom/current-ocr ' },
    analyze: async () => {
      calls++;
      return customAnalysis;
    },
  });
  assert.equal(calls, 0);
}

{
  let calls = 0;
  const candidate = await attachVideoOcr(
    { url: 'https://example.test/candidate.mp4', is_video: true as const },
    {
      analyze: async () => {
        calls++;
        return analyzed;
      },
    },
  );
  const selected = {
    url: candidate.url,
    is_video: true as const,
  };
  assert.equal(carryCurrentOcrMetadata(selected, candidate), true);
  await attachVideoOcr(selected, {
    analyze: async () => {
      calls++;
      return analyzed;
    },
  });
  assert.equal(calls, 1);
}

{
  const replaced = {
    url: 'https://example.test/new-source.mp4',
    is_video: true as const,
    ...analysisFields(analyzed),
  };
  clearVideoOcrMetadata(replaced);
  let calls = 0;
  await attachVideoOcr(replaced, {
    analyze: async () => {
      calls++;
      return analyzed;
    },
  });
  assert.equal(calls, 1);
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
