// search_social_v2.ts — compatibility CLI: keyword-search IG/X for canonical post URLs.
// Historically this navigated the logged-in CDP browser itself; it now invokes
// AcquisitionService.discover({kind:'query'}) — the relevant platform adapter, not this script,
// owns the navigation. Kept as a thin CLI wrapper so existing callers keep the same invocation +
// output shape.
//
//   bun search_social_v2.ts ig "korupsi BGN MBG"
//   bun search_social_v2.ts tw "korupsi BGN MBG"
//
// Output: output/<ig|tw>_urls.json  { query, fetched_at, logged_out_hint, urls:[...] }
//
// ponytail/DISCLOSED REGRESSION: as of Task 13, neither instagram.ts nor twitter.ts implements
// DiscoveryRequest.kind:'query' (both throw AcquisitionError(reason:'unsupported')) — so this
// command currently always writes an empty `urls` array. It degrades cleanly (no crash) rather
// than silently succeeding with fake data. `logged_out_hint` also stops being a live DOM check
// (there's no page left to inspect here) and is instead derived from the discover() failure
// reason, staying `true` only when the adapter reports an auth-required/challenge-shaped outcome.

import fs from 'node:fs';
import { validIG, validTW } from '../lib/validate.ts';
import { outPath } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';
import { createStandaloneAcquisitionContext, runAcquisitionCli } from '../acquisition/service.ts';
import { AcquisitionError } from '../acquisition/types.ts';
import type { Platform } from '../acquisition/types.ts';

const MAX = 20; // no CLI flag existed previously; matches the old "show top 15" display with headroom

async function main() {
  const platform = (process.argv[2] || '').toLowerCase();
  const query = process.argv[3];
  if (!['ig', 'tw'].includes(platform) || !query) {
    console.log('Usage: bun search_social_v2.ts <ig|tw> "<query>"');
    process.exit(1);
  }

  const cfg =
    platform === 'ig'
      ? { acquisitionPlatform: 'instagram' as Platform, valid: validIG, out: 'ig_urls.json' }
      : { acquisitionPlatform: 'twitter' as Platform, valid: validTW, out: 'tw_urls.json' };

  console.log(`🔎 [${platform}] discover(kind:'query'): ${query}`);
  const context = await createStandaloneAcquisitionContext();
  let links: string[] = [];
  let loggedOutHint = false;
  try {
    const disc = await context.service.discover({
      platform: cfg.acquisitionPlatform,
      kind: 'query',
      value: query,
      limit: MAX,
    });
    links = disc.items.map((it) => it.canonical_url);
  } catch (e) {
    const reason = e instanceof AcquisitionError ? e.outcome.reason : undefined;
    loggedOutHint = reason === 'auth-required' || reason === 'challenge';
    console.log(
      ui.amber(`${ui.WARN}  discover gagal: ${String((e as Error).message || e).slice(0, 120)}`),
    );
  }

  // Dedupe + validate (drop fabricated / handle-as-shortcode shapes).
  const seen = new Set<string>();
  const valid: string[] = [],
    rejected: string[] = [];
  for (const u of links) {
    if (seen.has(u)) continue;
    seen.add(u);
    (cfg.valid(u) ? valid : rejected).push(u);
  }

  console.log(ui.gold(`\n${ui.OK} ${valid.length} URL canonical tervalidasi:`));
  valid.slice(0, 15).forEach((l, i) => console.log(`   ${i + 1}. ${l}`));
  if (rejected.length) {
    console.log(
      ui.amber(
        `\n${ui.WARN} ${rejected.length} ditolak (bentuk tidak valid — JANGAN kirim ke Thoth):`,
      ),
    );
    rejected.slice(0, 5).forEach((l) => console.log(`   - ${l}`));
  }

  const outFile = outPath(cfg.out);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        query,
        fetched_at: new Date().toISOString(),
        logged_out_hint: loggedOutHint,
        urls: valid,
      },
      null,
      2,
    ),
  );
  console.log(`\n💾 ${outFile}`);
  if (valid.length === 0)
    console.log(
      ui.amber(
        `${ui.WARN}  Nol URL valid → JANGAN rakit URL manual. Buka postingan di browser login lalu salin URL canonical.`,
      ),
    );
}

if (import.meta.main) {
  runAcquisitionCli(main);
}
