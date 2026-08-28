import assert from 'node:assert';
import {
  type AnalyzedOcrAnalysis,
  analysisFields,
  configuredOcrModel,
  OCR_ANALYZER_VERSION,
  OCR_SCHEMA_VERSION,
  type OcrAnalysis,
  OcrAnalysisError,
  runRequiredOcr,
} from './ocr_contract.ts';
import type { OcrBox } from './subtitle_vision.ts';
import {
  analyzeSubtitles,
  analyzeSubtitlesDetailed,
  buildClassifiedDiagnostics,
  buildSampleTimes,
  classifyClip,
  classifyOcrFrames,
  classifyVisionText,
  fetchJsonWithTimeout,
  hashVideoId,
  mainDirectiveFields,
  normalizeRegion,
  parseDeepSeekOcr,
  parseDuration,
  parseOcrResponseContent,
  parseVisionFrame,
  probeDuration,
} from './subtitle_vision.ts';

// Bun 1.3.x kills the first sync spawn after a long idle gap with a spurious
// ETIMEDOUT within milliseconds, so a probe that never ran read as unprobeable
// media and failed the whole run. A kill landing well inside the budget is not
// a timeout: retry once.
{
  const timeouts: NodeJS.ErrnoException = Object.assign(new Error('spawnSync ETIMEDOUT'), {
    code: 'ETIMEDOUT',
  });
  let calls = 0;
  const spurious = probeDuration('C:/video.mp4', {}, () => {
    calls += 1;
    if (calls === 1) throw timeouts;
    return '25.167574\n';
  });
  assert.deepEqual(spurious, { status: 'ok', duration: 25.167574 });
  assert.equal(calls, 2);

  // A retry that times out again is a real failure, and is not retried forever.
  let persistent = 0;
  const stillFailing = probeDuration('C:/video.mp4', {}, () => {
    persistent += 1;
    throw timeouts;
  });
  assert.equal(persistent, 2);
  assert.equal(stillFailing.status, 'failed');
  assert.equal(stillFailing.status === 'failed' && stillFailing.reason, 'timeout');

  // A kill that lands after the budget genuinely elapsed is a real timeout, so
  // it must not spend a second probe.
  let realTimeout = 0;
  const genuine = probeDuration(
    'C:/video.mp4',
    {},
    () => {
      realTimeout += 1;
      throw timeouts;
    },
    0,
  );
  assert.equal(realTimeout, 1);
  assert.equal(genuine.status === 'failed' && genuine.reason, 'timeout');
}

assert.equal(configuredOcrModel({}), 'deepseek/deepseek-ocr');
assert.equal(
  configuredOcrModel({ THOTH_SUBTITLE_OCR_MODEL: ' custom/current-ocr ' }),
  'custom/current-ocr',
);

{
  const analysis: AnalyzedOcrAnalysis = {
    schema_version: 1,
    ocr_status: 'analyzed',
    provider: 'novita',
    model: 'deepseek/deepseek-ocr',
    analyzer_version: OCR_ANALYZER_VERSION,
    requested_frames: 4,
    valid_frames: 4,
    analyzed_at: '2026-07-23T00:00:00.000Z',
    verdict: {
      outcome: 'cover',
      trim_start: 3,
      mute_audio: false,
      subtitle_blur: [],
    },
  };
  assert.deepEqual(analysisFields(analysis), {
    ocr_schema_version: OCR_SCHEMA_VERSION,
    ocr_status: 'analyzed',
    ocr_model: 'deepseek/deepseek-ocr',
    ocr_analyzer_version: OCR_ANALYZER_VERSION,
    ocr_analyzed_at: '2026-07-23T00:00:00.000Z',
    ocr_requested_frames: 4,
    ocr_valid_frames: 4,
    ocr_outcome: 'cover',
    trim_start: 3,
    mute_audio: false,
    subtitle_blur: [],
  });

  const failed: OcrAnalysis = {
    schema_version: 1,
    ocr_status: 'failed',
    provider: 'novita',
    model: 'deepseek/deepseek-ocr',
    analyzer_version: OCR_ANALYZER_VERSION,
    requested_frames: 4,
    valid_frames: 3,
    analyzed_at: '2026-07-23T00:00:00.000Z',
    error_code: 'incomplete_frame_coverage',
    error_message: 'OCR did not analyze every scheduled frame',
  };
  assert.throws(
    () => analysisFields(failed as AnalyzedOcrAnalysis),
    (error: unknown) =>
      error instanceof OcrAnalysisError && error.code === 'incomplete_frame_coverage',
  );
  await assert.rejects(
    () =>
      runRequiredOcr(async () => {
        throw new Error('ordinary failure with Bearer secret-token');
      }),
    (error: unknown) =>
      error instanceof OcrAnalysisError &&
      error.code === 'analysis_exception' &&
      !error.message.includes('secret-token'),
  );
}

