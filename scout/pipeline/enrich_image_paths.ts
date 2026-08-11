// enrich_image_paths.ts — fill `image_path` for every NON-VIDEO entry (main + footage[]) of a
// content-set, via the shared AcquisitionService. Original media (a photo attachment the
// platform itself serves) is preferred — service.materialize() fetches it directly (gallery-dl /
// direct-http, no screenshot). Only when the entry has no such media (a text-only post, or the
// platform/adapter can't resolve one) do we fall back to service.captureSocialCard(), a targeted
// DOM screenshot of the post. Either way, this never opens its own CDP connection — the browser
// coordinator's per-canonical-URL dedup applies exactly as it does to every other stage.
//
//   bun enrich_image_paths.js <content_set.json> [--force] [--keywords k1,k2] [--mode any|all]
//
// - Targets entries with is_video === false, a supported URL (x/ig/fb/threads), and no existing crop.
//   --force re-crops even if image_path is already set.
// - With --keywords, ALSO sets relevance: the post text (from inspectPost, or empty if that failed)
//   is matched vs the keywords → "match" (Thoth keeps it) or "unverified" (Thoth drops it). Without
//   --keywords, relevance is left untouched. mode "any" (default) needs one keyword; "all" needs every.
// - Per-entry failure (unsupported platform, post not found) is logged and SKIPPED — never aborts the
//   whole set. Writes the content-set back in place.

import fs from 'node:fs';
import path from 'node:path';
import { inferPlatform } from '../scrapers/crop_post.ts';
import { matchesTopic } from '../lib/verify.ts';
import { ui } from '../lib/ui.ts';
import type { AcquisitionRunContext, AssetPurpose } from '../acquisition/index.ts';
import { createStandaloneAcquisitionContext, runAcquisitionCli } from '../acquisition/index.ts';

export interface EnrichImagePathsOptions {
  file: string;
  force: boolean;
  keywords: string[];
  mode: 'any' | 'all';
}

const hasCrop = (e: any) =>
  e && typeof e.image_path === 'string' && e.image_path.trim() && fs.existsSync(e.image_path.trim());

interface ResolvedImage {
  path: string;
  text: string;
  bytes: number;
}

// Original media first (service.materialize), a social-card screenshot only when the entry has
// no such media or inspecting it failed outright. Never throws — a total failure returns null so
// the caller can skip this one entry without aborting the rest.
async function resolveImagePath(
  url: string,
  purpose: AssetPurpose,
  context: AcquisitionRunContext,
): Promise<ResolvedImage | null> {
  let text = '';
  // Register BOTH intents before the first acquisition call: inspect() holds this URL's one
  // allowed navigation, and the twitter/instagram adapters only stash a social-card crop during
  // that visit when the 'social-card' intent is already registered. Without this the fallback
  // below asks for a second, differently-purposed visit, which the coordinator refuses — i.e.
  // no card at all for exactly the text-tweet/photo-post entries this stage exists to serve.
  // Tolerant: registerIntent() throws once a URL's visit has started (e.g. run_pipeline already
  // seeded the main URL), and this function must never throw.
  try {
    for (const intent of ['inspect', 'media', 'social-card'] as const) {
      context.service.registerIntent(url, intent);
    }
  } catch {
    // already visited this run — its intents are whatever the earlier caller registered
  }
  try {
    const inspected = await context.service.inspectPost(url);
    text = inspected.text || '';
    const asset = inspected.media.find((m) => m.kind === 'image');
    if (asset) {
      const local = await context.service.materialize(asset, purpose);
      return { path: local.path, text, bytes: local.bytes };
    }
  } catch (error) {
    // inspect unsupported/failed → fall through to a social-card screenshot below.
  }
  try {
    const local = await context.service.captureSocialCard(url, 'post');
    return { path: local.path, text, bytes: local.bytes };
  } catch (error) {
    return null;
  }
}

