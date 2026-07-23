// Detect speech captions and intro headlines while preserving editorial
// lower-thirds. Missing or incomplete OCR evidence is an explicit failure.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { novitaKey } from './env.ts';
import type { OcrAnalysis } from './ocr_contract.ts';
import {
  DEFAULT_OCR_MODEL,
  OCR_ANALYZER_VERSION,
  OCR_SCHEMA_VERSION,
} from './ocr_contract.ts';
import { outPath } from './paths.ts';

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
export type OcrAnalysisDeps = {
  env?: Record<string, string | undefined>;
  now?: () => Date;
  probeDuration?: (video: string) => number;
  frameDataUrl?: (video: string, t: number) => string | null;
  ocrFrame?: (image: string) => Promise<{ boxes: OcrBox[]; error?: string }>;
  retryCount?: number;
  appendDiagnostics?: (record: unknown) => void;
};

export function mainDirectiveFields(verdict: ClipVerdict): Pick<ClipVerdict, 'trim_start' | 'mute_audio' | 'subtitle_blur'> {
  return {
    trim_start: verdict.trim_start > 0 ? verdict.trim_start : 0,
    mute_audio: verdict.outcome === 'subtitle',
    subtitle_blur: verdict.outcome === 'subtitle' ? verdict.subtitle_blur : [],
  };
}

export function hashVideoId(videoUrl: string): string {
  return createHash('sha256').update(videoUrl || '').digest('hex').slice(0, 16);
}