{
  const analyzedAt = new Date('2026-07-23T00:00:00Z');
  const missingKey = await analyzeSubtitlesDetailed('C:/video.mp4', 10, {
    env: {},
    now: () => analyzedAt,
  });
  assert.equal(missingKey.ocr_status, 'failed');
  assert.equal(missingKey.error_code, 'missing_api_key');
  assert.equal(missingKey.error_message, 'OCR API key is not configured');
  assert.equal(missingKey.analyzed_at, analyzedAt.toISOString());
  assert.equal(missingKey.verdict, undefined);

  let durationDiagnostic: any;
  const noDuration = await analyzeSubtitlesDetailed('C:/video.mp4', 0, {
    env: { THOTH_NOVITA_API_KEY: 'test' },
    probeDuration: () => ({
      status: 'failed',
      code: 'duration_probe_failed',
      reason: 'process_exit',
      safe_exit_code: 1,
    }),
    appendDiagnostics: (record) => {
      durationDiagnostic = record;
    },
  });
  assert.equal(noDuration.ocr_status, 'failed');
  assert.equal(noDuration.error_code, 'duration_probe_failed');
  assert.equal(noDuration.verdict, undefined);
  assert.equal(durationDiagnostic.probe_reason, 'process_exit');
  assert.equal(durationDiagnostic.probe_exit_code, 1);

  let invalidDiagnostic: any;
  const invalidOutput = await analyzeSubtitlesDetailed('C:/video.mp4', 0, {
    env: { THOTH_NOVITA_API_KEY: 'test' },
    probeDuration: () => ({
      status: 'failed',
      code: 'duration_probe_failed',
      reason: 'invalid_output',
    }),
    appendDiagnostics: (record) => {
      invalidDiagnostic = record;
    },
  });
  assert.equal(invalidOutput.error_code, 'duration_probe_failed');
  assert.equal(invalidDiagnostic.probe_reason, 'invalid_output');

  // Real probeDuration against an absent binary: a checkout without the untracked
  // ffmpeg/ffprobe (a git worktree) must not read as unprobeable media.
  const missingTool = await analyzeSubtitlesDetailed('C:/video.mp4', 0, {
    env: { THOTH_NOVITA_API_KEY: 'test', THOTH_FFMPEG: 'C:/thoth-absent/ffmpeg.exe' },
  });
  assert.equal(missingTool.ocr_status, 'failed');
  assert.equal(missingTool.error_code, 'ffprobe_missing');
  assert.equal(missingTool.error_message, 'ffprobe executable was not found');
  assert.equal(missingTool.verdict, undefined);

  const clean = await analyzeSubtitlesDetailed('C:/video.mp4', 1, {
    env: {
      THOTH_NOVITA_API_KEY: 'test',
      THOTH_SUBTITLE_OCR_MODEL: 'custom/current-ocr',
    },
    frameDataUrl: (_video, t) => `frame:${t}`,
    ocrFrame: async () => ({ boxes: [] }),
  });
  assert.equal(clean.ocr_status, 'analyzed');
  assert.equal(clean.verdict?.outcome, 'clean');
  assert.equal(clean.model, 'custom/current-ocr');
  assert.equal(clean.valid_frames, clean.requested_frames);

  const partial = await analyzeSubtitlesDetailed('C:/video.mp4', 4, {
    env: { THOTH_NOVITA_API_KEY: 'test' },
    frameDataUrl: (_video, t) => `frame:${t}`,
    ocrFrame: async (image) =>
      image === 'frame:3' ? { boxes: [], error: 'TimeoutError' } : { boxes: [] },
    retryCount: 1,
  });
  assert.equal(partial.ocr_status, 'failed');
  assert.equal(partial.error_code, 'incomplete_frame_coverage');
  assert.equal(partial.valid_frames, partial.requested_frames - 1);
  assert.equal(partial.verdict, undefined);

  // Novita caps OCR at 30 requests/minute. At 12 frames per video a third video inside the same
  // minute gets a 429 on frame 7, and retries that fire back-to-back all land in the same exhausted
  // window — 12 wasted attempts, zero recoveries, then a fatal incomplete_frame_coverage. Waiting
  // between attempts lets the sliding window free a slot.
  const backoffs: number[] = [];
  let limited = 6;
  const throttled = await analyzeSubtitlesDetailed('C:/video.mp4', 4, {
    env: { THOTH_NOVITA_API_KEY: 'test' },
    frameDataUrl: (_video, t) => `frame:${t}`,
    ocrFrame: async () =>
      backoffs.length === 0 && limited-- > 0 ? { boxes: [], error: 'http_429' } : { boxes: [] },
    sleep: async (ms) => {
      backoffs.push(ms);
    },
    retryCount: 2,
  });
  assert.equal(throttled.ocr_status, 'analyzed');
  assert.equal(throttled.valid_frames, throttled.requested_frames);
  assert.ok(backoffs.length > 0, 'a rate-limited frame must wait before retrying');
  assert.ok(
    backoffs.every((ms) => ms > 0),
    'backoff must be a real delay',
  );

  // A frame that succeeds first try must never pay the delay.
  const unthrottled: number[] = [];
  await analyzeSubtitlesDetailed('C:/video.mp4', 4, {
    env: { THOTH_NOVITA_API_KEY: 'test' },
    frameDataUrl: (_video, t) => `frame:${t}`,
    ocrFrame: async () => ({ boxes: [] }),
    sleep: async (ms) => {
      unthrottled.push(ms);
    },
  });
  assert.equal(unthrottled.length, 0);

  let thrownAttempts = 0;
  const thrown = await analyzeSubtitlesDetailed('C:/video.mp4', 1, {
    env: { THOTH_NOVITA_API_KEY: 'test' },
    frameDataUrl: () => 'frame',
    ocrFrame: async () => {
      thrownAttempts++;
      throw new Error('Bearer private-test-token');
    },
    retryCount: 1,
  });
  assert.equal(thrown.ocr_status, 'failed');
  assert.equal(thrown.error_code, 'incomplete_frame_coverage');
  assert.equal(thrownAttempts, 2);
  assert.ok(!JSON.stringify(thrown).includes('private-test-token'));

  let sanitizedDiagnostic: unknown;
  const secretError = await analyzeSubtitlesDetailed('C:/video.mp4', 1, {
    env: { THOTH_NOVITA_API_KEY: 'test' },
    frameDataUrl: () => 'frame',
    ocrFrame: async () => ({
      boxes: [],
      error: 'Authorization: Bearer private-test-token',
    }),
    retryCount: 0,
    appendDiagnostics: (record) => {
      sanitizedDiagnostic = record;
    },
  });
  assert.equal(secretError.ocr_status, 'failed');
  const serializedDiagnostic = JSON.stringify(sanitizedDiagnostic);
  assert.match(serializedDiagnostic, /"error":"ocr_request_failed"/);
  assert.doesNotMatch(serializedDiagnostic, /Authorization|Bearer|private-test-token/i);

  const permanentCalls: number[] = [];
  let extractionDiagnostic: any;
  const extractionError = await analyzeSubtitlesDetailed('C:/video.mp4', 1, {
    env: { THOTH_NOVITA_API_KEY: 'test' },
    frameDataUrl: (_video, t) => {
      permanentCalls.push(t);
      throw new Error('Authorization: Bearer private-extraction-token');
    },
    ocrFrame: async () => ({ boxes: [] }),
    retryCount: 0,
    appendDiagnostics: (record) => {
      extractionDiagnostic = record;
    },
  });
  assert.equal(extractionError.ocr_status, 'failed');
  assert.equal(extractionError.error_code, 'incomplete_frame_coverage');
  assert.deepEqual(permanentCalls, [0.5, 0.5, 0.25, 0.25, 0, 0]);
  const serializedExtractionDiagnostic = JSON.stringify(extractionDiagnostic);
  assert.match(serializedExtractionDiagnostic, /"error":"frame_extract"/);
  assert.doesNotMatch(
    serializedExtractionDiagnostic,
    /Authorization|Bearer|private-extraction-token/i,
  );

  const orderedCalls: number[] = [];
  const orderedFailure = await analyzeSubtitlesDetailed('C:/video.mp4', 4, {
    env: { THOTH_NOVITA_API_KEY: 'test' },
    frameDataUrl: (_video, t) => {
      orderedCalls.push(t);
      return t <= 2 ? `frame:${t}` : null;
    },
    ocrFrame: async () => ({ boxes: [] }),
    retryCount: 0,
  });
  assert.equal(orderedFailure.ocr_status, 'failed');
  assert.deepEqual(orderedCalls.slice(-6), [3, 3, 2.75, 2.75, 2.5, 2.5]);

  const extractionCalls: number[] = [];
  let recoveredDiagnostic: any;
  const recovered = await analyzeSubtitlesDetailed('C:/video.mp4', 8, {
    env: {
      THOTH_NOVITA_API_KEY: 'test',
      THOTH_SUBTITLE_OCR_MAX_FRAMES: '7',
    },
    frameDataUrl: (_video, t) => {
      extractionCalls.push(t);
      return t === 7.92 ? null : `frame:${t}`;
    },
    ocrFrame: async (image) =>
      image === 'frame:7.67'
        ? { boxes: [] }
        : {
            boxes: [
              {
                text: 'MATCH DAY',
                x0: 0.1,
                y0: 0.3,
                x1: 0.9,
                y1: 0.43,
              },
            ],
          },
    appendDiagnostics: (record) => {
      recoveredDiagnostic = record;
    },
  });
  assert.equal(recovered.ocr_status, 'analyzed');
  assert.deepEqual(extractionCalls.slice(-3), [7.92, 7.92, 7.67]);
  assert.equal(recovered.verdict?.outcome, 'cover');
  assert.equal(recovered.verdict?.trim_start, 6.335);
  assert.equal(recoveredDiagnostic.samples.at(-1).t, 7.67);
  assert.equal(recoveredDiagnostic.samples.at(-1).requested_t, 7.92);
  assert.equal(recoveredDiagnostic.requested_frames, recoveredDiagnostic.valid_frames);
  assert.equal(recoveredDiagnostic.actual_retry_count, 0);

  let exactDiagnostic: any;
  const exact = await analyzeSubtitlesDetailed('C:/video.mp4', 1, {
    env: { THOTH_NOVITA_API_KEY: 'test' },
    frameDataUrl: (_video, t) => `frame:${t}`,
    ocrFrame: async () => ({ boxes: [] }),
    appendDiagnostics: (record) => {
      exactDiagnostic = record;
    },
  });
  assert.equal(exact.ocr_status, 'analyzed');
  assert.equal('requested_t' in exactDiagnostic.samples[0], false);

  let retryAttempts = 0;
  let retryDiagnostic: any;
  const retried = await analyzeSubtitlesDetailed('C:/video.mp4', 1, {
    env: { THOTH_NOVITA_API_KEY: 'test' },
    frameDataUrl: () => 'frame',
    ocrFrame: async () => {
      retryAttempts++;
      return retryAttempts === 1 ? { boxes: [], error: 'TimeoutError' } : { boxes: [] };
    },
    retryCount: 2,
    appendDiagnostics: (record) => {
      retryDiagnostic = record;
    },
  });
  assert.equal(retried.ocr_status, 'analyzed');
  assert.equal(retryAttempts, 2);
  assert.equal(retryDiagnostic.configured_retry_count, 2);
  assert.equal(retryDiagnostic.actual_retry_count, 1);

  await assert.rejects(
    () => analyzeSubtitles('', 0, { env: { THOTH_NOVITA_API_KEY: 'test' } }),
    (error: any) =>
      error?.name === 'OcrAnalysisError' &&
      error?.code === 'missing_video_path' &&
      !JSON.stringify(error).includes('test'),
  );
}

