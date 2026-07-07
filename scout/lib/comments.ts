// comments.js — shared TikTok comment detection: the vision prompt + Novita call + parse.
//
// Used by crop_comment_pipeline.js (screenshot → per-comment crops + content-set) and
// batch_pipeline.js (data only). One prompt = consistent extraction everywhere.
//
// The prompt isolates ONE top-level comment block per box — avatar + username + full text
// + meta row (time / Reply) + the like column (heart + count) + the "View N replies" line —
// and EXCLUDES neighbouring comments, indented replies, the video, nav, and the compose box.

import fs from 'node:fs';

const VISION_MODEL = process.env.THOTH_VISION_MODEL || 'qwen/qwen3-vl-30b-a3b-instruct'; // konsisten dgn cropper lain (8b deprecated Novita 2026-07)

// W x H = pixel dimensions of the image actually sent (after resize).
function commentPrompt(W, H) {
  return `Kamu analis layout presisi. Gambar ini screenshot TikTok berukuran ${W}x${H} piksel.
Kolom komentar ada di SISI KANAN layar (di kiri ada video/pemutar — ABAIKAN).

TUGAS: temukan SETIAP komentar TINGKAT-ATAS (top-level) yang terlihat di kolom komentar.
Untuk TIAP komentar, beri satu bounding box RAPAT yang mencakup PERSIS SATU blok komentar utuh.

SATU BLOK KOMENTAR — WAJIB ADA DI DALAM box (urut atas→bawah):
- Foto profil (avatar) bulat di kiri komentar
- Nama pengguna / username (baris tebal di atas)
- SELURUH teks komentar (jangan terpotong walau 2-3 baris, termasuk emoji)
- Baris metadata: waktu (mis. "6d ago", "2h") + tombol "Reply"/"Balas"
- Kolom SUKA di KANAN komentar: ikon hati + jumlah like (mis. "109", "1.2K")
- Baris "View N replies" / "Lihat N balasan" HANYA jika menempel langsung di komentar itu

WAJIB DI LUAR box (jangan ikut terbawa):
- Komentar LAIN di atas/bawahnya — JANGAN gabungkan dua komentar dalam satu box
- BALASAN yang menjorok (indent) setelah "View replies" — ambil komentar INDUK saja
- Area video/pemutar & tombol like/share video di kiri, header, kotak pencarian, navigasi
- Kotak "Add comment" / "Tambahkan komentar" di bagian bawah
- Sidebar, iklan, dan ruang kosong (whitespace) berlebih

ATURAN BOX:
- Lebar box = dari tepi KIRI avatar sampai tepi KANAN angka like (komentar selebar penuh).
- Tinggi box = dari atas avatar/username sampai bawah baris metadata/replies komentar itu.
- Padding tipis ~8-12px saja, jangan lebih. JANGAN memotong teks, avatar, atau angka.
- Koordinat PIKSEL gambar ${W}x${H}. (x1,y1)=kiri-atas, (x2,y2)=kanan-bawah. Integer, x2>x1, y2>y1.

Untuk TIAP komentar keluarkan field:
- "user": username (tanpa @ jika bisa)
- "text": teks komentar PERSIS apa adanya
- "likes": ANGKA integer (ubah "1.2K"->1200, "3.4M"->3400000; kosong/tak terlihat->0)
- "box": [x1,y1,x2,y2]

Keluarkan HANYA JSON array valid, tanpa teks/penjelasan lain:
[{"user":"","text":"","likes":0,"box":[x1,y1,x2,y2]}]`;
}

// Parse "1.2K" / "3,4rb" / 109 / "1.2 jt" / "3,261" / "3.261" → integer.
//
// The separator means different things depending on whether a magnitude suffix is present:
//   • WITH suffix (k/rb=×1e3, m/jt=×1e6) → the number is a DECIMAL multiplier, so ',' and '.'
//     are decimal points: "1,2K"=1200, "32.4K"=32400, "1.2 jt"=1_200_000.
//   • WITHOUT suffix → it's a full integer with GROUPING separators, so ',' and '.' are thousands
//     separators to be dropped: "3,261"=3261, "3.261"=3261, "1.234.567"=1234567, "409"=409.
// (The old code blanket-replaced ',' with '.' and treated everything as decimal, so "3.261" became
//  3 — wrecking ranking of view/like counts shown as plain thousands.)
function normalizeLikes(v) {
  if (typeof v === 'number') return Math.max(0, Math.round(v));
  const s = String(v || '').trim().toLowerCase();
  const numMatch = s.match(/\d[\d.,]*/);
  if (!numMatch) return 0;
  const num = numMatch[0];
  const suf = (s.match(/(rb|jt|k|m)/) || [])[1] || ''; // rb/jt before k/m in the alternation
  let n;
  if (suf) {
    n = parseFloat(num.replace(/,/g, '.')) || 0;        // suffix → decimal multiplier
    if (suf === 'k' || suf === 'rb') n *= 1e3;
    else n *= 1e6;                                       // m | jt
  } else {
    n = parseInt(num.replace(/[.,]/g, ''), 10) || 0;    // no suffix → drop thousands separators
  }
  return Math.max(0, Math.round(n));
}

// Send a (pre-resized) image to the vision model and return parsed comments.
// Returns { raw, comments:[{user,text,likes,box:[x1,y1,x2,y2]|null}] }. box is in the
// coordinate space of the image passed (size W x H).
async function detectComments({ imagePath, key, model = VISION_MODEL, W, H }) {
  const b64 = fs.readFileSync(imagePath).toString('base64');
  const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: commentPrompt(W, H) },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
        ],
      }],
      max_tokens: 4000,
      temperature: 0.05,
    }),
  });
  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || '';
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return { raw, comments: [] };
  let arr;
  try { arr = JSON.parse(m[0]); } catch (e) { return { raw, comments: [] }; }
  const comments = (Array.isArray(arr) ? arr : [])
    .map(c => ({
      user: String(c.user || c.author || 'anon').replace(/^@/, '').trim(),
      text: String(c.text || '').trim(),
      likes: normalizeLikes(c.likes),
      box: Array.isArray(c.box) && c.box.length === 4 ? c.box.map(n => Math.round(Number(n) || 0)) : null,
    }))
    .filter(c => c.text);
  return { raw, comments };
}

export { VISION_MODEL, commentPrompt, normalizeLikes, detectComments };
