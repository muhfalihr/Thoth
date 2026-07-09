// collect_comments.ts — fill content-set comments[] from MULTIPLE sources, not just one post.
//
// Comments are often empty because only one URL (or none) gets scraped. This dispatcher collects
// comments from: (1) the MAIN post, (2) relevant viral content already in the set (footage posts +
// videos), and (3) any --extra URL (e.g. the ORIGINAL Instagram post the topic came from — the user
// rule: "kalau topik dari postingan IG, ambil komentar dari postingan IG itu"). For each source it
// runs the matching per-platform scraper (which produces BOTH the crop AND the data), then merges +
// dedupes + caps. Reuses the proven scrapers — no refactor.
//
//   bun collect_comments.ts <content_set.json> [--per-source 6] [--cap 12] [--max-sources 4] [--extra url1,url2]
//
// Needs the relevant platform tabs attached + logged in (same as the standalone scrapers).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { outPath } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';
import { okCrop } from '../lib/crop_guard.ts';

const args = process.argv.slice(2);
const getFlag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const FILE = args.find((a, i) => !a.startsWith('--') && !['--per-source', '--cap', '--max-sources', '--extra'].includes(args[i - 1]));
const PER_SOURCE = parseInt(getFlag('--per-source', '6'), 10);
const CAP = parseInt(getFlag('--cap', '12'), 10);
const MAX_SOURCES = parseInt(getFlag('--max-sources', '4'), 10);
const EXTRA = (getFlag('--extra', '') || '').split(',').map(s => s.trim()).filter(Boolean);
if (!FILE) { console.log('Usage: bun collect_comments.ts <content_set.json> [--per-source 6] [--cap 12] [--max-sources 4] [--extra url1,url2]'); process.exit(1); }
if (!fs.existsSync(FILE)) { console.log(ui.red(`${ui.ERR} File tak ada: ${FILE}`)); process.exit(1); }

// platform → scraper script. (threads has no comment scraper → skipped.)
const SCRIPT = {
  tiktok: 'scrape_comments.ts', instagram: 'scrape_comments_ig.ts', twitter: 'scrape_comments_x.ts',
  youtube: 'scrape_comments_yt.ts', facebook: 'scrape_comments_fb.ts', reddit: 'scrape_comments_reddit.ts',
};
function platformOf(u) {
  u = u || '';
  if (/threads\.(com|net)/.test(u)) return null;        // no adapter
  if (/fbcdn\.net|cdninstagram\.com/.test(u)) return null; // raw CDN media, not a post page
  if (/tiktok\.com/.test(u)) return 'tiktok';
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/instagram\.com/.test(u)) return 'instagram';
  if (/(?:x|twitter)\.com/.test(u)) return 'twitter';
  if (/facebook\.com/.test(u)) return 'facebook';
  if (/reddit\.com/.test(u)) return 'reddit';
  return null;
}

const dedupeKey = c => `${(c.author || '').toLowerCase()}|${(c.text || '').trim().slice(0, 60).toLowerCase()}`;

(async () => {
  const set = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const main = set.main || {};
  const footage = set.footage || [];

  // Build the ordered, deduped source list: main post first, then relevant footage, then --extra.
  const mainPost = main.source_url || main.url || ''; // source_url = original post when main.url is a CDN/proxy
  const ranked = [
    mainPost,
    ...EXTRA,                                   // explicit origin (e.g. the IG reel the topic came from)
    ...footage.filter(f => !f.is_video).map(f => f.url),  // posts (X/IG/FB) → discussion
    ...footage.filter(f => f.is_video).map(f => f.url),   // videos (TikTok) → comments too
  ];
  const sources = [];
  const seenUrl = new Set();
  for (const u of ranked) {
    const plat = platformOf(u);
    if (!plat || !SCRIPT[plat]) continue;
    if (seenUrl.has(u)) continue; seenUrl.add(u);
    sources.push({ url: u, platform: plat });
    if (sources.length >= MAX_SOURCES) break;
  }

  console.log(ui.rule());
  console.log('  Collect Comments (multi-sumber)');
  console.log(ui.rule());
  if (!sources.length) { console.log(ui.amber(`${ui.WARN}  Tak ada sumber komentar yang punya scraper (threads/CDN di-skip). Pakai --extra <url>.`)); process.exit(0); }
  sources.forEach((s, i) => console.log(`  ${i + 1}. [${s.platform}] ${s.url.slice(0, 70)}`));

  const collected = [];
  for (const s of sources) {
    const tmp = `__cmt_${s.platform}_${Math.random().toString(36).slice(2, 8)}.json`;
    const tmpAbs = outPath(tmp);
    process.stdout.write(`\n• scrape [${s.platform}] … `);
    try {
      execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'scrapers', SCRIPT[s.platform]), s.url, tmp, '--max', String(PER_SOURCE)], { stdio: 'pipe', timeout: 180000 });
    } catch (e) { /* scraper may exit non-zero; still try to read its output */ }
    let got = [];
    try { const o = JSON.parse(fs.readFileSync(tmpAbs, 'utf8')); got = (o && o.comments) || []; } catch (e) {}
    try { fs.rmSync(tmpAbs); } catch (e) {}
    got.forEach(c => { c._src = s.url; c._platform = s.platform; });
    collected.push(...got);
    console.log(`+${got.length}`);
  }

  // Merge with any existing comments, dedupe, sort by likes, cap.
  const merged = [];
  const seen = new Set();
  for (const c of [...(set.comments || []), ...collected]) {
    const k = dedupeKey(c);
    if (!c.text || seen.has(k)) continue;
    seen.add(k);
    merged.push(c);
  }
  merged.sort((a, b) => (b.likes || 0) - (a.likes || 0));
  set.comments = merged.slice(0, CAP);

  // Strip any comment crop that's gone/black BEFORE hand-off. The merge above carries prior-run
  // comments forward, so a stale black crop (from before the density guard, or a deleted PNG) could
  // ride along and paste a black card into the video. Null it → Thoth draws its synthetic card.
  for (const c of set.comments) {
    if (!c.image_path) continue;
    let bad = !fs.existsSync(c.image_path);
    if (!bad) { try { bad = !okCrop(fs.readFileSync(c.image_path)); } catch (e) { bad = true; } }
    if (bad) { console.log(ui.amber(`  ${ui.WARN} crop komentar ${path.basename(c.image_path)} hilang/hitam → kartu sintetis`)); c.image_path = ''; }
  }

  fs.writeFileSync(FILE, JSON.stringify(set, null, 2), 'utf8');
  console.log('\n' + ui.rule('thin'));
  const withCrop = set.comments.filter(c => c.image_path).length;
  console.log(`Selesai: ${set.comments.length} komentar (${withCrop} ada crop) dari ${sources.length} sumber → ${FILE}`);
})();
