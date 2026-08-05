// topic_to_urls.ts — ONE topic → REAL post URLs across platforms, in one tested command.
// Routes the same query through AcquisitionService.discover({kind:'query'}) per selected
// platform and merges the results (canonical_url per PostRecord). Each platform is isolated: a
// discover() failure (including "kind not supported" — see the disclosure below) is logged and
// SKIPPED, never aborts the rest.
//
//   bun topic_to_urls.ts "<query>" [--platforms tiktok,tw,ig,fb] [--max N]
//
// Output → output/topic_urls_<slug>.json { query, fetched_at, platforms:{...}, all:[...] }.
//
// ponytail/DISCLOSED REGRESSION: as of Task 13, no adapter (instagram/twitter/tiktok/facebook)
// implements DiscoveryRequest.kind:'query' — each throws AcquisitionError(reason:'unsupported').
// That means every platform below will return 0 URLs until a future task implements query-based
// discovery in the adapters (acquisition/adapters/*.ts, out of Task 13's file scope). The
// per-platform try/catch + retry-on-zero already degrade this to a clean "0 URL" + warning line
// per platform rather than a crash, but the command's core purpose (finding real post URLs for a
// topic) is non-functional end-to-end right now. This is NOT a mild caveat — it's the honest
// state of this file after this migration.

import fs from 'node:fs';
import { sleep } from '../lib/cdp.ts';
import { outPath } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';
import { createStandaloneAcquisitionContext, runAcquisitionCli } from '../acquisition/service.ts';
import type { Platform } from '../acquisition/types.ts';

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

if (!QUERY) {
  console.log('Usage: bun topic_to_urls.ts "<query>" [--platforms tiktok,tw,ig,fb] [--max N]');
  process.exit(1);
}

const slug =
  QUERY.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'topic';

// platform key (CLI shorthand) -> Platform (acquisition/types.ts). 'fb'/'tw' predate the kernel's
// full platform names; keep the short CLI flags for backward compatibility with existing callers.
const PLATFORM_OF: Record<string, Platform> = {
  tiktok: 'tiktok',
  tw: 'twitter',
  ig: 'instagram',
  fb: 'facebook',
};

if (import.meta.main) {
  runAcquisitionCli(async () => {
    const context = await createStandaloneAcquisitionContext();
    console.log(ui.rule());
    console.log('  Topic → URLs (query sama lintas platform)');
    console.log(ui.rule());
    console.log('Query:', QUERY, '| platforms:', PLATFORMS.join(','), '| max/platform:', MAX);

    // Every platform routes through the SAME discover(kind:'query') call; the CLI key just picks
    // which Platform to pass. No per-platform script/inline-CDP branching left to maintain.
    const fetchOne = async (platform: Platform): Promise<string[]> => {
      const disc = await context.service.discover({ platform, kind: 'query', value: QUERY, limit: MAX });
      return disc.items.map((it) => it.canonical_url);
    };

    const platforms: Record<string, string[]> = {};
    for (const p of PLATFORMS) {
      const platform = PLATFORM_OF[p];
      if (!platform) {
        console.log(`• ${p}: tak didukung (pilih: tiktok, tw, ig, fb)`);
        continue;
      }
      process.stdout.write(`• ${p}: cari "${QUERY}" ... `);
      try {
        // Retry-on-zero: a platform sometimes returns 0 mid-pipeline (relay/tab hiccup) even though
        // the content exists — one retry after a short pause recovers it (avoids a non-video main).
        let urls = (await fetchOne(platform)).slice(0, MAX);
        if (!urls.length) {
          await sleep(2500);
          const r = (await fetchOne(platform)).slice(0, MAX);
          if (r.length) {
            urls = r;
            process.stdout.write('(retry) ');
          }
        }
        platforms[p] = urls;
        console.log(ui.gold(`${ui.OK} ${urls.length} URL`));
      } catch (err) {
        platforms[p] = [];
        console.log(
          ui.amber(`${ui.WARN}  ${String((err as Error).message || err).slice(0, 90)}`),
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
