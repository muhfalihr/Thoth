// discover_topics.js — pull REAL trending topics from the logged-in browser via CDP, so topic
// discovery is a tested script instead of an LLM-only procedure. Sources (each independent; a
// platform whose tab isn't attached is skipped, never aborts the rest):
//   - Instagram : recent reels of a CURATED account set (ig_accounts.json) → caption = topic,
//                 reel URL = source_url (usable as run_topic --main). PRIMARY/default source.
//   - X/Twitter : /explore/tabs/trending  → [data-testid="trend"] (clean topic/hashtag names)
//   - YouTube   : home feed (YouTube killed /feed/trending → redirects home) → popular video
//                 titles + URLs (a topic PROXY: recommended/popular, not strictly "trending")
//
//   node discover_topics.js [--top N] [--platforms instagram,x,youtube] [--per-account N]
//   (default --platforms instagram; edit ig_accounts.json to change the account set)
//
// Output → output/trending_topics.json { fetched_at, sources:{ instagram:[{topic,source_url,account,views}], ... } }.

import fs from 'node:fs';
import path from 'node:path';
import { connect, sleep } from '../lib/cdp.ts';
import { igProfileReels } from '../scrapers/ig_profile.ts';
import { outPath } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';

const args = process.argv.slice(2);
const getFlag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const TOP = parseInt(getFlag('--top', '15'), 10);
// Instagram is the primary source now: a curated set of accounts (ig_accounts.json)
// whose recent reels DEFINE the topic candidates. X/YouTube remain opt-in via --platforms.
const PLATFORMS = (getFlag('--platforms', 'instagram')).split(',').map(s => s.trim()).filter(Boolean);
const PER_ACCOUNT = parseInt(getFlag('--per-account', '3'), 10); // top reels per IG account
const IG_ACCOUNTS_FILE = path.join(import.meta.dirname, '..', 'config', 'ig_accounts.json');

// Exclude football/soccer topics by default (--include-football to keep them). Catches football
// terms + "X vs Y" versus-match style (e.g. "Indonesia Vs Vietnam", which has no football word).
const EXCLUDE_FOOTBALL = !args.includes('--include-football');
// Distinctive terms match as substrings (so concatenated hashtags like "#PialaAFF2026" are caught);
// short/ambiguous tokens keep \b boundaries to avoid false positives (aff≠affair, vs, gol≠golf).
const FOOTBALL_RE = /(sepak ?bola|timnas|piala|persib|persija|persebaya|arema|futsal|fifa|uefa|el ?clasico|champions ?league|premier ?league|real ?madrid|barcelona|manchester|arsenal|liverpool|chelsea|juventus|football|soccer|\baff\b|\bliga\b|\bgol\b|\bkiper\b|\bwasit\b|\bgawang\b|\bgaruda\b|\bvs\b|\bu-?1[579]\b|\bu-?2[13]\b)/i;
const isFootball = t => FOOTBALL_RE.test(t || '');

// X trending: each [data-testid="trend"] has a few spans (category, name, "N posts"). The topic
// name is the longest span that isn't meta.
const X_EXTRACT = `(() => {
  const out = [];
  document.querySelectorAll('[data-testid="trend"]').forEach(el => {
    const spans = Array.from(el.querySelectorAll('span')).map(s => s.innerText.trim()).filter(Boolean);
    const name = spans.find(s => !/posts|trending|·|^Trending/i.test(s) && s.length > 2) || spans[0] || '';
    if (name) out.push(name);
  });
  return JSON.stringify([...new Set(out)]);
})()`;

// YouTube home/popular: any /watch?v= link that carries a real title. Works across the current
// lockup layout (a.title / aria-label / innerText). Dedupe by video URL.
const YT_EXTRACT = `(() => {
  const out = []; const seen = new Set();
  document.querySelectorAll('a[href*="/watch?v="]').forEach(a => {
    const title = (a.getAttribute('title') || a.getAttribute('aria-label') || a.innerText || '').trim();
    const href = new URL(a.getAttribute('href'), location.origin).href.split('&')[0];
    if (title.length > 10 && !seen.has(href)) { seen.add(href); out.push({ topic: title, url: href }); }
  });
  return JSON.stringify(out);
})()`;

async function fromX() {
  const c = await connect({ match: ['x.com', 'twitter.com'], requireMatch: true });
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    await c.navigate('https://x.com/explore/tabs/trending', 6000);
    await sleep(2000);
    let raw = []; try { raw = JSON.parse(await c.evaluate(X_EXTRACT) || '[]'); } catch (e) {}
    return raw.slice(0, TOP).map(topic => ({ topic, source_url: 'https://x.com/explore/tabs/trending' }));
  } finally { c.close(); }
}

