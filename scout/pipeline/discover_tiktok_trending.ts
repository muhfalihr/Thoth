// discover_tiktok_trending.js — scrape viral TOPICS from TikTok Studio's "Inspiration → Trending"
// (https://www.tiktok.com/tiktokstudio/inspiration/trending). This is TikTok's own ranking of what's
// hot RIGHT NOW (topic phrase + total views), a strong seed for what to make content about — used to
// ENRICH the topic pool in discover_reels (run it with `--tiktok`).
//
//   bun discover_tiktok_trending.js [--max 25] [--out file]
//
// Needs a logged-in tiktok.com tab attached (CDP relay). Output → output/tiktok_trending.json.
// Also exports fetchTrending({max}) so discover_reels can merge a `tiktok_trending` section.
//
// NOTE: the page's column layout uses obfuscated styled-components class names, so the row scraper is
// CLASS-AGNOSTIC: it finds rows by SHAPE — cell[0] = "<rank><title>", cell[1] = a view count
// (293M / 1.2B …). That survives TikTok's frequent class-hash churn.

import fs from 'node:fs';
import { connect, sleep, run } from '../lib/cdp.ts';
import { outPath } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';

const TRENDING_URL = 'https://www.tiktok.com/tiktokstudio/inspiration/trending';

// Local count parser — extends K/M to B (billion), which trending topics can reach and the shared
// normalizeLikes() (IG-tuned: k/rb/m/jt only) does not handle.
function parseViews(v) {
  const s = String(v || '').trim().toLowerCase();
  const num = (s.match(/\d[\d.,]*/) || [])[0];
  if (!num) return 0;
  const suf = (s.match(/[kmb]/) || [])[0] || '';
  let n = parseFloat(num.replace(/,/g, '')) || 0;
  if (suf === 'k') n *= 1e3; else if (suf === 'm') n *= 1e6; else if (suf === 'b') n *= 1e9;
  return Math.max(0, Math.round(n));
}

// Region filter is a custom dropdown (no <select>): a trigger leaf showing the current region;
// clicking it drops a column of region options. We detect both class-agnostically by SHAPE. The
// regex just has to recognise a region label (incl. the current selection) — broad list covers the
// majors; "All regions" is the unfiltered default.
const REGION_RE = "/^(All regions|Indonesia|United States|Japan|Brazil|Malaysia|Vietnam|Thailand|Philippines|South Korea|India|Mexico|United Kingdom|Germany|France|Russia|Turkey|Egypt|Italy|Spain|Argentina|Colombia|Canada|Australia|Saudi Arabia|United Arab Emirates|Netherlands|Poland|Pakistan|Bangladesh|Nigeria|Taiwan|Singapore)$/i";

// Current region = the TOPMOST region-looking leaf (the closed dropdown shows the selection).
async function readRegion(client) {
  const raw = await client.evaluate(`(() => {
    const RE = ${REGION_RE};
    let best = '', bt = 1e9;
    for (const el of document.querySelectorAll('span,div,li,button,p')) {
      if (el.children.length !== 0) continue;
      const t = (el.textContent || '').trim();
      if (!RE.test(t) || el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.top < bt) { bt = r.top; best = t; }
    }
    return best;
  })()`);
  return String(raw || '').trim();
}

// Ensure the trending list is filtered to `region`. No-op if already selected. Best-effort: returns
// { ok, changed, region } — a failure to switch leaves whatever was shown (caller still scrapes).
async function selectRegion(client, region) {
  const target = String(region || '').trim();
  if (!target || /^all$/i.test(target)) return { ok: true, changed: false, region: await readRegion(client) };
  const cur = await readRegion(client);
  if (cur && cur.toLowerCase() === target.toLowerCase()) return { ok: true, changed: false, region: cur };

  // Open the dropdown: click the topmost region leaf (the trigger).
  const opened = await client.evaluate(`(() => {
    const RE = ${REGION_RE};
    let best = null, bt = 1e9;
    for (const el of document.querySelectorAll('span,div,li,button,p')) {
      if (el.children.length !== 0) continue;
      const t = (el.textContent || '').trim();
      if (!RE.test(t) || el.offsetParent === null) continue;
      const r = el.getBoundingClientRect(); if (r.width < 8) continue;
      if (r.top < bt) { bt = r.top; best = el; }
    }
    if (!best) return 'no-trigger';
    best.click(); return 'ok';
  })()`);
  if (opened !== 'ok') return { ok: false, changed: false, region: cur };
  await sleep(1200);

  // Click the target option: the matching leaf with the LARGEST top (the menu sits BELOW the trigger).
  const picked = await client.evaluate(`(() => {
    const TARGET = ${JSON.stringify(target)}.toLowerCase();
    let best = null, bt = -1;
    for (const el of document.querySelectorAll('span,div,li,button,p')) {
      if (el.children.length !== 0) continue;
      if ((el.textContent || '').trim().toLowerCase() !== TARGET) continue;
      if (el.offsetParent === null) continue;
      const r = el.getBoundingClientRect(); if (r.width < 8) continue;
      if (r.top > bt) { bt = r.top; best = el; }
    }
    if (!best) return 'no-option';
    (best.closest('li,[role=option]') || best).click(); best.click(); return 'ok';
  })()`);
  if (picked !== 'ok') return { ok: false, changed: false, region: cur };
  await sleep(4000); // table reloads for the new region
  const now = await readRegion(client);
  return { ok: now.toLowerCase() === target.toLowerCase(), changed: true, region: now };
}