assert.match(hashVideoId('https://example.test/private?a=secret'), /^[a-f0-9]{16}$/);
assert.equal(parseDuration('26.935011\n'), 26.935011);
assert.equal(parseDuration('N/A'), 0);
await assert.rejects(
  () =>
    fetchJsonWithTimeout(
      'https://never.test',
      {},
      5,
      (() => new Promise(() => {})) as typeof fetch,
    ),
  (error: any) => error?.name === 'TimeoutError',
);
await assert.rejects(
  () =>
    fetchJsonWithTimeout('https://stalled-body.test', {}, 5, (async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    })) as unknown as typeof fetch),
  (error: any) => error?.name === 'TimeoutError',
);
assert.deepEqual(parseOcrResponseContent(null), { boxes: [], error: 'malformed_content' });
assert.deepEqual(parseOcrResponseContent(''), { boxes: [] });
assert.deepEqual(parseOcrResponseContent('service unavailable'), {
  boxes: [],
  error: 'malformed_content',
});
assert.deepEqual(
  mainDirectiveFields({
    outcome: 'subtitle',
    trim_start: 4,
    mute_audio: true,
    subtitle_blur: [{ x: 0.1, y: 0.7, w: 0.8, h: 0.1, start: 5, end: 8 }],
  }),
  {
    trim_start: 4,
    mute_audio: true,
    subtitle_blur: [{ x: 0.1, y: 0.7, w: 0.8, h: 0.1, start: 5, end: 8 }],
  },
);
assert.deepEqual(
  mainDirectiveFields({
    outcome: 'clean',
    trim_start: 0,
    mute_audio: false,
    subtitle_blur: [],
  }),
  { trim_start: 0, mute_audio: false, subtitle_blur: [] },
);

