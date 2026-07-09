// trace_source.ts — resolve the ORIGINAL source of the MAIN video so Thoth doesn't double up a
// re-wrap's baked headline/watermark. Detection is LLM-driven (resolve_source.ts) over THREE text
// signals: main DESCRIPTION + CAPTION (oEmbed) + on-screen HEADLINE (read via vision from the cover).
//
//   bun trace_source.ts <content_set.json> [--keywords k1,k2] [--username <u>] [--model <m>]
//
// Flow (MAIN only):
//   1. Gather description + caption + headline(vision) of main.
//   2. resolveSource(LLM) → { source:{account,platform} | null, keywords[] }.
//   3. source → cari video akun itu (YouTube channel-name / TikTok-X handle-match) → GANTI main;
//      tak ketemu → main.rewrap=true + hint.
//   4. tak ada source, ada keywords → simpan main.source_keywords; kalau main NON-VIDEO, search
//      keywords → ambil video → jadikan main. (Main video yang sudah bagus TIDAK diganti.)
//   --username memaksa sumber (skip deteksi).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { connect, sleep } from '../lib/cdp.ts';
import { tiktokOembed, youtubeOembed, matchesTopic, probeVideo } from '../lib/verify.ts';
import { resolveSource, composeSearchQuery, tightenQuery } from './resolve_source.ts';
import { threadsVideoSrc, downloadThreads } from '../scrapers/threads_video.ts';
import { igProfileReels } from '../scrapers/ig_profile.ts';
import { tiktokProfileVideos, cropTiktokProfile } from '../scrapers/tiktok_profile.ts';
import { rankBySimilarity } from '../lib/embed.ts';
import { tiktokDirectUrl, downloadTiktok } from '../scrapers/tiktok_video.ts';
import { outPath } from '../lib/paths.ts';
import { isCuratedAggregator } from '../lib/aggregators.ts';
import { cropProfile } from '../scrapers/profile_crop.ts';

const args = process.argv.slice(2);
const getFlag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const FILE = args.find((a, i) => !a.startsWith('--') && !['--keywords', '--username', '--model'].includes(args[i - 1]));
const KEYWORDS = (getFlag('--keywords') || '').split(/[ ,]+/).filter(Boolean);
const FORCE_USER = getFlag('--username');
const NO_DL = args.includes('--no-threads-dl') || args.includes('--no-dl'); // skip local mp4 backup (Threads/TikTok)
const MODEL = getFlag('--model') || process.env.THOTH_VISION_MODEL || 'qwen/qwen3-vl-30b-a3b-instruct';
if (!FILE) { console.log('Usage: bun trace_source.ts <content_set.json> [--keywords k1,k2] [--username <u>] [--model <m>]'); process.exit(1); }
if (!fs.existsSync(FILE)) { console.log(ui.red(`${ui.ERR} File tak ada: ${FILE}`)); process.exit(1); }

const VIDEO = new Set(['tiktok', 'youtube']);
// Platforms whose posts can become a downloadable MAIN. tiktok/youtube are always video; twitter/
// instagram/facebook are admitted as candidates but each must pass a per-URL yt-dlp video probe;
// threads can't be probed by yt-dlp (page = "Unsupported URL") → confirmed via threadsVideoSrc (fbcdn).
const DLABLE = new Set(['tiktok', 'youtube', 'twitter', 'instagram', 'facebook', 'threads']);
import { novitaKey } from '../lib/env.ts';
import { ui } from '../lib/ui.ts';
const cleanUser = u => (u || '').replace(/^@/, '').replace(/[^A-Za-z0-9._].*$/, '').toLowerCase();

// Caption of the main video via public oEmbed (TikTok/YouTube). '' otherwise.
async function captionOf(main) {
  if (main.platform === 'tiktok') { const m = await tiktokOembed(main.url); return m && m.title || ''; }
  if (main.platform === 'youtube') { const m = await youtubeOembed(main.url); return m && m.title || ''; }
  if (main.platform === 'twitter') { return await twitterText(main.url); }
  if (main.platform === 'threads') { return (await threadsOg(main.url)).text; }
  return '';
}
// Threads keeps clean og:description (post text) + og:image (poster/photo) in the logged-in DOM —
// unlike X, which strips them. One CDP read serves both captionOf and coverOf; cached per-url since
// trace_source handles one main per run. ponytail: 1-entry cache is enough for a single-main process.
let _thrOg = { url: '', text: '', image: '' };
async function threadsOg(url) {
  if (_thrOg.url === url) return _thrOg;
  const res = { url, text: '', image: '' };
  let c; try { c = await connect({ match: ['threads.com', 'threads.net'], requireMatch: true }); } catch (e) { _thrOg = res; return res; }
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    await c.navigate(url, 8000); await sleep(3000);
    const raw = await c.evaluate(`JSON.stringify({
      text: (document.querySelector('meta[property="og:description"]')||{}).content||'',
      image: (document.querySelector('meta[property="og:image"]')||{}).content||''
    })`);
    try { const o = JSON.parse(raw || '{}'); res.text = (o.text || '').trim(); res.image = (o.image || '').trim(); } catch (e) {}
  } catch (e) {} finally { try { c.close(); } catch (e) {} }
  _thrOg = res; return res;
}
// X/Twitter has no post-text oEmbed → read the tweet body from the logged-in X tab over CDP,
// same selector the comment scraper uses (article[data-testid="tweet"] → tweetText). og:description
// is the fallback when the SPA article DOM hasn't hydrated yet.
async function twitterText(url) {
  let c; try { c = await connect({ match: ['x.com', 'twitter.com'], requireMatch: true }); } catch (e) { return ''; }
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    await c.navigate(url, 8000); await sleep(3000);
    const txt = await c.evaluate(`(() => {
      const a = document.querySelector('article[data-testid="tweet"]');
      const t = a && a.querySelector('[data-testid="tweetText"]');
      if (t && t.innerText.trim()) return t.innerText.trim();
      return (document.querySelector('meta[property="og:description"]')||{}).content || '';
    })()`);
    return (txt || '').trim();
  } catch (e) { return ''; } finally { try { c.close(); } catch (e) {} }
}
// Cover image of an IG reel = its og:image (the generated cover frame, which carries the on-screen
// HEADLINE overlay). oEmbed doesn't cover IG, so read it from the page over CDP (logged-in tab).
async function igCoverImage(url) {
  let c; try { c = await connect({ match: 'instagram.com', requireMatch: true }); } catch (e) { return ''; }
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    await c.navigate(url, 6000); await sleep(2500);
    const og = await c.evaluate(`(document.querySelector('meta[property="og:image"]')||{}).content || ''`);
    return og || '';
  } catch (e) { return ''; } finally { try { c.close(); } catch (e) {} }
}
// X/Twitter cover = the video poster frame (or photo) via yt-dlp's %(thumbnail)s. Tab-independent —
// the logged-in SPA does NOT inject og:image client-side (only server-rendered HTML has it), so a CDP
// og read returns empty; yt-dlp reads the real amplify_video_thumb URL. '' for text-only tweets.
function xCoverImage(url) {
  const YTDLP = process.env.YTDLP || 'yt-dlp';
  try {
    const out = execFileSync(YTDLP, ['--skip-download', '--no-warnings', '--print', '%(thumbnail)s', '--', url],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000 }).toString().trim().split(/\r?\n/)[0].trim();
    return /^https?:\/\//.test(out) ? out : '';
  } catch (e) { return ''; }
}
async function coverOf(main) {
  if (main.platform === 'tiktok') { const m = await tiktokOembed(main.url); return m && m.thumbnail || ''; }
  if (main.platform === 'youtube') { const m = await youtubeOembed(main.url); return m && m.thumbnail || ''; }
  if (main.platform === 'instagram') { return await igCoverImage(main.url); }
  if (main.platform === 'twitter') { return await xCoverImage(main.url); }
  if (main.platform === 'threads') { return (await threadsOg(main.url)).image; }
  return '';
}

