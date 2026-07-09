// pulse_harvest.ts — Cultural Pulse Harvester. Scans the trending feed ALREADY discovered by the tool
// (reel_topics.json .reels[] — i.e. what scanning real accounts surfaced, NOT an external trend index),
// scrapes top comments from a BUDGET of those videos, and distills the RECURRING entities/memes/phrases
// across them into CKB.pulse. This is "trend from actually watching" — the discourse, not the view count.
// Run daily (cron). Algorithm: RESEARCH_context_enrichment_narration.md §4 (budget + cache-first + decay).
//
//   bun pulse_harvest.ts [--max 12] [--per-video 12] [--src output/reel_topics.json] [--ttl 30]
//
// Best-effort: missing feed / no relay / scrape fail → that video is skipped. Needs logged-in tabs for
// the platforms scraped (same as collect_comments). Uses Novita (THOTH_NOVITA_API_KEY via lib/env.ts) for term distillation.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as ckb from './ckb.ts';
import { outPath } from '../lib/paths.ts';

const args = process.argv.slice(2);
const getFlag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MAX = parseInt(getFlag('--max', '12'), 10);
const PER_VIDEO = parseInt(getFlag('--per-video', '12'), 10);
const TTL_DAYS = parseFloat(getFlag('--ttl', '30'));
const MIN_FREQ = parseInt(getFlag('--min-freq', '2'), 10); // term must recur across ≥N videos to count as trending
const SRC = getFlag('--src', outPath('reel_topics.json'));

import { novitaKey } from '../lib/env.ts';
import { ui } from '../lib/ui.ts';
const KEY = novitaKey();
const MODEL = process.env.THOTH_CONTEXT_MODEL || 'deepseek/deepseek-v3.1';

const SCRIPT = {
  tiktok: 'scrape_comments.ts', instagram: 'scrape_comments_ig.ts', twitter: 'scrape_comments_x.ts',
  youtube: 'scrape_comments_yt.ts', facebook: 'scrape_comments_fb.ts',
};
const platformOf = u => /tiktok\.com/.test(u) ? 'tiktok' : /instagram\.com/.test(u) ? 'instagram'
  : /(?:x|twitter)\.com/.test(u) ? 'twitter' : /youtube\.com|youtu\.be/.test(u) ? 'youtube'
  : /facebook\.com/.test(u) ? 'facebook' : '';

// Pull candidate trending videos from the discovery feed (reels[] = scanned accounts).
function loadFeed() {
  let j; try { j = JSON.parse(fs.readFileSync(SRC, 'utf8')); } catch (e) { return []; }
  const reels = Array.isArray(j.reels) ? j.reels : (Array.isArray(j.urls) ? j.urls : []);
  const seen = new Set();
  return reels
    .map(r => ({ url: r.url || '', topic: r.topic || r.caption || '' }))
    .filter(r => r.url && platformOf(r.url) && SCRIPT[platformOf(r.url)] && !seen.has(r.url) && seen.add(r.url))
    .slice(0, MAX);
}

function scrapeComments(url) {
  const plat = platformOf(url);
  const tmp = outPath(`__pulse_${plat}_${Math.random().toString(36).slice(2, 8)}.json`);
  try { execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'scrapers', SCRIPT[plat]), url, tmp, '--max', String(PER_VIDEO)], { stdio: 'pipe', timeout: 180000 }); }
  catch (e) { /* tolerated */ }
  let comments = [];
  try { comments = (JSON.parse(fs.readFileSync(tmp, 'utf8')).comments) || []; } catch (e) {}
  try { fs.rmSync(tmp); } catch (e) {}
  return comments.map(c => (c.text || '').trim()).filter(Boolean);
}

// Distil recurring cultural terms + a current-register snapshot from the corpus (one LLM call).
// Returns { terms:[{term,kind}], register:[phrasing,...] }.
async function distil(corpus) {
  const empty = { terms: [], register: [] };
  if (!KEY || !corpus.trim()) return empty;
  const prompt = `Dari KUMPULAN KOMENTAR lintas banyak video trending Indonesia di bawah:
1. terms: ISTILAH yang SEDANG RAMAI / berulang — meme, kata kode/satir (mis. "konoha"), nama
   tokoh/brand yang ramai dibahas, jargon viral. DISTINKTIF & berulang, abaikan kata umum. Maks 20.
   Tiap item {"term","kind":"person|org|event|meme|slang|phrase"}.
2. register: 5-8 FRASA/INTERJEKSI/GAYA BAHASA kasual yang lagi sering dipakai warganet (mis. cara
   buka kalimat, slang seru, pola ekspresi) — BUKAN topik, tapi NADA/diksi. Array string pendek.

KOMENTAR:
${corpus.slice(0, 6000)}

Keluarkan HANYA JSON: {"terms":[{"term":"","kind":""}],"register":[""]}`;
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, max_tokens: 1000, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!resp.ok) return empty;
    const d = await resp.json();
    const txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    const m = txt.match(/\{[\s\S]*\}/); if (!m) return empty;
    const o = JSON.parse(m[0]);
    return {
      terms: (Array.isArray(o.terms) ? o.terms : []).map(t => ({ term: String(t.term || '').trim(), kind: String(t.kind || '').trim().toLowerCase() })).filter(t => t.term),
      register: (Array.isArray(o.register) ? o.register : []).map(s => String(s).trim()).filter(Boolean).slice(0, 10),
    };
  } catch (e) { return empty; }
}

(async () => {
  console.log(ui.rule());
  console.log('  Cultural Pulse Harvester');
  console.log(ui.rule());
  const feed = loadFeed();
  if (!feed.length) { console.log(`Tak ada video di feed (${SRC}). Jalankan discover_reels dulu.`); process.exit(0); }
  console.log(`Feed: ${feed.length} video (budget --max ${MAX}, --per-video ${PER_VIDEO})`);

  const perVideo = []; // [{url, text}]
  for (const v of feed) {
    process.stdout.write(`• [${platformOf(v.url)}] ${v.url.slice(0, 50)} … `);
    const texts = scrapeComments(v.url);
    const blob = (v.topic + ' ' + texts.join(' • ')).toLowerCase();
    perVideo.push({ url: v.url, text: blob });
    console.log(`${texts.length} komentar`);
  }

  const corpus = perVideo.map(v => v.text).join('\n');
  const { terms, register } = await distil(corpus);
  console.log(`Distilasi: ${terms.length} kandidat istilah, ${register.length} frasa register`);

  // Frequency = # of videos whose corpus contains the term (recurring across content = trending).
  const KB = await ckb.load();
  let kept = 0;
  for (const t of terms) {
    const tl = t.term.toLowerCase();
    const hits = perVideo.filter(v => v.text.includes(tl));
    if (hits.length < MIN_FREQ) continue; // must recur across ≥MIN_FREQ videos
    ckb.bumpPulse(KB, t.term, t.kind, hits.length, hits.map(h => h.url));
    kept++;
  }
  if (register.length) ckb.setRegister(KB, register);
  ckb.prunePulse(KB, TTL_DAYS);
  await ckb.save(KB);

  const top = ckb.topPulse(KB, 12);
  console.log(ui.rule('thin'));
  console.log(`Pulse: +${kept} istilah berulang (dari ${terms.length}). Top sekarang:`);
  top.forEach((p, i) => console.log(`  ${i + 1}. ${p.term} [${p.kind}]  freq=${p.freq} score=${p.score.toFixed(1)}`));
  console.log(`📄 CKB: ${ckb.LOCAL_PATH}`);
})();
