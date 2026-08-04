// enrich_image_paths.js — fill `image_path` for every NON-VIDEO entry (main + footage[]) of a
// content-set, by DOM-cropping the post (crop_post.js) on X / Instagram / Facebook. This wires
// crop_post into content-set building: after scout assembles main/footage/comments, run this
// to attach a clean post-card PNG to each non-video entry so Thoth renders it as a still card.
//
//   bun enrich_image_paths.js <content_set.json> [--force] [--keywords k1,k2] [--mode any|all]
//
// - Targets entries with is_video === false, a supported URL (x/ig/fb), and no existing crop.
//   --force re-crops even if image_path is already set.
// - With --keywords, ALSO sets relevance: the post caption (read while cropping) is matched vs the
//   keywords → "match" (Thoth keeps it) or "unverified" (Thoth drops it). Without --keywords,
//   relevance is left untouched. mode "any" (default) needs one keyword; "all" needs every keyword.
// - Per-entry failure (tab not attached, post not found) is logged and SKIPPED — never aborts the
//   whole set. Writes the content-set back in place.

import fs from 'node:fs';
import path from 'node:path';
import { cropPost, inferPlatform } from '../scrapers/crop_post.ts';
import { matchesTopic } from '../lib/verify.ts';
import { ui } from '../lib/ui.ts';
import type { AcquisitionRunContext } from '../acquisition/index.ts';
import { createStandaloneAcquisitionContext, runAcquisitionCli } from '../acquisition/index.ts';

export interface EnrichImagePathsOptions {
  file: string;
  force: boolean;
  keywords: string[];
  mode: 'any' | 'all';
}

const hasCrop = (e: any) =>
  e && typeof e.image_path === 'string' && e.image_path.trim() && fs.existsSync(e.image_path.trim());

export async function runEnrichImagePaths(
  options: EnrichImagePathsOptions,
  context: AcquisitionRunContext,
): Promise<void> {
  void context;
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
  console.log('  Enrich image_path (DOM crop post non-video)');
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
    try {
      const r = await cropPost({ url: e.url });
      if (r.ok) {
        e.image_path = r.image_path;
        ok++;
        let tag = '';
        if (keywords.length) {
          const hit = matchesTopic(r.text || '', keywords, mode);
          e.relevance = hit ? 'match' : 'unverified';
          if (hit) matched++;
          tag = hit ? ' [match]' : ' [unverified→Thoth buang]';
        }
        console.log(ui.gold(`${ui.OK} ${path.basename(r.image_path)} (${r.w}x${r.h})${tag}`));
      } else {
        fail++;
        e.image_path = '';
        console.log(ui.amber(`${ui.WARN}  ${r.reason}`));
      } // clear stale path → drop filter below catches it
    } catch (err: any) {
      fail++;
      if (err && err.relay)
        console.log(
          ui.amber(`${ui.WARN}  tab ${plat} belum ter-attach relay (skip; attach lalu --force)`),
        );
      else
        console.log(ui.amber(`${ui.WARN}  ${err && err.message ? err.message.slice(0, 60) : err}`));
    }
  }
  // Drop non-video footage we couldn't crop (no image_path): Thoth can't render them and they'd
  // fail lint ("is_video:false TANPA image_path"). A transient tab/crop miss must not break the set
  // — re-run with the tab attached + --force to recover them.
  const before = (set.footage || []).length;
  set.footage = (set.footage || []).filter(
    (f: any) => !(f.is_video === false && !(f.image_path && String(f.image_path).trim())),
  );
  const dropped = before - set.footage.length;

  fs.writeFileSync(file, JSON.stringify(set, null, 2), 'utf8');
  console.log(ui.rule('thin'));
  if (dropped)
    console.log(
      `🧹 ${dropped} footage non-video gagal di-crop → dibuang (attach tab + --force utk pulihkan).`,
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