async function fromYouTube() {
  const c = await connect({ match: 'youtube.com', requireMatch: true });
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    await c.navigate('https://www.youtube.com/', 6000); // /feed/trending now redirects here
    await sleep(2500);
    let raw = []; try { raw = JSON.parse(await c.evaluate(YT_EXTRACT) || '[]'); } catch (e) {}
    return raw.slice(0, TOP).map(o => ({ ...o, source_url: o.url }));
  } finally { c.close(); }
}

// Load the curated IG account handles (strips @, full URLs, trailing path).
function loadIgAccounts() {
  try {
    const j = JSON.parse(fs.readFileSync(IG_ACCOUNTS_FILE, 'utf8'));
    const arr = Array.isArray(j) ? j : (j.accounts || []);
    return arr
      .map(s => String(s).trim()
        .replace(/^@/, '')
        .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
        .replace(/[/?#].*$/, ''))
      .filter(Boolean);
  } catch (e) { return []; }
}

// Instagram: the topic candidates ARE the recent reels of a fixed account set.
// Each reel's caption = the topic; source_url = the reel (usable as run_topic --main).
// ONE shared CDP client drives the instagram tab across all accounts.
async function fromInstagram() {
  const accounts = loadIgAccounts();
  if (!accounts.length) {
    console.log(`(${IG_ACCOUNTS_FILE} kosong/absen — isi daftar akun dulu)`);
    return [];
  }
  const c = await connect({ match: 'instagram.com', requireMatch: true });
  const out = [];
  try {
    for (const acct of accounts) {
      process.stdout.write(`\n    @${acct} ... `);
      try {
        const reels = await igProfileReels(acct, { max: PER_ACCOUNT, captions: true, client: c });
        let n = 0;
        for (const r of reels) {
          const cap = (r.caption || '').replace(/\s+/g, ' ').trim();
          if (!cap) continue; // no caption → no topic signal
          out.push({ topic: cap.slice(0, 160), source_url: r.url, account: acct, views: r.views });
          n++;
        }
        process.stdout.write(n ? `${n} reel (top views ${reels[0] ? reels[0].views.toLocaleString() : 0})` : 'kosong');
      } catch (e) {
        process.stdout.write(`skip (${String(e && e.message || e).slice(0, 45)})`);
      }
    }
  } finally { c.close(); }
  process.stdout.write('\n  ');
  out.sort((a, b) => b.views - a.views); // viral-first across all accounts
  return out.slice(0, TOP);
}

(async () => {
  console.log(ui.rule());
  console.log('  Discover Topics (trending, DOM/CDP)');
  console.log(ui.rule());
  const sources = {};
  const jobs = { x: fromX, youtube: fromYouTube, instagram: fromInstagram };
  for (const p of PLATFORMS) {
    const fn = jobs[p];
    if (!fn) { console.log(`• ${p}: tak didukung (pilih: instagram, x, youtube)`); continue; }
    process.stdout.write(`• ${p}: ambil ${p === 'instagram' ? 'reels akun terkurasi' : 'trending'} ... `);
    try {
      const raw = await fn();
      const items = EXCLUDE_FOOTBALL ? raw.filter(it => !isFootball(it.topic)) : raw;
      const dropped = raw.length - items.length;
      sources[p] = items;
      console.log(ui.gold(`${ui.OK} ${items.length}${dropped ? ` (${dropped} sepak bola di-skip)` : ''}`));
      items.slice(0, 8).forEach((it, i) => console.log(
        `    ${i + 1}. ${it.account ? `[@${it.account}·${(it.views || 0).toLocaleString()}] ` : ''}${it.topic}`));
    } catch (err) {
      sources[p] = [];
      if (err && err.relay) console.log(ui.amber(`${ui.WARN}  tab ${p} belum ter-attach relay (skip)`));
      else console.log(ui.amber(`${ui.WARN}  ${err && err.message ? err.message.slice(0, 60) : err}`));
    }
  }
  const out = outPath('trending_topics.json');
  fs.writeFileSync(out, JSON.stringify({ fetched_at: new Date().toISOString(), sources }, null, 2), 'utf8');
  console.log(ui.rule('thin'));
  console.log(`📄 ${out}`);
  console.log('Lanjut: node topic_to_urls.ts "<topik pilihan>"');
})();