// VISION: read the on-screen HEADLINE/HOOK text (+ any visible credit/watermark) from the cover, as
// plain text — the LLM (resolveSource) then decides if it names a source or yields keywords.
async function visionHeadline(imgUrl, key, model) {
  if (!imgUrl || !key) return '';
  let ct = 'image/jpeg', b64;
  try { const ir = await fetch(imgUrl); if (!ir.ok) return ''; ct = ir.headers.get('content-type') || ct; b64 = Buffer.from(await ir.arrayBuffer()).toString('base64'); }
  catch (_) { return ''; }
  const prompt = `Baca SEMUA teks yang terlihat di cover video ini: HEADLINE/HOOK besar (judul/pancingan)
DAN kredit/watermark akun kecil bila ada (mis. "@akun", "cr: ...", logo channel). Kembalikan HANYA
teksnya apa adanya (gabung jadi 1-2 baris), atau "" kalau tak ada teks.`;
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, max_tokens: 200, temperature: 0, messages: [{ role: 'user', content: [
        { type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${ct};base64,${b64}` } }] }] }),
    });
    if (!resp.ok) return '';
    const d = await resp.json();
    return ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim().slice(0, 300);
  } catch (_) { return ''; }
}

// VISION: describe the SCENE (action/objects) + any on-screen text of a cover image as one plain
// sentence. Used to disambiguate a creator's many near-identical clips by what's actually happening
// (captions on high-volume creators are generic hashtags). '' on failure / no key.
async function visionCover(imgUrl, key, model) {
  if (!imgUrl || !key) return '';
  let ct = 'image/jpeg', b64;
  try { const ir = await fetch(imgUrl); if (!ir.ok) return ''; ct = ir.headers.get('content-type') || ct; b64 = Buffer.from(await ir.arrayBuffer()).toString('base64'); }
  catch (_) { return ''; }
  const prompt = `Lihat cover video ini. WAJIB & PALING PENTING: baca SEMUA teks overlay/judul di cover
APA ADANYA (itu sinyal topik paling menentukan untuk membedakan klip mirip). Lalu deskripsikan singkat
AKSI/kegiatan spesifik yang terjadi (apa yang sedang dilakukan), objek, dan lokasi — bukan cuma siapa
orangnya. Format: "<teks overlay>. <aksi/scene singkat>". Bahasa Indonesia, tanpa tanda kutip.`;
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, max_tokens: 160, temperature: 0, messages: [{ role: 'user', content: [
        { type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${ct};base64,${b64}` } }] }] }),
    });
    if (!resp.ok) return '';
    const d = await resp.json();
    return ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim().slice(0, 200);
  } catch (_) { return ''; }
}

