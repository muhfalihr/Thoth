// enrich_context.js — decode the CULTURAL CONTEXT of a content-set so the narration LLM understands
// the subtext (named entities, memes, coded slang, current events, audience sentiment) instead of
// misreading it (e.g. taking sarcastic comments literally and "blaming the netizens").
//
// Phase 1: ONE LLM call using the model's own knowledge. Writes back into the content-set:
//   - references[]        : {term, kind, summary} — entities/memes/slang/events the audience assumes
//   - comments[].context  : 1-line decoded meaning (subtext + tone) per meaningful comment
//   - discourse{}         : {audience_stance, themes[], narration_guidance} — collective reading
// Consumed by Thoth `generate_narration` ([Konteks Budaya] + [Maksud Komentar] blocks).
//
//   node enrich_context.js <content_set.json>
//
// Uses Novita (.novita_key); model via env THOTH_CONTEXT_MODEL (default deepseek-v3.1 — reasoning
// about subtext/recent memes needs a strong model). Best-effort: any failure leaves the set unchanged.

const fs = require('fs');
const path = require('path');

const KEY = (() => { const f = path.join(__dirname, '.novita_key'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : ''; })();
const MODEL = process.env.THOTH_CONTEXT_MODEL || 'deepseek/deepseek-v3.1'; // reasoner teks utk subteks/sentimen ID (current-event di-ground di Fase 2)

const FILE = process.argv[2];
if (!FILE) { console.log('Usage: node enrich_context.js <content_set.json>'); process.exit(1); }
if (!fs.existsSync(FILE)) { console.log('❌ File tak ada:', FILE); process.exit(1); }

const PROMPT = (title, desc, comments) => `Kamu analis BUDAYA INTERNET INDONESIA. Tugas: bongkar konteks
TERSEMBUNYI dari sebuah postingan + komentarnya, supaya penulis narasi paham maksud SEBENARNYA dan
TIDAK salah baca (mis. menganggap komentar sarkas sebagai keluhan harfiah / menyalahkan netizen).

POSTINGAN:
[Judul/Deskripsi]: ${((title || '') + '. ' + (desc || '')).trim().slice(0, 600) || '(kosong)'}

KOMENTAR (index | teks):
${comments.map((c, i) => `${i} | ${(c.text || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n').slice(0, 2200) || '(kosong)'}

LAKUKAN:
1. references: entitas/meme/slang/peristiwa yang DIRUJUK & perlu dijelaskan ke orang awam — nama
   tokoh (mis. "Nadiem Makarim"), kata kode/satir (mis. "konoha"=Indonesia), angka-meme, slang alay.
   Tiap item: {"term","kind":"person|org|place|event|meme|slang","summary":"1-2 kalimat FAKTUAL: apa
   itu & kenapa relevan di konteks ini"}. Kalau menyangkut status yg berubah (kasus hukum dll), sebut
   ringkas + perkiraan waktu bila tahu. Maks 8. Kalau RAGU/berpotensi halu, JANGAN masukkan.
2. comments: untuk komentar yg BERMAKNA (sarkas/berkode/sindiran/lucu/kontroversial), beri {"i":<index>,
   "context":"1 kalimat: arti tersirat + nada (sarkas/sindiran/canda/dukungan/peringatan/kritik)"}.
   Lewati komentar receh (pujian umum, emoji-doang, keluhan badan).
3. discourse: {"audience_stance":"1 kalimat maksud/perasaan KOLEKTIF audiens","themes":["2-4 tema
   singkat"],"narration_guidance":"1 kalimat nada/sudut yg harus diambil narator (mis. selami ironi,
   JANGAN menyalahkan komentator)"}.

Keluarkan HANYA JSON valid:
{"references":[{"term":"","kind":"","summary":""}],"comments":[{"i":0,"context":""}],"discourse":{"audience_stance":"","themes":[""],"narration_guidance":""}}`;

async function enrich(set) {
  if (!KEY) { console.log('  (no .novita_key → skip enrich, set unchanged)'); return false; }
  const main = set.main || {};
  const comments = (set.comments || []).filter(c => (c.text || '').trim());
  if (!comments.length && !(main.title || main.description)) { console.log('  (tak ada teks → skip)'); return false; }
  // Rank comments by likes; cap to keep the prompt tight. Keep original index mapping.
  const ranked = comments.map((c, i) => ({ c, i })).sort((a, b) => (b.c.likes || 0) - (a.c.likes || 0)).slice(0, 18);
  const promptComments = ranked.map(x => x.c);

  let txt = '';
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, temperature: 0.2,
        messages: [{ role: 'user', content: PROMPT(main.title, main.description, promptComments) }] }),
    });
    if (!resp.ok) { console.log(`  ⚠️ LLM ${resp.status} → skip`); return false; }
    const d = await resp.json();
    txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  } catch (e) { console.log('  ⚠️ LLM error → skip:', String(e.message || e).slice(0, 60)); return false; }

  const m = txt.match(/\{[\s\S]*\}/); if (!m) { console.log('  ⚠️ no JSON → skip'); return false; }
  let o; try { o = JSON.parse(m[0]); } catch (e) { console.log('  ⚠️ JSON parse fail → skip'); return false; }

  // references
  const refs = (Array.isArray(o.references) ? o.references : [])
    .map(r => ({ term: String(r.term || '').trim(), kind: String(r.kind || '').trim().toLowerCase(), summary: String(r.summary || '').trim() }))
    .filter(r => r.term && r.summary).slice(0, 8);
  set.references = refs;

  // discourse
  const dd = o.discourse || {};
  set.discourse = {
    audience_stance: String(dd.audience_stance || '').trim(),
    themes: (Array.isArray(dd.themes) ? dd.themes : []).map(t => String(t).trim()).filter(Boolean).slice(0, 4),
    narration_guidance: String(dd.narration_guidance || '').trim(),
  };

  // per-comment context — map back by the index we sent (ranked[i].i = original index in set.comments)
  let tagged = 0;
  (Array.isArray(o.comments) ? o.comments : []).forEach(cc => {
    const promptIdx = Number(cc.i);
    if (!Number.isInteger(promptIdx) || promptIdx < 0 || promptIdx >= ranked.length) return;
    const ctx = String(cc.context || '').trim();
    if (!ctx) return;
    const origIdx = ranked[promptIdx].i;
    if (set.comments[origIdx]) { set.comments[origIdx].context = ctx; tagged++; }
  });

  console.log(`  ✅ ${refs.length} ref, ${tagged} komentar di-decode, stance="${(set.discourse.audience_stance || '').slice(0, 60)}"`);
  return true;
}

(async () => {
  console.log('='.repeat(60));
  console.log('  Enrich Context (referensi budaya + maksud komentar)');
  console.log('='.repeat(60));
  let set; try { set = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { console.log('❌ JSON tak valid:', FILE); process.exit(0); }
  const changed = await enrich(set);
  if (changed) {
    fs.writeFileSync(FILE, JSON.stringify(set, null, 2), 'utf8');
    console.log(`📄 ${FILE} (references/discourse/comment-context ditulis)`);
  }
})();
