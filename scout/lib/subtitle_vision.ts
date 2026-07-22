// subtitle_vision.ts — buang footage video yang punya CAPTION UCAPAN / overlay REACT (auto-caption
// TikTok, subtitle react, face-cam/PiP). BIARKAN lower-third berita, logo, chyron. Best-effort:
// frame/vision gagal → false (jangan buang; fallback ke text-gate build_footage).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { novitaKey } from './env.ts';

const KEY = novitaKey();
const MODEL = process.env.THOTH_VISION_MODEL_JS || 'qwen/qwen3-vl-30b-a3b-instruct';
const FFMPEG = process.env.THOTH_FFMPEG || path.join(import.meta.dirname, '..', '..', 'ffmpeg.exe');

export type SubtitleRegion = { x: number; y: number; w: number; h: number; start?: number; end?: number };
export type FrameDet = { t: number; present: boolean; region: { x0: number; y0: number; x1: number; y1: number } | null };
export type ClipVerdict = { outcome: 'clean' | 'cover' | 'subtitle'; trim_start: number; mute_audio: boolean; subtitle_blur: SubtitleRegion[] };
export type OcrBox = {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};
export type OcrFrame = { t: number; boxes: OcrBox[]; error?: string };

// DeepSeek-OCR returns one or more 0..1000 grounding boxes for every ref block.
// Keep parsing fail-open: malformed fragments are ignored without discarding valid
// pairs elsewhere in the response.
export function parseDeepSeekOcr(content: string): OcrBox[] {
  const out: OcrBox[] = [];
  const pair = /<\|ref\|>([\s\S]*?)<\|\/ref\|>\s*<\|det\|>(\[\[[\s\S]*?\]\])<\|\/det\|>/g;
  for (const match of (content || '').matchAll(pair)) {
    try {
      const text = match[1].replace(/\s+/g, ' ').trim();
      const boxes = JSON.parse(match[2]);
      if (!text || !Array.isArray(boxes)) continue;
      for (const raw of boxes) {
        if (!Array.isArray(raw) || raw.length !== 4 || raw.some((n) => typeof n !== 'number' || !Number.isFinite(n))) continue;
        const scale = Math.max(...raw.map((n: number) => Math.abs(n))) > 1 ? 1000 : 1;
        const clamp = (n: number) => Math.min(1, Math.max(0, n / scale));
        let [x0, y0, x1, y1] = raw.map(clamp);
        if (x1 < x0) [x0, x1] = [x1, x0];
        if (y1 < y0) [y0, y1] = [y1, y0];
        if (x1 - x0 >= .01 && y1 - y0 >= .01) out.push({ text, x0, y0, x1, y1 });
      }
    } catch {}
  }
  return out;
}

export function buildSampleTimes(duration: number, maxFrames = 12): number[] {
  const limit = Math.max(1, Math.floor(maxFrames));
  if (!Number.isFinite(duration) || duration <= .5) return [0];

  const intro = [.5, 1, 2, 3, 4, 5].filter((t) => t < duration).slice(0, limit);
  if (intro.length >= limit || duration <= 5) return intro;

  const remaining = limit - intro.length;
  const safeEnd = Math.max(5, duration - Math.min(.1, duration / 100));
  const tail = Array.from({ length: remaining }, (_, i) =>
    Number((5 + (safeEnd - 5) * ((i + 1) / remaining)).toFixed(6)));
  return [...new Set([...intro, ...tail])].sort((a, b) => a - b).slice(0, limit);
}

function normText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function boxArea(box: OcrBox): number {
  return Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
}

