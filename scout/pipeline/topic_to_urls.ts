// topic_to_urls.ts — ONE topic → REAL post URLs across platforms, in one tested command.
//
//   bun topic_to_urls.ts "<query>" [--platforms tiktok,tw,ig,fb] [--max N] [--keywords "a b"]
//
// Output → output/topic_urls_<slug>.json { query, fetched_at, platforms:{...}, all:[...] }.
//
// tw/ig/fb route through scrapers/search_social_v2.ts's searchPlatform(), which navigates via
// AcquisitionService.browse() (one navigation per canonical URL per run, globally serialized —
// see service.ts) and confirms each hit via inspectPost(). No adapter implements
// DiscoveryRequest.kind:'query' (instagram.ts/twitter.ts/facebook.ts all defer keyword search
// to search_social_v2.ts by design — see each adapter's discover() comment), so this is the
// correct owner, not a workaround.
//
// tiktok keeps its own dedicated subprocess (search_tiktok_v2.ts, unmigrated raw-CDP script,
// out of this task's scope) — run via execFileSync, which blocks until it exits, so it never
// overlaps the tw/ig/fb browse() calls above (the per-platform loop below is sequential):
// global navigation concurrency stays at one across both code paths even though tiktok isn't
// using the shared coordinator internally.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { outPath } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';
import {
  createStandaloneAcquisitionContext,
  runAcquisitionCli,
  searchPlatform,
} from '../acquisition/index.ts';
import type { SearchContext, SearchPlatformKey } from '../acquisition/index.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const here = (f: string) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scrapers', f);

const args = process.argv.slice(2);
const getFlag = (n: string, d: string) => {
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

if (!QUERY) {
  console.log('Usage: bun topic_to_urls.ts "<query>" [--platforms tiktok,tw,ig,fb] [--max N]');
  process.exit(1);
}

// Primary keyword → caption-gate TikTok search at source (drops generic-feed spam). Default =
// first word of the query. search_tiktok_v2 gates with ALL keywords, so pass ONLY the primary
// entity to stay lenient; finer relevance is re-checked downstream (urls_to_contentset, mode
// "any").
const KEYWORDS = (getFlag('--keywords', '') || QUERY).split(/[ ,]+/).filter(Boolean);
const TT_KW = KEYWORDS[0] || '';

const slug =
  QUERY.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'topic';

// Blocking subprocess call: runs search_tiktok_v2.ts to completion (its own dedicated CDP
// session, outside the acquisition kernel — unmigrated, out of this task's scope), then reads
// back the JSON file it wrote. Sequential with the loop below → no overlap with browse()'s
// in-process navigations.
function runTikTokFetcher(query: string, keyword: string): string[] {
  const scriptArgs = [here('search_tiktok_v2.ts'), query, ...(keyword ? [keyword] : [])];
  execFileSync(process.execPath, scriptArgs, { stdio: 'pipe', timeout: 150000 });
  const data = JSON.parse(fs.readFileSync(outPath('tiktok_urls.json'), 'utf8'));
  return (data.urls || []).map((u: unknown) => (typeof u === 'string' ? u : (u as { url?: string })?.url)).filter(Boolean);
}

if (import.meta.main) {
  runAcquisitionCli(async () => {
    const context = await createStandaloneAcquisitionContext();
    console.log(ui.rule());
    console.log('  Topic → URLs (query sama lintas platform)');
    console.log(ui.rule());
    console.log('Query:', QUERY, '| platforms:', PLATFORMS.join(','), '| max/platform:', MAX);

    const searchCtx: SearchContext = context.service;
    const fetchOne = async (p: string): Promise<string[]> => {
      if (p === 'tiktok') return runTikTokFetcher(QUERY, TT_KW);
      if (p === 'tw' || p === 'ig' || p === 'fb') {
        const result = await searchPlatform(searchCtx, p as SearchPlatformKey, QUERY, MAX);
        return result.urls;
      }
      throw new Error(`tak didukung (pilih: tiktok, tw, ig, fb)`);
    };

    const platforms: Record<string, string[]> = {};
    for (const p of PLATFORMS) {
      process.stdout.write(`• ${p}: cari "${QUERY}" ... `);
      try {
        // Retry-on-zero: a platform sometimes returns 0 mid-pipeline (relay/tab hiccup) even though
        // the content exists — one retry after a short pause recovers it (avoids a non-video main).
        let urls = (await fetchOne(p)).slice(0, MAX);
        if (!urls.length) {
          await sleep(2500);
          const r = (await fetchOne(p)).slice(0, MAX);
          if (r.length) {
            urls = r;
            process.stdout.write('(retry) ');
          }
        }
        platforms[p] = urls;
        console.log(ui.gold(`${ui.OK} ${urls.length} URL`));
      } catch (err) {
        platforms[p] = [];
        // Friendlier hint for the common "managed Chromium/CDP relay isn't up" failure mode,
        // recovered from the pre-kernel version — a raw ECONNREFUSED/port message is confusing,
        // this names the actual fix (open the tab / start the managed browser).
        const relay = /1880\d|18792|ECONNREFUSED/.test(String((err as Error)?.message || err));
        console.log(
          ui.amber(
            relay
              ? `${ui.WARN}  tab ${p} belum terbuka/login di managed browser (skip)`
              : `${ui.WARN}  ${String((err as Error).message || err).slice(0, 90)}`,
          ),
        );
      }
    }

    // Flat list with platform tags (handy for building footage[]).
    const canon: Record<string, string> = {
      tw: 'twitter',
      ig: 'instagram',
      fb: 'facebook',
      tiktok: 'tiktok',
      threads: 'threads',
    };
    const all: { platform: string; url: string }[] = [];
    for (const [p, urls] of Object.entries(platforms))
      urls.forEach((url) => all.push({ platform: canon[p] || p, url }));

    const out = outPath(`topic_urls_${slug}.json`);
    fs.writeFileSync(
      out,
      JSON.stringify({ query: QUERY, fetched_at: new Date().toISOString(), platforms, all }, null, 2),
      'utf8',
    );
    console.log(ui.rule('thin'));
    console.log(`Total: ${all.length} URL → ${out}`);
  });
}
