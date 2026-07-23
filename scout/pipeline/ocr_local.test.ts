import assert from 'node:assert';
import {
  DEFAULT_OCR_MODEL,
  OCR_ANALYZER_VERSION,
  OCR_SCHEMA_VERSION,
  type OcrAnalysis,
} from '../lib/ocr_contract.ts';
import { type LocalOcrDeps, runLocalOcr } from './ocr_local.ts';

const analyzedAt = '2026-07-23T00:00:00.000Z';
const absoluteVideo = process.platform === 'win32' ? 'C:\\media\\video.mp4' : '/media/video.mp4';

function analyzedResult(): OcrAnalysis {
  return {
    schema_version: OCR_SCHEMA_VERSION,
    ocr_status: 'analyzed',
    provider: 'novita',
    model: DEFAULT_OCR_MODEL,
    analyzer_version: OCR_ANALYZER_VERSION,
    requested_frames: 2,
    valid_frames: 2,
    analyzed_at: analyzedAt,
    verdict: {
      outcome: 'clean',
      trim_start: 0,
      mute_audio: false,
      subtitle_blur: [],
    },
  };
}

function failedResult(): OcrAnalysis {
  return {
    schema_version: OCR_SCHEMA_VERSION,
    ocr_status: 'failed',
    provider: 'novita',
    model: DEFAULT_OCR_MODEL,
    analyzer_version: OCR_ANALYZER_VERSION,
    requested_frames: 2,
    valid_frames: 1,
    analyzed_at: analyzedAt,
    error_code: 'incomplete_frame_coverage',
    error_message: 'OCR did not analyze every scheduled frame',
  };
}

async function invoke(
  args: string[],
  overrides: Partial<LocalOcrDeps> = {},
): Promise<{ code: number; stdout: string; stderr: string; calls: string[] }> {
  let stdout = '';
  let stderr = '';
  const calls: string[] = [];
  const deps: LocalOcrDeps = {
    isFile: () => true,
    now: () => new Date(analyzedAt),
    analyze: async (videoPath) => {
      calls.push(videoPath);
      return analyzedResult();
    },
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
    ...overrides,
  };
  const code = await runLocalOcr(args, deps);
  return { code, stdout, stderr, calls };
}

function assertSingleJsonObject(stdout: string): OcrAnalysis {
  assert.ok(stdout.endsWith('\n'));
  assert.equal(stdout.trim().split(/\r?\n/).length, 1);
  const parsed = JSON.parse(stdout);
  assert.equal(typeof parsed, 'object');
  assert.ok(parsed !== null && !Array.isArray(parsed));
  assert.equal(stdout, `${JSON.stringify(parsed)}\n`);
  return parsed;
}

{
  const result = await invoke([]);
  assert.notEqual(result.code, 0);
  const payload = assertSingleJsonObject(result.stdout);
  assert.equal(payload.ocr_status, 'failed');
  assert.equal(payload.error_code, 'missing_video_path');
  assert.match(result.stderr, /video path is required/i);
  assert.deepEqual(result.calls, []);
}

{
  const result = await invoke(['relative.mp4']);
  assert.notEqual(result.code, 0);
  const payload = assertSingleJsonObject(result.stdout);
  assert.equal(payload.ocr_status, 'failed');
  assert.equal(payload.error_code, 'video_path_not_absolute');
  assert.match(result.stderr, /absolute/i);
  assert.deepEqual(result.calls, []);
}

{
  const result = await invoke([absoluteVideo], { isFile: () => false });
  assert.notEqual(result.code, 0);
  const payload = assertSingleJsonObject(result.stdout);
  assert.equal(payload.ocr_status, 'failed');
  assert.equal(payload.error_code, 'video_file_not_found');
  assert.match(result.stderr, /existing file/i);
  assert.deepEqual(result.calls, []);
  assert.ok(!result.stdout.includes(absoluteVideo));
  assert.ok(!result.stderr.includes(absoluteVideo));
}

{
  const result = await invoke([absoluteVideo]);
  assert.equal(result.code, 0);
  assert.deepEqual(assertSingleJsonObject(result.stdout), analyzedResult());
  assert.equal(result.stderr, '');
  assert.deepEqual(result.calls, [absoluteVideo]);
}

{
  const result = await invoke([absoluteVideo], {
    analyze: async () => failedResult(),
  });
  assert.notEqual(result.code, 0);
  assert.deepEqual(assertSingleJsonObject(result.stdout), failedResult());
  assert.match(result.stderr, /OCR analysis failed/i);
}

{
  const result = await invoke([absoluteVideo], {
    analyze: async () => {
      throw new Error('Bearer private-test-token');
    },
  });
  assert.notEqual(result.code, 0);
  const payload = assertSingleJsonObject(result.stdout);
  assert.equal(payload.ocr_status, 'failed');
  assert.equal(payload.error_code, 'analysis_exception');
  assert.ok(!result.stdout.includes('private-test-token'));
  assert.ok(!result.stderr.includes('private-test-token'));
}
