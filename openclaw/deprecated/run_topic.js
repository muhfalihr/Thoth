// run_topic.js — [DEPRECATED 2026-06-12 → pakai discover_reels.js + run_pipeline.js]
//
// KENAPA DEPRECATED: orkestrator ini berangkat dari topik-STRING (hasil search), bukan dari URL
// reel sumber. Akibatnya content-set-nya TIPIS: tanpa build_footage (objek/profil creator), tanpa
// extract_figures, dan TANPA collect_comments — padahal prompt narasi Thoth sangat bergantung
// pada komentar netizen. Jalur yang benar: discover_reels.js (topik dari hook/voiceover akun IG
// terkurasi) → run_pipeline.js <reel_url> (seed→trace→footage→figures→comments→validate).
// Disimpan di deprecated/ untuk referensi; masih bisa dijalankan dari folder ini.
//
// ONE command for the whole OpenClaw upstream: a topic → a validated Thoth
// content-set. Chains the tested scripts in order, each fault-isolated; stops (non-zero) only if
// a step truly can't continue (e.g. 0 URLs, or validate FAIL).
//
//   node deprecated/run_topic.js "<topik>" [--platforms tiktok,tw,ig,fb] [--max N] [--main <url>] [--no-enrich]
//
// Stages:  topic_to_urls → urls_to_contentset → enrich_image_paths → validate_content_set
// Then prints the `thoth run --content …` command (the Rust side stays separate — not auto-run).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { outPath } = require('../paths');

const args = process.argv.slice(2);
const getFlag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const NO_ENRICH = args.includes('--no-enrich');
const NO_NEWS = args.includes('--no-news');
const NO_TRACE = args.includes('--no-trace');
const QUERY = args.find(a => !a.startsWith('--') && !['--platforms', '--max', '--main', '--keywords', '--mode'].includes(args[args.indexOf(a) - 1]));
const PLATFORMS = getFlag('--platforms', 'tiktok,tw,ig,fb');
const MAX = getFlag('--max', '8');
const MAIN = getFlag('--main', null);
// Relevance keywords default to the topic itself; mode "any" (lenient). Thoth drops footage
// whose relevance != "match", so gating is what makes footage actually usable.
const KEYWORDS = getFlag('--keywords', QUERY);
const MODE = getFlag('--mode', 'any');
if (!QUERY) { console.log('Usage: node deprecated/run_topic.js "<topik>" [--platforms tiktok,tw,ig,fb] [--max N] [--main <url>] [--no-enrich]'); process.exit(1); }

const slug = QUERY.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'topic';
const here = f => path.join(__dirname, '..', f); // scripts live in the parent (workspace root)
const topicUrls = outPath(`topic_urls_${slug}.json`);
const contentSet = outPath(`content_set_${slug}.json`);

function step(n, label, script, scriptArgs) {
  console.log(`\n${'#'.repeat(60)}\n# [${n}] ${label}\n${'#'.repeat(60)}`);
  execFileSync('node', [here(script), ...scriptArgs], { stdio: 'inherit', timeout: 600000 });
}

try {
  step(1, 'Topik → URL lintas platform (+gate TikTok di sumber)', 'topic_to_urls.js', [QUERY, '--platforms', PLATFORMS, '--max', MAX, '--keywords', KEYWORDS]);
  if (!fs.existsSync(topicUrls)) throw new Error(`topic_urls tak terbentuk: ${topicUrls}`);

  const urlArgs = [topicUrls, '--keywords', KEYWORDS, '--mode', MODE]; if (MAIN) urlArgs.push('--main', MAIN);
  step(2, 'URL → content-set (+gate video relevansi)', 'urls_to_contentset.js', urlArgs);
  if (!fs.existsSync(contentSet)) throw new Error(`content_set tak terbentuk: ${contentSet}`);

  // Anti re-wrap: kalau MAIN ternyata repost akun lain (headline+watermark), cari sumber asli &
  // ganti. Best-effort: tak abort kalau gagal. --no-trace untuk lewati.
  if (NO_TRACE) console.log('\n[2a] trace source di-SKIP (--no-trace).');
  else { try { step('2a', 'Trace source (anti re-wrap, MAIN)', 'trace_source.js', [contentSet, '--keywords', KEYWORDS]); } catch (e) { console.log('  ⚠️ trace dilewati: ' + String(e && e.message || e).slice(0, 60)); } }

  // News (chart kurs / artikel) → footage image cards. Best-effort: tak abort kalau Google tab
  // tak ada / 0 hasil (search_news exit 0). --no-news untuk lewati.
  if (NO_NEWS) console.log('\n[2b] news di-SKIP (--no-news).');
  else { try { step('2b', 'News (chart/artikel) → footage', 'search_news.js', [QUERY, '--append', contentSet, '--max', MAX]); } catch (e) { console.log('  ⚠️ news dilewati: ' + String(e && e.message || e).slice(0, 60)); } }

  if (NO_ENRICH) console.log('\n[3] enrich di-SKIP (--no-enrich) — image_path & relevance post non-video belum diisi.');
  else step(3, 'Enrich image_path + gate relevansi non-video', 'enrich_image_paths.js', [contentSet, '--keywords', KEYWORDS, '--mode', MODE]);

  step(4, 'Validate content-set', 'validate_content_set.js', [contentSet]);

  console.log(`\n${'='.repeat(60)}\n✅ SIAP. Content-set tervalidasi: ${contentSet}`);
  console.log(`Jalankan di project Thoth:\n  thoth run --content "${contentSet}"`);
} catch (e) {
  const msg = String(e && e.message || e);
  // execFileSync throws with the child's exit status; validate FAIL = exit 1.
  console.error(`\n❌ Pipeline berhenti: ${msg.slice(0, 120)}`);
  console.error('   Cek output stage di atas (tab relay ter-attach? URL ada? lint FAIL?).');
  process.exit(1);
}