// DeepSeek-OCR grounding output uses a 0..1000 coordinate grid.
{
  const boxes = parseDeepSeekOcr(
    '<|ref|>CUCURELLA BUNGKUS TROFI<|/ref|><|det|>[[53,460,821,540]]<|/det|>\n' +
      '<|ref|>PIALA DUNIA PAKE KRESEK<|/ref|><|det|>[[70,545,790,617]]<|/det|>',
  );
  assert.deepEqual(boxes[0], {
    text: 'CUCURELLA BUNGKUS TROFI',
    x0: 0.053,
    y0: 0.46,
    x1: 0.821,
    y1: 0.54,
  });
  assert.equal(boxes.length, 2);
  assert.deepEqual(parseDeepSeekOcr('<|ref|>valid<|/ref|><|det|>[[900,700,100,300]]<|/det|>'), [
    { text: 'valid', x0: 0.1, y0: 0.3, x1: 0.9, y1: 0.7 },
  ]);
  // Novita's OpenAI-compatible adapter may strip the ref/det control tokens
  // while retaining the same text + grounding-grid payload.
  assert.deepEqual(
    parseDeepSeekOcr('CURELLA BUNGKUS TROFI[[90, 521, 803, 546]]\n24[[449, 650, 524, 690]]'),
    [
      { text: 'CURELLA BUNGKUS TROFI', x0: 0.09, y0: 0.521, x1: 0.803, y1: 0.546 },
      { text: '24', x0: 0.449, y0: 0.65, x1: 0.524, y1: 0.69 },
    ],
  );
  assert.deepEqual(buildSampleTimes(0.3, 12), [0]);
  const samples = buildSampleTimes(26.935, 12);
  assert.deepEqual(samples.slice(0, 6), [0.5, 1, 2, 3, 4, 5]);
  assert.ok(samples.length <= 12 && samples.at(-1)! > 20);
}