// VISION: like visionCover but ALSO classifies the cover as `footage` (raw recording OF the event —
// CCTV/eyewitness/news b-roll of the actual scene, people, place, incident) vs `commentary` (someone
// talking TO camera: talking-head/selfie/reaction, news anchor at a desk, podcast, a text/meme card,
// slideshow). One call (JSON) → same vision cost as visionCover. Used by findStoryVideo to PREFER the
// original footage over an on-topic commentary clip whose narratable caption otherwise out-ranks it.
// Returns { desc, kind } where kind ∈ 'footage'|'commentary'|'' (unknown). '' kind on any failure →
// caller degrades to similarity-only (old behavior).
async function visionCoverKind(imgUrl, key, model) {
  if (!imgUrl || !key) return { desc: '', kind: '' };
  let ct = 'image/jpeg', b64;
  try { const ir = await fetch(imgUrl); if (!ir.ok) return { desc: '', kind: '' }; ct = ir.headers.get('content-type') || ct; b64 = Buffer.from(await ir.arrayBuffer()).toString('base64'); }
  catch (_) { return { desc: '', kind: '' }; }
  const prompt = `Lihat cover video ini. Kerjakan DUA hal, balas HANYA JSON valid (tanpa markdown):
1) "desc": baca SEMUA teks overlay/judul APA ADANYA, lalu deskripsikan singkat aksi/scene + lokasi.
2) "kind": klasifikasikan ISI VISUAL cover —
   "footage" = REKAMAN ASLI kejadian: CCTV, rekaman saksi/HP, b-roll berita atas lokasi/orang/peristiwa
     yang sebenarnya (orang BERADA DI DALAM kejadian).
   "commentary" = orang BICARA KE kamera (talking-head/selfie/reaction), pembawa berita di meja studio,
     podcast, kartu teks/meme, slideshow, split-screen reaksi.
Contoh: {"desc":"...", "kind":"footage"}`;
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, max_tokens: 220, temperature: 0, messages: [{ role: 'user', content: [
        { type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${ct};base64,${b64}` } }] }] }),
    });
    if (!resp.ok) return { desc: '', kind: '' };
    const d = await resp.json();
    const raw = ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim();
    try { const j = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim()); const k = String(j.kind || '').toLowerCase(); return { desc: String(j.desc || '').slice(0, 200), kind: (k === 'footage' || k === 'commentary') ? k : '' }; }
    catch (_) { return { desc: raw.slice(0, 200), kind: /commentary|talking|reaksi|reaction|studio|podcast/i.test(raw) ? 'commentary' : '' }; }
  } catch (_) { return { desc: '', kind: '' }; }
}

// Normalise a handle/name for fuzzy compare (drop @, spaces, separators): hipmi_tv = hipmitv = "HIPMI TV".
const normHandle = s => (s || '').replace(/^@/, '').toLowerCase().replace(/[\s._\-]/g, '');

// URL belongs to @username? (TikTok/X encode the handle in the URL.)
function handleMatch(url, u) {
  const want = normHandle(u);
  let h = '';
  let m = url.match(/tiktok\.com\/@([\w.\-]+)/i) || url.match(/threads\.(?:com|net)\/@([\w.\-]+)/i);
  if (m) h = m[1];
  else { m = url.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)(?:\/|$|\?)/i); if (m && !/^(home|search|explore|i|hashtag|messages)$/i.test(m[1])) h = m[1]; }
  return !!h && normHandle(h) === want;
}

// Find a Threads source by PROFILE: open threads.com/@user, read each post's text, and pick the one
// whose text MATCHES the keywords (not just the newest). Falls back to newest if no keyword match.
// Guarded: needs a threads.com/threads.net tab attached.
async function findOriginalThreads(username, keywords = []) {
  let c; try { c = await connect({ match: ['threads.com', 'threads.net'], requireMatch: true }); } catch (e) { return null; }
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    await c.navigate('https://www.threads.com/@' + username, 6000);
    await sleep(2800);
    const raw = await c.evaluate(`(() => {
      const seen = new Set(); const out = [];
      document.querySelectorAll('[data-pressable-container="true"]').forEach(el => {
        const a = Array.from(el.querySelectorAll('a')).find(x => (x.getAttribute('href') || '').includes('/post/'));
        if (!a) return;
        const href = new URL(a.getAttribute('href'), location.origin).href.split('?')[0];
        if (seen.has(href)) return; seen.add(href);
        out.push({ href, text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240) });
      });
      return JSON.stringify(out.slice(0, 20));
    })()`);
    let posts = []; try { posts = JSON.parse(raw || '[]'); } catch (e) {}
    const ownRe = new RegExp('/@' + username.replace(/\./g, '\\.') + '/post/', 'i');
    const pool = posts.filter(p => ownRe.test(p.href));
    const list = pool.length ? pool : posts;
    let pick = keywords.length ? list.find(p => matchesTopic(p.text, keywords, 'any')) : null;
    if (!pick) pick = list[0];
    if (pick) console.log(`    [threads] pilih post ${keywords.length && list.indexOf(pick) >= 0 && matchesTopic(pick.text, keywords, 'any') ? '(match keyword)' : '(terbaru)'}: ${pick.href}`);
    return pick ? { url: pick.href, platform: 'threads' } : null;
  } finally { c.close(); }
}

// Find the ORIGINAL on Instagram by PROFILE: open instagram.com/<user>/reels/ → newest reel.
// The creator's own reel is the authentic source (vs a curator repost with baked overlay). Reels grid
// has no captions, so take the newest reel (creators like this post on-topic consistently). IG reels
// are downloadable by Thoth via firefox cookies. Guarded: needs an instagram.com tab attached.
// Source-reel pick is VIEWS-dominated: a creator gets credited for the SPECIFIC clip that went viral,
// so the reposted video is essentially always their most-viewed reel. (Its caption is often generic
// motivational text — semantically indistinguishable from off-topic reels — so caption similarity is a
// weak signal for *identity*, only useful as a sanity guard.) OFF_FLOOR = clearly-unrelated; ON_FLOOR =
// confidently on-topic. Used by build_footage too for the profile-footage relevance floor.
const OFF_FLOOR = 0.25, ON_FLOOR = 0.33;

async function findOriginalInstagram(username, keywords = [], topicText = '') {
  // includePosts:true → also scan feed posts (/p/), since creators often publish the source as a feed
  // VIDEO post, not a Reel; keep only verified-video posts (a /p/ can be a photo/carousel).
  const all = await igProfileReels(username, { max: 10, captions: true, includePosts: true });
  const reels = all.filter(r => r.isVideo !== false);
  if (!reels.length) return null;
  const topic = (topicText || keywords.join(', ')).trim();
  // Annotate with semantic sim (0 when no embeddings), then default to the highest-views reel.
  const ranked = topic ? await rankBySimilarity(topic, reels, r => r.caption || '') : reels.map(r => ({ ...r, sim: 0 }));
  const byViews = ranked.slice().sort((a, b) => b.views - a.views);
  let pick = byViews[0], how = 'views terbanyak (viral = direpost)';
  // GUARD: only override views if the top-views reel is clearly off-topic AND a confidently on-topic
  // reel exists — then take the highest-views among the on-topic set (handles a creator whose biggest
  // hit is unrelated to this story).
  const haveSim = ranked.some(r => r.sim > 0);
  if (haveSim && pick.sim < OFF_FLOOR) {
    const onTopic = byViews.filter(r => r.sim >= ON_FLOOR);
    if (onTopic.length) { pick = onTopic[0]; how = `top-views off-topik → konten on-topik (sim≥${ON_FLOOR}), views terbanyak`; }
  }
  console.log(`    [ig] pilih reel (${how}) ~${(pick.views || 0).toLocaleString()} views sim=${(pick.sim || 0).toFixed(3)}: ${pick.url}`);
  return { url: pick.url, platform: 'instagram', caption: pick.caption || '' };
}

// Find the ORIGINAL on TikTok by PROFILE (not search): open tiktok.com/@user, list the video grid, and
// pick the one whose caption best matches THIS story. TikTok search rarely surfaces a specific account's
// own post (so findOriginal/handleMatch keeps failing), but the profile grid lists it directly. A
// `tt/<user>` creator often posts MANY similar clips, so we rank by MEANING (caption↔story) and take the
// best on-topic one (≥ON_FLOOR); fall back to top-views only when embeddings are unavailable. Returns
// {url,platform:'tiktok',caption}|null. Needs a logged-in tiktok.com tab attached.
async function findOriginalTiktok(username, topicText = '', keywords = []) {
  let vids = [];
  try { vids = await tiktokProfileVideos(username, { max: 30, captions: true }); } catch (e) { return null; }
  if (!vids.length) { console.log(`    [tiktok] profil @${username}: 0 video terbaca (login/tab?).`); return null; }
  const topic = (topicText || keywords.join(', ')).trim();
  const capRanked = topic ? await rankBySimilarity(topic, vids, v => v.caption || '') : vids.map(v => ({ ...v, sim: 0 }));
  const key = novitaKey();

  // No vision available → IG-style: top-views, override to highest-views-on-topic only if the top is
  // clearly off-topic. (Caption sim is weak for these flooder creators, hence low confidence.)
  if (!key) {
    const byViews = capRanked.slice().sort((a, b) => b.views - a.views);
    let pick = byViews[0];
    if (capRanked.some(r => r.sim > 0) && pick.sim < OFF_FLOOR) { const on = byViews.filter(r => r.sim >= ON_FLOOR); if (on.length) pick = on[0]; }
    if (!pick) return null;
    console.log(`    [tiktok] (no-vision) pilih ~${(pick.views || 0).toLocaleString()} views sim=${(pick.sim || 0).toFixed(3)}: ${pick.url}`);
    return { url: pick.url, platform: 'tiktok', caption: pick.caption || '', lowConfidence: true };
  }

  // Captions are generic firefighter hashtags → unreliable for the SPECIFIC incident. Rank by the COVER
  // SCENE (vision). Bound vision cost to a pool: top-by-views (reposted-viral clip is high-views) ∪
  // top-by-caption-sim, then rank cover↔story. Best-effort: a flooder creator has many near-identical
  // covers, so flag low-confidence when the top picks are visually clustered.
  // Wider pool = better recall so the RIGHT clip (lower-views / generic-caption) isn't excluded before
  // vision ranking even gets to see it.
  const byViews = vids.slice().sort((a, b) => b.views - a.views).slice(0, 16);
  const byCap = capRanked.slice(0, 8);
  const pool = [...new Map([...byViews, ...byCap].map(v => [v.url, v])).values()];
  console.log(`    [tiktok] profil @${username}: ${vids.length} video → vision-cover ${pool.length} kandidat…`);
  for (const v of pool) { v.cover = await visionCover(v.thumbnail, key, MODEL); }
  // Rank by cover SCENE+overlay (vision) AND caption together — the cover's overlay text + the caption
  // carry the specific ACTIVITY that separates near-identical clips of the same subject/place.
  const ranked = await rankBySimilarity(topic, pool, v => [v.cover, v.caption].filter(Boolean).join('. '));
  if (!ranked.some(r => r.sim > 0)) return null;
  const top = ranked[0], second = ranked[1] || { sim: 0 };
  if ((top.sim || 0) < ON_FLOOR) { console.log(`    [tiktok] cover terbaik sim=${(top.sim || 0).toFixed(3)}<${ON_FLOOR} → tak cukup yakin, batal.`); return null; }
  const lowConfidence = (top.sim - (second.sim || 0)) < 0.05 || top.sim < 0.50;
  console.log(`    [tiktok] pilih video profil (vision-cover sim=${(top.sim || 0).toFixed(3)}${lowConfidence ? ui.amber(` ${ui.WARN} LOW-CONFIDENCE: banyak klip mirip`) : ''}) ~${(top.views || 0).toLocaleString()} views: ${top.url}`);
  console.log(`              cover: "${(top.cover || '').slice(0, 80)}"`);
  return { url: top.url, platform: 'tiktok', caption: top.caption || '', lowConfidence };
}

// Detect a camera-emoji credit ("[📸 @user]", "📷 @user", "🎥 cr: @user") → the original is on
// INSTAGRAM (common IG-repost convention the LLM may miss). Returns username (no @) or ''.
function detectCameraCredit(text) {
  const m = (text || '').match(/[📸📷🎥🎬🎞️📹]\s*(?:cr\.?|credit|by)?\s*[:\-]?\s*@([A-Za-z0-9._]{2,30})/i);
  return m ? cleanUser(m[1]) : '';
}

// Detect a "tt/{username}" credit (TikTok shorthand: "tt/user", "tt/@user", "tt: @user") → the
// original is on TIKTOK. `\btt` word-boundary so it won't fire inside words like "scott". Returns
// username (no @) or ''.
function detectTiktokCredit(text) {
  const m = (text || '').match(/\btt\s*[/:]\s*@?([A-Za-z0-9._]{2,30})/i);
  return m ? cleanUser(m[1]) : '';
}

// Run topic_to_urls for a query, return the merged `all` URL list. `gateKw` (optional) caption-gates
// TikTok search to that keyword at source (drops generic-feed noise — same gate build_footage uses).
function searchAll(q: string, gateKw?: string) {
  const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'q';
  const extra = gateKw ? ['--keywords', gateKw] : [];
  try { execFileSync(process.execPath, [path.join(import.meta.dirname, 'topic_to_urls.ts'), q, '--platforms', 'tiktok,tw,ig,fb', '--max', '4', ...extra], { stdio: 'pipe', timeout: 200000 }); }
  catch (e) { /* exit!=0 tolerated */ }
  const f = outPath(`topic_urls_${slug}.json`);
  if (!fs.existsSync(f)) return [];
  try { return (JSON.parse(fs.readFileSync(f, 'utf8')).all) || []; } catch (e) { return []; }
}

// Find the original on the SOURCE's handle (TikTok/X), video first. Returns {url,platform}|null.
function findOriginal(username, topic) {
  const uq = username.replace(/[._]+/g, ' ').trim();
  const all = searchAll((topic ? uq + ' ' + topic : uq).trim());
  const u = cleanUser(username);
  const onHandle = all.filter(e => handleMatch(e.url, u));
  const pick = onHandle.find(e => e.platform === 'tiktok') || onHandle.find(e => e.platform === 'youtube')
    || onHandle.find(e => e.platform === 'twitter') || onHandle[0] || null;
  return pick ? { url: pick.url, platform: pick.platform } : null;
}

// Find original on YouTube by CHANNEL NAME (watch URLs lack the handle).
async function findOriginalYouTube(username, topic) {
  const q = (username.replace(/[._]+/g, ' ') + ' ' + (topic || '')).trim();
  let c; try { c = await connect({ match: 'youtube.com', requireMatch: true }); } catch (e) { return null; }
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    await c.navigate('https://www.youtube.com/results?search_query=' + encodeURIComponent(q), 6000);
    await sleep(2000);
    const raw = await c.evaluate(`(() => { const out=[]; document.querySelectorAll('ytd-video-renderer').forEach(v=>{ const a=v.querySelector('a#video-title'); const ch=v.querySelector('ytd-channel-name #text, .ytd-channel-name'); const cn=((ch&&ch.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean)[0])||''; if(a && a.href.includes('watch')) out.push({u:a.href.split('&')[0], ch:cn}); }); return JSON.stringify(out.slice(0,12)); })()`);
    let items = []; try { items = JSON.parse(raw || '[]'); } catch (e) {}
    const want = normHandle(username);
    const hit = items.find(it => normHandle(it.ch) === want);
    return hit ? { url: hit.u, platform: 'youtube' } : null;
  } finally { c.close(); }
}

// Find any VIDEO (tiktok/youtube) matching free-text keywords. Returns {url,platform}|null.
function findVideoByKeywords(q) {
  const all = searchAll(q);
  const v = all.find(e => VIDEO.has(e.platform));
  return v ? { url: v.url, platform: v.platform } : null;
}

// Handle in a post URL (the @username for TikTok/X/Threads, the path-user for IG). '' if none.
function urlHandle(url) {
  const u = url || '';
  const m = u.match(/tiktok\.com\/@([\w.\-]+)/i) || u.match(/threads\.(?:com|net)\/@([\w.\-]+)/i)
    || u.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i) || u.match(/instagram\.com\/([A-Za-z0-9_.]+)\//i);
  let h = m ? m[1] : '';
  if (/^(p|reel|reels|tv|share|video|status|home|explore|i)$/i.test(h)) h = ''; // path segment, not a handle
  return h;
}

// Aggregator/curator/news accounts REPOST others' clips; the original is the eyewitness/creator who
// filmed it. Heuristic marker set (Indonesian media + repost slang) — used to PREFER originals, NOT to
// hard-exclude (we still need a downloadable clip, so aggregators remain a last resort).
const AGG_MARKERS = /(news|berita|media|infotainment|seleb|gosip|lambe|viral|update|terkini|trending|fakta|zona|pojok|repost|folbek|kabar|warta|portal|redaksi|jurnal|koran|radar|grid|idntimes|kumparan|tempo|detik|kompas|tribun|merdeka|suara|okezone|liputan|antara|inews|metrotv|tvone|narasi|rcti|sctv|indosiar|trans7|wartakota|jpnn|republika|cnnindo|cnbc|katadata|tirto|kontan|mediaindo|official|infosumbar|sumbar|padangkita|langgam|tv$)/i;
function isAggregatorHandle(h) { const n = normHandle(h); return !!n && AGG_MARKERS.test(n); }

// FALLBACK source finder: when the credited creator's OWN post can't be resolved by handle, find the
// SAME-INCIDENT video on a video platform using the story keywords, GATED by semantic relevance so an
// off-topic clip can't be promoted to main. PRIORITISES the original source over re-wrap aggregators —
// tier 0: handle == credited creator; tier 1: other non-aggregator ("original-ish"); tier 2: a
// news/curator account OR the very repost we're escaping (repostHandle). Lowest non-empty tier wins;
// aggregators are demoted, never excluded, so we always return a downloadable clip. TikTok-first within
// the chosen tier (honors the tt/ credit). {url,platform}|null.
const STORY_FLOOR = parseFloat(process.env.THOTH_SOURCE_STORY_MIN || '0.33');
async function findStoryVideo(keywords, storyText, opts: any = {}) {
  const credited = normHandle(opts.credited || '');
  const repost = normHandle(opts.repostHandle || '');
  const kws = (keywords || []).map(s => String(s).trim()).filter(Boolean);
  // An explicit LLM-composed query (opts.query) wins — it folds in vision (headline/scene) so it's far
  // more specific than joining loose keywords or the first words of a vague caption.
  // Entity-only query: search treats every token as AND, so filler verbs/connectors kill recall.
  const query = tightenQuery((opts.query || '').trim()
    || kws.slice(0, 3).join(' ')
    || (storyText || '').split(/\s+/).slice(0, 6).join(' '));
  if (!query) return null;
  const all = searchAll(query, kws[0] || query.split(/\s+/)[0]);
  const seen = new Set();
  // Admit downloadable-video platforms. tiktok/youtube are video by definition; twitter/instagram
  // posts MAY carry a video → confirmed per-candidate via yt-dlp probe below (text-only posts dropped).
  const vids = all.filter(e => DLABLE.has(e.platform) && !seen.has(e.url) && seen.add(e.url));
  if (!vids.length) { console.log('    ↪ fallback: nol video kandidat dari search keyword.'); return null; }
  const cand = [];
  for (const v of vids.slice(0, 10)) {
    let caption = '', isVideo = true, videoSrc = '', thumbnail = '', uploader = '', pageUrl = '';
    try {
      if (v.platform === 'tiktok') { const m = await tiktokOembed(v.url); caption = (m && m.title) || ''; thumbnail = (m && m.thumbnail) || ''; }
      else if (v.platform === 'youtube') { const m = await youtubeOembed(v.url); caption = (m && m.title) || ''; thumbnail = (m && m.thumbnail) || ''; }
      else if (v.platform === 'threads') { videoSrc = await threadsVideoSrc(v.url); isVideo = !!videoSrc; } // yt-dlp can't probe threads pages
      else { const p = probeVideo(v.url); isVideo = p.isVideo; caption = p.caption; thumbnail = p.thumbnail; uploader = p.uploader; pageUrl = p.webpageUrl; } // twitter/ig/fb
    } catch (e) {}
    if (!isVideo) { console.log(`    ↪ fallback: skip non-video ${v.platform} ${v.url}`); continue; }
    cand.push({ url: v.url, platform: v.platform, caption, isVideo: true, videoSrc, thumbnail, uploader, pageUrl });
  }
  if (!cand.length) { console.log('    ↪ fallback: semua kandidat non-video (tak ada yang bisa di-ingest).'); return null; }
  // VISION-COVER ranking (caption alone is noisy: a commentary/reaction clip whose caption mentions the
  // entities embed-matches high but its cover is a talking head, NOT the incident). Describe each cover
  // and rank cover↔story so visual mismatch is rejected — same approach as findOriginalTiktok. Falls back
  // to caption-only when no novita key / no thumbnails.
  const vkey = novitaKey();
  if (vkey) { for (const c of cand) { if (c.thumbnail) { const r = await visionCoverKind(c.thumbnail, vkey, MODEL); c.cover = r.desc; c.kind = r.kind; } } }
  const useCover = cand.some(c => c.cover);
  const ranked = await rankBySimilarity(storyText || query, cand, c => useCover ? [c.cover, c.caption].filter(Boolean).join('. ') : (c.caption || ''));
  const haveSim = ranked.some(r => r.sim > 0);
  const onTopic = haveSim ? ranked.filter(r => (r.sim || 0) >= STORY_FLOOR) : ranked; // no embeddings → trust search gate
  if (!onTopic.length) { console.log(`    ↪ fallback: kandidat terbaik sim=${((ranked[0] || {}).sim || 0).toFixed(3)} < ${STORY_FLOOR} → batal (tak cukup on-topik).`); return null; }
  // HARD-EXCLUDE curated topic-discovery accounts (ig_accounts.json) and their cross-posts — never main.
  const onTopicU = onTopic.filter(c => !isCuratedAggregator(urlHandle(c.url)));
  if (!onTopicU.length) { console.log('    ↪ fallback: semua kandidat on-topik dari akun kurator (ig_accounts) → batal.'); return null; }
  const tierOf = c => {
    const h = normHandle(urlHandle(c.url));
    if (credited && h && h === credited) return 0;     // the credited original creator — best
    if (!h) return 1;                                  // YouTube watch URL etc. — no handle to flag
    if (h === repost || isAggregatorHandle(h)) return 2; // the repost we're escaping / a news curator
    return 1;                                          // other account — original-ish
  };
  // Within a handle-tier, PREFER real footage over commentary (talking-head/reaction/news-desk) — the
  // user wants the ORIGINAL recording, and an on-topic commentary clip's narratable caption otherwise
  // out-ranks raw footage. Fall back to whatever's there when no footage cover exists / vision absent
  // (every kind=='' → footage filter empty → use full list = old sim-only behavior).
  // ponytail: footage-vs-commentary is a vision heuristic; if it ever demotes a genuine clip, set
  // THOTH_SOURCE_PREFER_FOOTAGE=0 to revert to pure similarity ranking.
  const PREFER_FOOTAGE = process.env.THOTH_SOURCE_PREFER_FOOTAGE !== '0';
  const bestOf = (list) => { if (!list.length) return null; const foot = PREFER_FOOTAGE ? list.filter(c => c.kind === 'footage') : []; return (foot.length ? foot : list)[0]; };
  let pick = null, why = '';
  for (const [tier, label] of [[0, 'kredit-original'], [1, 'non-agregator'], [2, 'agregator-berita (last-resort)']] as [number, string][]) {
    pick = bestOf(onTopicU.filter(c => tierOf(c) === tier));
    if (pick) { why = label; break; }
  }
  const demoted = PREFER_FOOTAGE && pick && pick.kind !== 'footage' && onTopicU.some(c => c.kind === 'commentary');
  console.log(`    ↪ fallback pilih video insiden [@${urlHandle(pick.url) || '?'} · ${why}${pick.kind ? ' · ' + pick.kind : ''}] (${pick.platform}, sim=${(pick.sim || 0).toFixed(3)}): ${pick.url}`);
  if (demoted) console.log(ui.amber(`              ${ui.WARN} tak ada cover footage asli pada tier ini → pakai kandidat non-footage.`));
  if (pick.cover) console.log(`              cover: "${(pick.cover || '').slice(0, 80)}"`);
  return { url: pick.url, platform: pick.platform, isVideo: true, caption: pick.caption || '', videoSrc: pick.videoSrc || '', uploader: pick.uploader || '', pageUrl: pick.pageUrl || '' };
}

async function setMainTo(set, orig, username) {
  set.main.url = orig.url;
  set.main.platform = orig.platform;
  // tiktok/youtube are video by definition; twitter/instagram carry a probed isVideo flag.
  set.main.is_video = (typeof orig.isVideo === 'boolean') ? orig.isVideo : VIDEO.has(orig.platform);
  if (orig.platform === 'twitter' || orig.platform === 'instagram' || orig.platform === 'facebook') {
    // yt-dlp downloads the post URL directly (cookies via ytdlp.rs for IG/FB) — not ephemeral, so no CDN
    // resolve / local backup needed. Trust yt-dlp's CANONICAL page url (handles Twitter's post-nesting/
    // repost & t.co redirects → the real video page) and the REAL uploader (the actual video author,
    // which can differ from the wrapper account on a cross-account quote/repost).
    if (orig.pageUrl && orig.pageUrl !== orig.url) { set.main.source_url = orig.url; set.main.url = orig.pageUrl; console.log(`    🔗 url kanonik (yt-dlp) → ${orig.pageUrl}\n       (dari wrapper: ${orig.url})`); }
    if (orig.uploader) { set.main.source_traced = orig.uploader; set.main.profile = { name: orig.uploader, handle: orig.uploader, followers: '', avatar_url: '' }; }
    if (orig.caption) { if (!(set.main.title || '').trim()) set.main.title = orig.caption.slice(0, 120); if (!(set.main.description || '').trim()) set.main.description = orig.caption; }
  }
  else if (orig.platform === 'threads') {
    // Threads PAGE can't be yt-dlp'd → resolve to its fbcdn <video> src (downloadable). fbcdn URL is
    // ephemeral → keep a local mp4 backup. source_url = the Threads post (credit; survives expiry).
    const vurl = orig.videoSrc || await threadsVideoSrc(orig.url);
    if (vurl) {
      set.main.source_url = orig.url; set.main.url = vurl; set.main.is_video = true;
      if (!NO_DL) { const code = (orig.url.split('/post/')[1] || 'thr').replace(/[/?#].*$/, ''); const out = outPath(`threads_${code}.mp4`); if (downloadThreads(vurl, out)) set.main.source_local = out; }
      console.log(ui.amber(`    🧵 Threads → video CDN${set.main.source_local ? ' + mp4 lokal' : ''}. ${ui.WARN} fbcdn ephemeral → thoth SEGERA.`));
    } else { set.main.is_video = false; console.log(ui.amber(`    ${ui.WARN} Threads tak ada <video> src → tak bisa di-ingest.`)); }
  }
  else if (orig.platform === 'tiktok') {
    // Fill title/description from oEmbed only when EMPTY — keep a curated news-style description
    // (it grounds narration far better than a creator's casual hashtag caption).
    const m = await tiktokOembed(orig.url); if (m && m.title) { if (!(set.main.title || '').trim()) set.main.title = m.title; if (!(set.main.description || '').trim()) set.main.description = m.title; }
    // yt-dlp tak bisa download PAGE TikTok → resolve ke URL CDN mp4 langsung (tikwm→CDP) + simpan mp4
    // lokal (cadangan krn CDN ephemeral). main.url=CDN (yt-dlp generic bisa), source_url=page TikTok asli.
    try {
      const d = await tiktokDirectUrl(orig.url);
      if (d && d.url) {
        set.main.source_url = orig.url; set.main.url = d.url;
        if (!NO_DL) { const id = (orig.url.match(/video\/(\d+)/) || [])[1] || 'tt'; const out = outPath(`tiktok_${id}.mp4`); const local = await downloadTiktok(orig.url, out); if (local) set.main.source_local = local; }
        console.log(ui.amber(`    🎬 TikTok → URL CDN (${d.via})${set.main.source_local ? ' + mp4 lokal' : ''}. ${ui.WARN} CDN ephemeral → thoth SEGERA.`));
      } else { console.log(ui.amber(`    ${ui.WARN} TikTok tak bisa resolve URL CDN (tikwm/CDP gagal) → yt-dlp kemungkinan gagal download.`)); }
    } catch (e) {}
  }
  else if (orig.platform === 'youtube') { const m = await youtubeOembed(orig.url); if (m && m.title) { if (!(set.main.title || '').trim()) set.main.title = m.title; if (!(set.main.description || '').trim()) set.main.description = m.title; } }
  // username (credited path) wins; otherwise keep a branch-set identity (e.g. twitter uploader) and
  // only default to '' when nothing set it — don't clobber the real video-owner attribution.
  if (username) { set.main.profile = { name: username, handle: username, followers: '', avatar_url: '' }; set.main.source_traced = username; }
  else if (typeof set.main.source_traced !== 'string') set.main.source_traced = '';
  delete set.main.rewrap; delete set.main.rewrap_source;
}

(async () => {
  const set = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const main = set.main;
  if (!main || !main.url) { console.log(ui.red(`${ui.ERR} content-set tanpa main.url.`)); process.exit(1); }
  const topic = KEYWORDS[0] || (main.query || main.title || '').split(/\s+/)[0] || '';

  console.log(ui.rule());
  console.log('  Trace Source (LLM) — MAIN');
  console.log(ui.rule());
  console.log('main:', main.platform, main.url);

  // Vision/text signals — hoisted so the [5] curated-aggregator enforce can reuse them to compose a
  // search query (caption alone is often vague; vision describes what the clip actually shows).
  let caption = '', headline = '', scene = '';
  let username = '', platHint = '', keywords = [];
  if (FORCE_USER) {
    username = cleanUser(FORCE_USER);
    console.log(`[force] username=@${username}`);
  } else {
    caption = await captionOf(main);
    const cover = await coverOf(main);
    headline = cover ? await visionHeadline(cover, novitaKey(), MODEL) : '';
    scene = cover ? await visionCover(cover, novitaKey(), MODEL) : '';
    console.log(`[1] caption: ${(caption || '(kosong)').slice(0, 60)}`);
    console.log(`[2] headline(vision): ${(headline || '(kosong)').slice(0, 70)}`);
    console.log(`[2b] scene(vision): ${(scene || '(kosong)').slice(0, 70)}`);
    const res = await resolveSource({ description: main.description || main.title || '', caption, headline: [headline, scene].filter(Boolean).join(' — ') });
    console.log(`[3] LLM → source: ${res.source ? '@' + res.source.account + (res.source.platform ? '/' + res.source.platform : '') : 'null'} | keywords: ${res.keywords.join(', ') || '-'}`);
    if (res.source && res.source.account) { username = cleanUser(res.source.account); platHint = res.source.platform || ''; }
    keywords = res.keywords || [];
  }

  // Camera-emoji credit ("[📸 @user]") = original is on Instagram (IG-repost convention the LLM often
  // misses → returns account without platform). Force IG unless the LLM was confident about another.
  const credText = (main.description || '') + ' ' + (main.title || '');
  const cam = detectCameraCredit(credText);
  if (cam && !['tiktok', 'youtube', 'threads', 'twitter'].includes(platHint)) {
    username = cam; platHint = 'instagram';
    console.log(`[3b] kredit kamera [📸 @${cam}] → platform instagram`);
  }

  // "tt/{username}" credit = original is on TikTok (TikTok-repost shorthand the LLM often misses).
  // Force TikTok unless the LLM was already confident about another platform (incl. IG via camera credit).
  const tt = detectTiktokCredit(credText);
  if (tt && !['instagram', 'youtube', 'threads', 'twitter'].includes(platHint)) {
    username = tt; platHint = 'tiktok';
    console.log(`[3b] kredit tt/${tt} → platform tiktok`);
  }

  // Search topic for source lookup: the LLM keywords (specific entities) beat the title's first word
  // ("Sebuah …"), which made the by-handle search a useless "@user Sebuah" query. Fall back to the
  // --keywords flag / first-word topic only when no LLM keywords exist.
  const searchTopic = (keywords && keywords.length) ? keywords.slice(0, 2).join(' ') : topic;

  // Rich story context for SOURCE-VIDEO RANKING (not just by-handle search). A creator posts many clips
  // about the same person/place; what discriminates the RIGHT one is the ACTIVITY, which lives in the
  // on-screen HEADLINE + SCENE (vision) — far more specific than title/desc/keywords (often empty or
  // just subject+location). Feed all signals so ranking favours the matching activity, not just subject.
  const storyCtx = [headline, scene, main.title, main.description, (keywords || []).join(', ')]
    .map(s => (s || '').trim()).filter(Boolean).join('. ').trim();

  if (username && platHint === 'threads') {
    // Threads PAGE tak bisa yt-dlp, TAPI <video>.src (fbcdn) bisa. Cari post sumber → ekstrak URL
    // video CDN-nya → jadikan main (yt-dlp bisa download URL mp4 langsung itu).
    const kw = keywords.length ? keywords : KEYWORDS;
    console.log(`[4] sumber Threads @${username} → cari post (match keyword) + ekstrak video CDN…`);
    const t = await findOriginalThreads(username, kw);
    const vurl = t ? await threadsVideoSrc(t.url) : '';
    if (vurl) {
      set.main.url = vurl;            // fbcdn direct mp4 (yt-dlp downloadable)
      set.main.platform = 'threads';
      set.main.is_video = true;
      set.main.source_traced = username;
      set.main.source_url = t.url;    // post Threads asli (kredit; URL fbcdn ephemeral)
      delete set.main.rewrap; delete set.main.rewrap_source; delete set.main.rewrap_platform;
      let local = '';
      if (!NO_DL) { const code = (t.url.split('/post/')[1] || 'thr').replace(/[/?#].*$/, ''); const out = outPath(`threads_${code}.mp4`); if (downloadThreads(vurl, out)) { local = out; set.main.source_local = out; } }
      console.log(`    ${ui.gold(ui.OK)} GANTI main → video CDN Threads (dari ${t.url})${local ? '\n       💾 mp4 lokal: ' + local + ' (cadangan kalau fbcdn expire)' : ''}\n       ${ui.amber(ui.WARN)} URL fbcdn ephemeral → jalankan thoth SEGERA.`);
    } else {
      set.main.rewrap = true; set.main.rewrap_source = username; set.main.rewrap_platform = 'threads';
      if (t) set.main.rewrap_url = t.url;
      console.log(ui.amber(`    ${ui.WARN} post Threads @${username} tanpa video / tak ketemu → dicatat (image-card)${t ? ': ' + t.url : ''}.`));
    }
  } else if (username && platHint === 'instagram') {
    // Original is on Instagram → grab the creator's own reel (downloadable via cookies) instead of
    // the curator's repost. is_video:true (IG reel is a video).
    console.log(`[4] sumber Instagram @${username} → cari reel SPESIFIK (match konten) dari profil…`);
    const orig = await findOriginalInstagram(username, keywords.length ? keywords : KEYWORDS, storyCtx);
    if (orig && orig.url !== main.url) {
      const oldUrl = main.url;
      set.main.url = orig.url; set.main.platform = 'instagram'; set.main.is_video = true;
      set.main.source_traced = username;
      // Keep the curated repost description/title (news-style topic framing that grounds narration) —
      // the creator's raw caption is casual hashtag-spam and worse for narration. Only fall back to the
      // caption when there's no existing description at all.
      if (orig.caption && !(set.main.description || '').trim()) { set.main.description = orig.caption; set.main.title = (set.main.title || '').trim() || orig.caption.slice(0, 120); }
      set.main.profile = { name: username, handle: username, followers: '', avatar_url: '' };
      delete set.main.rewrap; delete set.main.rewrap_source; delete set.main.rewrap_platform;
      console.log(ui.gold(`    ${ui.OK} GANTI main → instagram ${orig.url}\n       (dari repost: ${oldUrl})`));
    } else if (orig && orig.url === main.url) {
      set.main.source_traced = username;
      if (orig.caption && !(set.main.description || '').trim()) { set.main.description = orig.caption; }
      delete set.main.rewrap; delete set.main.rewrap_source; delete set.main.rewrap_platform;
      console.log('    ℹ️ main sudah = reel asli @' + username + '.');
    } else {
      set.main.rewrap = true; set.main.rewrap_source = username; set.main.rewrap_platform = 'instagram';
      console.log(ui.amber(`    ${ui.WARN} reel asli @${username} tak ketemu → flag (pakai repost).`));
    }
  } else if (username) {
    console.log(`[4] cari ASLI "@${username}"${platHint ? ' (' + platHint + ')' : ''} + "${searchTopic}"…`);
    const storyText = storyCtx;
    let orig = null;
    if (platHint === 'youtube') orig = await findOriginalYouTube(username, searchTopic);
    else if (platHint === 'tiktok') {
      // DIRECT creator profile FIRST — TikTok search rarely surfaces a specific account's own post, but
      // its profile grid lists it. This recovers the TRUE original (not a reposter of the same clip).
      orig = await findOriginalTiktok(username, storyText, keywords);
      if (!orig) orig = findOriginal(username, searchTopic); // search by-handle as secondary
    }
    else if (platHint && platHint !== 'youtube') orig = findOriginal(username, searchTopic);
    else orig = (await findOriginalYouTube(username, searchTopic)) || findOriginal(username, searchTopic);

    // FALLBACK: the credited creator's OWN post wasn't found (profile + by-handle search both empty).
    // Rather than keep the repost as main (baked headline/watermark — the very thing trace_source exists
    // to avoid), grab the SAME-INCIDENT video on a video platform by story keywords, gated by relevance.
    if (!orig) {
      console.log(`    ↪ post @${username} tak ketemu by-profile/handle → fallback cari video insiden by keyword (prioritas sumber non-agregator)…`);
      orig = await findStoryVideo(keywords.length ? keywords : KEYWORDS, storyText, { credited: username, repostHandle: urlHandle(main.url) });
    }

    if (orig && orig.url !== main.url) {
      const oldUrl = main.url;
      await setMainTo(set, orig, username);
      if (orig.lowConfidence) { set.main.source_low_confidence = true; console.log(ui.amber(`       ${ui.WARN} source_low_confidence=true (creator banyak klip mirip — verifikasi manual bila perlu).`)); }
      console.log(ui.gold(`    ${ui.OK} GANTI main → ${orig.platform} ${orig.url}\n       (dari: ${oldUrl})`));
      // Crop the creator's TikTok profile-card header → Thoth pastes it as the real
      // on-screen profile card (replacing the synthetic one).
      if (platHint === 'tiktok' && set.main.profile) {
        try {
          const png = outPath(`profile_${username}.png`);
          const cropped = await cropTiktokProfile(username, png);
          if (cropped) { set.main.profile.image_path = cropped; console.log(`    🪪 crop kartu profil → ${cropped}`); }
        } catch (e) {}
      }
    } else if (orig && orig.url === main.url) {
      console.log('    ℹ️ sumber = main itu sendiri. Dibiarkan.');
    } else {
      set.main.rewrap = true; set.main.rewrap_source = username; if (platHint) set.main.rewrap_platform = platHint;
      console.log(ui.amber(`    ${ui.WARN} asli "@${username}"${platHint ? ' (' + platHint + ')' : ''} tak ketemu (by-handle + fallback) → flag main.rewrap=true + hint (pakai yang ada).`));
    }
  } else if (keywords.length) {
    set.main.source_keywords = keywords;
    if (!VIDEO.has(main.platform) || main.is_video === false) {
      // Vision-grounded query (headline+scene) beats joining the first proper-noun keywords — for a
      // foreign story the victim's name alone surfaces junk; the incident terms surface the coverage.
      const q = await composeSearchQuery({ description: main.description || main.title || '', caption, headline, scene });
      if (q) console.log(`    🔎 query(LLM caption+vision): "${q}"`);
      console.log(`[4] main bukan video TikTok/YT → cari video sumber by keyword (prioritas non-agregator): "${q || keywords.join(' ')}"…`);
      const orig = await findStoryVideo(keywords, storyCtx, { credited: '', repostHandle: urlHandle(main.url), query: q });
      if (orig) { await setMainTo(set, orig, ''); set.main.source_via = 'keywords'; console.log(ui.gold(`    ${ui.OK} GANTI main → ${orig.platform} ${orig.url}`)); }
      else console.log(ui.amber(`    ${ui.WARN} video non-agregator tak ketemu dari keywords → keywords disimpan, main dibiarkan.`));
    } else {
      console.log(`    ℹ️ tak ada sumber eksplisit; keywords disimpan (main video dibiarkan): ${keywords.join(', ')}`);
    }
  } else {
    console.log(ui.gold(`    ${ui.OK} tak ada sinyal sumber/keyword — main dibiarkan.`));
  }

  // ── ENFORCE: a reel/post from a CURATED topic-discovery account (ig_accounts.json) must NEVER remain
  // the main — those accounts are aggregators; the discovered reel only signals WHAT to cover, not the
  // source video. If main (or its source_url) still resolves to a curated handle, force a non-aggregator
  // replacement. Catches the no-credit path and any credit that pointed back at a curator.
  {
    const mh = urlHandle(set.main.url), sh = urlHandle(set.main.source_url || '');
    const curated = isCuratedAggregator(mh) ? mh : (isCuratedAggregator(sh) ? sh : '');
    if (curated) {
      console.log(`[5] main masih dari akun kurator @${curated} (ig_accounts) → WAJIB ganti ke sumber non-agregator…`);
      const kws = keywords.length ? keywords : KEYWORDS;
      // Build the search query from caption + VISION (headline/scene) via LLM — for curator reels the
      // caption is often vague/motivational, so vision (what's actually on screen) yields a far more
      // specific query than caption/keywords alone. Falls back to keywords inside findStoryVideo.
      let q = await composeSearchQuery({
        description: set.main.description || set.main.title || '', caption, headline, scene,
      });
      if (q) console.log(`    🔎 query(LLM caption+vision): "${q}"`);
      const repl = await findStoryVideo(kws, storyCtx || `${set.main.title || ''}. ${set.main.description || ''}`.trim(), { credited: username, repostHandle: curated, query: q });
      if (repl) {
        const oldUrl = set.main.url;
        await setMainTo(set, repl, username || set.main.source_traced || '');
        console.log(ui.gold(`    ${ui.OK} GANTI main (enforce non-kurator) → ${repl.platform} ${repl.url}\n       (dari kurator: ${oldUrl})`));
      } else {
        set.main.rewrap = true; set.main.aggregator_unresolved = true;
        console.log(ui.amber(`    ${ui.WARN} TAK ADA sumber non-agregator ditemukan. main.aggregator_unresolved=true — reel kurator TIDAK boleh dipublish sebagai main; topik ini perlu sumber lain / di-skip.`));
      }
    }
  }

  // ── ENSURE main is DOWNLOADABLE: a TikTok PAGE url (tiktok.com/@/video/) can't be fetched by
  // yt-dlp (HTTP 403) → resolve to a direct CDN mp4 (tikwm→CDP), same as setMainTo does on a re-trace.
  // Runs even when main was NOT re-traced (main is its own original) — otherwise Thoth ingest 403s.
  try {
    if (/tiktok\.com\/@[^/]+\/video\//.test(set.main.url || '') && !set.main.source_url) {
      const page = set.main.url;
      const d = await tiktokDirectUrl(page);
      if (d && d.url) {
        set.main.source_url = page; set.main.url = d.url;
        if (!NO_DL) { const id = (page.match(/video\/(\d+)/) || [])[1] || 'tt'; const out = outPath(`tiktok_${id}.mp4`); const local = await downloadTiktok(page, out); if (local) set.main.source_local = local; }
        console.log(ui.amber(`    🎬 main TikTok PAGE → URL CDN (${d.via})${set.main.source_local ? ' + mp4 lokal' : ''}. ${ui.WARN} CDN ephemeral → thoth SEGERA.`));
      } else {
        console.log(ui.amber(`    ${ui.WARN} main TikTok PAGE tak bisa resolve URL CDN (tikwm/CDP) → yt-dlp kemungkinan 403.`));
      }
    }
  } catch (e) {}

  // Same for a Threads PAGE that STAYED main (yt-dlp can't fetch threads.com) → resolve its fbcdn
  // <video> src + keep a local mp4 (ephemeral). Text/photo posts have no <video> → is_video=false.
  try {
    if (/threads\.(com|net)\/@[^/]+\/post\//.test(set.main.url || '') && !set.main.source_url) {
      const page = set.main.url;
      const vurl = await threadsVideoSrc(page);
      if (vurl) {
        set.main.source_url = page; set.main.url = vurl; set.main.is_video = true;
        if (!NO_DL) { const code = (page.split('/post/')[1] || 'thr').replace(/[/?#].*$/, ''); const out = outPath(`threads_${code}.mp4`); if (downloadThreads(vurl, out)) set.main.source_local = out; }
        console.log(ui.amber(`    🧵 main Threads PAGE → video CDN${set.main.source_local ? ' + mp4 lokal' : ''}. ${ui.WARN} fbcdn ephemeral → thoth SEGERA.`));
      } else {
        set.main.is_video = false;
        console.log(ui.amber(`    ${ui.WARN} main Threads PAGE tanpa <video> → post teks/foto (image-card).`));
      }
    }
  } catch (e) {}

  // ── Real PROFILE-CARD crop (any platform) → Thoth pastes it instead of the synthetic card.
  // TikTok already cropped in its branch above (image_path set → skipped here); this covers IG and,
  // as more platforms land in profile_crop.ts, X/FB/YT too. Best-effort: failure keeps synthetic card.
  try {
    set.main.profile = set.main.profile || {};
    const handle = cleanUser(set.main.profile.handle || urlHandle(set.main.url)
      || urlHandle(set.main.source_url || '') || set.main.source_traced || '');
    // ALWAYS record the creator identity from the handle — even when the crop fails. Thoth needs
    // name/handle to render the creator card; without it the card is skipped (and previously it fell
    // back to the story SUBJECT, e.g. "Moka", instead of the uploader). The crop, if it succeeds,
    // upgrades the synthetic card to the real profile screenshot.
    if (handle) {
      if (!set.main.profile.handle) set.main.profile.handle = handle;
      if (!set.main.profile.name)   set.main.profile.name   = handle;
    }
    const haveCrop = set.main.profile.image_path && fs.existsSync(set.main.profile.image_path);
    if (!haveCrop && handle) {
      const png = outPath(`profile_${handle || set.main.platform || 'main'}.png`);
      const cropped = await cropProfile(set.main.platform, handle, png, { url: set.main.source_url || set.main.url });
      if (cropped) {
        set.main.profile.image_path = cropped;
        console.log(`    🪪 crop kartu profil ${set.main.platform} @${handle} → ${cropped}`);
      } else {
        console.log(`    ℹ️ crop profil ${set.main.platform} gagal → kartu nama @${handle} (tanpa screenshot).`);
      }
    }
  } catch (e) {}

  // Ground narration: if nothing filled main title/description (e.g. an X/text post that stayed as
  // main because no source video was traced), fall back to the caption we extracted from the post.
  // Empty main.description → narration has no topic and invents one (CLAUDE.md grounding contract).
  if (caption) {
    if (!(set.main.title || '').trim())      set.main.title = caption.slice(0, 120);
    if (!(set.main.description || '').trim()) set.main.description = caption;
  }

  fs.writeFileSync(FILE, JSON.stringify(set, null, 2), 'utf8');
  console.log(ui.rule('thin'));
  console.log(`📄 ${FILE}`);
})();
