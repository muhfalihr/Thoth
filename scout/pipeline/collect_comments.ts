// collect_comments.ts — fill content-set comments[] from MULTIPLE sources, not just one post.
//
// Comments are often empty because only one URL (or none) gets scraped. This dispatcher collects
// comments from: (1) the MAIN post, (2) relevant viral content already in the set (footage posts +
// videos), and (3) any --extra URL (e.g. the ORIGINAL Instagram post the topic came from — the user
// rule: "kalau topik dari postingan IG, ambil komentar dari postingan IG itu"). Every source is
// acquired through the shared AcquisitionService (service.collectComments()) — no per-platform
// scraper subprocess — then merged, deduped, ranked by likes, and capped. Only the comments that
// survive the cap get a screenshot (service.captureSocialCard()); the rest never pay for one.
//
//   bun collect_comments.ts <content_set.json> [--per-source 6] [--cap 12] [--max-sources 4] [--extra url1,url2]
//
// Needs the relevant platform tabs attached + logged in (same as before).

import fs from 'node:fs';
import { ui } from '../lib/ui.ts';
import { dedupeAndRankComments, isLinkSpam, isStickerOnly, scrapeCommentsOnPage } from '../lib/comment_engine.ts';
import type { CdpClient } from '../lib/cdp.ts';
import type {
  AcquisitionRunContext,
  CommentRecord,
  LocalAsset,
  Platform,
} from '../acquisition/index.ts';
import { createStandaloneAcquisitionContext, runAcquisitionCli } from '../acquisition/index.ts';
import { EXTRACT_JS as TIKTOK_EXTRACT_JS, loadComments as tiktokEnsureLoaded } from '../scrapers/scrape_comments.ts';
import {
  EXTRACT_JS as IG_EXTRACT_JS,
  SCROLL_JS as IG_SCROLL_JS,
  ensureLoaded as igEnsureLoaded,
} from '../scrapers/scrape_comments_ig.ts';
import {
  EXTRACT_JS as X_EXTRACT_JS,
  SCROLL_JS as X_SCROLL_JS,
  ensureLoaded as xEnsureLoaded,
} from '../scrapers/scrape_comments_x.ts';
import {
  EXTRACT_JS as FB_EXTRACT_JS,
  SCROLL_JS as FB_SCROLL_JS,
  ensureLoaded as fbEnsureLoaded,
} from '../scrapers/scrape_comments_fb.ts';

// Platforms whose CLI scrape_comments_*.ts already knows how to wait-for-load + extract +
// (via scrapeCommentsOnPage) crop each comment individually. collectNormalizedComments()
// routes these through AcquisitionService.browse() (ONE navigation, same as
// service.collectComments() would have used) instead of the adapter's text-only
// collectComments() — see the ponytail note at its call site for why.
interface CropCapableOpts {
  ensureLoaded: (client: CdpClient) => Promise<number>;
  extractJs: string;
  scrollJs?: string;
}

const CROP_CAPABLE: Partial<Record<Platform, CropCapableOpts>> = {
  tiktok: { ensureLoaded: tiktokEnsureLoaded, extractJs: TIKTOK_EXTRACT_JS },
  instagram: { ensureLoaded: igEnsureLoaded, extractJs: IG_EXTRACT_JS, scrollJs: IG_SCROLL_JS },
  twitter: { ensureLoaded: xEnsureLoaded, extractJs: X_EXTRACT_JS, scrollJs: X_SCROLL_JS },
  facebook: { ensureLoaded: fbEnsureLoaded, extractJs: FB_EXTRACT_JS, scrollJs: FB_SCROLL_JS },
};

export interface CollectCommentsOptions {
  file: string;
  perSource: number;
  cap: number;
  maxSources: number;
  extra: string[];
}

// platform → is there a kernel adapter worth trying? (threads has no comment adapter → skipped;
// raw CDN media URLs are not a post page.)
const KNOWN_PLATFORM = new Set<Platform>([
  'tiktok',
  'instagram',
  'twitter',
  'youtube',
  'facebook',
  'reddit',
]);

