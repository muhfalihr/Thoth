// pulse_harvest.js — Cultural Pulse Harvester. Scans the trending feed ALREADY discovered by the tool
// (reel_topics.json .reels[] — i.e. what scanning real accounts surfaced, NOT an external trend index),
// scrapes top comments from a BUDGET of those videos, and distills the RECURRING entities/memes/phrases
// across them into CKB.pulse. This is "trend from actually watching" — the discourse, not the view count.
// Run daily (cron). Algorithm: RESEARCH_context_enrichment_narration.md §4 (budget + cache-first + decay).
//
//   node pulse_harvest.js [--max 12] [--per-video 12] [--src output/reel_topics.json] [--ttl 30]
//
// Best-effort: missing feed / no relay / scrape fail → that video is skipped. Needs logged-in tabs for
// the platforms scraped (same as collect_comments). Uses Novita (.novita_key) for term distillation.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ckb = require('./ckb');
const { outPath } = require('./paths');

const args = process.argv.slice(2);
const getFlag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MAX = parseInt(getFlag('--max', '12'), 10);
const PER_VIDEO = parseInt(getFlag('--per-video', '12'), 10);
const TTL_DAYS = parseFloat(getFlag('--ttl', '30'));
const MIN_FREQ = parseInt(getFlag('--min-freq', '2'), 10); // term must recur across ≥N videos to count as trending
const SRC = getFlag('--src', outPath('reel_topics.json'));

const KEY = (() => { const f = path.join(__dirname, '.novita_key'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : ''; })();
const MODEL = process.env.THOTH_CONTEXT_MODEL || 'deepseek/deepseek-v3.1';

const SCRIPT = {
  tiktok: 'scrape_comments.js', instagram: 'scrape_comments_ig.js', twitter: 'scrape_comments_x.js',
  youtube: 'scrape_comments_yt.js', facebook: 'scrape_comments_fb.js',
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
  try { execFileSync('node', [path.join(__dirname, SCRIPT[plat]), url, tmp, '--max', String(PER_VIDEO)], { stdio: 'pipe', timeout: 180000 }); }
  catch (e) { /* tolerated */ }
  let comments = [];
  try { comments = (JSON.parse(fs.readFileSync(tmp, 'utf8')).comments) || []; } catch (e) {}
  try { fs.rmSync(tmp); } catch (e) {}
  return comments.map(c => (c.text || '').trim()).filter(Boolean);
}

// Distil recurring cultural terms from the whole harvested corpus (one LLM call).
async function distil(corpus) {
  if (!KEY || !corpus.trim()) return [];
  const prompt = `Dari KUMPULAN KOMENTAR lintas banyak video trending Indonesia di bawah, ekstrak ISTILAH
yang SEDANG RAMAI / berulang: meme, kata kode/satir (mis. "konoha"), nama tokoh/brand yang ramai
dibahas, frasa/jargon viral. Fokus yang DISTINKTIF & berulang, abaikan kata umum. Tiap item:
{"term","kind":"person|org|event|meme|slang|phrase"}. Maks 20.

KOMENTAR:
${corpus.slice(0, 6000)}

Keluarkan HANYA JSON: {"terms":[{"term":"","kind":""}]}`;
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, max_tokens: 1000, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!resp.ok) return [];
    const d = await resp.json();
    const txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    const m = txt.match(/\{[\s\S]*\}/); if (!m) return [];
    const o = JSON.parse(m[0]);
    return (Array.isArray(o.terms) ? o.terms : []).map(t => ({ term: String(t.term || '').trim(), kind: String(t.kind || '').trim().toLowerCase() })).filter(t => t.term);
  } catch (e) { return []; }
}

(async () => {
  console.log('='.repeat(60));
  console.log('  Cultural Pulse Harvester');
  console.log('='.repeat(60));
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
  const terms = await distil(corpus);
  console.log(`Distilasi: ${terms.length} kandidat istilah`);

  // Frequency = # of videos whose corpus contains the term (recurring across content = trending).
  const KB = ckb.load();
  let kept = 0;
  for (const t of terms) {
    const tl = t.term.toLowerCase();
    const hits = perVideo.filter(v => v.text.includes(tl));
    if (hits.length < MIN_FREQ) continue; // must recur across ≥MIN_FREQ videos
    ckb.bumpPulse(KB, t.term, t.kind, hits.length, hits.map(h => h.url));
    kept++;
  }
  ckb.prunePulse(KB, TTL_DAYS);
  ckb.save(KB);

  const top = ckb.topPulse(KB, 12);
  console.log('-'.repeat(60));
  console.log(`Pulse: +${kept} istilah berulang (dari ${terms.length}). Top sekarang:`);
  top.forEach((p, i) => console.log(`  ${i + 1}. ${p.term} [${p.kind}]  freq=${p.freq} score=${p.score.toFixed(1)}`));
  console.log(`📄 CKB: ${ckb.CKB_PATH}`);
})();
