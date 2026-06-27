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
    return { entities: j.entities || {}, memes: j.memes || {} };
  } catch (e) { return { entities: {}, memes: {} }; }
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

module.exports = { load, save, get, put, norm, CKB_PATH };
