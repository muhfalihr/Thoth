// search_social_v2.ts — keyword-search IG / X / Facebook for REAL canonical post URLs.
//
// WHY: IG/X/FB post URLs "selalu tidak bisa diakses" karena dirakit dari handle/keyword
// (mis. instagram.com/p/<handle>/reel/ → 404) atau diakses logged-out (x.com login-wall).
// FIX: navigate the already-logged-in managed browser, pull canonical hrefs from the DOM,
// validate their shape, then confirm+canonicalize each survivor via
// AcquisitionService.inspectPost() (real fetch, not a regex guess) before returning it.
//
// No adapter implements DiscoveryRequest.kind:'query' — instagram.ts/twitter.ts/facebook.ts
// all throw AcquisitionError(reason:'unsupported') for it, by design (see each adapter's
// discover() comment: they explicitly defer keyword search to THIS file). So this file does
// its own DOM scrape of the search-results page — but routed through
// AcquisitionService.browse() (this file's only sanctioned navigation primitive), never a raw
// lib/cdp.ts connect(). browse() is the same context.visit() every adapter uses: it enforces
// one navigation per canonical URL per run and serializes all browser navigation globally
// through browser_coordinator's tail chain.
//
//   bun search_social_v2.ts ig "korupsi BGN MBG"
//   bun search_social_v2.ts tw "korupsi BGN MBG"
//
// Output: output/<ig|tw>_urls.json  { query, fetched_at, logged_out_hint, urls:[...] }

import fs from 'node:fs';
import { sleep } from '../lib/cdp.ts';
import { validIG, validTW } from '../lib/validate.ts';
import { outPath } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';
import { createStandaloneAcquisitionContext, runAcquisitionCli } from '../acquisition/service.ts';
import { AcquisitionError } from '../acquisition/types.ts';
import type { AcquisitionIntent, Platform, PostRecord } from '../acquisition/types.ts';
import type { CdpClient } from '../lib/cdp.ts';

// The seam this file needs from AcquisitionService — deliberately narrow (not the whole
// class) so a test can hand in a plain object fake instead of building a real service.
export interface SearchContext {
  browse<T>(platform: Platform, url: string, acquire: (client: CdpClient) => Promise<T>): Promise<T>;
  registerIntent(url: string, intent: AcquisitionIntent): void;
  inspectPost(url: string): Promise<PostRecord>;
}

export type SearchPlatformKey = 'ig' | 'tw' | 'fb';

interface SearchConfig {
  platform: Platform;
  searchUrl: (query: string) => string;
  extractJs: string; // Runtime.evaluate expression returning a JSON-stringified string[]
  valid: (url: string) => boolean;
}

// Login-wall / dead-page detector shared across platforms — cheap DOM text sniff, same
// phrases the pre-kernel version checked for.
const LOGGED_OUT_JS =
  '/log in|masuk untuk|sign up|something went wrong|page isn.t available/i.test(document.body?.innerText||"")';

const SEARCH_CONFIGS: Record<SearchPlatformKey, SearchConfig> = {
  ig: {
    platform: 'instagram',
    searchUrl: (q) => `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(q)}`,
    extractJs:
      'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a=>a.href.split("?")[0]).filter(h=>/instagram\\.com\\/(reel|p|tv)\\/[A-Za-z0-9_-]{5,}/.test(h)))',
    valid: validIG,
  },
  tw: {
    platform: 'twitter',
    searchUrl: (q) => `https://x.com/search?q=${encodeURIComponent(q)}&f=live`,
    extractJs:
      'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a=>a.href.split("?")[0]).filter(h=>/(x|twitter)\\.com\\/[^/]+\\/status\\/\\d{15,}/.test(h)))',
    valid: validTW,
  },
  fb: {
    platform: 'facebook',
    searchUrl: (q) => `https://www.facebook.com/search/posts?q=${encodeURIComponent(q)}`,
    extractJs: `(() => {
      const re = /\\/(posts|permalink\\.php|share\\/p|groups\\/\\d+\\/posts)\\//;
      const set = new Set();
      Array.from(document.querySelectorAll('a[href]')).forEach(a => {
        const h = a.getAttribute('href') || '';
        if (re.test(h) || h.includes('story_fbid')) set.add(new URL(h, location.origin).href.split('?')[0].split('&')[0]);
      });
      return JSON.stringify(Array.from(set));
    })()`,
    // ponytail: the pre-kernel fbSearch() never gated FB links through FB_RE either — a
    // permalink.php?story_fbid=... hit legitimately fails FB_RE's /.+/(videos|posts|reel)/.+
    // shape, so gating here would silently throw away good results. Accept whatever the
    // extractJs regex above already scoped to post-shaped hrefs; inspectPost() below is the
    // real validation (a candidate it can't resolve is dropped).
    valid: () => true,
  },
};

export interface PlatformSearchResult {
  urls: string[];
  rejected: string[];
  loggedOutHint: boolean;
}

