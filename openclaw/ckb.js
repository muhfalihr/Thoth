// ckb.js — Cultural Knowledge Base, backed by SUPABASE (Postgres). Caches RESOLVED references
// (entities/memes) + the daily Cultural Pulse across runs/machines so a term seen once is reused
// without re-hitting web/LLM (cache-first; RESEARCH_context_enrichment_narration.md §4-§5).
//
//   const ckb = require('./ckb'); const KB = await ckb.load();   // ← async (DB)
//   ckb.get(KB,'Nadiem Makarim','person') // sync, in-memory → {summary,as_of_date,source_url} | null (TTL)
//   ckb.put(KB,'Nadiem Makarim','person',{summary,as_of_date,source_url});
//   await ckb.save(KB);                                          // ← async (flush dirty rows)
//
// Connection: CLIPPER_SUPABASE_URL (or THOTH_SUPABASE_URL) env, a `.supabase_url` file (like
// .novita_key), or a CLIPPER_SUPABASE_URL/THOTH_SUPABASE_URL line in a nearby .env. Requires the `pg`
// package in the run dir (workspace: `npm install pg`). If the URL/pg/connection is unavailable it
// DEGRADES to a local JSON file (workspace/ckb.json) so the tool never breaks.
//
// Schema (auto-created): ckb_entities, ckb_memes (term_key PK, summary, as_of_date, source_url,
// updated_at), ckb_pulse (term_key PK, freq, first_seen, last_seen, sample_urls[]).
// ponytail: load() pulls all rows into memory — fine at CKB scale; switch to keyed lookups if it grows.

const fs = require('fs');
const path = require('path');

const LOCAL_PATH      = process.env.THOTH_CKB_PATH || path.join(__dirname, 'ckb.json');
const ENTITY_TTL_DAYS = parseFloat(process.env.THOTH_CKB_ENTITY_TTL || '14');
const MEME_TTL_DAYS   = parseFloat(process.env.THOTH_CKB_MEME_TTL   || '120');
const PULSE_TAU_DAYS  = parseFloat(process.env.THOTH_PULSE_TAU      || '7');

const norm = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
const longBucket = kind => kind === 'meme' || kind === 'slang';
const isFresh = (ts, days) => ts && (Date.now() - ts) < days * 864e5;

