// vision_crop.js — isolate ONE social post from a screenshot into a clean card PNG.
//
// This is the reusable tool behind content-sourcing/SKILL.md → "Postingan Non-Video →
// Screenshot + Vision Crop": for is_video:false entries (tweet text, IG photo, FB status,
// article) yt-dlp can't download, so scout prepares the visual. Feed a raw screenshot;
// get back a tight crop suitable for `image_path`.
//
// Replaces the old vision_pipeline.js (which had a dead hardcoded key + was pinned to a
// leftover dev screenshot). Key is read from THOTH_NOVITA_API_KEY (.env root via lib/env.js) — never hardcoded.
//
//   node vision_crop.js <input.png> [output.png] [--w 1200]
//
// Exit 0 = crop written; 2 = obstructed/low-confidence (retry screenshot); 1 = error.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { cropPath } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';

const FFMPEG = process.env.THOTH_FFMPEG || 'C:\\Users\\mfr\\Documents\\MyTools\\CLIPPER\\ffmpeg.exe';
import * as env from '../lib/env.ts';
// Override with env THOTH_VISION_MODEL — a larger qwen3-vl (e.g. qwen/qwen3-vl-235b-a22b-instruct)
// isolates posts far better. (8b deprecated di Novita 2026-07 → default 30b-a3b.)
const VISION_MODEL = process.env.THOTH_VISION_MODEL || 'qwen/qwen3-vl-30b-a3b-instruct';

function novitaKey() {
  const k = env.novitaKey();
  if (!k) throw new Error(`THOTH_NOVITA_API_KEY kosong — isi di ${env.ENV_FILE}`);
  return k;
}

// Read PNG dimensions from the IHDR chunk (bytes 16..24).
function pngSize(file) {
  const b = fs.readFileSync(file).subarray(16, 24);
  return { w: b.readUInt32BE(0), h: b.readUInt32BE(4) };
}

const CROP_PROMPT = (W, H) => `Kamu adalah analis layout presisi. Gambar ini screenshot SATU postingan media sosial
(Twitter/X, Instagram, Facebook, atau artikel berita) berukuran ${W}x${H} piksel.

TUGAS: tentukan satu bounding box yang meng-crop HANYA postingan UTAMA, supaya hasilnya
jadi kartu visual yang BERSIH dan terbaca untuk video short vertikal.

WAJIB ADA DI DALAM BOX: header penulis (foto profil + nama + @handle), seluruh teks isi
postingan (jangan terpotong), media yang menyatu (foto/thumbnail/quote di dalamnya),
timestamp, dan baris metrik (like/retweet/komentar/views) milik postingan ini.

WAJIB DI LUAR BOX: bilah browser/OS, navigasi atas situs & search bar, sidebar kiri/kanan
(Trending, "Who to follow", iklan), kotak tulis balasan ("Post your reply"), balasan &
postingan LAIN, rail rekomendasi ("More Tweets", "Suggested"), banner cookie/consent,
modal/overlay login, footer, dan whitespace berlebih.

ATURAN: crop rapat (padding ~10-15px), jangan motong teks/avatar/gambar, jangan bawa
potongan postingan tetangga. Kalau ada overlay yang menutupi sebagian postingan, set
"obstructed": true dan tetap beri box terbaik. Koordinat PIKSEL gambar ${W}x${H};
(x1,y1)=kiri-atas, (x2,y2)=kanan-bawah, integer, WAJIB x2>x1 dan y2>y1.

Keluarkan HANYA JSON valid persis format ini:
{"box":[x1,y1,x2,y2],"post":{"author":"","handle":"","text":"","has_media":true},"obstructed":false,"confidence":0.0,"notes":""}`;

async function main() {
  const argv = process.argv.slice(2);
  const flags: any = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--w') flags.w = parseInt(argv[++i], 10);
    else pos.push(argv[i]);
  }
  const input = pos[0];
  if (!input) {
    console.log('Usage: node vision_crop.ts <input.png> [output.png] [--w 1200]');
    process.exit(1);
  }
  if (!fs.existsSync(input)) throw new Error(`Input tidak ada: ${input}`);
  const visionW = flags.w || 1200;
  // Default crop lands in output/crops/ (keeps the workspace root clean); an explicit
  // second arg overrides.
  const output = pos[1] || cropPath(path.basename(input).replace(/\.png$/i, '') + '_crop.png');

  // 1. Resize for the vision API (fixed width, keep ratio).
  const dir = path.dirname(path.resolve(output));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const resized = path.join(dir, '_vc_resized.png');
  execSync(`"${FFMPEG}" -i "${input}" -vf "scale=${visionW}:-1" -update 1 -y "${resized}"`, { stdio: 'pipe', timeout: 15000 });
  const sent = pngSize(resized);
  console.log(`[1/3] Resized → ${sent.w}x${sent.h} (vision space)`);

  // 2. Vision: get the bounding box that isolates the main post.
  const b64 = fs.readFileSync(resized).toString('base64');
  console.log(`[2/3] Vision (${VISION_MODEL})…`);
  const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + novitaKey() },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: CROP_PROMPT(sent.w, sent.h) },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
        ],
      }],
      max_tokens: 700,
      temperature: 0.05,
    }),
  });
  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Vision tak balas JSON. Raw: ' + raw.slice(0, 200));
  const det = JSON.parse(m[0]);
  const box = det.box;
  if (!Array.isArray(box) || box.length !== 4) throw new Error('box tidak valid: ' + JSON.stringify(box));

  // 3. Scale box back to ORIGINAL resolution and crop.
  const orig = pngSize(input);
  const sx = orig.w / sent.w, sy = orig.h / sent.h;
  let x1 = Math.max(0, Math.round(box[0] * sx));
  let y1 = Math.max(0, Math.round(box[1] * sy));
  let x2 = Math.min(orig.w, Math.round(box[2] * sx));
  let y2 = Math.min(orig.h, Math.round(box[3] * sy));
  const w = x2 - x1, h = y2 - y1;
  if (w < 20 || h < 20) throw new Error(`box terlalu kecil setelah scale-back (${w}x${h}).`);

  execSync(`"${FFMPEG}" -i "${input}" -vf "crop=${w}:${h}:${x1}:${y1}" -update 1 -y "${output}"`, { stdio: 'pipe', timeout: 15000 });
  try { fs.unlinkSync(resized); } catch (_) {}

  const kb = (fs.statSync(output).size / 1024).toFixed(1);
  console.log(`[3/3] Crop → ${path.basename(output)} (${w}x${h}, ${kb} KB)`);
  if (det.post) console.log(`      post: @${det.post.handle || '?'} — "${String(det.post.text || '').slice(0, 60)}"`);
  console.log('image_path:', path.resolve(output));

  if (det.obstructed || (typeof det.confidence === 'number' && det.confidence < 0.5)) {
    console.log(ui.amber(`${ui.WARN}  obstructed / confidence rendah — pertimbangkan screenshot ulang (tutup overlay) sebelum dipakai.`));
    process.exitCode = 2;
  }
}

// process.exitCode (not process.exit) so the fetch socket drains — avoids the Node 24
// /Windows libuv "UV_HANDLE_CLOSING" assertion on abrupt exit after fetch.
main().catch(e => { console.error(ui.red(`${ui.ERR} ${e.message}`)); process.exitCode = 1; });
