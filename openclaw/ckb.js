// ckb.js — Cultural Knowledge Base (local JSON). Caches RESOLVED references (entities/memes) across
// runs so a term seen in one video is reused for the next WITHOUT re-hitting web/LLM — the "cache-first"
// core of the enrichment plan (RESEARCH_context_enrichment_narration.md §4). Persists at workspace/ckb.json.
//
//   const ckb = require('./ckb'); const KB = ckb.load();
//   const hit = ckb.get(KB, 'Nadiem Makarim', 'person');   // {summary,as_of_date,source_url} | null (TTL-checked)
//   ckb.put(KB, 'Nadiem Makarim', 'person', {summary, as_of_date, source_url}); ckb.save(KB);
//
// TTL: entities/events get a SHORT ttl (status changes: tersangka→divonis); memes/slang LONG.
// Upgrade path (future, not needed for a single-machine tool): back this with Supabase for
// cross-machine sharing + embedding fuzzy-match. THOTH_SUPABASE_URL is a raw postgres string, so a
// JS backend would need a `pg` dependency + the CKB tables (DDL in the research doc §5).

const fs = require('fs');
const path = require('path');

const CKB_PATH = process.env.THOTH_CKB_PATH || path.join(__dirname, 'ckb.json');
const ENTITY_TTL_DAYS = parseFloat(process.env.THOTH_CKB_ENTITY_TTL || '14');  // status-changing → short
const MEME_TTL_DAYS   = parseFloat(process.env.THOTH_CKB_MEME_TTL   || '120'); // memes/slang → long

const norm = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
const longBucket = kind => kind === 'meme' || kind === 'slang';
const isFresh = (ts, days) => ts && (Date.now() - ts) < days * 864e5;

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(CKB_PATH, 'utf8'));
    return { entities: j.entities || {}, memes: j.memes || {}, pulse: j.pulse || {} };
  } catch (e) { return { entities: {}, memes: {}, pulse: {} }; }
}

function save(KB) {
  try { fs.writeFileSync(CKB_PATH, JSON.stringify(KB, null, 2), 'utf8'); } catch (e) {}
}

// Fresh cached summary for `term` (TTL depends on kind), or null.
function get(KB, term, kind) {
  const k = norm(term); if (!k) return null;
  const bucket = longBucket(kind) ? KB.memes : KB.entities;
  const ttl = longBucket(kind) ? MEME_TTL_DAYS : ENTITY_TTL_DAYS;
  const e = bucket[k];
  if (e && e.summary && isFresh(e.ts, ttl)) {
    return { summary: e.summary, as_of_date: e.as_of_date || '', source_url: e.source_url || '' };
  }
  return null;
}

function put(KB, term, kind, data) {
  const k = norm(term); if (!k || !data || !data.summary) return;
  const bucket = longBucket(kind) ? KB.memes : KB.entities;
  bucket[k] = {
    term, kind: kind || '',
    summary: data.summary,
    as_of_date: data.as_of_date || '',
    source_url: data.source_url || '',
    ts: Date.now(),
  };
}

// ── Cultural Pulse: rolling "what's recurring across trending content" (set by pulse_harvest.js) ──
const PULSE_TAU_DAYS = parseFloat(process.env.THOTH_PULSE_TAU || '7'); // recency decay constant

// Record that `term` recurred across `count` trending videos in this harvest.
function bumpPulse(KB, term, kind, count, urls) {
  const k = norm(term); if (!k) return;
  KB.pulse = KB.pulse || {};
  const now = Date.now();
  const e = KB.pulse[k] || { term, kind: kind || '', freq: 0, first_seen: now, sample_urls: [] };
  e.freq += (count || 1);
  if (kind) e.kind = kind;
  e.last_seen = now;
  (urls || []).forEach(u => { if (u && !e.sample_urls.includes(u) && e.sample_urls.length < 5) e.sample_urls.push(u); });
  KB.pulse[k] = e;
}

// Drop pulse entries not seen for `days` (stale memes fade out).
function prunePulse(KB, days) {
  if (!KB.pulse) return;
  const cutoff = Date.now() - days * 864e5;
  for (const k of Object.keys(KB.pulse)) { if ((KB.pulse[k].last_seen || 0) < cutoff) delete KB.pulse[k]; }
}

// Top-N live terms by recency-decayed score = freq · exp(-ageDays/tau). Returns [{term,kind,score,freq}].
function topPulse(KB, n = 10) {
  const now = Date.now();
  return Object.values(KB.pulse || {})
    .map(e => {
      const ageDays = (now - (e.last_seen || now)) / 864e5;
      return { term: e.term, kind: e.kind || '', freq: e.freq || 0, score: (e.freq || 0) * Math.exp(-ageDays / PULSE_TAU_DAYS) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

module.exports = { load, save, get, put, norm, CKB_PATH, bumpPulse, prunePulse, topPulse };
