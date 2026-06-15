// build_footage.js — build footage[] from VISUAL OBJECTS (footage_objects) instead of the topic query.
//
// Footage = cutaway b-roll of the concrete things in the story. For each object (e.g. gojek, grab,
// indofest senayan) we search all platforms and take `--per` items as a MIX of video b-roll
// (TikTok/YouTube → is_video:true) and posts (X/IG/FB/Threads → cropped to image_path). Each footage
// is gated to ITS object (relevance:"match", query=object) so Thoth keeps it.
//
//   node build_footage.js <content_set.json> [--objects "a,b,c"] [--per 2] [--max 3] [--no-crop]
//
// Without --objects, objects are extracted from main.title + main.description via footage_objects (LLM).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { footageObjects } = require('./footage_objects');
const { cropPost, inferPlatform } = require('./crop_post');
const { tiktokOembed, youtubeOembed } = require('./verify');
const { igProfileReels } = require('./ig_profile');
const { rankBySimilarity, embed, cosine } = require('./embed');
const { tiktokDirectUrl } = require('./tiktok_video');
const { outPath } = require('./paths');
const { isCuratedAggregator, urlHandle } = require('./aggregators');

const args = process.argv.slice(2);
const getFlag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const FILE = args.find((a, i) => !a.startsWith('--') && !['--objects', '--per', '--max', '--profile'].includes(args[i - 1]));
const OBJ_FLAG = getFlag('--objects', null);
const PER = parseInt(getFlag('--per', '2'), 10);
const MAX = getFlag('--max', '3');
const NO_CROP = args.includes('--no-crop');
const PROFILE_FLAG = getFlag('--profile', null); // IG username to also pull relevant footage from
if (!FILE) { console.log('Usage: node build_footage.js <content_set.json> [--objects "a,b"] [--per 2] [--max 3] [--no-crop]'); process.exit(1); }
if (!fs.existsSync(FILE)) { console.log('❌ File tak ada:', FILE); process.exit(1); }

const VIDEO = new Set(['tiktok', 'youtube']);
const slugify = q => q.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'q';

// A footage hit is RELEVANT to its object when the caption/post text contains the object's
// significant tokens. Drops generic/off-topic search noise — especially uncurated X/IG/FB posts
// (topic_to_urls only caption-gates TikTok at search time, not posts).
function relevant(text, obj) {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return false;
  // Require ALL significant tokens (≥3 chars) present — multi-word objects must match fully so a
  // single generic token (e.g. "pictures") can't let off-topic noise through ("mvp pictures" must
  // have BOTH "mvp" AND "pictures", not just "pictures").
  const toks = obj.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
  if (!toks.length) return true;
  return toks.every(w => t.includes(w));
}

// Promo/spam post: link-first or carrying a known spam/shortener domain. Such posts ride a topic's
// hashtags but aren't real footage of it (e.g. "Yang lagi viral di mobil vidku.fun … #Gempa").
function looksSpam(text) {
  const t = (text || '').toLowerCase().trim();
  return /^https?:\/\//.test(t) || /vidku\.|t\.me\/|bit\.ly|tinyurl|cutt\.ly|\.fun\b|\.xyz\b/i.test(t);
}

// Run topic_to_urls for an object, gated to that object, return the merged `all` list.
function searchObject(obj) {
  try { execFileSync('node', [path.join(__dirname, 'topic_to_urls.js'), obj, '--platforms', 'tiktok,tw,ig,fb', '--max', String(MAX), '--keywords', obj], { stdio: 'pipe', timeout: 200000 }); }
  catch (e) { /* exit!=0 tolerated */ }
  const f = outPath(`topic_urls_${slugify(obj)}.json`);
  if (!fs.existsSync(f)) return [];
  try { return (JSON.parse(fs.readFileSync(f, 'utf8')).all) || []; } catch (e) { return []; }
}

