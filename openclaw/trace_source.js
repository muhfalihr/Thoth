// trace_source.js — resolve the ORIGINAL source of the MAIN video so CLIPPER doesn't double up a
// re-wrap's baked headline/watermark. Detection is LLM-driven (resolve_source.js) over THREE text
// signals: main DESCRIPTION + CAPTION (oEmbed) + on-screen HEADLINE (read via vision from the cover).
//
//   node trace_source.js <content_set.json> [--keywords k1,k2] [--username <u>] [--model <m>]
//
// Flow (MAIN only):
//   1. Gather description + caption + headline(vision) of main.
//   2. resolveSource(LLM) → { source:{account,platform} | null, keywords[] }.
//   3. source → cari video akun itu (YouTube channel-name / TikTok-X handle-match) → GANTI main;
//      tak ketemu → main.rewrap=true + hint.
//   4. tak ada source, ada keywords → simpan main.source_keywords; kalau main NON-VIDEO, search
//      keywords → ambil video → jadikan main. (Main video yang sudah bagus TIDAK diganti.)
//   --username memaksa sumber (skip deteksi).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { connect, sleep } = require('./cdp');
const { tiktokOembed, youtubeOembed, matchesTopic } = require('./verify');
const { resolveSource } = require('./resolve_source');
const { threadsVideoSrc, downloadThreads } = require('./threads_video');
const { igProfileReels } = require('./ig_profile');
const { tiktokProfileVideos, cropTiktokProfile } = require('./tiktok_profile');
const { rankBySimilarity } = require('./embed');
const { tiktokDirectUrl, downloadTiktok } = require('./tiktok_video');
const { outPath } = require('./paths');
const { isCuratedAggregator } = require('./aggregators');

const args = process.argv.slice(2);
const getFlag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const FILE = args.find((a, i) => !a.startsWith('--') && !['--keywords', '--username', '--model'].includes(args[i - 1]));
const KEYWORDS = (getFlag('--keywords') || '').split(/[ ,]+/).filter(Boolean);
const FORCE_USER = getFlag('--username');
const NO_DL = args.includes('--no-threads-dl') || args.includes('--no-dl'); // skip local mp4 backup (Threads/TikTok)
const MODEL = getFlag('--model') || process.env.CLIPPER_VISION_MODEL || 'qwen/qwen3-vl-8b-instruct';
if (!FILE) { console.log('Usage: node trace_source.js <content_set.json> [--keywords k1,k2] [--username <u>] [--model <m>]'); process.exit(1); }
if (!fs.existsSync(FILE)) { console.log('❌ File tak ada:', FILE); process.exit(1); }

const VIDEO = new Set(['tiktok', 'youtube']);
const KEY_FILE = path.join(__dirname, '.novita_key');
const novitaKey = () => fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : '';
const cleanUser = u => (u || '').replace(/^@/, '').replace(/[^A-Za-z0-9._].*$/, '').toLowerCase();