// normalizeRegion: qwen3-vl returns 0-1000 grid coords; must rescale to [0..1]
// so Rust doesn't clamp w→1.0 and blur the whole frame (the reported bug).
{
  const r = normalizeRegion(53, 460, 821, 617); // observed real output
  assert.ok(Math.abs(r.x0 - 0.053) < 1e-9 && Math.abs(r.y0 - 0.46) < 1e-9);
  assert.ok(Math.abs(r.x1 - 0.821) < 1e-9 && Math.abs(r.y1 - 0.617) < 1e-9);
  // width/height are a band, NOT full-frame
  assert.ok(r.x1 - r.x0 < 0.8 && r.y1 - r.y0 < 0.2);
  // already-normalized coords pass through unscaled
  const n = normalizeRegion(0.1, 0.4, 0.9, 0.5);
  assert.deepEqual(n, { x0: 0.1, y0: 0.4, x1: 0.9, y1: 0.5 });
  // reversed corners get ordered; out-of-range clamps to [0,1]
  const rev = normalizeRegion(900, 700, 100, 300);
  assert.deepEqual(rev, { x0: 0.1, y0: 0.3, x1: 0.9, y1: 0.7 });
  // parseVisionFrame applies normalization end-to-end
  const pf = parseVisionFrame('{"present":true,"region":[53,460,821,617],"why":"x"}');
  assert.equal(pf.present, true);
  assert.ok(pf.region && pf.region.x1 - pf.region.x0 < 0.8);
}

// Vision diinstruksi balas JSON {"reject":bool,"why":""}. Uji parsing + default aman.
assert.equal(classifyVisionText('{"reject":true,"why":"auto-caption ucapan"}'), true);
assert.equal(classifyVisionText('noise {"reject":false,"why":"lower-third berita"} noise'), false);
assert.equal(classifyVisionText('model ngaco tanpa json'), false); // tak yakin → jangan buang
assert.equal(classifyVisionText(''), false);
console.log('ok subtitle_vision');

const R = (y0: number) => ({ x0: 0.1, y0, x1: 0.9, y1: y0 + 0.08 });

// CLEAN: no text anywhere
assert.equal(
  classifyClip(
    [
      { t: 1, present: false, region: null },
      { t: 5, present: false, region: null },
    ],
    20,
  ).outcome,
  'clean',
);

// COVER: text only in first <=5s, clean after -> trim to midpoint(lastText, nextClean)
{
  const v = classifyClip(
    [
      { t: 1, present: true, region: R(0.05) },
      { t: 3, present: true, region: R(0.05) },
      { t: 5, present: false, region: null },
      { t: 8, present: false, region: null },
    ],
    20,
  );
  assert.equal(v.outcome, 'cover');
  assert.equal(v.trim_start, 4); // midpoint(3, 5)
  assert.equal(v.mute_audio, false);
  assert.deepEqual(v.subtitle_blur, []);
}

// SUBTITLE: text after COVER_MAX -> mute + blur windows around detecting frames
{
  const v = classifyClip(
    [
      { t: 1, present: false, region: null },
      { t: 5, present: false, region: null },
      { t: 8, present: true, region: R(0.72) },
      { t: 12, present: true, region: R(0.72) },
    ],
    20,
  );
  assert.equal(v.outcome, 'subtitle');
  assert.equal(v.mute_audio, true);
  assert.equal(v.subtitle_blur.length, 1); // t=8 and t=12 windows merge (Δ=4 → [6,10]∪[10,14])
  assert.ok(Math.abs(v.subtitle_blur[0].x - 0.1) < 1e-9);
  assert.ok(Math.abs(v.subtitle_blur[0].w - 0.8) < 1e-9); // x1-x0
}

// SUBTITLE everywhere -> single whole-clip region via {start:0,end:0} sentinel.
// `duration` (20) is a sampling default, but the narration render clip is often
// 30-50s; a bounded [0,20] window would leave the tail un-blurred and leak
// captions. end:0 tells Rust to ungate the blur for the entire render clip.
{
  const v = classifyClip(
    [
      { t: 1, present: true, region: R(0.7) },
      { t: 5, present: true, region: R(0.7) },
      { t: 8, present: true, region: R(0.7) },
      { t: 12, present: true, region: R(0.7) },
    ],
    20,
  );
  assert.equal(v.outcome, 'subtitle');
  assert.equal(v.subtitle_blur.length, 1);
  assert.equal(v.subtitle_blur[0].start, 0);
  assert.equal(v.subtitle_blur[0].end, 0);
}

// SUBTITLE, all frames present but no region boxes → mute, no crash, empty blur
{
  const v = classifyClip(
    [
      { t: 1, present: true, region: null },
      { t: 5, present: true, region: null },
      { t: 8, present: true, region: null },
      { t: 12, present: true, region: null },
    ],
    20,
  );
  assert.equal(v.outcome, 'subtitle');
  assert.equal(v.mute_audio, true);
  assert.deepEqual(v.subtitle_blur, []);
}
console.log('ok classifyClip');

const b = (text: string, x0: number, y0: number, x1: number, y1: number): OcrBox => ({
  text,
  x0,
  y0,
  x1,
  y1,
});
const f = (t: number, ...boxes: OcrBox[]) => ({ t, boxes });

// Localized one-glyph CJK captions remain subtitle evidence when their geometry
// is ordinary and the text changes across samples.
{
  const cjkCaptions = classifyOcrFrames(
    [
      f(1, b('啊', 0.18, 0.72, 0.82, 0.8)),
      f(3, b('呢', 0.18, 0.72, 0.82, 0.8)),
      f(5, b('哦', 0.18, 0.72, 0.82, 0.8)),
    ],
    8,
  );
  assert.equal(cjkCaptions.outcome, 'subtitle');
  assert.ok(cjkCaptions.subtitle_blur.length > 0);
}

