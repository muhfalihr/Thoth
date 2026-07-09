// run_pipeline.ts — one command: a chosen topic URL → a complete, validated Thoth content-set.
//
// Chains the whole scout enrich flow that was previously run by hand:
//   seed (auto-fetch caption) → trace_source (resolve real source / keyword-find main)
//   → extract_figures (tokoh) → build_footage (objek→footage, gated) → collect_comments (multi-sumber)
//   → validate.
//
//   bun run_pipeline.ts <topic_url> [--out file.json] [--title "..."] [--desc "..."]
//                        [--per 2] [--max 4] [--cap 12] [--no-comments]
//
// <topic_url> = the post/reel the topic was discovered from (e.g. an IG reel). Caption is auto-fetched
// (TikTok/YouTube oEmbed; IG via og:description) unless --title/--desc are given. Needs the relevant
// platform tabs attached (IG caption fetch + comment scraping + Threads/crop steps).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connect, run, sleep } from '../lib/cdp.ts';
import { tiktokOembed, youtubeOembed } from '../lib/verify.ts';
import { outPath } from '../lib/paths.ts';
import { ui } from '../lib/ui.ts';

const args = process.argv.slice(2);
const getFlag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const URL = args.find((a, i) => !a.startsWith('--') && !['--out', '--title', '--desc', '--per', '--max', '--cap'].includes(args[i - 1]));
const OUT = getFlag('--out', 'thoth_content_set.json');
const TITLE = getFlag('--title', '');
const DESC = getFlag('--desc', '');
const PER = getFlag('--per', '2');
const MAX = getFlag('--max', '4');
const CAP = getFlag('--cap', '12');
const NO_COMMENTS = args.includes('--no-comments');
if (!URL) { console.log('Usage: bun run_pipeline.ts <topic_url> [--out f.json] [--title][--desc] [--per 2][--max 4][--cap 12] [--no-comments]'); process.exit(1); }

const here = s => path.join(import.meta.dirname, s);
const platformOf = u => /tiktok\.com/.test(u) ? 'tiktok' : /youtube\.com|youtu\.be/.test(u) ? 'youtube'
  : /instagram\.com/.test(u) ? 'instagram' : /(?:x|twitter)\.com/.test(u) ? 'twitter'
  : /facebook\.com/.test(u) ? 'facebook' : /threads\.(com|net)/.test(u) ? 'threads' : 'web';

// Best-effort caption fetch when --desc not supplied.
async function fetchCaption(url, platform) {
  try {
    if (platform === 'tiktok') { const m = await tiktokOembed(url); return (m && m.title) || ''; }
    if (platform === 'youtube') { const m = await youtubeOembed(url); return (m && m.title) || ''; }
    if (platform === 'instagram') {
      const c = await connect({ match: 'instagram.com', requireMatch: true });
      try {
        try { await c.cmd('Page.bringToFront'); } catch (e) {}
        await c.navigate(url, 6000); await sleep(3000);
        // og:description = "<n> likes, <n> comments - <user> on <date>: \"CAPTION\"".
        const og = (await c.evaluate(`(document.querySelector('meta[property="og:description"]')||{}).content || ''`)) || '';
        // og = '<user> on <date>: "CAPTION'  (may be truncated, no closing quote). Take after `: "`.
        const i = og.indexOf(': "');
        return (i >= 0 ? og.slice(i + 3).replace(/"\s*$/, '') : og).trim();
      } finally { c.close(); }
    }
  } catch (e) {}
  return '';
}

// Run a sub-step; tolerate non-zero exit (steps degrade gracefully + we validate at the end).
function step(label, script, scriptArgs) {
  ui.stage(label);
  try { execFileSync(process.execPath, [here(script), ...scriptArgs], { stdio: 'inherit', timeout: 600000 }); }
  catch (e) { console.log(ui.amber(`  ${ui.WARN} ${label} exit≠0 — lanjut`)); }
}

run(async () => {
  const platform = platformOf(URL);
  const file = outPath(OUT);

  ui.stage('RUN PIPELINE  →  ' + file);
  console.log(ui.dim(`topic: [${platform}] ${URL}`));

  // 1) Seed content-set (main + caption).
  const desc = DESC || await fetchCaption(URL, platform);
  console.log(`caption: ${(desc || '(kosong)').slice(0, 90)}`);
  const seed = {
    main: { url: URL, platform, title: TITLE || desc.slice(0, 120), description: desc, is_video: true, duration_sec: 0,
      profile: { name: '', handle: '', followers: '', avatar_url: '' } },
    footage: [], comments: [],
  };
  fs.writeFileSync(file, JSON.stringify(seed, null, 2), 'utf8');

  // 2-6) Chain the enrich steps. collect_comments runs BEFORE build_footage so subject/object extraction
  // can mine the comments too (names/brands often surface there). extract_figures runs AFTER build_footage
  // so it can also read footage descriptions — named subjects (e.g. "Sara Wijayanto", "MVP Pictures")
  // often surface there even when the topic/main caption is just a teaser.
  step('trace_source (sumber/main)', 'trace_source.ts', [file]);
  if (!NO_COMMENTS) step('collect_comments (multi-sumber)', 'collect_comments.ts', [file, '--cap', CAP, '--extra', URL]);
  step('build_footage (objek→footage)', 'build_footage.ts', [file, '--per', PER, '--max', MAX]);
  step('extract_figures (tokoh — main + footage)', 'extract_figures.ts', [file]);
  // Decode cultural context (entitas/meme/slang + maksud komentar) → narasi paham subteks,
  // tak menyalahkan netizen. Best-effort (skip diam bila tak ada key / gagal).
  if (!NO_COMMENTS) step('enrich_context (referensi budaya + maksud komentar)', '../enrich/enrich_context.ts', [file]);

  // 6) Validate + summary.
  step('validate', 'validate_content_set.ts', [file]);

  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    ui.stage('RINGKASAN');
    console.log(`MAIN     : [${s.main.platform}] ${s.main.url}`);
    console.log(`FIGURES  : ${(s.figures || []).map(f => f.name + '[' + f.type + ']').join(', ') || '(none)'}`);
    console.log(`FOOTAGE  : ${(s.footage || []).length} (${(s.footage || []).filter(f => f.is_video).length} video / ${(s.footage || []).filter(f => !f.is_video).length} card)`);
    console.log(`COMMENTS : ${(s.comments || []).length}`);
    console.log(`\n📄 ${file}`);
  } catch (e) {}
});