// ── connection-string resolution ───────────────────────────────────────────────
function readEnvVar(p, key) {
  try { const m = fs.readFileSync(p, 'utf8').match(new RegExp(key + '\\s*=\\s*(\\S+)')); return m ? m[1] : ''; }
  catch (e) { return ''; }
}
function supabaseUrl() {
  if (process.env.CLIPPER_SUPABASE_URL) return process.env.CLIPPER_SUPABASE_URL;
  if (process.env.THOTH_SUPABASE_URL)   return process.env.THOTH_SUPABASE_URL;
  const f = path.join(__dirname, '.supabase_url'); if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  for (const c of [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')]) {
    const u = readEnvVar(c, 'CLIPPER_SUPABASE_URL') || readEnvVar(c, 'THOTH_SUPABASE_URL');
    if (u) return u;
  }
  return '';
}

async function pgClient() {
  const url = supabaseUrl(); if (!url) return null;
  let Client; try { ({ Client } = require('pg')); } catch (e) { return null; } // pg not installed → local fallback
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try { await c.connect(); return c; } catch (e) { try { await c.end(); } catch (_) {} return null; }
}

const DDL = `
CREATE TABLE IF NOT EXISTS ckb_entities (term_key text PRIMARY KEY, term text, kind text, summary text, as_of_date text, source_url text, updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS ckb_memes    (term_key text PRIMARY KEY, term text, kind text, summary text, as_of_date text, source_url text, updated_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS ckb_pulse    (term_key text PRIMARY KEY, term text, kind text, freq int DEFAULT 0, first_seen timestamptz DEFAULT now(), last_seen timestamptz DEFAULT now(), sample_urls text[] DEFAULT '{}');`;

function freshKB(backend) {
  return { entities: {}, memes: {}, pulse: {}, _dirty: { entities: new Set(), memes: new Set(), pulse: new Set() }, _prune: 0, _backend: backend };
}

async function load() {
  const c = await pgClient();
  if (c) {
    const KB = freshKB('supabase');
    try {
      await c.query(DDL);
      const sel = 'term_key,term,kind,summary,as_of_date,source_url,extract(epoch from updated_at)*1000 AS ts';
      for (const [tbl, bucket] of [['ckb_entities', 'entities'], ['ckb_memes', 'memes']]) {
        const r = await c.query(`SELECT ${sel} FROM ${tbl}`);
        r.rows.forEach(x => KB[bucket][x.term_key] = { term: x.term, kind: x.kind, summary: x.summary, as_of_date: x.as_of_date || '', source_url: x.source_url || '', ts: Number(x.ts) });
      }
      const p = await c.query('SELECT term_key,term,kind,freq,extract(epoch from first_seen)*1000 AS fs,extract(epoch from last_seen)*1000 AS ls,sample_urls FROM ckb_pulse');
      p.rows.forEach(x => KB.pulse[x.term_key] = { term: x.term, kind: x.kind, freq: x.freq, first_seen: Number(x.fs), last_seen: Number(x.ls), sample_urls: x.sample_urls || [] });
      return KB;
    } catch (e) { console.log('  (CKB supabase load failed → local:', String(e.message || e).slice(0, 50) + ')'); }
    finally { try { await c.end(); } catch (_) {} }
  }
  // fallback: local JSON
  const KB = freshKB('local');
  try { const j = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8')); KB.entities = j.entities || {}; KB.memes = j.memes || {}; KB.pulse = j.pulse || {}; } catch (e) {}
  return KB;
}

function get(KB, term, kind) {
  const k = norm(term); if (!k) return null;
  const e = (longBucket(kind) ? KB.memes : KB.entities)[k];
  const ttl = longBucket(kind) ? MEME_TTL_DAYS : ENTITY_TTL_DAYS;
  if (e && e.summary && isFresh(e.ts, ttl)) return { summary: e.summary, as_of_date: e.as_of_date || '', source_url: e.source_url || '' };
  return null;
}

function put(KB, term, kind, data) {
  const k = norm(term); if (!k || !data || !data.summary) return;
  const b = longBucket(kind) ? 'memes' : 'entities';
  KB[b][k] = { term, kind: kind || '', summary: data.summary, as_of_date: data.as_of_date || '', source_url: data.source_url || '', ts: Date.now() };
  KB._dirty[b].add(k);
}

function bumpPulse(KB, term, kind, count, urls) {
  const k = norm(term); if (!k) return;
  const now = Date.now();
  const e = KB.pulse[k] || { term, kind: kind || '', freq: 0, first_seen: now, sample_urls: [] };
  e.freq += (count || 1);
  if (kind) e.kind = kind;
  e.last_seen = now;
  (urls || []).forEach(u => { if (u && !e.sample_urls.includes(u) && e.sample_urls.length < 5) e.sample_urls.push(u); });
  KB.pulse[k] = e;
  KB._dirty.pulse.add(k);
}

function prunePulse(KB, days) {
  const cutoff = Date.now() - days * 864e5;
  for (const k of Object.keys(KB.pulse)) { if ((KB.pulse[k].last_seen || 0) < cutoff) delete KB.pulse[k]; }
  KB._prune = days; // save() also issues a DB-side DELETE
}

function topPulse(KB, n = 10) {
  const now = Date.now();
  return Object.values(KB.pulse || {})
    .map(e => { const age = (now - (e.last_seen || now)) / 864e5; return { term: e.term, kind: e.kind || '', freq: e.freq || 0, score: (e.freq || 0) * Math.exp(-age / PULSE_TAU_DAYS) }; })
    .sort((a, b) => b.score - a.score).slice(0, n);
}

function saveLocal(KB) {
  try { fs.writeFileSync(LOCAL_PATH, JSON.stringify({ entities: KB.entities, memes: KB.memes, pulse: KB.pulse }, null, 2), 'utf8'); } catch (e) {}
}

async function save(KB) {
  if (KB._backend !== 'supabase') return saveLocal(KB);
  const c = await pgClient();
  if (!c) return saveLocal(KB); // connection lost → don't lose data
  try {
    for (const [tbl, bucket] of [['ckb_entities', 'entities'], ['ckb_memes', 'memes']]) {
      for (const k of KB._dirty[bucket]) {
        const e = KB[bucket][k]; if (!e) continue;
        await c.query(
          `INSERT INTO ${tbl}(term_key,term,kind,summary,as_of_date,source_url,updated_at) VALUES($1,$2,$3,$4,$5,$6,now())
           ON CONFLICT(term_key) DO UPDATE SET term=$2,kind=$3,summary=$4,as_of_date=$5,source_url=$6,updated_at=now()`,
          [k, e.term, e.kind, e.summary, e.as_of_date, e.source_url]);
      }
    }
    for (const k of KB._dirty.pulse) {
      const e = KB.pulse[k]; if (!e) continue;
      await c.query(
        `INSERT INTO ckb_pulse(term_key,term,kind,freq,first_seen,last_seen,sample_urls)
         VALUES($1,$2,$3,$4,to_timestamp($5/1000.0),to_timestamp($6/1000.0),$7)
         ON CONFLICT(term_key) DO UPDATE SET term=$2,kind=$3,freq=$4,last_seen=to_timestamp($6/1000.0),sample_urls=$7`,
        [k, e.term, e.kind, e.freq, e.first_seen, e.last_seen, e.sample_urls]);
    }
    if (KB._prune > 0) await c.query("DELETE FROM ckb_pulse WHERE last_seen < now() - ($1 || ' days')::interval", [String(KB._prune)]);
  } catch (e) { console.log('  (CKB supabase save failed:', String(e.message || e).slice(0, 60) + ')'); }
  finally { try { await c.end(); } catch (_) {} }
}

module.exports = { load, save, get, put, norm, bumpPulse, prunePulse, topPulse, supabaseUrl };
