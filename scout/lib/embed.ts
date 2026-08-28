// embed.js — semantic similarity via the configured embedding provider (default: novita
// qwen3-embedding-8b; see THOTH_SCOUT_EMBED_PROVIDER / THOTH_EMBED_MODEL).
// Used to rank a creator's reels by how well their caption matches the story topic, so we can pick
// the SPECIFIC source video (and relevant profile footage) by MEANING — literal keyword overlap fails
// when the news-style repost caption ("pedagang buah Jatinangor") shares no words with the creator's
// own casual caption ("Yang dibutuhkan itu fungsi bukan gengsi").
//
//   import { embed, cosine, rankBySimilarity } from './embed.ts';
//   const ranked = await rankBySimilarity('pedagang buah hidup sehat', reels, r => r.caption);
//   → reels sorted by sim desc, each annotated with .sim (0..1); [] / null-safe.

import {
  providerEmbeddingsUrl,
  providerFor,
  providerKey,
  providerReady,
  providerSpec,
} from './env.ts';

const MODEL = process.env.THOTH_EMBED_MODEL || 'qwen/qwen3-embedding-8b';

// Provider embedding dipilih lewat THOTH_SCOUT_EMBED_PROVIDER (default: sama seperti dulu, novita).
// Gemini bukan OpenAI-compatible di sini: satu teks per request, ke `:embedContent`, dan key-nya
// ikut di query string — jadi bentuk request/response-nya dipisah, bukan dipaksa seragam.
const PROVIDER = providerFor('embed');

async function embedGemini(input, idx, texts) {
  const out = texts.map(() => null);
  const key = providerKey(PROVIDER);
  const url = `${providerEmbeddingsUrl(PROVIDER, process.env, MODEL)}?key=${encodeURIComponent(key)}`;
  await Promise.all(
    input.map(async (text, k) => {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${MODEL}`,
          content: { parts: [{ text }] },
        }),
      });
      if (!resp.ok) return;
      const d = await resp.json();
      const values = d?.embedding?.values;
      if (Array.isArray(values)) out[idx[k]] = values;
    }),
  );
  return out;
}

// Embed an array of strings → array of vectors (same order). Empty strings → null slot.
async function embed(texts) {
  if (!providerReady(PROVIDER)) return texts.map(() => null);
  const idx = [];
  const input = [];
  texts.forEach((t, i) => {
    const s = (t || '').trim();
    if (s) {
      idx.push(i);
      input.push(s.slice(0, 2000));
    }
  });
  if (!input.length) return texts.map(() => null);
  try {
    if (providerSpec(PROVIDER).family === 'gemini') return await embedGemini(input, idx, texts);
    const key = providerKey(PROVIDER);
    const resp = await fetch(providerEmbeddingsUrl(PROVIDER), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model: MODEL, input }),
    });
    if (!resp.ok) return texts.map(() => null);
    const d = await resp.json();
    const out = texts.map(() => null);
    (d.data || []).forEach((e, k) => {
      if (e && e.embedding) out[idx[k]] = e.embedding;
    });
    return out;
  } catch (e) {
    return texts.map(() => null);
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
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

export { cosine, embed, rankBySimilarity };
