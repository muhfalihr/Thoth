#!/usr/bin/env bun
// cli.ts — SATU entrypoint untuk semua fitur scout.
//
//   bun cli.ts <perintah> [args...]
//
// Argumen setelah <perintah> diteruskan apa adanya ke script target, jadi semua
// flag lama (--max-per, --out, --extra, dst.) tetap berlaku. Dijalankan lewat sini,
// lib/env.ts sudah ter-load → semua child process mewarisi credential dari .env root.

import './lib/env.ts'; // inject .env root ke process.env sebelum spawn apa pun

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ui } from './lib/ui.ts';

// perintah → [script, deskripsi singkat]
const CMDS: Record<string, [string, string]> = {
  browser:  ['lib/browser.ts',                       'managed browser CDP 18800: start|status|stop|path|env'],
  discover: ['pipeline/discover_reels.ts',           'discovery topik akun IG kurator (--max-per --hours --include --tiktok)'],
  trending: ['pipeline/discover_tiktok_trending.ts', 'trending TikTok Studio (--max --region)'],
  run:      ['pipeline/run_pipeline.ts',             '<url> → content-set lengkap (--out --per --max --cap)'],
  comments: ['pipeline/collect_comments.ts',         '<set.json> komentar multi-sumber (--extra <url> --cap)'],
  footage:  ['pipeline/build_footage.ts',            '<set.json> b-roll objek cerita (--per --max)'],
  figures:  ['pipeline/extract_figures.ts',          '<set.json> tokoh/organisasi → figures[]'],
  enrich:   ['enrich/enrich_context.ts',             '<set.json> konteks budaya komentar (references/discourse)'],
  images:   ['pipeline/enrich_image_paths.ts',       '<set.json> crop post non-video → image_path (--force)'],
  validate: ['pipeline/validate_content_set.ts',     '<set.json> lint WAJIB sebelum hand-off (exit 0 = aman)'],
  pulse:    ['enrich/pulse_harvest.ts',              'Cultural Pulse harian → CKB (--max --per-video --min-freq)'],
  topics:   ['pipeline/discover_topics.ts',          'discovery sekunder trending X/YouTube'],
  news:     ['scrapers/search_news.ts',              'kartu image Google News → footage[]'],
};

function help(bad?: string) {
  const spine = `  ${ui.violet(ui.SPINE)} `;
  if (bad) console.error(`${spine}${ui.red(`${ui.ERR} Perintah tak dikenal: ${bad}`)}`);
  console.log(`${spine}${ui.dim('Pakai:')} bun cli.ts ${ui.gold('<perintah>')} [args...]`);
  console.log(spine);
  const w = Math.max(...Object.keys(CMDS).map(k => k.length));
  for (const [k, [, desc]] of Object.entries(CMDS)) console.log(`${spine}${ui.gold(k.padEnd(w))}  ${ui.dim(desc)}`);
  console.log(spine);
  console.log(`${spine}${ui.violet('Flow harian:')} ${ui.dim('browser status → discover → run <url> → validate → thoth run --content')}`);
  process.exit(bad ? 1 : 0);
}

ui.banner();
const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') help();
if (!CMDS[cmd]) help(cmd);

const r = spawnSync(process.execPath, [path.join(import.meta.dirname, CMDS[cmd][0]), ...rest], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