(async () => {
  const set = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  set.footage = set.footage || [];
  const main = set.main || {};

  // IG creator to ALSO pull footage from: explicit --profile, else auto from a traced IG source.
  const profileUser = PROFILE_FLAG || ((main.source_traced && /instagram/i.test(main.platform || '')) ? main.source_traced : '');

  let objects = OBJ_FLAG ? OBJ_FLAG.split(',').map(s => s.trim()).filter(Boolean)
    : await footageObjects({ description: main.description || '', headline: main.title || '' });
  console.log('='.repeat(60));
  console.log('  Build Footage dari OBJEK' + (profileUser ? ' + PROFIL @' + profileUser : ''));
  console.log('='.repeat(60));
  console.log('Objek:', objects.join(' | ') || '(kosong)');
  if (!objects.length && !profileUser) { console.log('Tak ada objek. Selesai.'); process.exit(0); }

  const have = new Set(set.footage.map(f => f.url));
  let addedV = 0, addedP = 0;

  // FOOTAGE dari profil SUMBER (creator asli): reel-reel creator yang RELEVAN ke topik (selain main) —
  // konten autentik & on-topik. IG reel downloadable Thoth via cookies. Cap biar tetap variatif.
  const REL_MIN = 0.30; // cosine floor: on-topic reels ≥~0.33, off-topic ≤~0.27 (qwen3-embedding).
  if (profileUser && isCuratedAggregator(profileUser)) {
    console.log(`• profil @${profileUser} = akun kurator (ig_accounts) → skip footage profil`);
  } else if (profileUser) {
    process.stdout.write(`• profil @${profileUser} … `);
    let added = 0;
    try {
      const reels = await igProfileReels(profileUser, { max: 8, captions: true });
      // Topic text = objects + figure names + title → rank creator reels by MEANING (a casual creator
      // caption rarely shares literal words with the story keywords). Keep only on-topic ones (sim≥floor).
      const topic = [...objects, ...(set.figures || []).map(f => f.name), main.title || ''].filter(Boolean).join(', ');
      const ranked = await rankBySimilarity(topic, reels, r => r.caption || '');
      // No embeddings (sim all 0) → fall back to literal token overlap so we still add something useful.
      const useSim = ranked.some(r => r.sim > 0);
      const toks = new Set();
      const addToks = s => (s || '').toLowerCase().split(/\s+/).forEach(w => w.length >= 4 && toks.add(w));
      objects.forEach(addToks); (set.figures || []).forEach(f => addToks(f.name)); addToks(main.title);
      for (const r of ranked) {
        if (added >= PER + 1) break;
        if (r.url === main.url || have.has(r.url)) continue;
        if (useSim) { if (r.sim < REL_MIN) continue; }
        else { const cap = (r.caption || '').toLowerCase(); if (toks.size && ![...toks].some(t => cap.includes(t))) continue; }
        have.add(r.url);
        set.footage.push({ url: r.url, platform: 'instagram', query: 'profil @' + profileUser, is_video: true, relevance: 'match', description: r.caption || '' });
        added++; addedV++;
      }
      fs.writeFileSync(FILE, JSON.stringify(set, null, 2), 'utf8');
    } catch (e) {}
    console.log(`+${added} reel relevan`);
  }
  for (const obj of objects) {
   try {
    process.stdout.write(`• "${obj}" … `);
    const rawAll = searchObject(obj);
    const all = rawAll.filter(e => !isCuratedAggregator(urlHandle(e.url))); // never footage from ig_accounts curators / their cross-posts
    const aggSkip = rawAll.length - all.length;
    const vids = all.filter(e => VIDEO.has(e.platform) && !have.has(e.url));
    const posts = all.filter(e => inferPlatform(e.url) && !have.has(e.url)); // x/ig/fb/threads croppable
    const nVid = Math.ceil(PER / 2), nPost = PER - nVid;
    const pickV = vids.slice(0, nVid);
    let pickP = posts.slice(0, nPost);
    // fill shortfall from the other type
    while (pickV.length + pickP.length < PER) {
      const more = vids.slice(pickV.length).concat(posts.slice(pickP.length)).find(e => !pickV.includes(e) && !pickP.includes(e));
      if (!more) break;
      (VIDEO.has(more.platform) ? pickV : pickP).push(more);
    }
    let pv = 0, pp = 0, dropped = 0;
    for (const e of pickV) {
      have.add(e.url);
      // description = caption asli footage (oEmbed) → di-embed Thoth utk cocokkan ke narasi.
      let description = '';
      try {
        if (e.platform === 'tiktok') { const m = await tiktokOembed(e.url); description = (m && m.title) || ''; }
        else if (e.platform === 'youtube') { const m = await youtubeOembed(e.url); description = (m && m.title) || ''; }
      } catch (err) {}
      // GATE: video TikTok sudah di-caption-gate saat search → caption kosong tetap diterima
      // (percaya gate search); kalau ADA caption, harus cocok ke objek.
      if (description.trim() && !relevant(description, obj)) { dropped++; continue; }
      // TikTok: yt-dlp (Thoth) tak bisa download PAGE TikTok (extractor rusak/403) → resolve ke URL
      // CDN mp4 langsung (tikwm→CDP) yg yt-dlp generic BISA download. Simpan page asli di source_url.
      // Gagal resolve → biar page url (Thoth drop diam, non-fatal). URL CDN ephemeral → jalankan thoth segera.
      let furl = e.url, src_url;
      if (e.platform === 'tiktok') { try { const d = await tiktokDirectUrl(e.url); if (d && d.url) { furl = d.url; src_url = e.url; } } catch (err) {} }
      set.footage.push({ url: furl, platform: e.platform, query: obj, is_video: true, relevance: 'match', description, ...(src_url ? { source_url: src_url } : {}) });
      pv++; addedV++;
    }
    for (const e of pickP) {
      have.add(e.url);
      let image_path = '', description = '';
      if (!NO_CROP) { try { const r = await cropPost({ url: e.url }); if (r.ok) { image_path = r.image_path; description = (r.text || '').trim(); } } catch (err) {} }
      // GATE: post (X/IG/FB) TIDAK di-gate saat search → wajib teks-nya cocok ke objek + bukan spam.
      if (!relevant(description, obj) || looksSpam(description)) { if (image_path) { try { fs.rmSync(image_path); } catch (e2) {} } dropped++; continue; }
      if (NO_CROP || image_path) { set.footage.push({ url: e.url, platform: e.platform === 'tw' ? 'twitter' : e.platform === 'ig' ? 'instagram' : e.platform, query: obj, is_video: false, relevance: 'match', image_path, description }); pp++; addedP++; }
    }
    console.log(`+${pv}v/${pp}p` + (dropped ? ` (${dropped} drop tak-relevan)` : '') + (aggSkip ? ` (${aggSkip} drop akun-kurator)` : ''));
    fs.writeFileSync(FILE, JSON.stringify(set, null, 2), 'utf8'); // persist after EACH object (crash-resilient)
   } catch (e) {
    console.log(`(⚠️ "${obj}" gagal: ${String((e && e.message) || e).slice(0, 70)} — skip)`);
   }
  }

  // ── STORY-GATE: buang footage yang DESKRIPSINYA jauh dari cerita main (cosine) ─────────────────
  // Object-gate (relevant()) cuma cek token objek; footage bisa lolos tapi beda ANGLE (mis. "Berapa
  // Gaji Petugas SPBU" / "Harga Pertamax naik" share domain SPBU/bensin tapi bukan insidennya).
  // CATATAN: gate ini KASAR — footage yang share domain skornya mirip yang on-topik (semua ~0.4),
  // jadi ambang dibuat KONSERVATIF (buang ekor terjelas saja); penyaringan halus ada di placement
  // Thoth (relevance floor per-window). Override: THOTH_FOOTAGE_STORY_MIN.
  const STORY_MIN = parseFloat(process.env.THOTH_FOOTAGE_STORY_MIN || '0.33');
  try {
    const story = `${main.title || ''}. ${main.description || ''}`.trim();
    const gated = set.footage.filter(f => (f.description || '').trim());
    if (story && gated.length) {
      const vecs = await embed([story, ...gated.map(f => f.description)]);
      const q = vecs[0];
      if (q) {
        const drop = new Set();
        gated.forEach((f, i) => { const s = cosine(q, vecs[i + 1]); if (vecs[i + 1] && s < STORY_MIN) { drop.add(f); console.log(`  ✂️ story-gate drop (${s.toFixed(3)}<${STORY_MIN}): ${(f.description || '').slice(0, 55)}`); } });
        if (drop.size) {
          for (const f of drop) { if (f.image_path) { try { fs.rmSync(f.image_path); } catch (e) {} } }
          set.footage = set.footage.filter(f => !drop.has(f));
        }
      }
    }
  } catch (e) {}

  fs.writeFileSync(FILE, JSON.stringify(set, null, 2), 'utf8');
  console.log('-'.repeat(60));
  console.log(`Selesai: +${addedV} video b-roll, +${addedP} kartu post → footage total ${set.footage.length}. (${FILE})`);
  console.log('Lalu: node validate_content_set.js "' + FILE + '"');
})();