function platformOf(u: string): Platform | null {
  u = u || '';
  if (/threads\.(com|net)/.test(u)) return null; // no comment adapter
  if (/fbcdn\.net|cdninstagram\.com/.test(u)) return null; // raw CDN media, not a post page
  if (/tiktok\.com/.test(u)) return 'tiktok';
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/instagram\.com/.test(u)) return 'instagram';
  if (/(?:x|twitter)\.com/.test(u)) return 'twitter';
  if (/facebook\.com/.test(u)) return 'facebook';
  if (/reddit\.com/.test(u)) return 'reddit';
  return null;
}

export function buildCommentSources(
  set: any,
  extra: string[],
  maxSources: number,
): { url: string; platform: Platform }[] {
  const main = set.main || {};
  const footage = set.footage || [];

  // Build the ordered, deduped source list: main post first, then relevant footage, then --extra.
  const mainPost = main.source_url || main.url || ''; // source_url = original post when main.url is a CDN/proxy
  const ranked = [
    mainPost,
    ...extra, // explicit origin (e.g. the IG reel the topic came from)
    ...footage.filter((f: any) => !f.is_video).map((f: any) => f.url), // posts (X/IG/FB) → discussion
    ...footage.filter((f: any) => f.is_video).map((f: any) => f.url), // videos (TikTok) → comments too
  ];
  const sources: { url: string; platform: Platform }[] = [];
  const seenUrl = new Set<string>();
  for (const u of ranked) {
    const plat = platformOf(u);
    if (!plat || !KNOWN_PLATFORM.has(plat)) continue;
    if (seenUrl.has(u)) continue;
    seenUrl.add(u);
    sources.push({ url: u, platform: plat });
    if (sources.length >= maxSources) break;
  }
  return sources;
}

// ── Reusable comment seam (Task 15) ─────────────────────────────────────────────────────────
export interface CommentSource {
  url: string;
  platform: Platform;
}

export interface CollectNormalizedCommentDeps {
  perSource: number;
  cap: number;
  collect(url: string, max: number): Promise<CommentRecord[]>;
  capture(url: string, comment: CommentRecord): Promise<LocalAsset>;
}

export interface CommentInfo {
  text: string;
  author?: string;
  likes?: number;
  avatar_url?: string;
  image_path?: string;
}

type TaggedComment = CommentRecord & { _sourceUrl: string };

// Collect from every source, tolerating a single source's failure (unsupported platform,
// timeout, ...) without aborting the rest. Junk (sticker-only / link-spam) is dropped here so
// EVERY caller is covered uniformly — not just the crop-capable path below, whose own
// scrapeCommentsOnPage() already filters at extraction time, but also the deps.collect()
// fallback (service.collectComments(), e.g. reddit/youtube) which does not. Merge + dedupe +
// rank by likes, cap to deps.cap, THEN capture a screenshot only for the comments that survive
// the cap AND don't already carry their own per-comment image_path — the perSource pool that
// gets filtered out never pays for a screenshot.
export async function collectNormalizedComments(
  sources: CommentSource[],
  deps: CollectNormalizedCommentDeps,
): Promise<CommentInfo[]> {
  const collected: TaggedComment[] = [];
  for (const source of sources) {
    let got: CommentRecord[] = [];
    try {
      got = await deps.collect(source.url, deps.perSource);
    } catch (error) {
      continue; // one bad source must not abort the others
    }
    for (const c of got) {
      const text = (c.text || '').trim();
      if (!text || isStickerOnly(text) || isLinkSpam(text)) continue;
      collected.push({ ...c, _sourceUrl: source.url });
    }
  }

  const capped = dedupeAndRankComments(collected, deps.cap);

  const results: CommentInfo[] = [];
  for (const c of capped) {
    // Prefer the record's OWN per-comment crop (scrapeCommentsOnPage via the crop-capable path)
    // over deps.capture() — deps.capture() memoizes on the SOURCE URL, so calling it for every
    // comment from the same post would collapse them all onto one shared post-level screenshot
    // (the Critical bug this restores). Only fall back to deps.capture() when the record has no
    // crop of its own (the service.collectComments() fallback path never sets image_path).
    let image_path = c.image_path || '';
    if (!image_path) {
      try {
        const asset = await deps.capture(c._sourceUrl, c);
        image_path = asset.path;
      } catch (error) {
        image_path = ''; // screenshot failed → Thoth draws its synthetic card
      }
    }
    results.push({
      author: c.author || 'anon',
      text: c.text,
      likes: c.likes || 0,
      avatar_url: '',
      image_path,
    });
  }
  return results;
}