// Search `key`'s platform for `query`, returning up to `max` REAL canonical post URLs.
// Two-stage: (1) scrape the search-results page DOM for post-shaped hrefs, shape-validate +
// dedupe; (2) confirm each survivor via inspectPost() — this both drops dead/mismatched
// links and canonicalizes the URL (tracking params stripped, host lowercased) instead of
// trusting the raw href. A candidate inspectPost() can't resolve is dropped, never fabricated.
export async function searchPlatform(
  context: SearchContext,
  key: SearchPlatformKey,
  query: string,
  max: number,
): Promise<PlatformSearchResult> {
  const cfg = SEARCH_CONFIGS[key];
  const searchUrl = cfg.searchUrl(query);

  const { rawLinks, loggedOutHint } = await context.browse(cfg.platform, searchUrl, async (client) => {
    // The visit's own connect() already navigated + settled; search results still render
    // client-side after that, so give them a beat before reading the DOM.
    await sleep(1500);
    const hint = await client.evaluate(LOGGED_OUT_JS);
    // Throw (not just return a boolean) so this signal actually reaches the coordinator's
    // circuit breaker + negative cache via AcquisitionService.browse()'s failUrlOperation()
    // path — a silently-returned hint never opened the breaker, so a challenged/logged-out
    // search page kept getting re-navigated to on every following query.
    if (hint) {
      throw new AcquisitionError(`search: logged-out/challenge page for ${cfg.platform}`, {
        status: 'blocked',
        reason: 'auth-required',
        attempts: 1,
        elapsed_ms: 0,
      });
    }
    let links: string[] = [];
    try {
      links = JSON.parse((await client.evaluate(cfg.extractJs)) || '[]');
    } catch {
      links = [];
    }
    return { rawLinks: links as string[], loggedOutHint: false };
  });

  const seen = new Set<string>();
  const candidates: string[] = [];
  const rejected: string[] = [];
  for (const u of rawLinks) {
    if (seen.has(u)) continue;
    seen.add(u);
    (cfg.valid(u) ? candidates : rejected).push(u);
  }

  const urls: string[] = [];
  for (const raw of candidates.slice(0, max)) {
    context.registerIntent(raw, 'inspect');
    try {
      const post = await context.inspectPost(raw);
      urls.push(post.canonical_url);
    } catch {
      // best-effort normalization: a link the adapter can't confirm is dropped, not kept raw
    }
  }

  return { urls, rejected, loggedOutHint };
}

// No CLI flag ever existed for this — 20 bounds how many inspectPost() calls (each a real
// browser navigation) the standalone CLI below fires per invocation. topic_to_urls.ts passes
// its own smaller --max per platform; this only caps the bare `bun search_social_v2.ts ig "q"`
// path, comfortably above its old "show top 15" display.
const MAX = 20;

async function main() {
  const platformKey = (process.argv[2] || '').toLowerCase();
  const query = process.argv[3];
  if (!['ig', 'tw'].includes(platformKey) || !query) {
    console.log('Usage: bun search_social_v2.ts <ig|tw> "<query>"');
    process.exit(1);
  }
  const key = platformKey as 'ig' | 'tw';
  const outFile = key === 'ig' ? 'ig_urls.json' : 'tw_urls.json';

  console.log(`🔎 [${key}] search: ${query}`);
  const context = await createStandaloneAcquisitionContext();
  let urls: string[] = [];
  let rejected: string[] = [];
  let loggedOutHint = false;
  try {
    const result = await searchPlatform(context.service, key, query, MAX);
    urls = result.urls;
    rejected = result.rejected;
    loggedOutHint = result.loggedOutHint;
  } catch (e) {
    const reason = e instanceof AcquisitionError ? e.outcome.reason : undefined;
    loggedOutHint = reason === 'auth-required' || reason === 'challenge';
    console.log(
      ui.amber(`${ui.WARN}  search gagal: ${String((e as Error).message || e).slice(0, 120)}`),
    );
  }

  if (loggedOutHint)
    console.log(
      ui.amber(
        `${ui.WARN}  Halaman tampak login-wall / error. Sesi mungkin belum login. URL tak diverifikasi.`,
      ),
    );

  console.log(ui.gold(`\n${ui.OK} ${urls.length} URL canonical tervalidasi:`));
  urls.slice(0, 15).forEach((l, i) => console.log(`   ${i + 1}. ${l}`));
  if (rejected.length) {
    console.log(
      ui.amber(
        `\n${ui.WARN} ${rejected.length} ditolak (bentuk tidak valid — JANGAN kirim ke Thoth):`,
      ),
    );
    rejected.slice(0, 5).forEach((l) => console.log(`   - ${l}`));
  }

  const outFilePath = outPath(outFile);
  fs.writeFileSync(
    outFilePath,
    JSON.stringify(
      { query, fetched_at: new Date().toISOString(), logged_out_hint: loggedOutHint, urls },
      null,
      2,
    ),
  );
  console.log(`\n💾 ${outFilePath}`);
  if (urls.length === 0)
    console.log(
      ui.amber(
        `${ui.WARN}  Nol URL valid → JANGAN rakit URL manual. Buka postingan di browser login lalu salin URL canonical.`,
      ),
    );
}

if (import.meta.main) {
  runAcquisitionCli(main);
}
