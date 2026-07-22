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

const PROMPT =
  `Lihat frame video ini. Jawab HANYA JSON {"reject":bool,"why":"<=8 kata"}.\n` +
  `reject=true HANYA jika ada: (a) subtitle transkrip UCAPAN yang di-burn-in (auto-caption gaya TikTok/CapCut, ` +
  `teks kata-per-kata mengikuti omongan), ATAU (b) overlay REACT — wajah orang/webcam menimpa klip (face-cam/PiP), reupload react.\n` +
  `reject=false untuk: lower-third berita, logo channel, watermark, headline grafis, teks judul singkat, tanpa teks.`;

// Parse respons vision → true bila BUANG. Tak ada JSON / ragu → false (aman).
export function classifyVisionText(resp: string): boolean {
  const m = (resp || '').match(/\{[\s\S]*?\}/);
  if (!m) return false;
  try { return JSON.parse(m[0]).reject === true; } catch { return false; }
}

export type SubtitleRegion = { x: number; y: number; w: number; h: number; start?: number; end?: number };
export type FrameDet = { t: number; present: boolean; region: { x0: number; y0: number; x1: number; y1: number } | null };
export type ClipVerdict = { outcome: 'clean' | 'cover' | 'subtitle'; trim_start: number; mute_audio: boolean; subtitle_blur: SubtitleRegion[] };

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
    if (r) wins = [{ s: 0, e: duration, r }];
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

// Ambil 1 frame tengah → data URL base64 JPEG. Gagal → null.
function midFrameDataUrl(videoUrl: string): string | null {
  const tmp = path.join(os.tmpdir(), `subv_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  try {
    // -ss 50% via -sseof tak andal untuk stream; pakai -ss di ~3s (cukup untuk lihat caption yg muncul).
    execFileSync(FFMPEG, ['-y', '-ss', '3', '-i', videoUrl, '-frames:v', '1', '-vf', 'scale=512:-1', '-q:v', '5', tmp],
      { stdio: 'pipe', timeout: 30000 });
    const b64 = fs.readFileSync(tmp).toString('base64');
    return `data:image/jpeg;base64,${b64}`;
  } catch { return null; }
  finally { try { fs.rmSync(tmp); } catch {} }
}

export async function hasReactionSubtitle(videoUrl: string): Promise<boolean> {
  if (!KEY || !videoUrl) return false;
  const img = midFrameDataUrl(videoUrl);
  if (!img) return false; // frame gagal → jangan buang (fallback text-gate)
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: MODEL, max_tokens: 60, temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: img } },
        ] }],
      }),
    });
    if (!resp.ok) return false;
    const d: any = await resp.json();
    return classifyVisionText(d?.choices?.[0]?.message?.content || '');
  } catch { return false; }
}