// Sparse OCR glyphs with implausibly large boxes are hallucinations from visual
// noise, not captions. The recorded source produced these at both the lower
// band and nearly full-frame scale; together they must not reject the clip.
{
  const phantomOcr = classifyOcrFrames(
    [
      f(0.5, b('三', 0, 0.77, 0.424, 0.84)),
      f(1, b('1', 0, 0.75, 0.499, 0.808)),
      f(2, b('#', 0, 0.64, 0.66, 0.712)),
      f(3, b('#', 0, 0.75, 0.65, 0.844)),
      f(4, b('#', 0, 0.8, 0.6, 0.884)),
      f(5, b('#', 0.12, 0.777, 0.76, 0.852)),
      f(64.733334, b('福', 0, 0, 0.997, 0.997)),
      f(84.644445, b('福', 0, 0, 0.996, 0.996)),
      f(104.555556, b('1', 0, 0, 0.995, 0.999)),
    ],
    110,
  );
  assert.equal(phantomOcr.outcome, 'clean');
  assert.deepEqual(phantomOcr.subtitle_blur, []);
}

// A headline and later captions are independent actions: trim the former and
// retain output-relative blur windows for the latter.
{
  const hybrid = classifyOcrFrames(
    [
      f(0.5, b('CUCURELLA BUNGKUS TROFI', 0.05, 0.46, 0.82, 0.54)),
      f(1, b('CUCURELLA BUNGKUS TROFI', 0.05, 0.46, 0.82, 0.54)),
      f(3, b('CUCURELLA BUNGKUS TROFI', 0.05, 0.46, 0.82, 0.54)),
      f(5, b('BAWA PULANG', 0.25, 0.78, 0.75, 0.85)),
      f(8, b('KOK PIALA SEMEWAH', 0.18, 0.76, 0.82, 0.86)),
      f(12, b('REPLIKA RESMI YANG', 0.2, 0.75, 0.8, 0.86)),
    ],
    26.935,
  );
  assert.equal(hybrid.outcome, 'subtitle');
  assert.equal(hybrid.trim_start, 4);
  assert.equal(hybrid.mute_audio, true);
  assert.ok(hybrid.subtitle_blur.length >= 1);
  assert.ok(hybrid.subtitle_blur.every((r) => r.y > 0.7));
}

// Intro headline geometry must never leak into subtitle diagnostics, while a
// later moving/growing subtitle track uses extrema from every constituent frame.
{
  const frames = [
    f(0.5, b('INTRO HEADLINE', 0.08, 0.4, 0.92, 0.52)),
    f(2, b('INTRO HEADLINE', 0.06, 0.39, 0.94, 0.53)),
    f(4, b('spoken one', 0.24, 0.74, 0.7, 0.8)),
    f(6, b('spoken two', 0.12, 0.72, 0.88, 0.84)),
  ];
  const result = classifyOcrFrames(frames, 10);
  const diagnostics = buildClassifiedDiagnostics(frames, result);

  assert.equal(result.trim_start, 3);
  assert.ok(result.subtitle_blur.every((region) => region.y > 0.68));
  assert.ok(
    diagnostics.every((frame) =>
      frame.subtitle_boxes.every((box) => box.text !== 'INTRO HEADLINE'),
    ),
  );

  const merged = result.subtitle_blur.find((region) => region.start! <= 4 && region.end! >= 6);
  assert.ok(merged, 'moving/growing subtitle frames should share one temporal window');
  assert.ok(merged.x <= 0.12);
  assert.ok(merged.x + merged.w >= 0.88);
  assert.ok(merged.y <= 0.72);
  assert.ok(merged.y + merged.h >= 0.84);
}

// An unreadable sample is not evidence that a tracked headline disappeared.
{
  const partialFailure = classifyOcrFrames(
    [
      f(1, b('MATCH DAY', 0.1, 0.3, 0.9, 0.4)),
      f(2, b('MATCH DAY', 0.1, 0.3, 0.9, 0.4)),
      { t: 3, boxes: [], error: 'TimeoutError' },
      f(4, b('MATCH DAY', 0.1, 0.3, 0.9, 0.4)),
      f(5),
    ],
    8,
  );
  assert.equal(partialFailure.trim_start, 4.5);
}

// Regression from the reported source: DeepSeek emits each headline line as a
// thin box (~1.8% frame area), so width + temporal stability must carry it.
{
  const realGeometry = classifyOcrFrames(
    [
      f(
        1,
        b('CURELLA BUNGKUS TROFI', 0.09, 0.521, 0.803, 0.546),
        b('PIALA DUNIA PAKE KRESEK', 0.09, 0.568, 0.777, 0.595),
      ),
      f(
        2,
        b('CUCURELLA BUNGKUS TROFI', 0.114, 0.521, 0.924, 0.546),
        b('PIALA DUNIA PAKE KRESEK', 0.114, 0.568, 0.894, 0.593),
      ),
      f(
        3,
        b('CUCURELLA BUNGKUS TROFI', 0.117, 0.521, 0.919, 0.546),
        b('PIALA DUNIA PAKE KRESEK', 0.117, 0.567, 0.891, 0.592),
      ),
      f(4, b('DIA NGGAK TAHU', 0.174, 0.758, 0.83, 0.799)),
      f(5, b('BAWA PULANG', 0.215, 0.755, 0.787, 0.799)),
      f(8, b('KOK PIALA SEMEWAH', 0.277, 0.733, 0.7, 0.824)),
    ],
    10,
  );
  assert.equal(realGeometry.trim_start, 3.5);
  assert.ok(realGeometry.subtitle_blur.every((region) => region.y > 0.7));
}

