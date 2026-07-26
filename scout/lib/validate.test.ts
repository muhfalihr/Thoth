import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_OCR_MODEL, OCR_ANALYZER_VERSION } from './ocr_contract.ts';
import type { ContentSet } from './types.ts';
import { lintContentSet } from './validate.ts';

const analyzed = (
  outcome: 'clean' | 'cover' | 'subtitle' = 'clean',
  model = DEFAULT_OCR_MODEL,
) => ({
  ocr_status: 'analyzed' as const,
  ocr_schema_version: 1,
  ocr_model: model,
  ocr_analyzer_version: OCR_ANALYZER_VERSION,
  ocr_analyzed_at: '2026-07-23T00:00:00.000Z',
  ocr_requested_frames: 4,
  ocr_valid_frames: 4,
  ocr_outcome: outcome,
  trim_start: outcome === 'cover' ? 3 : 0,
  mute_audio: outcome === 'subtitle',
  subtitle_blur:
    outcome === 'subtitle' ? [{ x: 0.1, y: 0.7, w: 0.8, h: 0.1, start: 3, end: 5 }] : [],
});

const videoSet = (): ContentSet => ({
  main: {
    url: 'https://cdn.example.test/main.mp4',
    title: 'Main',
    description: 'Grounded description',
    is_video: true,
    ...analyzed(),
  },
  footage: [],
  comments: [],
});

const errorText = (set: ContentSet) => lintContentSet(set).errors.join('\n');

{
  const set = videoSet();
  Object.assign(set.main, analyzed('clean', 'custom/current-ocr'));
  assert.equal(
    lintContentSet(set, {
      THOTH_SUBTITLE_OCR_MODEL: ' custom/current-ocr ',
    }).ok,
    true,
  );
  assert.match(lintContentSet(set, {}).errors.join('\n'), /main.*stale.*model/i);
}

{
  const set = videoSet();
  delete set.main.ocr_status;
  assert.match(errorText(set), /main.*not analyzed/i);
}

{
  const set = videoSet();
  set.main.ocr_status = 'failed';
  assert.match(errorText(set), /main.*analysis failed/i);
}

{
  const missingSchema = videoSet();
  delete missingSchema.main.ocr_schema_version;
  assert.match(errorText(missingSchema), /main.*stale.*schema/i);

  const wrongSchema = videoSet();
  wrongSchema.main.ocr_schema_version = 2;
  assert.match(errorText(wrongSchema), /main.*stale.*schema/i);

  const wrongModel = videoSet();
  wrongModel.main.ocr_model = 'qwen/qwen3-vl';
  assert.match(errorText(wrongModel), /main.*stale.*model/i);

  const wrongAnalyzer = videoSet();
  wrongAnalyzer.main.ocr_analyzer_version = 'deepseek-ocr-v1';
  assert.match(errorText(wrongAnalyzer), /main.*stale.*analyzer/i);
}

{
  const subtitleWithoutMute = videoSet();
  Object.assign(subtitleWithoutMute.main, analyzed('subtitle'), { mute_audio: false });
  assert.match(errorText(subtitleWithoutMute), /main.*inconsistent.*subtitle.*mute/i);

  const subtitleWithoutBlur = videoSet();
  Object.assign(subtitleWithoutBlur.main, analyzed('subtitle'), { subtitle_blur: [] });
  assert.match(errorText(subtitleWithoutBlur), /main.*inconsistent.*subtitle.*blur/i);

  const cleanWithDirectives = videoSet();
  Object.assign(cleanWithDirectives.main, analyzed(), {
    trim_start: 1,
    mute_audio: true,
    subtitle_blur: [{ x: 0.1, y: 0.7, w: 0.8, h: 0.1, start: 1, end: 2 }],
  });
  assert.match(errorText(cleanWithDirectives), /main.*inconsistent.*clean/i);

  const coverWithoutTrim = videoSet();
  Object.assign(coverWithoutTrim.main, analyzed('cover'), { trim_start: 0 });
  assert.match(errorText(coverWithoutTrim), /main.*inconsistent.*cover.*trim/i);

  const coverWithSubtitleDirectives = videoSet();
  Object.assign(coverWithSubtitleDirectives.main, analyzed('cover'), {
    mute_audio: true,
    subtitle_blur: [{ x: 0.1, y: 0.7, w: 0.8, h: 0.1, start: 1, end: 2 }],
  });
  assert.match(errorText(coverWithSubtitleDirectives), /main.*inconsistent.*cover.*subtitle/i);
}