export async function runCollectComments(
  options: CollectCommentsOptions,
  context: AcquisitionRunContext,
): Promise<void> {
  const { file, perSource, cap, maxSources, extra } = options;
  const set = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sources = buildCommentSources(set, extra, maxSources);

  console.log(ui.rule());
  console.log('  Collect Comments (multi-sumber)');
  console.log(ui.rule());
  if (!sources.length) {
    console.log(
      ui.amber(
        `${ui.WARN}  Tak ada sumber komentar yang punya adapter (threads/CDN di-skip). Pakai --extra <url>.`,
      ),
    );
    return;
  }
  sources.forEach((s, i) => console.log(`  ${i + 1}. [${s.platform}] ${s.url.slice(0, 70)}`));

  // Register intents before any source is visited: 'comments' so the adapter knows this visit
  // is for comment collection, 'social-card' so any adapter that can stash a card screenshot
  // during that SAME visit does so (avoids a second navigation when capture() runs below).
  for (const source of sources) {
    context.service.registerIntent(source.url, 'comments');
    context.service.registerIntent(source.url, 'social-card');
  }

  const comments = await collectNormalizedComments(sources, {
    perSource,
    cap,
    collect: (url, max) => {
      const platform = platformOf(url);
      const opts = platform ? CROP_CAPABLE[platform] : undefined;
      if (!platform || !opts) return context.service.collectComments(url, { max });
      // ponytail: bypasses AcquisitionService.collectComments() (text-only) for crop-capable
      // platforms. Navigation still goes through the kernel's sanctioned browse() primitive —
      // ONE visit per canonical URL, same as collectComments() would have used — we just run
      // scrape_comments_*.ts's proven per-comment extract+crop pass (scrapeCommentsOnPage)
      // against it instead of the adapter's text-only extractor. Product correctness (real
      // per-comment crops, not one shared post card) beats kernel purity here; see the task-15
      // review findings for why the adapters themselves are not extended to do this.
      return context.service.browse(platform, url, (client) =>
        scrapeCommentsOnPage(client, { ...opts, max }),
      );
    },
    capture: (url) => context.service.captureSocialCard(url, 'comment'),
  });
  set.comments = comments;
  fs.writeFileSync(file, JSON.stringify(set, null, 2), 'utf8');

  console.log('\n' + ui.rule('thin'));
  const withCrop = set.comments.filter((c: any) => c.image_path).length;
  console.log(
    `Selesai: ${set.comments.length} komentar (${withCrop} ada crop) dari ${sources.length} sumber → ${file}`,
  );
}

export function parseCollectCommentsArgs(argv: string[]): CollectCommentsOptions {
  const getFlag = (n: string, d: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : d;
  };
  const file = argv.find(
    (a, i) =>
      !a.startsWith('--') &&
      !['--per-source', '--cap', '--max-sources', '--extra'].includes(argv[i - 1]),
  );
  const perSource = parseInt(getFlag('--per-source', '6'), 10);
  const cap = parseInt(getFlag('--cap', '12'), 10);
  const maxSources = parseInt(getFlag('--max-sources', '4'), 10);
  const extra = (getFlag('--extra', '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!file) {
    console.log(
      'Usage: bun collect_comments.ts <content_set.json> [--per-source 6] [--cap 12] [--max-sources 4] [--extra url1,url2]',
    );
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.log(ui.red(`${ui.ERR} File tak ada: ${file}`));
    process.exit(1);
  }
  return { file, perSource, cap, maxSources, extra };
}

if (import.meta.main) {
  runAcquisitionCli(async () => {
    const options = parseCollectCommentsArgs(process.argv.slice(2));
    const context = await createStandaloneAcquisitionContext();
    await runCollectComments(options, context);
  });
}