export async function runEnrichImagePaths(
  options: EnrichImagePathsOptions,
  context: AcquisitionRunContext,
): Promise<void> {
  const { file, force, keywords, mode } = options;
  const set = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Collect non-video entries that need a crop.
  const targets: { label: string; e: any }[] = [];
  if (set.main) targets.push({ label: 'main', e: set.main });
  (set.footage || []).forEach((e: any, i: number) => targets.push({ label: `footage[${i}]`, e }));

  const todo = targets.filter(
    ({ e }) =>
      e &&
      e.is_video === false &&
      typeof e.url === 'string' &&
      inferPlatform(e.url) &&
      (force || !hasCrop(e)),
  );

  console.log(ui.rule());
  console.log('  Enrich image_path (acquisition kernel: media/social-card)');
  console.log(ui.rule());
  console.log(`File: ${file}`);
  console.log(
    `Kandidat non-video: ${todo.length} (dari ${targets.length} entri; sisanya video / sudah ada crop / platform tak didukung)`,
  );
  if (!todo.length) {
    console.log('Tak ada yang perlu di-crop. Selesai.');
    return;
  }

  if (keywords.length) console.log(`Gate relevansi: keywords=[${keywords.join(', ')}] mode=${mode}`);

  let ok = 0,
    fail = 0,
    matched = 0;
  for (const { label, e } of todo) {
    const plat = inferPlatform(e.url);
    process.stdout.write(`• ${label} [${plat}] ${e.url.slice(0, 70)} ... `);
    const purpose: AssetPurpose = label === 'main' ? 'main' : 'footage';
    const resolved = await resolveImagePath(e.url, purpose, context);
    if (resolved) {
      e.image_path = resolved.path;
      ok++;
      let tag = '';
      if (keywords.length) {
        const hit = matchesTopic(resolved.text || '', keywords, mode);
        e.relevance = hit ? 'match' : 'unverified';
        if (hit) matched++;
        tag = hit ? ' [match]' : ' [unverified→Thoth buang]';
      }
      console.log(
        ui.gold(
          `${ui.OK} ${path.basename(resolved.path)} (${(resolved.bytes / 1024).toFixed(1)} KB)${tag}`,
        ),
      );
    } else {
      fail++;
      e.image_path = ''; // clear stale path → drop filter below catches it
      console.log(ui.amber(`${ui.WARN}  gagal ambil media/social-card (unsupported / not found)`));
    }
  }
  // Drop non-video footage we couldn't crop (no image_path): Thoth can't render them and they'd
  // fail lint ("is_video:false TANPA image_path"). A transient miss must not break the set — re-run
  // with --force to retry.
  const before = (set.footage || []).length;
  set.footage = (set.footage || []).filter(
    (f: any) => !(f.is_video === false && !(f.image_path && String(f.image_path).trim())),
  );
  const dropped = before - set.footage.length;

  fs.writeFileSync(file, JSON.stringify(set, null, 2), 'utf8');
  console.log(ui.rule('thin'));
  if (dropped)
    console.log(
      `🧹 ${dropped} footage non-video gagal di-crop → dibuang (--force utk pulihkan).`,
    );
  console.log(
    `Selesai: ${ok} crop terisi${keywords.length ? ` (${matched} on-topic/"match")` : ''}, ${fail} gagal/skip → ${file}`,
  );
  console.log('Validasi: bun validate_content_set.ts "' + file + '"');
}

export function parseEnrichImagePathsArgs(argv: string[]): EnrichImagePathsOptions {
  const getFlag = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : null;
  };
  const force = argv.includes('--force');
  const mode = (getFlag('--mode') || 'any') as 'any' | 'all';
  const keywords = (getFlag('--keywords') || '').split(/[ ,]+/).filter(Boolean);
  const file = argv.find(
    (a, i) => !a.startsWith('--') && argv[i - 1] !== '--keywords' && argv[i - 1] !== '--mode',
  );
  if (!file) {
    console.log(
      'Usage: bun enrich_image_paths.ts <content_set.json> [--force] [--keywords k1,k2] [--mode any|all]',
    );
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.log(ui.red(`${ui.ERR} File tak ada: ${file}`));
    process.exit(1);
  }

  let set;
  try {
    set = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    console.log(ui.red(`${ui.ERR} JSON tak valid: ${e.message}`));
    process.exit(1);
  }
  if (Array.isArray(set) || !set || typeof set !== 'object') {
    console.log(ui.red(`${ui.ERR} content-set harus objek tunggal {main,footage,comments}.`));
    process.exit(1);
  }

  return { file, force, keywords, mode };
}

if (import.meta.main) {
  runAcquisitionCli(async () => {
    const options = parseEnrichImagePathsArgs(process.argv.slice(2));
    const context = await createStandaloneAcquisitionContext();
    await runEnrichImagePaths(options, context);
  });
}
