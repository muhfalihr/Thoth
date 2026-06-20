// resolve_source.js — LLM decides the ORIGINAL source of a (reposted) video from its text signals.
//
// Many curator reels/reposts hint at the original source in their DESCRIPTION / CAPTION / on-screen
// HEADLINE text — sometimes naming the account (username) + which platform it came from. This feeds
// those three text signals to an LLM and returns EITHER:
//   - source: { account, platform }  (when the text credits a source), OR
//   - keywords: [...]                (when there is no source → terms to SEARCH the source video).
//
//   module: const { resolveSource } = require('./resolve_source');
//           await resolveSource({ description, caption, headline });
//             → { source: {account,platform}|null, keywords: [], reason }
//   CLI:    node resolve_source.js --headline "..." [--caption "..."] [--desc "..."]
//
// Uses Novita (.novita_key); model via env THOTH_LLM_MODEL (default qwen3-vl-8b-instruct, works
// text-only on the OpenAI-compatible endpoint).

const fs = require('fs');
const path = require('path');

const KEY = (() => { const f = path.join(__dirname, '.novita_key'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : ''; })();
const MODEL = process.env.THOTH_LLM_MODEL || 'qwen/qwen3-vl-8b-instruct';
const PLATFORMS = ['tiktok', 'instagram', 'twitter', 'youtube', 'facebook', 'threads'];

const PROMPT = ({ description, caption, headline }) => `Kamu menganalisis sebuah video REPOST/REACTION (mis. reel kurator). Dari teks di bawah, tentukan
SUMBER ASLI video tersebut.

ATURAN:
1. Kalau teks MENYEBUT sumber asli — username akun (mis. "@akun", "cr: akun", "sumber: akun",
   "via akun", logo channel) DAN/ATAU platform-nya — kembalikan "source": {"account","platform"}.
   - "platform" HARUS salah satu: ${PLATFORMS.join(' | ')} (atau "" kalau platform tak jelas).
   - "account" = username tanpa "@" (atau "" kalau cuma platform yang disebut).
   - KREDIT EMOJI KAMERA ("[📸 @user]", "📷 @user", "🎥 cr: @user") → platform-nya "instagram"
     (konvensi repost IG yang mengkredit akun IG asli).
   - KREDIT "tt/{user}" ("tt/user", "tt/@user", "tt: @user") → platform-nya "tiktok"
     ("tt" = singkatan TikTok; konvensi repost yang mengkredit akun TikTok asli).
2. SELALU isi "keywords": 3-6 kata/frasa kunci PALING SPESIFIK dari teks (nama orang/tempat/
   peristiwa/objek) untuk MENCARI video sumbernya — WAJIB diisi baik "source" ada MAUPUN null.
   Urut dari yang paling menentukan dulu (entitas/peristiwa inti, mis. "damkar padang"). Jangan
   masukkan kata generik ("video","viral","detik-detik","sebuah","aksi","memperlihatkan").
3. Jangan mengarang sumber yang tak ada di teks. Kalau ragu → perlakukan sebagai tanpa-sumber (keywords).

TEKS:
[DESKRIPSI]: ${(description || '').slice(0, 600) || '(kosong)'}
[CAPTION]: ${(caption || '').slice(0, 400) || '(kosong)'}
[HEADLINE/HOOK on-screen]: ${(headline || '').slice(0, 300) || '(kosong)'}

Keluarkan HANYA JSON valid persis format ini:
{"source": {"account": "", "platform": ""} , "keywords": [], "reason": ""}
(set "source": null bila tak ada sumber.)`;

async function resolveSource({ description = '', caption = '', headline = '', key = KEY, model = MODEL } = {}) {
  if (!key) return { source: null, keywords: [], reason: 'no novita key' };
  if (!(description || caption || headline)) return { source: null, keywords: [], reason: 'no text' };
  let txt = '';
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, max_tokens: 400, temperature: 0, messages: [{ role: 'user', content: PROMPT({ description, caption, headline }) }] }),
    });
    if (!resp.ok) return { source: null, keywords: [], reason: 'llm ' + resp.status };
    const d = await resp.json();
    txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  } catch (e) { return { source: null, keywords: [], reason: 'llm err ' + String(e.message || e).slice(0, 40) }; }

  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { source: null, keywords: [], reason: 'parse fail' };
  let o; try { o = JSON.parse(m[0]); } catch (e) { return { source: null, keywords: [], reason: 'json fail' }; }

  // Normalise.
  let source = null;
  if (o.source && (o.source.account || o.source.platform)) {
    const account = String(o.source.account || '').replace(/^@/, '').trim();
    let platform = String(o.source.platform || '').toLowerCase().trim();
    if (platform === 'x' || platform === 'x/twitter') platform = 'twitter';
    if (!PLATFORMS.includes(platform)) platform = '';
    if (account || platform) source = { account, platform };
  }
  const keywords = Array.isArray(o.keywords) ? o.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 6) : [];
  return { source, keywords, reason: String(o.reason || '').slice(0, 120) };
}

// Compose ONE search query (3-7 words) to find the ORIGINAL source video of the same event.
// Unlike resolveSource (which extracts an account + loose keywords), this returns a ready-to-search
// phrase and LEANS ON VISION (on-screen headline + scene description) because a curator reel's caption
// is often vague/motivational and doesn't describe the actual incident. Used by trace_source when a
// curated-aggregator main must be replaced by a non-aggregator source.
async function composeSearchQuery({ description = '', caption = '', headline = '', scene = '', key = KEY, model = MODEL } = {}) {
  if (!key) return '';
  if (!(description || caption || headline || scene)) return '';
  const prompt = `Dari sinyal sebuah video repost/kurator di bawah, buat SATU query pencarian paling efektif
untuk menemukan VIDEO SUMBER ASLI (berita/eyewitness) dari PERISTIWA yang sama.
ATURAN:
- Query = 3-7 kata: entitas/peristiwa PALING spesifik (nama orang/tempat/lembaga/objek + kejadian).
- UTAMAKAN info dari [HEADLINE on-screen] & [DESKRIPSI VISUAL] (apa yang TERLIHAT) — [CAPTION] sering
  generik/motivasional dan tak menggambarkan isi spesifik.
- DILARANG kata generik: video, viral, detik-detik, sebuah, aksi, momen, terbaru, terkini.
- Bahasa Indonesia. Keluarkan HANYA query-nya (tanpa tanda kutip, tanpa penjelasan).
[DESKRIPSI]: ${(description || '').slice(0, 500) || '(kosong)'}
[CAPTION]: ${(caption || '').slice(0, 300) || '(kosong)'}
[HEADLINE on-screen]: ${(headline || '').slice(0, 300) || '(kosong)'}
[DESKRIPSI VISUAL]: ${(scene || '').slice(0, 300) || '(kosong)'}`;
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, max_tokens: 60, temperature: 0, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!resp.ok) return '';
    const d = await resp.json();
    let q = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    return q.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 120);
  } catch (e) { return ''; }
}

module.exports = { resolveSource, composeSearchQuery };

// ---- CLI ----
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : ''; };
  const input = { description: get('--desc'), caption: get('--caption'), headline: get('--headline') };
  if (!input.description && !input.caption && !input.headline) { console.log('Usage: node resolve_source.js --headline "..." [--caption "..."] [--desc "..."]'); process.exit(1); }
  (async () => {
    const r = await resolveSource(input);
    console.log(JSON.stringify(r, null, 2));
  })();
}
