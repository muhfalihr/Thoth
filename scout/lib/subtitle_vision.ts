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