function boxIou(a: OcrBox, b: OcrBox): number {
  const intersection = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
    Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const union = boxArea(a) + boxArea(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

function verticalOverlap(a: OcrBox, b: OcrBox): number {
  const overlap = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return overlap / Math.max(.000001, Math.min(a.y1 - a.y0, b.y1 - b.y0));
}

function textSimilarity(a: string, b: string): number {
  const aa = normText(a);
  const bb = normText(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  const tokensA = new Set(aa.split(' '));
  const tokensB = new Set(bb.split(' '));
  const tokenIntersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  const tokenUnion = new Set([...tokensA, ...tokensB]).size;
  const tokenScore = tokenUnion ? tokenIntersection / tokenUnion : 0;
  const bigrams = (s: string) => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const bigramsA = bigrams(aa);
  const bigramsB = bigrams(bb);
  const shared = [...bigramsA].filter((pair) => bigramsB.has(pair)).length;
  const dice = bigramsA.size + bigramsB.size ? (2 * shared) / (bigramsA.size + bigramsB.size) : 0;
  return Math.max(tokenScore, dice);
}

function envelope(boxes: OcrBox[]): OcrBox {
  const x0 = Math.max(0, Math.min(...boxes.map((box) => box.x0)) - .02);
  const y0 = Math.max(0, Math.min(...boxes.map((box) => box.y0)) - .015);
  const x1 = Math.min(1, Math.max(...boxes.map((box) => box.x1)) + .02);
  const y1 = Math.min(1, Math.max(...boxes.map((box) => box.y1)) + .015);
  return { text: boxes.map((box) => box.text).join(' '), x0, y0, x1, y1 };
}

// Headline removal and subtitle censorship are deliberately independent. A clip
// can therefore retain a positive trim_start while also carrying later blur
// windows (the common social-video hybrid case).
export function classifyOcrFrames(frames: OcrFrame[], duration: number): ClipVerdict {
  const clean: ClipVerdict = { outcome: 'clean', trim_start: 0, mute_audio: false, subtitle_blur: [] };
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return clean;

  const usableCount = sorted.filter((frame) => !frame.error).length || sorted.length;
  const stableThreshold = Math.max(2, Math.ceil(usableCount * .6));
  const isStableSmall = (candidate: OcrBox) => {
    if (boxArea(candidate) >= .02) return false;
    let matches = 0;
    for (const frame of sorted) {
      if (frame.boxes.some((box) => boxArea(box) < .02 &&
        normText(box.text) === normText(candidate.text) && boxIou(box, candidate) >= .6)) matches++;
    }
    return matches >= stableThreshold;
  };
  const filtered = sorted.map((frame) => ({
    ...frame,
    boxes: frame.boxes.filter((box) => !isStableSmall(box)),
  }));

  let trimStart = 0;
  for (let frameIndex = 0; frameIndex < filtered.length; frameIndex++) {
    const frame = filtered[frameIndex];
    if (frame.t > COVER_MAX) break;
    for (const anchor of frame.boxes.filter((box) => boxArea(box) >= .04)) {
      const matchingIndexes: number[] = [];
      for (let i = frameIndex; i < filtered.length && filtered[i].t <= COVER_MAX; i++) {
        if (filtered[i].boxes.some((box) => textSimilarity(anchor.text, box.text) >= .5 && boxIou(anchor, box) >= .45)) {
          matchingIndexes.push(i);
        }
      }
      if (matchingIndexes.length < 2) continue;
      const lastIndex = matchingIndexes[matchingIndexes.length - 1];
      const absentIndex = filtered.findIndex((later, i) => i > lastIndex &&
        !later.boxes.some((box) => textSimilarity(anchor.text, box.text) >= .5 && boxIou(anchor, box) >= .45));
      if (absentIndex > lastIndex) {
        trimStart = Math.max(trimStart, (filtered[lastIndex].t + filtered[absentIndex].t) / 2);
      }
    }
  }

  const candidateFrames = filtered.map((frame) => ({
    ...frame,
    boxes: frame.t + 1e-9 >= trimStart
      ? frame.boxes.filter((box) => box.x1 - box.x0 >= .18 && box.y1 - box.y0 >= .025)
      : [],
  }));
  const selectedByFrame = candidateFrames.map((frame, frameIndex) => frame.boxes.filter((box) =>
    candidateFrames.some((other, otherIndex) => otherIndex !== frameIndex && other.boxes.some((otherBox) =>
      verticalOverlap(box, otherBox) >= .5 && normText(box.text) !== normText(otherBox.text)))));

  type Window = { start: number; end: number; region: OcrBox };
  const windows: Window[] = [];
  for (let i = 0; i < selectedByFrame.length; i++) {
    if (selectedByFrame[i].length === 0) continue;
    const start = i > 0 ? (filtered[i - 1].t + filtered[i].t) / 2 : 0;
    const end = i + 1 < filtered.length ? (filtered[i].t + filtered[i + 1].t) / 2 : duration;
    windows.push({ start: Math.max(trimStart, start), end: Math.min(duration, end), region: envelope(selectedByFrame[i]) });
  }

  const merged: Window[] = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.start < previous.end - 1e-6 && boxIou(previous.region, window.region) >= .6) {
      previous.end = Math.max(previous.end, window.end);
      previous.region = envelope([previous.region, window.region]);
    } else {
      merged.push({ ...window });
    }
  }
  const subtitleBlur = merged.map(({ start, end, region }) => ({
    x: region.x0,
    y: region.y0,
    w: region.x1 - region.x0,
    h: region.y1 - region.y0,
    start,
    end,
  }));
  if (subtitleBlur.length > 0) {
    return { outcome: 'subtitle', trim_start: trimStart, mute_audio: true, subtitle_blur: subtitleBlur };
  }
  if (trimStart > 0) {
    return { outcome: 'cover', trim_start: trimStart, mute_audio: false, subtitle_blur: [] };
  }
  return clean;
}

const COVER_MAX = 5.0;

// Pure: given per-frame detections (sorted by t) + clip duration → verdict.
export function classifyClip(frames: FrameDet[], duration: number): ClipVerdict {
  const clean: ClipVerdict = { outcome: 'clean', trim_start: 0, mute_audio: false, subtitle_blur: [] };
  const fs = [...frames].sort((a, b) => a.t - b.t);
  const withText = fs.filter((f) => f.present);
  if (withText.length === 0) return clean;

  const lastText = withText[withText.length - 1].t;
  const cleanAfter = fs.find((f) => !f.present && f.t > lastText);

  // COVER: text confined to the intro, and a later frame confirms it clears.
  if (lastText <= COVER_MAX && cleanAfter) {
    return { outcome: 'cover', trim_start: (lastText + cleanAfter.t) / 2, mute_audio: false, subtitle_blur: [] };
  }

  // SUBTITLE: build a blur window per detecting frame, merge overlaps into union regions.
  const gap = (i: number) => {
    const prev = i > 0 ? fs[i].t - fs[i - 1].t : (fs.length > 1 ? fs[1].t - fs[0].t : 2);
    const next = i < fs.length - 1 ? fs[i + 1].t - fs[i].t : prev;
    return Math.max(prev, next) / 2;
  };
  const allText = withText.length === fs.length;
  type W = { s: number; e: number; r: NonNullable<FrameDet['region']> };
  let wins: W[] = [];
  if (allText) {
    // Guard: a present frame may carry a null region (type permits it); localize only
    // if some frame gave a box. No box anywhere → still SUBTITLE + mute, just no blur.
    const r = withText.find((f) => f.region)?.region;
    // Subtitles in EVERY sampled frame → they span the whole clip. Emit the
    // {s:0,e:0} whole-clip sentinel (Rust ungates the blur for the entire render
    // clip) instead of {e:duration}: `duration` is a 20s default here, but the
    // narration render clip is often 30-50s, so a bounded window would leave the
    // tail un-blurred and leak captions. See ffmpeg.rs build_subtitle_blur_overlay.
    if (r) wins = [{ s: 0, e: 0, r }];
  } else {
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      if (!f.present || !f.region) continue;
      const d = gap(i);
      wins.push({ s: Math.max(0, f.t - d), e: Math.min(duration, f.t + d), r: f.region });
    }
    wins.sort((a, b) => a.s - b.s);
    const merged: W[] = [];
    for (const w of wins) {
      const last = merged[merged.length - 1];
      if (last && w.s <= last.e) {
        last.e = Math.max(last.e, w.e);
        last.r = { x0: Math.min(last.r.x0, w.r.x0), y0: Math.min(last.r.y0, w.r.y0),
                   x1: Math.max(last.r.x1, w.r.x1), y1: Math.max(last.r.y1, w.r.y1) };
      } else merged.push({ ...w });
    }
    wins = merged;
  }
  const subtitle_blur = wins.map((w) => ({
    x: w.r.x0, y: w.r.y0, w: w.r.x1 - w.r.x0, h: w.r.y1 - w.r.y0, start: w.s, end: w.e,
  }));
  return { outcome: 'subtitle', trim_start: 0, mute_audio: true, subtitle_blur };
}

