// footage_objects.js — LLM extracts VISUAL OBJECTS (b-roll subjects) from a post's description +
// caption + headline, to use as FOOTAGE search queries (separate from the topic query).
//
// Footage = cutaway b-roll, so the best queries are the concrete THINGS shown/implied in the story,
// not the abstract topic. The LLM also EXPANDS generic terms to concrete instances (e.g. "ojol/ojek
// online" → "gojek", "grab"; "mobil sport" → "porsche") so footage is easy to find & relevant.
//
//   module: const { footageObjects } = require('./footage_objects');
//           await footageObjects({ description, caption, headline })  → ["ojol","gojek","grab",...]
//   CLI:    node footage_objects.js --headline "..." [--caption "..."] [--desc "..."]
//
// Uses Novita (.novita_key); model via env CLIPPER_LLM_MODEL (default qwen3-vl-235b — brand-expansion
// like "ojol"→gojek,grab needs a strong model; 8b under-performs).

const fs = require('fs');
const path = require('path');

const KEY = (() => { const f = path.join(__dirname, '.novita_key'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : ''; })();
const MODEL = process.env.CLIPPER_LLM_MODEL || 'qwen/qwen3-vl-235b-a22b-instruct';

const PROMPT = ({ description, caption, headline }) => `Dari teks postingan di bawah, ekstrak OBJEK VISUAL / subjek KONKRET yang cocok dijadikan query
pencarian FOOTAGE (b-roll) — yaitu BENDA / TEMPAT / BRAND / AKTIVITAS yang bisa DITAMPILKAN di video.

ATURAN:
1. Tentukan dulu SUBJEK SPESIFIK topik (nama/judul/tempat/peristiwa inti) sebagai JANGKAR — mis.
   "cerita lila", "gempa filipina", "mindanao", "silmy karim". SETIAP objek harus UNAMBIGU menunjuk
   ke subjek ini (jangan sampai menarik peristiwa/hal lain yang mirip).
2. UTAMAKAN objek DISTINKTIF yang sudah spesifik sendiri (nama tokoh/brand/judul/tempat/event) —
   pakai apa adanya (mis. "sara wijayanto", "mvp pictures", "daryono", "m block space").
3. JANGKAR kata GENERIK/umum ke subjek topik — JANGAN keluarkan telanjang. Ini WAJIB untuk:
   - kategori: "film"→"film cerita lila", "bioskop"→"bioskop cerita lila"
   - sub-peristiwa/bencana/kejadian umum: "longsor"→"longsor filipina", "banjir"→"banjir <tempat>",
     "bangunan runtuh"→"bangunan runtuh filipina", "tsunami"/"tsunami warning"→"tsunami filipina",
     "kebakaran"/"demo"/"kecelakaan"/"gempa" → selalu + lokasi/nama event.
   DILARANG keluar SENDIRIAN tanpa jangkar: film, bioskop, video, trailer, berita, longsor, banjir,
   tsunami, gempa, kebakaran, demo, kecelakaan, kejadian, momen, jalan, acara, orang.
4. EKSPANSI BRAND utk layanan/produk generik (BUKAN di-jangkar lokasi): "ojol"/"ojek online" → gojek,
   grab, maxim; "e-commerce" → shopee, tokopedia; "mobil sport" → porsche, ferrari; "moge" → harley.
5. HINDARI objek abstrak (pembayaran, peta jalan, harga, aplikasi, tiket masuk) & angka. JANGAN
   masukkan akun pengunggah/kurator.
6. 4-8 objek, ringkas (1-4 kata), huruf kecil, tanpa duplikat.

TEKS:
[DESKRIPSI/CAPTION]: ${((description || '') + ' ' + (caption || '')).trim().slice(0, 700) || '(kosong)'}
[HEADLINE/HOOK]: ${(headline || '').slice(0, 300) || '(kosong)'}

Keluarkan HANYA JSON valid: {"objects": ["", ""]}`;

async function footageObjects({ description = '', caption = '', headline = '', key = KEY, model = MODEL } = {}) {
  if (!key) return [];
  if (!(description || caption || headline)) return [];
  let txt = '';
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, max_tokens: 300, temperature: 0, messages: [{ role: 'user', content: PROMPT({ description, caption, headline }) }] }),
    });
    if (!resp.ok) return [];
    const d = await resp.json();
    txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  } catch (e) { return []; }
  const m = txt.match(/\{[\s\S]*\}/); if (!m) return [];
  let o; try { o = JSON.parse(m[0]); } catch (e) { return []; }
  const seen = new Set();
  return (Array.isArray(o.objects) ? o.objects : [])
    .map(x => String(x).toLowerCase().trim())
    .filter(x => x && x.length <= 30 && !seen.has(x) && seen.add(x))
    .slice(0, 8);
}

module.exports = { footageObjects };

// ---- CLI ----
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : ''; };
  const input = { description: get('--desc'), caption: get('--caption'), headline: get('--headline') };
  if (!input.description && !input.caption && !input.headline) { console.log('Usage: node footage_objects.js --headline "..." [--caption "..."] [--desc "..."]'); process.exit(1); }
  (async () => { console.log(JSON.stringify(await footageObjects(input), null, 2)); })();
}