export function parseDuration(value: string): number {
  const parsed = Number.parseFloat((value || '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function fetchJsonWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = 20_000,
  fetchImpl: typeof fetch = fetch,
): Promise<{ response: Response; data: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`request exceeded ${timeoutMs}ms`);
      error.name = 'TimeoutError';
      reject(error);
      controller.abort();
    }, Math.max(1, timeoutMs));
  });
  try {
    const requestAndBody = (async () => {
      const response = await fetchImpl(input, { ...init, signal: controller.signal });
      const data = response.ok ? await response.json() : null;
      return { response, data };
    })();
    return await Promise.race([
      requestAndBody,
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function parseOcrResponseContent(content: unknown): { boxes: OcrBox[]; error?: string } {
  if (typeof content !== 'string') return { boxes: [], error: 'malformed_content' };
  const boxes = parseDeepSeekOcr(content);
  if (content.trim() && boxes.length === 0) return { boxes: [], error: 'malformed_content' };
  return { boxes };
}

// DeepSeek-OCR returns one or more 0..1000 grounding boxes for every ref block.
// Keep parsing fail-open: malformed fragments are ignored without discarding valid
// pairs elsewhere in the response.
export function parseDeepSeekOcr(content: string): OcrBox[] {
  const out: OcrBox[] = [];
  const append = (rawText: string, encodedBoxes: string) => {
    const text = rawText.replace(/\s+/g, ' ').trim();
    const boxes = JSON.parse(encodedBoxes);
    if (!text || !Array.isArray(boxes)) return;
    for (const raw of boxes) {
      if (!Array.isArray(raw) || raw.length !== 4 || raw.some((n) => typeof n !== 'number' || !Number.isFinite(n))) continue;
      const scale = Math.max(...raw.map((n: number) => Math.abs(n))) > 1 ? 1000 : 1;
      const clamp = (n: number) => Math.min(1, Math.max(0, n / scale));
      let [x0, y0, x1, y1] = raw.map(clamp);
      if (x1 < x0) [x0, x1] = [x1, x0];
      if (y1 < y0) [y0, y1] = [y1, y0];
      if (x1 - x0 >= .01 && y1 - y0 >= .01) out.push({ text, x0, y0, x1, y1 });
    }
  };
  const pair = /<\|ref\|>([\s\S]*?)<\|\/ref\|>\s*<\|det\|>(\[\[[\s\S]*?\]\])<\|\/det\|>/g;
  for (const match of (content || '').matchAll(pair)) {
    try { append(match[1], match[2]); } catch {}
  }
  // Novita currently strips DeepSeek's <|ref|>/<|det|> markers from message
  // content, leaving one `recognized text[[x0,y0,x1,y1]]` payload per line.
  if (out.length === 0) {
    const plainPair = /^\s*(.*?)\s*(\[\[\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\]\])\s*$/gm;
    for (const match of (content || '').matchAll(plainPair)) {
      try { append(match[1], match[2]); } catch {}
    }
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

function horizontalOverlap(a: OcrBox, b: OcrBox): number {
  const overlap = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  return overlap / Math.max(.000001, Math.min(a.x1 - a.x0, b.x1 - b.x0));
}

function hasMultilineLayout(boxes: OcrBox[]): boolean {
  return boxes.some((box, index) => boxes.some((other, otherIndex) => {
    if (index === otherIndex) return false;
    const gap = Math.max(0, Math.max(box.y0, other.y0) - Math.min(box.y1, other.y1));
    return gap <= .07 && horizontalOverlap(box, other) >= .3;
  }));
}

function isEditorialLabel(text: string): boolean {
  return /^(breaking news|live(?: news)?|exclusive|news(?: update)?|sports|weather|headlines?)$/.test(normText(text));
}

function isLikelyLowerThird(
  box: OcrBox,
  frameIndex: number,
  frames: OcrFrame[],
  editorialLabels: OcrBox[],
): boolean {
  if (box.y0 < .65 || box.x0 > .3) return false;

  // A changing left-aligned caption is ambiguous by itself. Treat it as an
  // editorial lower-third only when a separate, persistent label anchors the
  // same band (for example a stable "LIVE NEWS" badge beside a changing chyron).
  const boxCenterY = (box.y0 + box.y1) / 2;
  const hasCompanionLabel = editorialLabels.some((label) => {
    const labelCenterY = (label.y0 + label.y1) / 2;
    return normText(label.text) !== normText(box.text) &&
      Math.abs(labelCenterY - boxCenterY) <= .12 &&
      label.x0 < box.x0 - .03 &&
      boxIou(label, box) < .2;
  });
  if (!hasCompanionLabel) return false;

  const track = frames.flatMap((frame, index) => frame.boxes
    .filter((other) => verticalOverlap(box, other) >= .5 && Math.abs(other.x0 - box.x0) <= .04)
    .map((other) => ({ index, box: other })));
  const frameCount = new Set(track.map((match) => match.index)).size;
  if (frameCount < 2) return false;

  const lefts = track.map((match) => match.box.x0);
  return Math.max(...lefts) - Math.min(...lefts) <= .035 &&
    track.some((match) => match.index !== frameIndex && normText(match.box.text) !== normText(box.text));
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

function unionEnvelope(a: OcrBox, b: OcrBox): OcrBox {
  return {
    text: `${a.text} ${b.text}`.trim(),
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

// Headline removal and subtitle censorship are deliberately independent. A clip
// can therefore retain a positive trim_start while also carrying later blur
// windows (the common social-video hybrid case).
export function classifyOcrFrames(frames: OcrFrame[], duration: number): ClipVerdict {
  const clean: ClipVerdict = { outcome: 'clean', trim_start: 0, mute_audio: false, subtitle_blur: [] };
  // Failed samples are unknown, not clean. Excluding them prevents an HTTP/frame
  // error from becoming false evidence that a headline disappeared.
  const sorted = frames.filter((frame) => !frame.error).sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return clean;

  const usableCount = sorted.length;
  const stableThreshold = Math.max(2, Math.ceil(usableCount * .6));
  const editorialLabels = sorted.flatMap((frame) => frame.boxes).filter((candidate, candidateIndex, all) => {
    if (!isEditorialLabel(candidate.text) || candidate.y0 < .65 || boxArea(candidate) >= .02) return false;
    const matches = sorted.filter((frame) => frame.boxes.some((box) =>
      isEditorialLabel(box.text) && normText(box.text) === normText(candidate.text) && boxIou(box, candidate) >= .6));
    return matches.length >= stableThreshold &&
      all.findIndex((box) => normText(box.text) === normText(candidate.text) && boxIou(box, candidate) >= .6) === candidateIndex;
  });
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
    // Headlines are often emitted one line at a time: visually dominant width,
    // but only ~1.5-2% frame area because the box is thin.
    for (const anchor of frame.boxes.filter((box) =>
      boxArea(box) >= .015 && box.x1 - box.x0 >= .45)) {
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

  const rawCandidateFrames = filtered.map((frame) => ({
    ...frame,
    boxes: frame.t + 1e-9 >= trimStart
      ? frame.boxes.filter((box) => box.x1 - box.x0 >= .18 && box.y1 - box.y0 >= .025)
      : [],
  }));
  const candidateFrames = rawCandidateFrames.map((frame, frameIndex) => ({
    ...frame,
    boxes: frame.boxes.filter((box) => !isLikelyLowerThird(box, frameIndex, rawCandidateFrames, editorialLabels)),
  }));
  const multilineFrames = candidateFrames.map((frame) => hasMultilineLayout(frame.boxes));
  const selectedByFrame = candidateFrames.map((frame, frameIndex) => frame.boxes.filter((box) =>
    candidateFrames.some((other, otherIndex) => otherIndex !== frameIndex && other.boxes.some((otherBox) =>
      verticalOverlap(box, otherBox) >= .5 && normText(box.text) !== normText(otherBox.text))) ||
    (multilineFrames[frameIndex] && candidateFrames.some((other, otherIndex) =>
      otherIndex !== frameIndex && multilineFrames[otherIndex] && other.boxes.some((otherBox) =>
        verticalOverlap(box, otherBox) >= .5)))));

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
    const sameTrack = previous && (
      boxIou(previous.region, window.region) >= .6 ||
      verticalOverlap(previous.region, window.region) >= .5 &&
        horizontalOverlap(previous.region, window.region) >= .5
    );
    if (previous && window.start <= previous.end + 1e-6 && sameTrack) {
      previous.end = Math.max(previous.end, window.end);
      previous.region = unionEnvelope(previous.region, window.region);
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

export type ClassifiedOcrDiagnostic = {
  t: number;
  headline_boxes: OcrBox[];
  subtitle_boxes: OcrBox[];
};

export function buildClassifiedDiagnostics(
  frames: OcrFrame[],
  verdict: ClipVerdict,
): ClassifiedOcrDiagnostic[] {
  return frames.map((frame) => {
    if (frame.error) return { t: frame.t, headline_boxes: [], subtitle_boxes: [] };
    const headline_boxes = verdict.trim_start > 0 && frame.t < verdict.trim_start
      ? frame.boxes.filter((box) => boxArea(box) >= .015 && box.x1 - box.x0 >= .45)
      : [];
    const subtitle_boxes = frame.boxes.filter((box) => {
      const centerX = (box.x0 + box.x1) / 2;
      const centerY = (box.y0 + box.y1) / 2;
      return verdict.subtitle_blur.some((region) => {
        const active = region.start === 0 && region.end === 0 ||
          frame.t >= (region.start ?? 0) - 1e-6 && frame.t <= (region.end ?? 0) + 1e-6;
        return active && centerX >= region.x && centerX <= region.x + region.w &&
          centerY >= region.y && centerY <= region.y + region.h;
      });
    });
    return { t: frame.t, headline_boxes, subtitle_boxes };
  });
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
function frameDataUrl(videoUrl: string, t: number, env: Record<string, string | undefined>): string | null {
  const ffmpeg = env.THOTH_FFMPEG || path.join(import.meta.dirname, '..', '..', 'ffmpeg.exe');
  const tmp = path.join(os.tmpdir(), `subv_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  try {
    execFileSync(ffmpeg, ['-y', '-ss', String(t), '-i', videoUrl, '-frames:v', '1', '-vf', 'scale=960:-1', '-q:v', '4', tmp],
      { stdio: 'pipe', timeout: 30000 });
    const b64 = fs.readFileSync(tmp).toString('base64');
    return `data:image/jpeg;base64,${b64}`;
  } catch { return null; }
  finally { try { fs.rmSync(tmp); } catch {} }
}

// Normalize a legacy vision bbox to [0..1]. The previous adapter returned a
// 0..1000 grid even when asked for normalized coordinates; retain this parser
// only for backwards-compatible pure callers. Live bbox detection uses DeepSeek.
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

async function ocrFrame(
  img: string,
  apiKey: string,
  model: string,
  env: Record<string, string | undefined>,
): Promise<{ boxes: OcrBox[]; error?: string }> {
  try {
    const configuredTimeout = Number.parseInt(env.THOTH_SUBTITLE_OCR_TIMEOUT_MS || '20000', 10);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 20_000;
    const { response: resp, data } = await fetchJsonWithTimeout('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, max_tokens: 4096, temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'text', text: '<|grounding|>OCR this image.' },
          { type: 'image_url', image_url: { url: img, detail: 'high' } },
        ] }],
      }),
    }, timeoutMs);
    if (!resp.ok) return { boxes: [], error: `http_${resp.status}` };
    const d: any = data;
    const content = d?.choices?.[0]?.message?.content;
    return parseOcrResponseContent(content);
  } catch (error) {
    return { boxes: [], error: error instanceof Error ? error.name : 'unknown_error' };
  }
}

function probeDuration(videoUrl: string, env: Record<string, string | undefined>): number {
  const ffmpeg = env.THOTH_FFMPEG || path.join(import.meta.dirname, '..', '..', 'ffmpeg.exe');
  const ffprobe = env.THOTH_FFPROBE || path.join(path.dirname(ffmpeg), 'ffprobe.exe');
  try {
    const raw = execFileSync(ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoUrl,
    ], { encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
    return parseDuration(raw);
  } catch {
    return 0;
  }
}

function appendDiagnostics(record: unknown): void {
  try {
    fs.appendFileSync(outPath('subtitle_ocr_debug.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  } catch {}
}

// Multi-frame OCR analysis produces independent trim + blur actions. Runtime
// failures remain explicit below; they are never converted into clean evidence.
function safeErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case 'missing_video_path': return 'Video path is required';
    case 'missing_api_key': return 'OCR API key is not configured';
    case 'duration_probe_failed': return 'Video duration could not be determined';
    case 'incomplete_frame_coverage': return 'OCR did not analyze every scheduled frame';
    default: return 'OCR analysis failed';
  }
}

function resultBase(
  status: OcrAnalysis['ocr_status'],
  model: string,
  analyzedAt: string,
  requestedFrames: number,
  validFrames: number,
): Omit<OcrAnalysis, 'verdict' | 'error_code' | 'error_message'> {
  return {
    schema_version: OCR_SCHEMA_VERSION,
    ocr_status: status,
    provider: 'novita',
    model,
    analyzer_version: OCR_ANALYZER_VERSION,
    requested_frames: requestedFrames,
    valid_frames: validFrames,
    analyzed_at: analyzedAt,
  };
}

function appendAnalysisDiagnostics(
  videoUrl: string,
  duration: number,
  analysis: OcrAnalysis,
  frames: OcrFrame[] = [],
  writeDiagnostics: (record: unknown) => void = appendDiagnostics,
  retryCounts = { configured: 0, actual: 0 },
): void {
  const classified = analysis.verdict
    ? buildClassifiedDiagnostics(frames, analysis.verdict)
    : frames.map((frame) => ({ t: frame.t, headline_boxes: [], subtitle_boxes: [] }));
  writeDiagnostics({
    schema_version: analysis.schema_version,
    ocr_status: analysis.ocr_status,
    provider: analysis.provider,
    model: analysis.model,
    analyzer_version: analysis.analyzer_version,
    analyzed_at: analysis.analyzed_at,
    video_id: hashVideoId(videoUrl),
    duration,
    requested_frames: analysis.requested_frames,
    valid_frames: analysis.valid_frames,
    configured_retry_count: retryCounts.configured,
    actual_retry_count: retryCounts.actual,
    samples: frames.map(({ t, boxes, error }, index) => ({
      t,
      boxes,
      headline_boxes: classified[index].headline_boxes,
      subtitle_boxes: classified[index].subtitle_boxes,
      ...(error ? { error } : {}),
    })),
    ...(analysis.verdict ? { verdict: analysis.verdict } : {}),
    ...(analysis.error_code ? {
      error_code: analysis.error_code,
      error_message: analysis.error_message,
    } : {}),
  });
}

function failedAnalysis(
  videoUrl: string,
  duration: number,
  model: string,
  analyzedAt: string,
  errorCode: string,
  requestedFrames = 0,
  validFrames = 0,
  frames: OcrFrame[] = [],
  writeDiagnostics: (record: unknown) => void = appendDiagnostics,
  retryCounts = { configured: 0, actual: 0 },
): OcrAnalysis {
  const result: OcrAnalysis = {
    ...resultBase('failed', model, analyzedAt, requestedFrames, validFrames),
    error_code: errorCode,
    error_message: safeErrorMessage(errorCode),
  };
  appendAnalysisDiagnostics(videoUrl, duration, result, frames, writeDiagnostics, retryCounts);
  return result;
}

function safeFrameErrorCode(error: unknown): string {
  const raw = error instanceof Error
    ? error.name
    : typeof error === 'string'
      ? error
      : '';
  if (/^http_\d{3}$/i.test(raw)) return 'http_error';
  switch (raw.toLowerCase()) {
    case 'malformed_content': return 'malformed_content';
    case 'timeouterror':
    case 'timeout': return 'timeout';
    case 'aborterror':
    case 'request_aborted': return 'request_aborted';
    case 'frame_extract': return 'frame_extract';
    default: return 'ocr_request_failed';
  }
}

// Multi-frame OCR analysis. Missing configuration, extraction failures, and
// incomplete model coverage are explicit failures; only complete coverage may
// produce a clean verdict.
export async function analyzeSubtitlesDetailed(
  videoUrl: string,
  duration = 0,
  deps: OcrAnalysisDeps = {},
): Promise<OcrAnalysis> {
  const env = deps.env ?? process.env;
  const writeDiagnostics = deps.appendDiagnostics ?? appendDiagnostics;
  const analyzedAt = (deps.now ?? (() => new Date()))().toISOString();
  const model = env.THOTH_SUBTITLE_OCR_MODEL?.trim() || DEFAULT_OCR_MODEL;
  const apiKey = deps.env
    ? env.THOTH_NOVITA_API_KEY?.trim() || ''
    : novitaKey();
  const retryCount = Number.isFinite(deps.retryCount) && deps.retryCount! >= 0
    ? Math.floor(deps.retryCount!)
    : 2;

  if (!videoUrl) {
    return failedAnalysis(
      videoUrl,
      duration,
      model,
      analyzedAt,
      'missing_video_path',
      0,
      0,
      [],
      writeDiagnostics,
      { configured: retryCount, actual: 0 },
    );
  }
  if (!apiKey) {
    return failedAnalysis(
      videoUrl,
      duration,
      model,
      analyzedAt,
      'missing_api_key',
      0,
      0,
      [],
      writeDiagnostics,
      { configured: retryCount, actual: 0 },
    );
  }

  const resolvedDuration = duration > 0
    ? duration
    : (deps.probeDuration ?? ((video) => probeDuration(video, env)))(videoUrl);
  if (!Number.isFinite(resolvedDuration) || resolvedDuration <= 0) {
    return failedAnalysis(
      videoUrl,
      duration,
      model,
      analyzedAt,
      'duration_probe_failed',
      0,
      0,
      [],
      writeDiagnostics,
      { configured: retryCount, actual: 0 },
    );
  }

  const configuredMax = Number.parseInt(env.THOTH_SUBTITLE_OCR_MAX_FRAMES || '12', 10);
  const maxFrames = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 12;
  const times = buildSampleTimes(resolvedDuration, maxFrames);
  const extractFrame = deps.frameDataUrl ?? ((video, t) => frameDataUrl(video, t, env));
  const analyzeFrame = deps.ocrFrame ?? ((image) => ocrFrame(image, apiKey, model, env));
  const frames: OcrFrame[] = [];
  let actualRetryCount = 0;

  for (const t of times) {
    let image: string | null;
    try {
      image = extractFrame(videoUrl, t);
    } catch {
      image = null;
    }
    if (!image) {
      frames.push({ t, boxes: [], error: 'frame_extract' });
      continue;
    }
    let frameResult: { boxes: OcrBox[]; error?: string } = { boxes: [], error: 'ocr_failed' };
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      if (attempt > 0) actualRetryCount++;
      try {
        const response = await analyzeFrame(image);
        frameResult = response.error
          ? { boxes: [], error: safeFrameErrorCode(response.error) }
          : response;
      } catch (error) {
        frameResult = {
          boxes: [],
          error: safeFrameErrorCode(error),
        };
      }
      if (!frameResult.error) break;
    }
    frames.push({ t, ...frameResult });
  }

  const validFrames = frames.filter((frame) => !frame.error).length;
  if (validFrames !== times.length) {
    return failedAnalysis(
      videoUrl,
      resolvedDuration,
      model,
      analyzedAt,
      'incomplete_frame_coverage',
      times.length,
      validFrames,
      frames,
      writeDiagnostics,
      { configured: retryCount, actual: actualRetryCount },
    );
  }

  const verdict = classifyOcrFrames(frames, resolvedDuration);
  const result: OcrAnalysis = {
    ...resultBase('analyzed', model, analyzedAt, times.length, validFrames),
    verdict,
  };
  appendAnalysisDiagnostics(
    videoUrl,
    resolvedDuration,
    result,
    frames,
    writeDiagnostics,
    { configured: retryCount, actual: actualRetryCount },
  );
  return result;
}

export class OcrAnalysisError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`OCR analysis failed (${code}): ${message}`);
    this.name = 'OcrAnalysisError';
    this.code = code;
  }
}

export async function analyzeSubtitles(
  videoUrl: string,
  duration = 0,
  deps: OcrAnalysisDeps = {},
): Promise<ClipVerdict> {
  const analysis = await analyzeSubtitlesDetailed(videoUrl, duration, deps);
  if (analysis.ocr_status !== 'analyzed' || !analysis.verdict) {
    throw new OcrAnalysisError(
      analysis.error_code || 'unknown_failure',
      analysis.error_message || safeErrorMessage('unknown_failure'),
    );
  }
  return analysis.verdict;
}

export async function hasReactionSubtitle(videoUrl: string): Promise<boolean> {
  return (await analyzeSubtitles(videoUrl)).outcome === 'subtitle';
}
