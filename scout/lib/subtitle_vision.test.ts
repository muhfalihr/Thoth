import assert from 'node:assert';
import {
  buildSampleTimes,
  buildClassifiedDiagnostics,
  classifyOcrFrames,
  classifyVisionText,
  classifyClip,
  hashVideoId,
  fetchJsonWithTimeout,
  mainDirectiveFields,
  normalizeRegion,
  parseDeepSeekOcr,
  parseDuration,
  parseOcrResponseContent,
  parseVisionFrame,
} from './subtitle_vision.ts';
import type { OcrBox } from './subtitle_vision.ts';

assert.match(hashVideoId('https://example.test/private?a=secret'), /^[a-f0-9]{16}$/);
assert.equal(parseDuration('26.935011\n'), 26.935011);
assert.equal(parseDuration('N/A'), 0);
await assert.rejects(
  () => fetchJsonWithTimeout(
    'https://never.test',
    {},
    5,
    (() => new Promise(() => {})) as typeof fetch,
  ),
  (error: any) => error?.name === 'TimeoutError',
);
await assert.rejects(
  () => fetchJsonWithTimeout(
    'https://stalled-body.test',
    {},
    5,
    (async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    })) as unknown as typeof fetch,
  ),
  (error: any) => error?.name === 'TimeoutError',
);
assert.deepEqual(parseOcrResponseContent(null), { boxes: [], error: 'malformed_content' });
assert.deepEqual(parseOcrResponseContent(''), { boxes: [] });
assert.deepEqual(mainDirectiveFields({
  outcome: 'subtitle',
  trim_start: 4,
  mute_audio: true,
  subtitle_blur: [{ x: .1, y: .7, w: .8, h: .1, start: 5, end: 8 }],
}), {
  trim_start: 4,
  mute_audio: true,
  subtitle_blur: [{ x: .1, y: .7, w: .8, h: .1, start: 5, end: 8 }],
});
assert.deepEqual(mainDirectiveFields({
  outcome: 'clean', trim_start: 0, mute_audio: false, subtitle_blur: [],
}), { trim_start: 0, mute_audio: false, subtitle_blur: [] });

// DeepSeek-OCR grounding output uses a 0..1000 coordinate grid.
{
  const boxes = parseDeepSeekOcr(
    '<|ref|>CUCURELLA BUNGKUS TROFI<|/ref|><|det|>[[53,460,821,540]]<|/det|>\n' +
    '<|ref|>PIALA DUNIA PAKE KRESEK<|/ref|><|det|>[[70,545,790,617]]<|/det|>',
  );
  assert.deepEqual(boxes[0], {
    text: 'CUCURELLA BUNGKUS TROFI',
    x0: .053, y0: .46, x1: .821, y1: .54,
  });
  assert.equal(boxes.length, 2);
  assert.deepEqual(
    parseDeepSeekOcr('<|ref|>valid<|/ref|><|det|>[[900,700,100,300]]<|/det|>'),
    [{ text: 'valid', x0: .1, y0: .3, x1: .9, y1: .7 }],
  );
  // Novita's OpenAI-compatible adapter may strip the ref/det control tokens
  // while retaining the same text + grounding-grid payload.
  assert.deepEqual(
    parseDeepSeekOcr('CURELLA BUNGKUS TROFI[[90, 521, 803, 546]]\n24[[449, 650, 524, 690]]'),
    [
      { text: 'CURELLA BUNGKUS TROFI', x0: .09, y0: .521, x1: .803, y1: .546 },
      { text: '24', x0: .449, y0: .65, x1: .524, y1: .69 },
    ],
  );
  assert.deepEqual(buildSampleTimes(.3, 12), [0]);
  const samples = buildSampleTimes(26.935, 12);
  assert.deepEqual(samples.slice(0, 6), [.5, 1, 2, 3, 4, 5]);
  assert.ok(samples.length <= 12 && samples.at(-1)! > 20);
}

// normalizeRegion: qwen3-vl returns 0-1000 grid coords; must rescale to [0..1]
// so Rust doesn't clamp w→1.0 and blur the whole frame (the reported bug).
{
  const r = normalizeRegion(53, 460, 821, 617); // observed real output
  assert.ok(Math.abs(r.x0 - 0.053) < 1e-9 && Math.abs(r.y0 - 0.460) < 1e-9);
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
  classifyClip([{ t: 1, present: false, region: null }, { t: 5, present: false, region: null }], 20).outcome,
  'clean');

// COVER: text only in first <=5s, clean after -> trim to midpoint(lastText, nextClean)
{
  const v = classifyClip([
    { t: 1, present: true, region: R(0.05) }, { t: 3, present: true, region: R(0.05) },
    { t: 5, present: false, region: null }, { t: 8, present: false, region: null },
  ], 20);
  assert.equal(v.outcome, 'cover');
  assert.equal(v.trim_start, 4);           // midpoint(3, 5)
  assert.equal(v.mute_audio, false);
  assert.deepEqual(v.subtitle_blur, []);
}

