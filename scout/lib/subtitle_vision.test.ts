import assert from 'node:assert';
import {
  buildSampleTimes,
  classifyOcrFrames,
  classifyVisionText,
  classifyClip,
  normalizeRegion,
  parseDeepSeekOcr,
  parseVisionFrame,
} from './subtitle_vision.ts';
import type { OcrBox } from './subtitle_vision.ts';

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
  assert.ok(hybrid.subtitle_blur.length >= 3);
  assert.ok(hybrid.subtitle_blur.every((r) => r.y > .70));
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
  assert.equal(twoLine.subtitle_blur.length, 2);
  assert.ok(twoLine.subtitle_blur.every((r) => r.h > .14));
}
console.log('ok classifyOcrFrames');
