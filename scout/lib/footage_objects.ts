// footage_objects.js — LLM extracts VISUAL OBJECTS (b-roll subjects) from a post's description +
// caption + headline, to use as FOOTAGE search queries (separate from the topic query).
//
// Footage = cutaway b-roll, so the best queries are the concrete THINGS shown/implied in the story,
// not the abstract topic. The LLM also EXPANDS generic terms to concrete instances (e.g. "ojol/ojek
// online" → "gojek", "grab"; "mobil sport" → "porsche") so footage is easy to find & relevant.
//
//   module: import { footageObjects } from './footage_objects.ts';
//           await footageObjects({ description, caption, headline, comments })
//             → { subjects:["nvidia"], objects:["chip ai","data center"], people:["jensen huang"] }
//           subjects = jangkar topik; objects = benda b-roll (digabung subject saat query); people = tokoh.
//   CLI:    bun footage_objects.js --headline "..." [--caption "..."] [--desc "..."] [--comments "..."]
//
// Uses Novita (THOTH_NOVITA_API_KEY via lib/env.js); model via env THOTH_LLM_MODEL (default deepseek-v3.1 — a TEXT reasoner;
// brand-expansion like "ojol"→gojek,grab needs a strong model, a vision model is wasteful here).

import fs from 'node:fs';
import path from 'node:path';

import { chatCompletion, chatKey } from './llm.ts';
const KEY = chatKey();
const MODEL = process.env.THOTH_LLM_MODEL || 'deepseek/deepseek-v3.1'; // text reasoning (brand-expansion) — pakai reasoner teks, bukan model vision

const PROMPT = ({
  description,
  caption,
  headline,
  comments,
}) => `Dari teks postingan di bawah, ekstrak entitas untuk query pencarian FOOTAGE (b-roll) — klip/post
yang bisa DITAMPILKAN di video. Pisahkan jadi SUBJECT (jangkar), OBJECT (benda konkret), PEOPLE (tokoh).

ATURAN:
1. SUBJECT = jangkar entitas INTI topik: nama brand/organisasi/judul/tempat/peristiwa (mis. "nvidia",
   "cerita lila", "gempa filipina", "mindanao"). 1-3 saja, yang paling sentral. subjects[0] = PALING inti.
2. OBJECT = BENDA / PRODUK / TEMPAT / AKTIVITAS konkret yang ditampilkan/diimplikasikan (mis. "chip ai",
   "data center", "kartu grafis", "longsor", "bioskop"). JANGAN di-jangkar/ditempeli subject — biarkan
   GENERIK; subject digabung OTOMATIS saat pencarian. Nama distinktif (mis. "mvp pictures",
   "m block space") boleh apa adanya. EKSPANSI brand generik: "ojol"→gojek,grab; "e-commerce"→shopee,
   tokopedia; "mobil sport"→porsche,ferrari. 4-8 object, ringkas (1-4 kata), huruf kecil, tanpa duplikat.
3. PEOPLE = tokoh terkenal yang TERKAIT erat subject (CEO/pendiri/figur publik), dari pengetahuanmu bila
   tak disebut eksplisit — mis. nvidia→"jensen huang", tesla→"elon musk". 0-2 saja. Kosongkan bila ragu.
4. HINDARI hal abstrak (pembayaran, harga, kebijakan, angka) & akun pengunggah/kurator.

TEKS:
[DESKRIPSI/CAPTION]: ${((description || '') + ' ' + (caption || '')).trim().slice(0, 700) || '(kosong)'}
[HEADLINE/HOOK]: ${(headline || '').slice(0, 300) || '(kosong)'}
[KOMENTAR NETIZEN]: ${(comments || '').slice(0, 600) || '(kosong)'}

Keluarkan HANYA JSON valid: {"subjects": [""], "objects": ["", ""], "people": []}`;

async function footageObjects({
  description = '',
  caption = '',
  headline = '',
  comments = '',
  key = KEY,
  model = MODEL,
} = {}) {
  const empty = { subjects: [], objects: [], people: [] };
  if (!key) return empty;
  if (!(description || caption || headline || comments)) return empty;
  let txt = '';
  try {
    const resp = await chatCompletion({
        model,
        max_tokens: 400,
        temperature: 0,
        messages: [{ role: 'user', content: PROMPT({ description, caption, headline, comments }) }],
      });
    if (!resp.ok) return empty;
    const d = await resp.json();
    txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  } catch (e) {
    return empty;
  }
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return empty;
  let o;
  try {
    o = JSON.parse(m[0]);
  } catch (e) {
    return empty;
  }
  const clean = (arr, max) => {
    const seen = new Set();
    return (Array.isArray(arr) ? arr : [])
      .map((x) => String(x).toLowerCase().trim())
      .filter((x) => x && x.length <= 40 && !seen.has(x) && seen.add(x))
      .slice(0, max);
  };
  return {
    subjects: clean(o.subjects, 3),
    objects: clean(o.objects, 8),
    people: clean(o.people, 2),
  };
}

export { footageObjects };

// ---- CLI ----
if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : '';
  };
  const input = {
    description: get('--desc'),
    caption: get('--caption'),
    headline: get('--headline'),
    comments: get('--comments'),
  };
  if (!input.description && !input.caption && !input.headline) {
    console.log('Usage: bun footage_objects.ts --headline "..." [--caption "..."] [--desc "..."]');
    process.exit(1);
  }
  (async () => {
    console.log(JSON.stringify(await footageObjects(input), null, 2));
  })();
}