// SUBTITLE: text after COVER_MAX -> mute + blur windows around detecting frames
{
  const v = classifyClip([
    { t: 1, present: false, region: null }, { t: 5, present: false, region: null },
    { t: 8, present: true, region: R(0.72) }, { t: 12, present: true, region: R(0.72) },
  ], 20);
  assert.equal(v.outcome, 'subtitle');
  assert.equal(v.mute_audio, true);
  assert.equal(v.subtitle_blur.length, 1);                 // t=8 and t=12 windows merge (Δ=4 → [6,10]∪[10,14])
  assert.ok(Math.abs(v.subtitle_blur[0].x - 0.1) < 1e-9);
  assert.ok(Math.abs(v.subtitle_blur[0].w - 0.8) < 1e-9);  // x1-x0
}

// SUBTITLE everywhere -> single whole-clip region via {start:0,end:0} sentinel.
// `duration` (20) is a sampling default, but the narration render clip is often
// 30-50s; a bounded [0,20] window would leave the tail un-blurred and leak
// captions. end:0 tells Rust to ungate the blur for the entire render clip.
{
  const v = classifyClip([
    { t: 1, present: true, region: R(0.7) }, { t: 5, present: true, region: R(0.7) },
    { t: 8, present: true, region: R(0.7) }, { t: 12, present: true, region: R(0.7) },
  ], 20);
  assert.equal(v.outcome, 'subtitle');
  assert.equal(v.subtitle_blur.length, 1);
  assert.equal(v.subtitle_blur[0].start, 0);
  assert.equal(v.subtitle_blur[0].end, 0);
}

// SUBTITLE, all frames present but no region boxes → mute, no crash, empty blur
{
  const v = classifyClip([
    { t: 1, present: true, region: null }, { t: 5, present: true, region: null },
    { t: 8, present: true, region: null }, { t: 12, present: true, region: null },
  ], 20);
  assert.equal(v.outcome, 'subtitle');
  assert.equal(v.mute_audio, true);
  assert.deepEqual(v.subtitle_blur, []);
}
console.log('ok classifyClip');

const b = (text: string, x0: number, y0: number, x1: number, y1: number): OcrBox =>
  ({ text, x0, y0, x1, y1 });
const f = (t: number, ...boxes: OcrBox[]) => ({ t, boxes });

// A headline and later captions are independent actions: trim the former and
// retain output-relative blur windows for the latter.
{
  const hybrid = classifyOcrFrames([
    f(.5, b('CUCURELLA BUNGKUS TROFI', .05, .46, .82, .54)),
    f(1, b('CUCURELLA BUNGKUS TROFI', .05, .46, .82, .54)),
    f(3, b('CUCURELLA BUNGKUS TROFI', .05, .46, .82, .54)),
    f(5, b('BAWA PULANG', .25, .78, .75, .85)),
    f(8, b('KOK PIALA SEMEWAH', .18, .76, .82, .86)),
    f(12, b('REPLIKA RESMI YANG', .20, .75, .80, .86)),
  ], 26.935);
  assert.equal(hybrid.outcome, 'subtitle');
  assert.equal(hybrid.trim_start, 4);
  assert.equal(hybrid.mute_audio, true);
  assert.ok(hybrid.subtitle_blur.length >= 1);
  assert.ok(hybrid.subtitle_blur.every((r) => r.y > .70));
}

// An unreadable sample is not evidence that a tracked headline disappeared.
{
  const partialFailure = classifyOcrFrames([
    f(1, b('MATCH DAY', .1, .3, .9, .4)),
    f(2, b('MATCH DAY', .1, .3, .9, .4)),
    { t: 3, boxes: [], error: 'TimeoutError' },
    f(4, b('MATCH DAY', .1, .3, .9, .4)),
    f(5),
  ], 8);
  assert.equal(partialFailure.trim_start, 4.5);
}

// Regression from the reported source: DeepSeek emits each headline line as a
// thin box (~1.8% frame area), so width + temporal stability must carry it.
{
  const realGeometry = classifyOcrFrames([
    f(1,
      b('CURELLA BUNGKUS TROFI', .09, .521, .803, .546),
      b('PIALA DUNIA PAKE KRESEK', .09, .568, .777, .595)),
    f(2,
      b('CUCURELLA BUNGKUS TROFI', .114, .521, .924, .546),
      b('PIALA DUNIA PAKE KRESEK', .114, .568, .894, .593)),
    f(3,
      b('CUCURELLA BUNGKUS TROFI', .117, .521, .919, .546),
      b('PIALA DUNIA PAKE KRESEK', .117, .567, .891, .592)),
    f(4, b('DIA NGGAK TAHU', .174, .758, .83, .799)),
    f(5, b('BAWA PULANG', .215, .755, .787, .799)),
    f(8, b('KOK PIALA SEMEWAH', .277, .733, .70, .824)),
  ], 10);
  assert.equal(realGeometry.trim_start, 3.5);
  assert.ok(realGeometry.subtitle_blur.every((region) => region.y > .70));
}

