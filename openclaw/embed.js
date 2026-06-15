// embed.js — semantic similarity via Novita embeddings (qwen3-embedding-8b).
// Used to rank a creator's reels by how well their caption matches the story topic, so we can pick
// the SPECIFIC source video (and relevant profile footage) by MEANING — literal keyword overlap fails
// when the news-style repost caption ("pedagang buah Jatinangor") shares no words with the creator's
// own casual caption ("Yang dibutuhkan itu fungsi bukan gengsi").
//
//   const { embed, cosine, rankBySimilarity } = require('./embed');
//   const ranked = await rankBySimilarity('pedagang buah hidup sehat', reels, r => r.caption);
//   → reels sorted by sim desc, each annotated with .sim (0..1); [] / null-safe.

const fs = require('fs');
const path = require('path');

const KEY = (() => { const f = path.join(__dirname, '.novita_key'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : ''; })();
const MODEL = process.env.CLIPPER_EMBED_MODEL || 'qwen/qwen3-embedding-8b';

// Embed an array of strings → array of vectors (same order). Empty strings → null slot.
async function embed(texts) {
  if (!KEY) return texts.map(() => null);
  const idx = []; const input = [];
  texts.forEach((t, i) => { const s = (t || '').trim(); if (s) { idx.push(i); input.push(s.slice(0, 2000)); } });
  if (!input.length) return texts.map(() => null);
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/embeddings', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, input }),
    });
    if (!resp.ok) return texts.map(() => null);
    const d = await resp.json();
    const out = texts.map(() => null);
    (d.data || []).forEach((e, k) => { if (e && e.embedding) out[idx[k]] = e.embedding; });
    return out;
  } catch (e) { return texts.map(() => null); }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Rank `items` by cosine(query, getText(item)). Returns a NEW array sorted by .sim desc; each item is
// shallow-cloned with a numeric `.sim` (0 when no embedding available). If embeddings are unavailable
// (no key / API down), every .sim is 0 and original order is preserved → caller falls back gracefully.
async function rankBySimilarity(query, items, getText) {
  if (!items || !items.length) return [];
  const vecs = await embed([query, ...items.map(getText)]);
  const q = vecs[0];
  const scored = items.map((it, i) => ({ ...it, sim: q ? cosine(q, vecs[i + 1]) : 0 }));
  scored.sort((a, b) => b.sim - a.sim);
  return scored;
}

module.exports = { embed, cosine, rankBySimilarity };