// Scrape the trending Topics table from an already-connected tiktok.com client, filtered to `region`.
async function scrapeTopics(client, max, region) {
  const here = await client.evaluate('location.href');
  if (!/inspiration\/trending/.test(String(here))) {
    await client.navigate(TRENDING_URL, 9000);
    await sleep(6000);
  }
  await sleep(1500);
  // Filter to the requested region (default Indonesia) before reading the list.
  if (region) {
    const reg = await selectRegion(client, region);
    if (reg.changed && reg.ok) console.log(`  region → ${reg.region}`);
    else if (reg.changed) console.log(ui.amber(`  ${ui.WARN}  region: gagal switch ke ${region} (sekarang ${reg.region || '?'})`));
    else if (reg.ok) console.log(`  region: ${reg.region || '?'} (sudah sesuai)`);
    else console.log(ui.amber(`  ${ui.WARN}  region: gagal buka filter — pakai ${reg.region || 'tampilan saat ini'}`));
    await sleep(1000);
  }
  // Lazy list — scroll to materialise more rows.
  for (let i = 0; i < 8; i++) { await client.evaluate('window.scrollBy(0, 1000)'); await sleep(800); }

  const raw = await client.evaluate(`(() => {
    const VIEWS = /^[\\d]+(?:[.,]\\d+)?\\s*[KMB]$/i;
    const seen = new Set(); const rows = [];
    for (const el of document.querySelectorAll('div,li,tr')) {
      const kids = Array.from(el.children);
      if (kids.length < 2) continue;
      const c0 = (kids[0].textContent || '').trim();
      const c1 = (kids[1].textContent || '').trim();
      if (!VIEWS.test(c1)) continue;                  // 2nd cell must be a view count
      const m = c0.match(/^(\\d{1,3})(\\D.+)$/);        // 1st cell = <rank><title>
      if (!m) continue;
      const rank = parseInt(m[1], 10);
      const title = m[2].trim();
      if (!title || title.length < 4 || rank < 1 || rank > 200) continue;
      if (seen.has(title)) continue; seen.add(title);
      rows.push({ rank, title: title.slice(0, 120), views: c1 });
    }
    rows.sort((a, b) => a.rank - b.rank);
    return JSON.stringify(rows);
  })()`);
  let list = []; try { list = JSON.parse(raw || '[]'); } catch (e) {}
  return list.slice(0, max).map(r => ({ ...r, views_n: parseViews(r.views) }));
}

// Connect to a tiktok.com tab, scrape, disconnect. Best-effort → [] on failure (never throws into
// the caller so discover_reels' IG run is unaffected by a TikTok hiccup).
async function fetchTrending({ max = 25, region = 'Indonesia' } = {}) {
  let client;
  try {
    client = await connect({ match: 'tiktok.com', requireMatch: true });
    try { await client.cmd('Page.bringToFront'); } catch (e) {}
    return await scrapeTopics(client, max, region);
  } catch (e) {
    console.log(ui.amber(`${ui.WARN}  TikTok trending gagal: ${String(e.message || e).slice(0, 80)} (butuh tab tiktok.com login)`));
    return [];
  } finally {
    if (client) { try { client.close(); } catch (e) {} }
  }
}

export { fetchTrending, scrapeTopics, selectRegion, readRegion, parseViews, TRENDING_URL };

if (import.meta.main) {
  const args = process.argv.slice(2);
  const getFlag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const MAX = parseInt(getFlag('--max', '25'), 10);
  const OUT = getFlag('--out', null);
  const REGION = getFlag('--region', 'Indonesia');   // 'all' / 'All regions' = unfiltered
  run(async () => {
    console.log(ui.rule());
    console.log('  TikTok Studio — Trending Topics (Inspiration)');
    console.log(ui.rule());
    console.log('Region:', REGION);
    const topics = await fetchTrending({ max: MAX, region: REGION });
    const out = OUT || outPath('tiktok_trending.json');
    fs.writeFileSync(out, JSON.stringify(
      { fetched_at: new Date().toISOString(), source: TRENDING_URL, region: REGION, topics }, null, 2), 'utf8');
    console.log(`\n${topics.length} topik trending:`);
    topics.slice(0, 20).forEach(t => console.log(`  ${t.rank}. [${t.views}] ${t.title}`));
    console.log(`📄 ${out}`);
  });
}