// Changing, left-anchored text in a stable lower-third slot is a chyron, not
// spoken caption text, and must not cause footage rejection.
{
  const lowerThird = classifyOcrFrames([
    f(1, b('BREAKING NEWS', .05, .84, .58, .89)),
    f(3, b('MARKETS RALLY', .055, .84, .51, .89)),
    f(5, b('MORE AT TEN', .052, .84, .48, .89)),
  ], 8);
  assert.equal(lowerThird.outcome, 'clean');
}

// Alignment alone is insufficient: ordinary auto-captions can be left-aligned.
{
  const leftCaptions = classifyOcrFrames([
    f(1, b('I NEVER EXPECTED', .05, .72, .55, .79)),
    f(3, b('THIS TO HAPPEN', .052, .72, .52, .79)),
    f(5, b('WATCH UNTIL END', .051, .72, .58, .79)),
  ], 8);
  assert.equal(leftCaptions.outcome, 'subtitle');
}

// Persistent two-line captions are still subtitles even when OCR text does not
// change between samples.
{
  const stableTwoLine = classifyOcrFrames([
    f(1,
      b('THIS LINE STAYS', .18, .70, .82, .75),
      b('SO DOES THIS', .25, .76, .75, .81)),
    f(3,
      b('THIS LINE STAYS', .18, .70, .82, .75),
      b('SO DOES THIS', .25, .76, .75, .81)),
    f(5,
      b('THIS LINE STAYS', .18, .70, .82, .75),
      b('SO DOES THIS', .25, .76, .75, .81)),
  ], 8);
  assert.equal(stableTwoLine.outcome, 'subtitle');
  assert.ok(stableTwoLine.subtitle_blur.every((region) => region.h > .12));
}

// A small, stable corner watermark is neither headline nor subtitle.
{
  const watermark = classifyOcrFrames([
    f(1, b('@channel', .86, .03, .98, .06)),
    f(3, b('@channel', .86, .03, .98, .06)),
    f(8, b('@channel', .86, .03, .98, .06)),
  ], 10);
  assert.equal(watermark.outcome, 'clean');
}

// Cover-only headline clears before body footage.
{
  const cover = classifyOcrFrames([
    f(.5, b('MATCH DAY', .10, .30, .90, .43)),
    f(2, b('MATCH DAY', .11, .30, .91, .43)),
    f(4),
    f(8),
  ], 12);
  assert.equal(cover.outcome, 'cover');
  assert.equal(cover.trim_start, 3);
  assert.equal(cover.mute_audio, false);
}

// Moving captions remain one positional band but preserve per-window geometry.
{
  const subtitle = classifyOcrFrames([
    f(1),
    f(3, b('SATU', .16, .73, .70, .80)),
    f(5, b('DUA', .25, .75, .85, .84)),
    f(8, b('TIGA', .10, .72, .74, .81)),
  ], 10);
  assert.equal(subtitle.outcome, 'subtitle');
  assert.equal(subtitle.trim_start, 0);
  assert.ok(subtitle.subtitle_blur.length >= 2);
  assert.ok(subtitle.subtitle_blur.some((r) => r.x < .15));
}

// Two OCR lines in one frame become a single padded subtitle envelope.
{
  const twoLine = classifyOcrFrames([
    f(1),
    f(3,
      b('BARIS SATU', .16, .70, .82, .76),
      b('BARIS DUA', .22, .77, .76, .84)),
    f(5,
      b('KALIMAT BARU', .14, .71, .80, .77),
      b('LANJUTANNYA', .20, .78, .78, .85)),
  ], 8);
  assert.equal(twoLine.subtitle_blur.length, 1);
  assert.ok(twoLine.subtitle_blur.every((r) => r.h > .14));
}

{
  const frames = [
    f(1, b('HEADLINE', .1, .3, .9, .4)),
    f(2, b('HEADLINE', .1, .3, .9, .4)),
    f(3),
    f(5, b('CAPTION A', .2, .72, .8, .8)),
    f(7, b('CAPTION B', .2, .72, .8, .8)),
  ];
  const verdict = classifyOcrFrames(frames, 9);
  const diagnostics = buildClassifiedDiagnostics(frames, verdict);
  assert.ok(diagnostics.find((frame) => frame.t === 1)!.headline_boxes.length > 0);
  assert.ok(diagnostics.find((frame) => frame.t === 5)!.subtitle_boxes.length > 0);
}


// Repeated merging must not re-pad an already padded region on every sample.
{
  const repeated = classifyOcrFrames([
    f(1, b('ONE', .2, .72, .8, .8)),
    f(2, b('TWO', .2, .72, .8, .8)),
    f(3, b('THREE', .2, .72, .8, .8)),
    f(4, b('FOUR', .2, .72, .8, .8)),
    f(5, b('FIVE', .2, .72, .8, .8)),
  ], 6);
  assert.equal(repeated.subtitle_blur.length, 1);
  assert.ok(Math.abs(repeated.subtitle_blur[0].x - .18) < 1e-9);
  assert.ok(Math.abs(repeated.subtitle_blur[0].w - .64) < 1e-9);
}
console.log('ok classifyOcrFrames');