{
  const malformedTime = videoSet();
  malformedTime.main.ocr_analyzed_at = 'not-a-date';
  assert.match(errorText(malformedTime), /main.*malformed.*analyzed_at/i);

  const incompleteCoverage = videoSet();
  incompleteCoverage.main.ocr_valid_frames = 3;
  assert.match(errorText(incompleteCoverage), /main.*malformed.*frame/i);
}

{
  const missing = videoSet();
  missing.footage.push({
    url: 'https://cdn.example.test/missing.mp4',
    is_video: true,
    relevance: 'match',
    query: 'missing',
  });
  assert.match(errorText(missing), /footage\[0\].*not analyzed/i);

  const failed = videoSet();
  failed.footage.push({
    url: 'https://cdn.example.test/failed.mp4',
    is_video: true,
    relevance: 'match',
    query: 'failed',
    ...analyzed(),
    ocr_status: 'failed',
  });
  assert.match(errorText(failed), /footage\[0\].*analysis failed/i);
}

{
  const invalidTrim = videoSet();
  invalidTrim.main.trim_start = Number.NaN;
  assert.match(errorText(invalidTrim), /main.*malformed.*trim_start/i);

  const invalidBox = videoSet();
  invalidBox.main.subtitle_blur = [{ x: 0.8, y: 0.7, w: 0.3, h: 0.1, start: 1, end: 2 }];
  assert.match(errorText(invalidBox), /main.*malformed.*subtitle_blur/i);

  const invalidWindow = videoSet();
  invalidWindow.main.subtitle_blur = [{ x: 0.1, y: 0.7, w: 0.8, h: 0.1, start: 4, end: 2 }];
  assert.match(errorText(invalidWindow), /main.*malformed.*subtitle_blur/i);
}

{
  const set = videoSet();
  set.footage.push({
    url: 'https://cdn.example.test/subtitle.mp4',
    is_video: true,
    relevance: 'match',
    query: 'subtitle',
    ...analyzed('subtitle'),
  });
  assert.match(errorText(set), /footage\[0\].*subtitle.*rejected/i);
}

{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thoth-ocr-validator-'));
  const mainImage = path.join(tempDir, 'main.bin');
  const footageImage = path.join(tempDir, 'footage.bin');
  fs.writeFileSync(mainImage, Buffer.alloc(4096, 1));
  fs.writeFileSync(footageImage, Buffer.alloc(4096, 2));
  try {
    const set: ContentSet = {
      main: {
        url: 'https://example.test/main-still',
        title: 'Main still',
        description: 'Grounded description',
        is_video: false,
        image_path: mainImage,
      },
      footage: [
        {
          url: 'https://example.test/footage-still',
          is_video: false,
          image_path: footageImage,
          relevance: 'match',
          query: 'still',
        },
      ],
      comments: [],
    };
    assert.equal(lintContentSet(set).ok, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

{
  const set = videoSet();
  set.footage.push(
    {
      url: 'https://cdn.example.test/clean.mp4',
      is_video: true,
      relevance: 'match',
      query: 'clean',
      ...analyzed(),
    },
    {
      url: 'https://cdn.example.test/cover.mp4',
      is_video: true,
      relevance: 'match',
      query: 'cover',
      ...analyzed('cover'),
    },
  );
  assert.deepEqual(lintContentSet(set).errors, []);
}