// Caption of the main video via public oEmbed (TikTok/YouTube). '' otherwise.
async function captionOf(main) {
  if (main.platform === 'tiktok') { const m = await tiktokOembed(main.url); return m && m.title || ''; }
  if (main.platform === 'youtube') { const m = await youtubeOembed(main.url); return m && m.title || ''; }
  return '';
}
async function coverOf(main) {
  if (main.platform === 'tiktok') { const m = await tiktokOembed(main.url); return m && m.thumbnail || ''; }
  if (main.platform === 'youtube') { const m = await youtubeOembed(main.url); return m && m.thumbnail || ''; }
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
  const prompt = `Deskripsikan dalam 1 kalimat APA yang terjadi di cover video ini: scene, objek, aksi
(mis. "mobil damkar melaju malam hari di jalan ramai di belakang sebuah mobil pribadi"). Sebutkan juga
teks overlay bila ada. Bahasa Indonesia, ringkas, tanpa tanda kutip.`;
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, max_tokens: 120, temperature: 0, messages: [{ role: 'user', content: [
        { type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${ct};base64,${b64}` } }] }] }),
    });
    if (!resp.ok) return '';
    const d = await resp.json();
    return ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim().slice(0, 200);
  } catch (_) { return ''; }
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
// are downloadable by CLIPPER via firefox cookies. Guarded: needs an instagram.com tab attached.
// Source-reel pick is VIEWS-dominated: a creator gets credited for the SPECIFIC clip that went viral,
// so the reposted video is essentially always their most-viewed reel. (Its caption is often generic
// motivational text — semantically indistinguishable from off-topic reels — so caption similarity is a
// weak signal for *identity*, only useful as a sanity guard.) OFF_FLOOR = clearly-unrelated; ON_FLOOR =
// confidently on-topic. Used by build_footage too for the profile-footage relevance floor.
const OFF_FLOOR = 0.25, ON_FLOOR = 0.33;

async function findOriginalInstagram(username, keywords = [], topicText = '') {
  const reels = await igProfileReels(username, { max: 6, captions: true });
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
  const byViews = vids.slice().sort((a, b) => b.views - a.views).slice(0, 12);
  const byCap = capRanked.slice(0, 6);
  const pool = [...new Map([...byViews, ...byCap].map(v => [v.url, v])).values()];
  console.log(`    [tiktok] profil @${username}: ${vids.length} video → vision-cover ${pool.length} kandidat…`);
  for (const v of pool) { v.cover = await visionCover(v.thumbnail, key, MODEL); }
  const ranked = await rankBySimilarity(topic, pool, v => v.cover || v.caption || '');
  if (!ranked.some(r => r.sim > 0)) return null;
  const top = ranked[0], second = ranked[1] || { sim: 0 };
  if ((top.sim || 0) < ON_FLOOR) { console.log(`    [tiktok] cover terbaik sim=${(top.sim || 0).toFixed(3)}<${ON_FLOOR} → tak cukup yakin, batal.`); return null; }
  const lowConfidence = (top.sim - (second.sim || 0)) < 0.05 || top.sim < 0.50;
  console.log(`    [tiktok] pilih video profil (vision-cover sim=${(top.sim || 0).toFixed(3)}${lowConfidence ? ' ⚠️ LOW-CONFIDENCE: banyak klip mirip' : ''}) ~${(top.views || 0).toLocaleString()} views: ${top.url}`);
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
function searchAll(q, gateKw) {
  const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'q';
  const extra = gateKw ? ['--keywords', gateKw] : [];
  try { execFileSync('node', [path.join(__dirname, 'topic_to_urls.js'), q, '--platforms', 'tiktok,tw,ig,fb', '--max', '4', ...extra], { stdio: 'pipe', timeout: 200000 }); }
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
const STORY_FLOOR = parseFloat(process.env.CLIPPER_SOURCE_STORY_MIN || '0.33');
async function findStoryVideo(keywords, storyText, opts = {}) {
  const credited = normHandle(opts.credited || '');
  const repost = normHandle(opts.repostHandle || '');
  const kws = (keywords || []).map(s => String(s).trim()).filter(Boolean);
  const query = (kws.slice(0, 2).join(' ') || (storyText || '').split(/\s+/).slice(0, 4).join(' ')).trim();
  if (!query) return null;
  const all = searchAll(query, kws[0] || query.split(/\s+/)[0]);
  const seen = new Set();
  const vids = all.filter(e => VIDEO.has(e.platform) && !seen.has(e.url) && seen.add(e.url));
  if (!vids.length) { console.log('    ↪ fallback: nol video kandidat dari search keyword.'); return null; }
  const cand = [];
  for (const v of vids.slice(0, 10)) {
    let caption = '';
    try {
      if (v.platform === 'tiktok') { const m = await tiktokOembed(v.url); caption = (m && m.title) || ''; }
      else if (v.platform === 'youtube') { const m = await youtubeOembed(v.url); caption = (m && m.title) || ''; }
    } catch (e) {}
    cand.push({ url: v.url, platform: v.platform, caption });
  }
  const ranked = await rankBySimilarity(storyText || query, cand, c => c.caption || '');
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
  let pool = onTopicU.filter(c => tierOf(c) === 0), why = 'kredit-original';
  if (!pool.length) { pool = onTopicU.filter(c => tierOf(c) === 1); why = 'non-agregator'; }
  if (!pool.length) { pool = onTopicU.filter(c => tierOf(c) === 2); why = 'agregator-berita (last-resort)'; }
  const pick = pool.find(r => r.platform === 'tiktok') || pool[0]; // TikTok-first within the tier
  console.log(`    ↪ fallback pilih video insiden [@${urlHandle(pick.url) || '?'} · ${why}] (${pick.platform}, sim=${(pick.sim || 0).toFixed(3)}): ${pick.url}`);
  return { url: pick.url, platform: pick.platform };
}

async function setMainTo(set, orig, username) {
  set.main.url = orig.url;
  set.main.platform = orig.platform;
  set.main.is_video = VIDEO.has(orig.platform);
  if (orig.platform === 'tiktok') {
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
        console.log(`    🎬 TikTok → URL CDN (${d.via})${set.main.source_local ? ' + mp4 lokal' : ''}. ⚠️ CDN ephemeral → clipper SEGERA.`);
      } else { console.log('    ⚠️ TikTok tak bisa resolve URL CDN (tikwm/CDP gagal) → yt-dlp kemungkinan gagal download.'); }
    } catch (e) {}
  }
  else if (orig.platform === 'youtube') { const m = await youtubeOembed(orig.url); if (m && m.title) { if (!(set.main.title || '').trim()) set.main.title = m.title; if (!(set.main.description || '').trim()) set.main.description = m.title; } }
  if (username) set.main.profile = { name: username, handle: username, followers: '', avatar_url: '' };
  set.main.source_traced = username || '';
  delete set.main.rewrap; delete set.main.rewrap_source;
}

(async () => {
  const set = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const main = set.main;
  if (!main || !main.url) { console.log('❌ content-set tanpa main.url.'); process.exit(1); }
  const topic = KEYWORDS[0] || (main.query || main.title || '').split(/\s+/)[0] || '';

  console.log('='.repeat(60));
  console.log('  Trace Source (LLM) — MAIN');
  console.log('='.repeat(60));
  console.log('main:', main.platform, main.url);

  let username = '', platHint = '', keywords = [];
  if (FORCE_USER) {
    username = cleanUser(FORCE_USER);
    console.log(`[force] username=@${username}`);
  } else {
    const caption = await captionOf(main);
    const cover = await coverOf(main);
    const headline = cover ? await visionHeadline(cover, novitaKey(), MODEL) : '';
    console.log(`[1] caption: ${(caption || '(kosong)').slice(0, 60)}`);
    console.log(`[2] headline(vision): ${(headline || '(kosong)').slice(0, 70)}`);
    const res = await resolveSource({ description: main.description || main.title || '', caption, headline });
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
      console.log(`    ✅ GANTI main → video CDN Threads (dari ${t.url})${local ? '\n       💾 mp4 lokal: ' + local + ' (cadangan kalau fbcdn expire)' : ''}\n       ⚠️ URL fbcdn ephemeral → jalankan clipper SEGERA.`);
    } else {
      set.main.rewrap = true; set.main.rewrap_source = username; set.main.rewrap_platform = 'threads';
      if (t) set.main.rewrap_url = t.url;
      console.log(`    ⚠️ post Threads @${username} tanpa video / tak ketemu → dicatat (image-card)${t ? ': ' + t.url : ''}.`);
    }
  } else if (username && platHint === 'instagram') {
    // Original is on Instagram → grab the creator's own reel (downloadable via cookies) instead of
    // the curator's repost. is_video:true (IG reel is a video).
    console.log(`[4] sumber Instagram @${username} → cari reel SPESIFIK (match konten) dari profil…`);
    const topicText = `${main.title || ''} ${main.description || ''}`.trim();
    const orig = await findOriginalInstagram(username, keywords.length ? keywords : KEYWORDS, topicText);
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
      console.log(`    ✅ GANTI main → instagram ${orig.url}\n       (dari repost: ${oldUrl})`);
    } else if (orig && orig.url === main.url) {
      set.main.source_traced = username;
      if (orig.caption && !(set.main.description || '').trim()) { set.main.description = orig.caption; }
      delete set.main.rewrap; delete set.main.rewrap_source; delete set.main.rewrap_platform;
      console.log('    ℹ️ main sudah = reel asli @' + username + '.');
    } else {
      set.main.rewrap = true; set.main.rewrap_source = username; set.main.rewrap_platform = 'instagram';
      console.log(`    ⚠️ reel asli @${username} tak ketemu → flag (pakai repost).`);
    }
  } else if (username) {
    console.log(`[4] cari ASLI "@${username}"${platHint ? ' (' + platHint + ')' : ''} + "${searchTopic}"…`);
    const storyText = `${main.title || ''}. ${main.description || ''}`.trim();
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
      if (orig.lowConfidence) { set.main.source_low_confidence = true; console.log('       ⚠️ source_low_confidence=true (creator banyak klip mirip — verifikasi manual bila perlu).'); }
      console.log(`    ✅ GANTI main → ${orig.platform} ${orig.url}\n       (dari: ${oldUrl})`);
      // Crop the creator's TikTok profile-card header → CLIPPER pastes it as the real
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
      console.log(`    ⚠️ asli "@${username}"${platHint ? ' (' + platHint + ')' : ''} tak ketemu (by-handle + fallback) → flag main.rewrap=true + hint (pakai yang ada).`);
    }
  } else if (keywords.length) {
    set.main.source_keywords = keywords;
    if (!VIDEO.has(main.platform) || main.is_video === false) {
      console.log(`[4] main bukan video TikTok/YT → cari video sumber by keyword (prioritas non-agregator): "${keywords.join(' ')}"…`);
      const orig = await findStoryVideo(keywords, `${main.title || ''}. ${main.description || ''}`.trim(), { credited: '', repostHandle: urlHandle(main.url) });
      if (orig) { await setMainTo(set, orig, ''); set.main.source_via = 'keywords'; console.log(`    ✅ GANTI main → ${orig.platform} ${orig.url}`); }
      else console.log('    ⚠️ video non-agregator tak ketemu dari keywords → keywords disimpan, main dibiarkan.');
    } else {
      console.log(`    ℹ️ tak ada sumber eksplisit; keywords disimpan (main video dibiarkan): ${keywords.join(', ')}`);
    }
  } else {
    console.log('    ✅ tak ada sinyal sumber/keyword — main dibiarkan.');
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
      const repl = await findStoryVideo(kws, `${set.main.title || ''}. ${set.main.description || ''}`.trim(), { credited: username, repostHandle: curated });
      if (repl) {
        const oldUrl = set.main.url;
        await setMainTo(set, repl, username || set.main.source_traced || '');
        console.log(`    ✅ GANTI main (enforce non-kurator) → ${repl.platform} ${repl.url}\n       (dari kurator: ${oldUrl})`);
      } else {
        set.main.rewrap = true; set.main.aggregator_unresolved = true;
        console.log('    ⚠️ TAK ADA sumber non-agregator ditemukan. main.aggregator_unresolved=true — reel kurator TIDAK boleh dipublish sebagai main; topik ini perlu sumber lain / di-skip.');
      }
    }
  }

  fs.writeFileSync(FILE, JSON.stringify(set, null, 2), 'utf8');
  console.log('-'.repeat(60));
  console.log(`📄 ${FILE}`);
})();