// Changing, left-anchored text in a stable lower-third slot is a chyron, not
// spoken caption text, and must not cause footage rejection.
{
  const lowerThird = classifyOcrFrames(
    [
      f(1, b('LIVE NEWS', 0.02, 0.84, 0.14, 0.89), b('BREAKING NEWS', 0.18, 0.84, 0.7, 0.89)),
      f(3, b('LIVE NEWS', 0.02, 0.84, 0.14, 0.89), b('MARKETS RALLY', 0.182, 0.84, 0.66, 0.89)),
      f(5, b('LIVE NEWS', 0.02, 0.84, 0.14, 0.89), b('MORE AT TEN', 0.181, 0.84, 0.62, 0.89)),
    ],
    8,
  );
  assert.equal(lowerThird.outcome, 'clean');
}

// Alignment alone is insufficient: ordinary auto-captions can be left-aligned.
{
  const leftCaptions = classifyOcrFrames(
    [
      f(1, b('I SAW IT LIVE', 0.05, 0.72, 0.55, 0.79)),
      f(3, b('THIS TO HAPPEN', 0.052, 0.72, 0.52, 0.79)),
      f(5, b('WATCH UNTIL END', 0.051, 0.72, 0.58, 0.79)),
    ],
    8,
  );
  assert.equal(leftCaptions.outcome, 'subtitle');
}

// Persistent two-line captions are still subtitles even when OCR text does not
// change between samples.
{
  const stableTwoLine = classifyOcrFrames(
    [
      f(1, b('THIS LINE STAYS', 0.18, 0.7, 0.82, 0.75), b('SO DOES THIS', 0.25, 0.76, 0.75, 0.81)),
      f(3, b('THIS LINE STAYS', 0.18, 0.7, 0.82, 0.75), b('SO DOES THIS', 0.25, 0.76, 0.75, 0.81)),
      f(5, b('THIS LINE STAYS', 0.18, 0.7, 0.82, 0.75), b('SO DOES THIS', 0.25, 0.76, 0.75, 0.81)),
    ],
    8,
  );
  assert.equal(stableTwoLine.outcome, 'subtitle');
  assert.ok(stableTwoLine.subtitle_blur.every((region) => region.h > 0.12));
}

// A small, stable corner watermark is neither headline nor subtitle.
{
  const watermark = classifyOcrFrames(
    [
      f(1, b('@channel', 0.86, 0.03, 0.98, 0.06)),
      f(3, b('@channel', 0.86, 0.03, 0.98, 0.06)),
      f(8, b('@channel', 0.86, 0.03, 0.98, 0.06)),
    ],
    10,
  );
  assert.equal(watermark.outcome, 'clean');
}

// OCR re-measures geometry on every frame, so a banner sitting right on the 2%-of-frame cutoff
// reads 0.0192 on one sample and 0.0202 on the next. Judging each box on its own area punished
// that twice — the over-cutoff samples escaped the filter AND stopped counting toward stability,
// so every sample survived into the headline scan and the banner's last sample read as a headline
// vanishing. On a real IDN Times chyron that discarded 47s of an 89s video.
{
  const banner = (t: number, y1: number) => f(t, b('IDN TIMES', 0.25, 0.8, 0.75, y1));
  const jitter = classifyOcrFrames(
    [banner(1, 0.8384), banner(2, 0.8404), banner(3, 0.8384), banner(4, 0.8404), banner(5, 0.8384)],
    20,
  );
  assert.equal(jitter.outcome, 'clean');
  assert.equal(jitter.trim_start, 0);

  // The banner genuinely leaving is still a headline: the median only decides whether the box is
  // furniture, it must not make a real cover undetectable.
  const realCover = classifyOcrFrames(
    [
      f(1, b('BREAKING STORY HEADLINE', 0.2, 0.3, 0.8, 0.42)),
      f(3, b('BREAKING STORY HEADLINE', 0.2, 0.3, 0.8, 0.42)),
      f(5),
    ],
    20,
  );
  assert.equal(realCover.outcome, 'cover');
  assert.equal(realCover.trim_start, 4);
}

// Cover-only headline clears before body footage.
{
  const cover = classifyOcrFrames(
    [
      f(0.5, b('MATCH DAY', 0.1, 0.3, 0.9, 0.43)),
      f(2, b('MATCH DAY', 0.11, 0.3, 0.91, 0.43)),
      f(4),
      f(8),
    ],
    12,
  );
  assert.equal(cover.outcome, 'cover');
  assert.equal(cover.trim_start, 3);
  assert.equal(cover.mute_audio, false);
}

