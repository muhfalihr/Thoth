// topic_to_urls.ts — ONE topic → REAL post URLs across platforms, in one tested command.
// Orchestrates the proven per-platform fetchers (same query everywhere) and merges their output:
//   - TikTok    : search_tiktok_v2.ts  (href /video/{id} + caption gate)      → output/tiktok_urls.json
//   - Twitter/X : search_social_v2.ts tw (canonical /status/{id} from DOM)     → output/tw_urls.json
//   - Instagram : search_social_v2.ts ig (canonical /p/ from DOM)             → output/ig_urls.json
//   - Facebook  : inline CDP search (/search/posts?q=) → real permalinks
// Each platform is isolated: a missing/!attached tab is logged and SKIPPED, never aborts the rest.
//
//   bun topic_to_urls.ts "<query>" [--platforms tiktok,tw,ig,fb] [--max N]
//
// Output → output/topic_urls_<slug>.json { query, fetched_at, platforms:{...}, all:[...] }.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connect, sleep } from '../lib/cdp.ts';
import { outPath } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';

const args = process.argv.slice(2);
const getFlag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const QUERY = args.find(
  (a) =>
    !a.startsWith('--') &&
    !['--platforms', '--max', '--keywords'].includes(args[args.indexOf(a) - 1]),
);
const PLATFORMS = getFlag('--platforms', 'tiktok,tw,ig,fb')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MAX = parseInt(getFlag('--max', '8'), 10);
// Primary keyword → caption-gate TikTok search at source (drops generic-feed spam). Default = first
// word of the query. search_tiktok_v2 gates with ALL keywords, so pass ONLY the primary entity to
// stay lenient; finer relevance is re-checked downstream (urls_to_contentset, mode "any").
const KEYWORDS = (getFlag('--keywords', '') || QUERY).split(/[ ,]+/).filter(Boolean);
const TT_KW = KEYWORDS[0] || '';

if (!QUERY) {
  console.log('Usage: bun topic_to_urls.ts "<query>" [--platforms tiktok,tw,ig,fb] [--max N]');
  process.exit(1);
}

const slug =
  QUERY.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'topic';
const here = (f) => path.join(import.meta.dirname, '..', 'scrapers', f); // fetchers live in scrapers/

// Run a tested CLI fetcher, then read the JSON file it wrote. Returns string[] of URLs.
function runFetcher(scriptArgs, outFile) {
  execFileSync(process.execPath, [here(scriptArgs[0]), ...scriptArgs.slice(1)], {
    stdio: 'pipe',
    timeout: 150000,
  });
  if (!fs.existsSync(outFile)) return [];
  const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  return (data.urls || []).map((u) => (typeof u === 'string' ? u : u.url)).filter(Boolean);
}

const FETCHERS = {
  tiktok: () =>
    runFetcher(
      ['search_tiktok_v2.ts', QUERY, ...(TT_KW ? [TT_KW] : [])],
      outPath('tiktok_urls.json'),
    ),
  tw: () => runFetcher(['search_social_v2.ts', 'tw', QUERY], outPath('tw_urls.json')),
  ig: () => runFetcher(['search_social_v2.ts', 'ig', QUERY], outPath('ig_urls.json')),
  fb: fbSearch, // inline (no standalone FB search script)
};

// Facebook post search via the logged-in tab: /search/posts?q= → real permalinks.
async function fbSearch() {
  const c = await connect({ match: 'facebook.com', requireMatch: true });
  try {
    try {
      await c.cmd('Page.bringToFront');
    } catch (e) {}
    await c.navigate('https://www.facebook.com/search/posts?q=' + encodeURIComponent(QUERY), 7000);
    await sleep(3000);
    const raw = await c.evaluate(`(() => {
      const re = /\\/(posts|permalink\\.php|share\\/p|groups\\/\\d+\\/posts)\\//;
      const set = new Set();
      Array.from(document.querySelectorAll('a[href]')).forEach(a => {
        const h = a.getAttribute('href') || '';
        if (re.test(h) || h.includes('story_fbid')) set.add(new URL(h, location.origin).href.split('?')[0].split('&')[0]);
      });
      return JSON.stringify(Array.from(set));
    })()`);
    let urls = [];
    try {
      urls = JSON.parse(raw || '[]');
    } catch (e) {}
    return urls;
  } finally {
    c.close();
  }
}

(async () => {
  console.log(ui.rule());
  console.log('  Topic → URLs (query sama lintas platform)');
  console.log(ui.rule());
  console.log('Query:', QUERY, '| platforms:', PLATFORMS.join(','), '| max/platform:', MAX);

  const platforms = {};
  for (const p of PLATFORMS) {
    const fn = FETCHERS[p];
    if (!fn) {
      console.log(`• ${p}: tak didukung (pilih: tiktok, tw, ig, fb)`);
      continue;
    }
    process.stdout.write(`• ${p}: cari "${QUERY}" ... `);
    try {
      // Retry-on-zero: a platform sometimes returns 0 mid-pipeline (relay/tab hiccup) even though
      // the content exists — one retry after a short pause recovers it (avoids a non-video main).
      let urls = (await fn()).slice(0, MAX);
      if (!urls.length) {
        await sleep(2500);
        const r = (await fn()).slice(0, MAX);
        if (r.length) {
          urls = r;
          process.stdout.write('(retry) ');
        }
      }
      platforms[p] = urls;
      console.log(ui.gold(`${ui.OK} ${urls.length} URL`));
    } catch (err) {
      platforms[p] = [];
      const relay =
        err &&
        (err.relay || /1880\d|18792|ECONNREFUSED|terbuka|CDP/.test(String(err.message || err)));
      console.log(
        ui.amber(
          relay
            ? `${ui.WARN}  tab ${p} belum terbuka/login di managed browser (skip)`
            : `${ui.WARN}  ${String((err && err.message) || err).slice(0, 70)}`,
        ),
      );
    }
  }

  // Flat list with platform tags (handy for building footage[]).
  const canon = {
    tw: 'twitter',
    ig: 'instagram',
    fb: 'facebook',
    tiktok: 'tiktok',
    threads: 'threads',
  };
  const all = [];
  for (const [p, urls] of Object.entries<any>(platforms))
    urls.forEach((url) => all.push({ platform: canon[p] || p, url }));

  const out = outPath(`topic_urls_${slug}.json`);
  fs.writeFileSync(
    out,
    JSON.stringify({ query: QUERY, fetched_at: new Date().toISOString(), platforms, all }, null, 2),
    'utf8',
  );
  console.log(ui.rule('thin'));
  console.log(`Total: ${all.length} URL → ${out}`);
})();
