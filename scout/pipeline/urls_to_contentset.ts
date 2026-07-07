// urls_to_contentset.js — last glue: a topic's URL list (from topic_to_urls.js) → a ready
// Thoth content-set {main, footage[], comments[]}. Picks a video as `main` (what Thoth
// downloads+clips), turns the rest into `footage[]` with is_video flags so the pipeline knows
// which to download (TikTok/YouTube) vs crop as a still card (X/IG/FB → image_path via enrich).
//
//   node urls_to_contentset.js <topic_urls_*.json> [--main <url>] [--out <file>]
//
// Output → output/content_set_<slug>.json. Then: enrich_image_paths → validate_content_set → thoth run.

import fs from 'node:fs';
import path from 'node:path';
import { outPath } from '../lib/paths.ts';
import { tiktokOembed, youtubeOembed, matchesTopic } from '../lib/verify.ts';
import { ui } from '../lib/ui.ts';

const args = process.argv.slice(2);
const getFlag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const IN = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--main' && args[args.indexOf(a) - 1] !== '--out');
const MAIN_OVERRIDE = getFlag('--main');
if (!IN) { console.log('Usage: node urls_to_contentset.ts <topic_urls_*.json> [--main <url>] [--out <file>]'); process.exit(1); }
if (!fs.existsSync(IN)) { console.log(ui.red(`${ui.ERR} File tak ada: ${IN}`)); process.exit(1); }

let src; try { src = JSON.parse(fs.readFileSync(IN, 'utf8')); } catch (e) { console.log(ui.red(`${ui.ERR} JSON tak valid: ${e.message}`)); process.exit(1); }
const query = src.query || 'topik';
const all = Array.isArray(src.all) ? src.all : [];
if (!all.length) { console.log(ui.red(`${ui.ERR} Tak ada URL di field \`all\`.`)); process.exit(1); }

// TikTok/YouTube = video (yt-dlp downloadable); X/IG/FB = treat as non-video → still card via crop.
const VIDEO = new Set(['tiktok', 'youtube']);
const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'topic';
const OUT = getFlag('--out') || outPath(`content_set_${slug}.json`);
const handleOf = u => (u.match(/@([\w.]+)/) || [, ''])[1] || (u.match(/(?:x|twitter)\.com\/([^/?#]+)/) || [, ''])[1] || '';

(async () => {
  // Keywords for relevance gating (Thoth drops footage relevance != "match"). Default = topic.
  const KEYWORDS = (getFlag('--keywords') || query).split(/[ ,]+/).filter(Boolean);
  const MODE = getFlag('--mode') || 'any';
  const platOf = u => /threads\.(com|net)/.test(u) ? 'threads' : /tiktok\.com/.test(u) ? 'tiktok' : /youtube\.com|youtu\.be/.test(u) ? 'youtube'
    : /(?:x|twitter)\.com/.test(u) ? 'twitter' : /instagram\.com/.test(u) ? 'instagram' : /facebook\.com/.test(u) ? 'facebook' : 'web';

  // Caption of a VIDEO url via public oEmbed (for relevance checks); '' for non-video.
  const videoCaption = async e => {
    if (e.platform === 'tiktok') { const m = await tiktokOembed(e.url); return (m && m.title) || ''; }
    if (e.platform === 'youtube') { const m = await youtubeOembed(e.url); return (m && m.title) || ''; }
    return '';
  };

  // Choose main = the video Thoth will clip → MUST be on-topic. Prefer the first video (TikTok
  // then YouTube) whose oEmbed caption matches the keywords; fall back to the first video (with a
  // warning) or the first URL. An off-topic main would derail the entire clip.
  let main, mainCaption = '';
  if (MAIN_OVERRIDE) {
    main = { url: MAIN_OVERRIDE, platform: platOf(MAIN_OVERRIDE) };
    mainCaption = await videoCaption(main);
  } else {
    const vids = all.filter(e => VIDEO.has(e.platform));
    for (const v of vids) { const cap = await videoCaption(v); if (cap && matchesTopic(cap, KEYWORDS, MODE)) { main = v; mainCaption = cap; break; } }
    if (!main) {
      main = vids[0] || all[0];
      if (main && VIDEO.has(main.platform)) { mainCaption = await videoCaption(main); console.log(ui.amber(`${ui.WARN}  Tak ada video yg caption-nya match [${KEYWORDS.join(', ')}] — pakai video pertama (mungkin off-topic): ${main.url}`)); }
    }
  }
  if (!main) { console.log(ui.red(`${ui.ERR} Tak ada kandidat main.`)); process.exit(1); }

  const mainIsVideo = VIDEO.has(main.platform);
  if (!mainIsVideo) console.log(ui.amber(`${ui.WARN}  main bukan video (${main.platform}) — Thoth butuh main yg bisa di-ingest yt-dlp. Pertimbangkan --main <url tiktok/youtube>.`));

  // Title/description from the main's real caption (grounds narration); else topic line.
  const title = mainCaption || `${query}`;
  const description = mainCaption || `Topik viral: ${query}`;
  const mainAuthor = handleOf(main.url);

  const mainObj = {
    url: main.url, platform: main.platform, title, description,
    is_video: mainIsVideo, duration_sec: 0,
    profile: { name: mainAuthor, handle: mainAuthor, followers: '', avatar_url: '' },
  };

  // Relevance gate for footage. VIDEO gated here (oEmbed caption); NON-VIDEO left "" and gated
  // later by enrich_image_paths (reads post text while cropping).
  const footage = [];
  let matched = 0;
  for (const e of all.filter(x => x.url !== main.url)) {
    const isVid = VIDEO.has(e.platform);
    let relevance = '';
    if (isVid) {
      const cap = await videoCaption(e);
      relevance = cap && matchesTopic(cap, KEYWORDS, MODE) ? 'match' : 'unverified';
      if (relevance === 'match') matched++;
    }
    footage.push({ url: e.url, platform: e.platform, query, is_video: isVid, relevance });
  }

  const set = { main: mainObj, footage, comments: [] };
  fs.writeFileSync(OUT, JSON.stringify(set, null, 2), 'utf8');

  const vid = footage.filter(f => f.is_video).length;
  const img = footage.length - vid;
  console.log(ui.rule());
  console.log('  URLs → Content-Set');
  console.log(ui.rule());
  console.log(`Topik   : ${query}`);
  console.log(`Main    : [${mainObj.platform}${mainObj.is_video ? '' : ui.amber(` ${ui.WARN}non-video`)}] ${mainObj.url}`);
  console.log(`          "${title.slice(0, 70)}"`);
  console.log(`Footage : ${footage.length} (${vid} video cutaway [${matched} on-topic/"match"] + ${img} non-video → image card; relevance non-video di-gate saat enrich)`);
  console.log(`Gate    : keywords=[${KEYWORDS.join(', ')}] mode=${MODE}`);
  console.log(`📄 ${OUT}`);
  console.log(ui.rule('thin'));
  console.log('Lanjut:');
  console.log(`  node enrich_image_paths.ts "${OUT}"`);
  console.log(`  node validate_content_set.ts "${OUT}"`);
  console.log(`  thoth run --content "${OUT}"`);
})();
