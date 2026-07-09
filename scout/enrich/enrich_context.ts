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
//   bun enrich_context.js <content_set.json>
//
// Uses Novita (THOTH_NOVITA_API_KEY via lib/env.js); model via env THOTH_CONTEXT_MODEL (default deepseek-v3.1 — reasoning
// about subtext/recent memes needs a strong model). Best-effort: any failure leaves the set unchanged.

import fs from 'node:fs';
import path from 'node:path';
import * as ckb from './ckb.ts';

import { novitaKey } from '../lib/env.ts';
import { ui } from '../lib/ui.ts';
const KEY = novitaKey();
const MODEL = process.env.THOTH_CONTEXT_MODEL || 'deepseek/deepseek-v3.1'; // reasoner teks utk subteks/sentimen ID (current-event di-ground di Fase 2)

const FILE = process.argv[2];
if (!FILE) {
  console.log('Usage: bun enrich_context.ts <content_set.json>');
  process.exit(1);
}
if (!fs.existsSync(FILE)) {
  console.log(ui.red(`${ui.ERR} File tak ada: ${FILE}`));
  process.exit(1);
}

const PROMPT = (
  title,
  desc,
  comments,
) => `Kamu analis BUDAYA INTERNET INDONESIA. Tugas: bongkar konteks
TERSEMBUNYI dari sebuah postingan + komentarnya, supaya penulis narasi paham maksud SEBENARNYA dan
TIDAK salah baca (mis. menganggap komentar sarkas sebagai keluhan harfiah / menyalahkan netizen).

POSTINGAN:
[Judul/Deskripsi]: ${((title || '') + '. ' + (desc || '')).trim().slice(0, 600) || '(kosong)'}

KOMENTAR (index | teks):
${
  comments
    .map((c, i) => `${i} | ${(c.text || '').replace(/\s+/g, ' ').slice(0, 160)}`)
    .join('\n')
    .slice(0, 2200) || '(kosong)'
}

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
  if (!KEY) {
    console.log('  (no THOTH_NOVITA_API_KEY → skip enrich, set unchanged)');
    return false;
  }
  const main = set.main || {};
  const comments = (set.comments || []).filter((c) => (c.text || '').trim());
  if (!comments.length && !(main.title || main.description)) {
    console.log('  (tak ada teks → skip)');
    return false;
  }
  // Rank comments by likes; cap to keep the prompt tight. Keep original index mapping.
  const ranked = comments
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.likes || 0) - (a.c.likes || 0))
    .slice(0, 18);
  const promptComments = ranked.map((x) => x.c);

  let txt = '';
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        temperature: 0.2,
        messages: [{ role: 'user', content: PROMPT(main.title, main.description, promptComments) }],
      }),
    });
    if (!resp.ok) {
      console.log(ui.amber(`  ${ui.WARN} LLM ${resp.status} → skip`));
      return false;
    }
    const d = await resp.json();
    txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  } catch (e) {
    console.log(ui.amber(`  ${ui.WARN} LLM error → skip: ${String(e.message || e).slice(0, 60)}`));
    return false;
  }

  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) {
    console.log(ui.amber(`  ${ui.WARN} no JSON → skip`));
    return false;
  }
  let o;
  try {
    o = JSON.parse(m[0]);
  } catch (e) {
    console.log(ui.amber(`  ${ui.WARN} JSON parse fail → skip`));
    return false;
  }

  // references
  const refs = (Array.isArray(o.references) ? o.references : [])
    .map((r) => ({
      term: String(r.term || '').trim(),
      kind: String(r.kind || '')
        .trim()
        .toLowerCase(),
      summary: String(r.summary || '').trim(),
    }))
    .filter((r) => r.term && r.summary)
    .slice(0, 8);
  set.references = refs;

  // ── Fase 2b: CKB cache — reuse summaries resolved in PAST runs (cross-video, cache-first). A cached
  // entity/meme skips the web/LLM grounding below; entities expire (short TTL) so status stays current.
  const KB = await ckb.load();
  const cached = new Set();
  refs.forEach((r) => {
    const c = ckb.get(KB, r.term, r.kind);
    if (c) {
      r.summary = c.summary;
      if (c.as_of_date) r.as_of_date = c.as_of_date;
      if (c.source_url) r.source_url = c.source_url;
      cached.add(r.term);
    }
  });
  if (cached.size) console.log(`  💾 CKB hit: ${cached.size} term dari cache (skip grounding)`);

  // discourse
  const dd = o.discourse || {};
  set.discourse = {
    audience_stance: String(dd.audience_stance || '').trim(),
    themes: (Array.isArray(dd.themes) ? dd.themes : [])
      .map((t) => String(t).trim())
      .filter(Boolean)
      .slice(0, 4),
    narration_guidance: String(dd.narration_guidance || '').trim(),
  };

  // per-comment context — map back by the index we sent (ranked[i].i = original index in set.comments)
  let tagged = 0;
  (Array.isArray(o.comments) ? o.comments : []).forEach((cc) => {
    const promptIdx = Number(cc.i);
    if (!Number.isInteger(promptIdx) || promptIdx < 0 || promptIdx >= ranked.length) return;
    const ctx = String(cc.context || '').trim();
    if (!ctx) return;
    const origIdx = ranked[promptIdx].i;
    if (set.comments[origIdx]) {
      set.comments[origIdx].context = ctx;
      tagged++;
    }
  });

  // ── Fase 2a: web-grounding — refresh entity/event summaries to CURRENT status (Google News, CDP).
  // The model's training cutoff makes status stale (e.g. "Nadiem" still "menteri", not "tersangka 2026").
  // Best-effort: no relay / no headlines → keep the model summary. Disable with THOTH_GROUND=0.
  if (process.env.THOTH_GROUND !== '0' && refs.length) {
    const groundable = refs.filter(
      (r) => ['person', 'org', 'event', 'place'].includes(r.kind) && !cached.has(r.term),
    );
    if (groundable.length) {
      try {
        const { groundTerms } = await import('./web_grounding.ts');
        const hl = await groundTerms(
          groundable.map((r) => r.term),
          { max: 5 },
        );
        const withHl = groundable.filter((r) => (hl[r.term] || []).length);
        if (withHl.length) {
          const upd = await groundSummaries(withHl, hl);
          let n = 0;
          upd.forEach((g) => {
            const r = refs.find((x) => x.term === g.term);
            if (!r || !g.summary) return;
            r.summary = g.summary;
            if (g.as_of_date) r.as_of_date = g.as_of_date;
            const first = (hl[r.term] || [])[0];
            if (first && first.url) r.source_url = first.url;
            n++;
          });
          console.log(`  🌐 grounded ${n}/${withHl.length} entitas via Google News`);
        } else {
          console.log('  🌐 grounding: tak ada headline relevan (lewati)');
        }
      } catch (e) {
        console.log('  🌐 grounding skip:', String(e.message || e).slice(0, 60));
      }
    }
  }

  // Persist resolved references (entities + memes) so future videos reuse them (cache-first).
  refs.forEach((r) => ckb.put(KB, r.term, r.kind, r));
  await ckb.save(KB);

  // Fase 3b: inject currently-live discourse terms (daily pulse harvest) as a STYLE reference.
  const trends = ckb.topPulse(KB, 8).map((p) => p.term);
  if (trends.length) set.discourse.trends = trends;

  // Fase 4: current register/voice snapshot → optional flavor in narration_guidance (no forcing).
  const reg = ckb.getRegister(KB);
  if (reg.length) {
    const note = `Gaya bahasa yang lagi hidup (OPSIONAL, pakai bila pas, JANGAN dipaksakan): ${reg.join(', ')}`;
    set.discourse = set.discourse || {};
    set.discourse.narration_guidance = set.discourse.narration_guidance
      ? `${set.discourse.narration_guidance} | ${note}`
      : note;
  }

  console.log(
    ui.gold(
      `  ${ui.OK} ${refs.length} ref, ${tagged} komentar di-decode, stance="${(set.discourse.audience_stance || '').slice(0, 60)}"`,
    ),
  );
  return true;
}

// Pass B: rewrite entity/event summaries using the latest Google-News headlines (current status +
// as_of_date). Returns [{term, summary, as_of_date}]. Best-effort → [] on any failure.
async function groundSummaries(refs, headlines) {
  const blocks = refs
    .map((r) => {
      const hl = (headlines[r.term] || [])
        .map((h) => `- ${h.title}${h.source ? ' (' + h.source + ')' : ''}`)
        .join('\n');
      return `### ${r.term} [${r.kind}]\nRingkasan lama: ${r.summary}\nHeadline terbaru:\n${hl || '(tak ada)'}`;
    })
    .join('\n\n');
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Hari ini: ${today}. Perbarui ringkasan tiap entitas memakai HEADLINE TERBARU di bawah.
Status bisa berubah (mis. "menteri"→"tersangka"→"divonis"). Tulis 1-2 kalimat FAKTUAL + STATUS TERKINI.
Sertakan as_of_date (format YYYY-MM atau YYYY-MM-DD; mendekati hari ini karena headline = berita terbaru,
JANGAN menebak tahun lampau; tak boleh > hari ini). Kalau headline TIDAK relevan dengan entitas,
pertahankan ringkasan lama apa adanya.

${blocks}

Keluarkan HANYA JSON: {"items":[{"term":"","summary":"","as_of_date":""}]}`;
  let txt = '';
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 900,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) return [];
    const d = await resp.json();
    txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  } catch (e) {
    return [];
  }
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const o = JSON.parse(m[0]);
    return (Array.isArray(o.items) ? o.items : []).map((x) => ({
      term: String(x.term || '').trim(),
      summary: String(x.summary || '').trim(),
      as_of_date: String(x.as_of_date || '').trim(),
    }));
  } catch (e) {
    return [];
  }
}

(async () => {
  console.log(ui.rule());
  console.log('  Enrich Context (referensi budaya + maksud komentar)');
  console.log(ui.rule());
  let set;
  try {
    set = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.log(ui.red(`${ui.ERR} JSON tak valid: ${FILE}`));
    process.exit(0);
  }
  const changed = await enrich(set);
  if (changed) {
    fs.writeFileSync(FILE, JSON.stringify(set, null, 2), 'utf8');
    console.log(`📄 ${FILE} (references/discourse/comment-context ditulis)`);
  }
})();
