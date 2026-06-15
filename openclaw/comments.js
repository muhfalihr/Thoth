// comments.js — shared TikTok comment detection: the vision prompt + Novita call + parse.
//
// Used by crop_comment_pipeline.js (screenshot → per-comment crops + content-set) and
// batch_pipeline.js (data only). One prompt = consistent extraction everywhere.
//
// The prompt isolates ONE top-level comment block per box — avatar + username + full text
// + meta row (time / Reply) + the like column (heart + count) + the "View N replies" line —
// and EXCLUDES neighbouring comments, indented replies, the video, nav, and the compose box.

const fs = require('fs');

const VISION_MODEL = 'qwen/qwen3-vl-8b-instruct';

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

// Parse "1.2K" / "3,4rb" / 109 / "1.2 jt" → integer.
function normalizeLikes(v) {
  if (typeof v === 'number') return Math.max(0, Math.round(v));
  const s = String(v || '').trim().toLowerCase().replace(/,/g, '.');
  const m = s.match(/([\d.]+)\s*(k|m|rb|jt)?/);
  if (!m) return 0;
  let n = parseFloat(m[1]) || 0;
  if (m[2] === 'k' || m[2] === 'rb') n *= 1e3;
  else if (m[2] === 'm' || m[2] === 'jt') n *= 1e6;
  return Math.round(n);
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

module.exports = { VISION_MODEL, commentPrompt, normalizeLikes, detectComments };