// Ambil 1 frame di detik t → data URL base64 JPEG. Gagal → null.
function frameDataUrl(videoUrl: string, t: number): string | null {
  const tmp = path.join(os.tmpdir(), `subv_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  try {
    execFileSync(FFMPEG, ['-y', '-ss', String(t), '-i', videoUrl, '-frames:v', '1', '-vf', 'scale=512:-1', '-q:v', '5', tmp],
      { stdio: 'pipe', timeout: 30000 });
    const b64 = fs.readFileSync(tmp).toString('base64');
    return `data:image/jpeg;base64,${b64}`;
  } catch { return null; }
  finally { try { fs.rmSync(tmp); } catch {} }
}

const PROMPT =
  `Lihat frame video ini. Jawab HANYA JSON {"present":bool,"region":[x0,y0,x1,y1]|null,"why":"<=8 kata"}.\n` +
  `present=true HANYA jika ada subtitle transkrip UCAPAN yang di-burn-in (auto-caption gaya TikTok/CapCut, ` +
  `face-cam/PiP react). region = kotak NORMALISASI [0..1] (x0,y0=kiri-atas; x1,y1=kanan-bawah) yang membungkus teks itu.\n` +
  `present=false (region null) untuk: lower-third berita, logo channel, watermark, headline grafis, teks judul singkat, tanpa teks.`;

// Normalize a vision bbox to [0..1]. qwen3-vl IGNORES the prompt's "normalized"
// instruction and returns 0-1000 grid coords (observed e.g. [53,460,821,617]);
// detect that (any value >1) and rescale by 1000, then clamp to [0..1] and fix
// corner ordering. WITHOUT this, downstream w=x1-x0=768 reaches Rust, which
// clamps it to 1.0 and blurs the ENTIRE frame instead of just the subtitle band.
// ponytail: 1000-grid is the qwen3-vl convention; if the model is swapped for one
// that returns absolute pixels, clamp still bounds it (over-wide, not full-frame-safe) — revisit divisor then.
export function normalizeRegion(
  x0: number, y0: number, x1: number, y1: number,
): NonNullable<FrameDet['region']> {
  const s = Math.max(Math.abs(x0), Math.abs(y0), Math.abs(x1), Math.abs(y1)) > 1 ? 1000 : 1;
  const c = (n: number) => Math.min(1, Math.max(0, n / s));
  let [ax, ay, bx, by] = [c(x0), c(y0), c(x1), c(y1)];
  if (bx < ax) [ax, bx] = [bx, ax];
  if (by < ay) [ay, by] = [by, ay];
  return { x0: ax, y0: ay, x1: bx, y1: by };
}

// Parse respons vision satu frame. Tak ada JSON / ragu → present:false (aman).
export function parseVisionFrame(resp: string): { present: boolean; region: FrameDet['region'] } {
  const m = (resp || '').match(/\{[\s\S]*?\}/);
  if (!m) return { present: false, region: null };
  try {
    const o = JSON.parse(m[0]);
    if (o?.present !== true) return { present: false, region: null };
    const a = o.region;
    const region = Array.isArray(a) && a.length === 4 && a.every((n: any) => typeof n === 'number')
      ? normalizeRegion(a[0], a[1], a[2], a[3]) : null;
    return { present: true, region };
  } catch { return { present: false, region: null }; }
}

// Back-compat: legacy {"reject":bool} responses still classify as present.
export function classifyVisionText(resp: string): boolean {
  const p = parseVisionFrame(resp);
  if (p.present) return true;
  const m = (resp || '').match(/\{[\s\S]*?\}/);
  try { return !!m && JSON.parse(m[0]).reject === true; } catch { return false; }
}

const SAMPLE_TIMES = [1, 3, 5, 8, 12];

async function visionFrame(img: string): Promise<{ present: boolean; region: FrameDet['region'] }> {
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: MODEL, max_tokens: 80, temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: img } },
        ] }],
      }),
    });
    if (!resp.ok) return { present: false, region: null };
    const d: any = await resp.json();
    return parseVisionFrame(d?.choices?.[0]?.message?.content || '');
  } catch { return { present: false, region: null }; }
}

// Multi-frame subtitle analysis → verdict. Vision unavailable → CLEAN (never blocks).
export async function analyzeSubtitles(videoUrl: string, duration = 20): Promise<ClipVerdict> {
  const clean: ClipVerdict = { outcome: 'clean', trim_start: 0, mute_audio: false, subtitle_blur: [] };
  if (!KEY || !videoUrl) return clean;
  const times = SAMPLE_TIMES.filter((t) => t < duration || t <= 1);
  const frames: FrameDet[] = [];
  for (const t of times) {
    const img = frameDataUrl(videoUrl, t);
    if (!img) continue;                       // frame grab failed → skip (conservative)
    const { present, region } = await visionFrame(img);
    frames.push({ t, present, region });
  }
  if (frames.length === 0) return clean;       // no usable frame → don't block
  return classifyClip(frames, duration);
}

export async function hasReactionSubtitle(videoUrl: string): Promise<boolean> {
  return (await analyzeSubtitles(videoUrl)).outcome === 'subtitle';
}
