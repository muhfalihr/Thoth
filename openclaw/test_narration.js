// test_narration.js — A/B narration prose across models with the IMPROVED prompt, WITHOUT a full
// CLIPPER run. Builds source_text from a content-set (title+desc+figures+top comments), sends the new
// SYSTEM+user prompt to each model via Novita, prints {hook, narration} for comparison.
//
//   node test_narration.js <content_set.json> [--models a,b,c]

const fs = require('fs');
const path = require('path');
const KEY = fs.readFileSync(path.join(__dirname, '.novita_key'), 'utf8').trim();

const args = process.argv.slice(2);
const FILE = args.find(a => !a.startsWith('--'));
const get = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : ''; };
const MODELS = (get('--models') || 'qwen/qwen-2.5-72b-instruct,deepseek/deepseek-v4-flash,deepseek/deepseek-v4-pro').split(',');

const SYSTEM = "Lo kreator konten shorts viral Indonesia, spesialisasi RAGE-BAIT yang bikin orang gemes, heran, atau pengen share. Lo bukan reporter, bukan motivator, bukan ceramah. Lo adalah orang yang sinis, skeptis, heran — yang nge-judge kejadian aneh sambil ngakak sendiri. Sopan tapi TAJAM. Output HANYA JSON, gaada teks lain.";

function buildSource(s) {
  const b = [];
  if (s.main && s.main.title) b.push('[Judul]\n' + s.main.title);
  if (s.main && s.main.description) b.push('[Deskripsi]\n' + s.main.description);
  if (s.figures && s.figures.length) b.push('[Tokoh]\n' + s.figures.map(f => `- ${f.name}${f.role ? ' (' + f.role + ')' : ''}${f.description ? ': ' + f.description : ''}`).join('\n'));
  if (s.comments && s.comments.length) {
    const top = s.comments.slice().sort((a, c) => (c.likes || 0) - (a.likes || 0)).slice(0, 12)
      .map(c => c.likes ? `- ${c.author} (${c.likes} like): ${c.text}` : `- ${c.author}: ${c.text}`);
    b.push('[Komentar Netizen Teratas]\n' + top.join('\n'));
  }
  return b.join('\n\n');
}

const userPrompt = (src, words, secs) => `Ini SUMBER KONTEKS sebuah kejadian (blok [Judul]/[Deskripsi]/[Tokoh]/[Komentar Netizen Teratas]). Pahami TOPIK & FAKTA nyatanya dari SEMUA blok:
====================
${src}
====================

PENTING — GROUNDING: Narasi WAJIB berdasar fakta & topik NYATA di atas (nama tokoh, kejadian, angka, sentimen komentar). DILARANG mengarang yang tidak ada di konteks.

Bikin SATU narasi RAGE-BAIT menerus (bahasa id) buat di-voiceover-in:

STRUKTUR WAJIB:
1. HOOK: buka dgn pernyataan gila/penasaran ("Niatnya X eh malah Y", "Bisa-bisanya [tokoh] [hal gila]"). Jangan sapaan 'Gais'/'Halo'.
2. ISI: gaya SINIS + HERAN. Dari komentar PILIH HANYA 1-2 yang BENAR-BENAR lucu/nyeleneh/kontroversial — PARAFRASE jadi kalimat sendiri yang natural (kutip singkat HANYA kalau punchy). ABAIKAN komentar RECEH/random: keluhan badan ('paha gatel','pegel'), pujian umum ('keren','sehat'), emoji-doang, atau yg gak nambah cerita. JANGAN dump banyak komentar mentah. Reaksi heran singkat & VARIASIKAN. Campur kalimat pendek & sedang biar NGALIR natural.
3. PENUTUP: satu pertanyaan tajam SPESIFIK ke kasus ini (sebut detail/tokoh/angka) — BUKAN template generik yang bisa ditempel di video mana pun. JANGAN nasihat/motivasi/moral.

NATURAL & ANTI-TEMPLATE:
- Bahasa Indonesia LISAN yang wajar; hindari frasa kaku/terjemahan literal.
- JANGAN ulang FRASA KUNCI/sudut yang sama 2×: kalau HOOK sudah pakai satu frasa (mis. 'jantung model apa','15km tiap pagi'), JANGAN ulang lagi di isi/penutup — cari sudut & diksi lain. Tiap kalimat tambah info BARU.
- Tiap naskah harus terasa BEDA, bukan cetakan ganti-nama.

LARANGAN: kata kasar; bahasa berita/formal ('merupakan','tersebut','beliau'); ceramah/nasihat; sapaan alay ('mantul!','gaspol!'); kalimat bertele-tele.

Panjang ~${words} kata (≈${secs} detik). Output JSON: {"hook":"≤12 kata","narration":"..."}`;

async function gen(model, system, user) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model, max_tokens: 700, temperature: 0.8, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!r.ok) return { err: 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120) };
    const d = await r.json();
    const txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    const m = txt.match(/\{[\s\S]*\}/);
    const o = m ? JSON.parse(m[0]) : { hook: '', narration: txt };
    return { hook: o.hook, narration: o.narration, ms: Date.now() - t0 };
  } catch (e) { return { err: String(e.message || e).slice(0, 120) }; }
}

(async () => {
  const set = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const src = buildSource(set);
  const user = userPrompt(src, 135, 45);
  console.log('SOURCE blocks:\n' + src.slice(0, 400) + '\n' + '='.repeat(70));
  for (const model of MODELS) {
    const r = await gen(model.trim(), SYSTEM, user);
    console.log('\n### ' + model.trim() + (r.ms ? `  (${(r.ms / 1000).toFixed(1)}s)` : ''));
    if (r.err) { console.log('  ERR: ' + r.err); continue; }
    console.log('HOOK: ' + r.hook);
    console.log('NARR: ' + r.narration);
  }
})();