// Moving captions in one positional band share a window whose geometry follows
// the full track rather than the first frame.
{
  const subtitle = classifyOcrFrames(
    [
      f(1),
      f(3, b('SATU', 0.16, 0.73, 0.7, 0.8)),
      f(5, b('DUA', 0.25, 0.75, 0.85, 0.84)),
      f(8, b('TIGA', 0.1, 0.72, 0.74, 0.81)),
    ],
    10,
  );
  assert.equal(subtitle.outcome, 'subtitle');
  assert.equal(subtitle.trim_start, 0);
  assert.equal(subtitle.subtitle_blur.length, 1);
  assert.ok(subtitle.subtitle_blur[0].x < 0.1);
  assert.ok(subtitle.subtitle_blur[0].x + subtitle.subtitle_blur[0].w > 0.85);
}

// Temporally adjacent text in disjoint horizontal tracks stays separate.
{
  const separateTracks = classifyOcrFrames(
    [
      f(1),
      f(3, b('LEFT CAPTION', 0.05, 0.72, 0.35, 0.8)),
      f(5, b('RIGHT CAPTION', 0.65, 0.72, 0.95, 0.8)),
    ],
    8,
  );
  assert.equal(separateTracks.subtitle_blur.length, 2);
}

// Simultaneous captions in disjoint horizontal tracks must not be enveloped
// into one nearly full-width blur region.
{
  const simultaneousTracks = classifyOcrFrames(
    [
      f(1),
      f(3, b('LEFT ONE', 0.05, 0.72, 0.35, 0.8), b('RIGHT ONE', 0.65, 0.72, 0.95, 0.8)),
      f(5, b('LEFT TWO', 0.06, 0.72, 0.36, 0.8), b('RIGHT TWO', 0.64, 0.72, 0.94, 0.8)),
    ],
    8,
  );
  assert.equal(simultaneousTracks.subtitle_blur.length, 2);
  assert.ok(simultaneousTracks.subtitle_blur.every((region) => region.w < 0.4));
  assert.ok(
    simultaneousTracks.subtitle_blur.some(
      (region) => region.x <= 0.05 && region.x + region.w <= 0.4,
    ),
  );
  assert.ok(
    simultaneousTracks.subtitle_blur.some(
      (region) => region.x >= 0.6 && region.x + region.w >= 0.95,
    ),
  );
}

// A broad track that splits into two simultaneous captions may be consumed by
// only one of them; otherwise in-place union makes the second reuse it too.
{
  const splitTransition = classifyOcrFrames(
    [
      f(1),
      f(3, b('BROAD CAPTION', 0.2, 0.72, 0.8, 0.8)),
      f(5, b('LEFT SPLIT', 0.1, 0.72, 0.4, 0.8), b('RIGHT SPLIT', 0.6, 0.72, 0.9, 0.8)),
    ],
    8,
  );
  assert.equal(splitTransition.subtitle_blur.length, 2);
  assert.ok(
    !splitTransition.subtitle_blur.some((region) => region.x <= 0.1 && region.x + region.w >= 0.9),
  );
}

// Two OCR lines in one frame become a single padded subtitle envelope.
{
  const twoLine = classifyOcrFrames(
    [
      f(1),
      f(3, b('BARIS SATU', 0.16, 0.7, 0.82, 0.76), b('BARIS DUA', 0.22, 0.77, 0.76, 0.84)),
      f(5, b('KALIMAT BARU', 0.14, 0.71, 0.8, 0.77), b('LANJUTANNYA', 0.2, 0.78, 0.78, 0.85)),
    ],
    8,
  );
  assert.equal(twoLine.subtitle_blur.length, 1);
  assert.ok(twoLine.subtitle_blur.every((r) => r.h > 0.14));
}

{
  const frames = [
    f(1, b('HEADLINE', 0.1, 0.3, 0.9, 0.4)),
    f(2, b('HEADLINE', 0.1, 0.3, 0.9, 0.4)),
    f(3),
    f(5, b('CAPTION A', 0.2, 0.72, 0.8, 0.8)),
    f(7, b('CAPTION B', 0.2, 0.72, 0.8, 0.8)),
  ];
  const verdict = classifyOcrFrames(frames, 9);
  const diagnostics = buildClassifiedDiagnostics(frames, verdict);
  assert.ok(diagnostics.find((frame) => frame.t === 1)!.headline_boxes.length > 0);
  assert.ok(diagnostics.find((frame) => frame.t === 5)!.subtitle_boxes.length > 0);
}

// Repeated merging must not re-pad an already padded region on every sample.
{
  const repeated = classifyOcrFrames(
    [
      f(1, b('ONE', 0.2, 0.72, 0.8, 0.8)),
      f(2, b('TWO', 0.2, 0.72, 0.8, 0.8)),
      f(3, b('THREE', 0.2, 0.72, 0.8, 0.8)),
      f(4, b('FOUR', 0.2, 0.72, 0.8, 0.8)),
      f(5, b('FIVE', 0.2, 0.72, 0.8, 0.8)),
    ],
    6,
  );
  assert.equal(repeated.subtitle_blur.length, 1);
  assert.ok(Math.abs(repeated.subtitle_blur[0].x - 0.18) < 1e-9);
  assert.ok(Math.abs(repeated.subtitle_blur[0].w - 0.64) < 1e-9);
}
console.log('ok classifyOcrFrames');
