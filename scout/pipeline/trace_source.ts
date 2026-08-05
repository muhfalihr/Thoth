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

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { connect, sleep } from '../lib/cdp.ts';
import {
  evaluateMainSuitability,
  type MainCandidate,
  type MainCandidateOrigin,
  type MainStoryEvidence,
} from '../lib/main_candidate.ts';
import { appendMainCandidateDiagnostic } from '../lib/main_candidate_diagnostics.ts';
import { createMainCandidateRuntimeDeps } from '../lib/main_candidate_runtime.ts';
import { chooseInputOrReplacement, rankAcceptedMainCandidates } from '../lib/main_gate.ts';
import { admitSearchCandidates } from '../lib/main_search_candidates.ts';
import {
  attachVideoOcr,
  carryCurrentOcrMetadata,
  clearVideoOcrMetadata,
  shouldAttachVideoOcr,
} from '../lib/ocr_content.ts';
import { outPath } from '../lib/paths.ts';
import { matchesTopic, tiktokOembed, youtubeOembed } from '../lib/verify.ts';
import { cropProfile } from '../scrapers/profile_crop.ts';
import { downloadThreads, threadsVideoSrc } from '../scrapers/threads_video.ts';
import { downloadTiktok, tiktokDirectUrl } from '../scrapers/tiktok_video.ts';
import { resolveSource, tightenQuery } from './resolve_source.ts';
import {
  readVisionSignals,
  selectTraceVisionInput,
  visionInputDataUrl,
} from './trace_source_vision.ts';
import type { AcquisitionRunContext, PostRecord } from '../acquisition/index.ts';
import { createStandaloneAcquisitionContext, runAcquisitionCli } from '../acquisition/index.ts';

export interface TraceSourceOptions {
  file: string;
  keywords: string[];
  username: string | null;
  model: string;
  noDl: boolean;
}

export function parseTraceSourceArgs(argv: string[]): TraceSourceOptions {
  const getFlag = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : null;
  };
  const file = argv.find(
    (a, i) => !a.startsWith('--') && !['--keywords', '--username', '--model'].includes(argv[i - 1]),
  );
  const keywords = (getFlag('--keywords') || '').split(/[ ,]+/).filter(Boolean);
  const username = getFlag('--username');
  const noDl = argv.includes('--no-threads-dl') || argv.includes('--no-dl'); // skip local mp4 backup (Threads/TikTok)
  const model =
    getFlag('--model') || process.env.THOTH_VISION_MODEL || 'qwen/qwen3-vl-30b-a3b-instruct';
  if (!file) {
    console.log(
      'Usage: bun trace_source.ts <content_set.json> [--keywords k1,k2] [--username <u>] [--model <m>]',
    );
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.log(ui.red(`${ui.ERR} File tak ada: ${file}`));
    process.exit(1);
  }
  return { file, keywords, username, model, noDl };
}

const VIDEO = new Set(['tiktok', 'youtube']);
// Platforms whose posts can become a downloadable MAIN. tiktok/youtube are always video; twitter/
// instagram/facebook are admitted as candidates but each must pass a per-URL yt-dlp video probe;
// threads can't be probed by yt-dlp (page = "Unsupported URL") → confirmed via threadsVideoSrc (fbcdn).
const DLABLE = new Set(['tiktok', 'youtube', 'twitter', 'instagram', 'facebook', 'threads']);

import { novitaKey } from '../lib/env.ts';
import { ui } from '../lib/ui.ts';

const cleanUser = (u) =>
  (u || '')
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9._].*$/, '')
    .toLowerCase();

// Cover image/local asset for vision: an image-kind media asset's CDN url when the post has one, else
// a DOM social-card crop (ponytail: no adapter's PostRecord exposes a poster/thumbnail for a VIDEO
// post -- only the raw video CDN url -- so a crop is the only cover source left for video mains;
// upgrade path is an adapter-level poster field if one becomes available). captureSocialCard is a
// cache hit, not a second navigation, when 'social-card' was pre-registered before inspectPost ran.
async function coverOf(main, record: PostRecord, context: AcquisitionRunContext): Promise<string> {
  const image = record.media.find((m) => m.kind === 'image');
  if (image?.ephemeral_url) return image.ephemeral_url;
  try {
    const card = await context.service.captureSocialCard(main.url, 'post');
    return card.path;
  } catch (e) {
    return '';
  }
}

// VISION: read the on-screen HEADLINE/HOOK text (+ any visible credit/watermark) from the cover, as
// plain text — the LLM (resolveSource) then decides if it names a source or yields keywords.
async function visionHeadline(imgUrl, key, model) {
  const dataUrl = await visionInputDataUrl(imgUrl);
  if (!dataUrl || !key) return '';
  const prompt = `Baca SEMUA teks yang terlihat di cover video ini: HEADLINE/HOOK besar (judul/pancingan)
DAN kredit/watermark akun kecil bila ada (mis. "@akun", "cr: ...", logo channel). Kembalikan HANYA
teksnya apa adanya (gabung jadi 1-2 baris), atau "" kalau tak ada teks.`;
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    if (!resp.ok) return '';
    const d = await resp.json();
    return (
      (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) ||
      ''
    )
      .trim()
      .slice(0, 300);
  } catch (_) {
    return '';
  }
}

// VISION: describe the SCENE (action/objects) + any on-screen text of a cover image as one plain
// sentence. Used to disambiguate a creator's many near-identical clips by what's actually happening
// (captions on high-volume creators are generic hashtags). '' on failure / no key.
async function visionCover(imgUrl, key, model) {
  const dataUrl = await visionInputDataUrl(imgUrl);
  if (!dataUrl || !key) return '';
  const prompt = `Lihat cover video ini. WAJIB & PALING PENTING: baca SEMUA teks overlay/judul di cover
APA ADANYA (itu sinyal topik paling menentukan untuk membedakan klip mirip). Lalu deskripsikan singkat
AKSI/kegiatan spesifik yang terjadi (apa yang sedang dilakukan), objek, dan lokasi — bukan cuma siapa
orangnya. Format: "<teks overlay>. <aksi/scene singkat>". Bahasa Indonesia, tanpa tanda kutip.`;
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        max_tokens: 160,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    if (!resp.ok) return '';
    const d = await resp.json();
    return (
      (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) ||
      ''
    )
      .trim()
      .slice(0, 200);
  } catch (_) {
    return '';
  }
}

async function visionCoverKind(imgUrl, key, model) {
  if (!imgUrl || !key) return { desc: '', kind: '' };
  let ct = 'image/jpeg';
  let b64 = '';
  const dataMatch = String(imgUrl).match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (dataMatch) {
    ct = dataMatch[1];
    b64 = dataMatch[2];
  } else {
    try {
      const response = await fetch(imgUrl);
      if (!response.ok) return { desc: '', kind: '' };
      ct = response.headers.get('content-type') || ct;
      b64 = Buffer.from(await response.arrayBuffer()).toString('base64');
    } catch {
      return { desc: '', kind: '' };
    }
  }
  const prompt = `Lihat cover video ini. Kerjakan DUA hal, balas HANYA JSON valid (tanpa markdown):
1) "desc": baca SEMUA teks overlay/judul APA ADANYA, lalu deskripsikan singkat aksi/scene + lokasi.
2) "kind": klasifikasikan ISI VISUAL cover —
   "footage" = REKAMAN ASLI kejadian: CCTV, rekaman saksi/HP, b-roll berita atas lokasi/orang/peristiwa
     yang sebenarnya (orang BERADA DI DALAM kejadian).
   "commentary" = orang BICARA KE kamera (talking-head/selfie/reaction), pembawa berita di meja studio,
     podcast, kartu teks/meme, slideshow, split-screen reaksi.
Contoh: {"desc":"...", "kind":"footage"}`;
  try {
    const response = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: 220,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${ct};base64,${b64}` } },
            ],
          },
        ],
      }),
    });
    if (!response.ok) return { desc: '', kind: '' };
    const data = await response.json();
    const raw = String(data.choices?.[0]?.message?.content || '').trim();
    try {
      const parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
      const kind = String(parsed.kind || '').toLowerCase();
      return {
        desc: String(parsed.desc || '').slice(0, 200),
        kind: kind === 'footage' || kind === 'commentary' ? kind : '',
      };
    } catch {
      return {
        desc: raw.slice(0, 200),
        kind: /commentary|talking|reaksi|reaction|studio|podcast/i.test(raw) ? 'commentary' : '',
      };
    }
  } catch {
    return { desc: '', kind: '' };
  }
}

// Normalise a handle/name for fuzzy compare (drop @, spaces, separators): hipmi_tv = hipmitv = "HIPMI TV".
const normHandle = (s) =>
  (s || '')
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[\s._-]/g, '');

// URL belongs to @username? (TikTok/X encode the handle in the URL.)
function handleMatch(url, u) {
  const want = normHandle(u);
  let h = '';
  let m = url.match(/tiktok\.com\/@([\w.-]+)/i) || url.match(/threads\.(?:com|net)\/@([\w.-]+)/i);
  if (m) h = m[1];
  else {
    m = url.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)(?:\/|$|\?)/i);
    if (m && !/^(home|search|explore|i|hashtag|messages)$/i.test(m[1])) h = m[1];
  }
  return !!h && normHandle(h) === want;
}

// Find a Threads source by PROFILE: open threads.com/@user, read each post's text, and pick the one
// whose text MATCHES the keywords (not just the newest). Falls back to newest if no keyword match.
// Guarded: needs a threads.com/threads.net tab attached.
async function findOriginalThreads(username, keywords = []) {
  let c: Awaited<ReturnType<typeof connect>>;
  try {
    c = await connect({ match: ['threads.com', 'threads.net'], requireMatch: true });
  } catch (e) {
    return null;
  }
  try {
    try {
      await c.cmd('Page.bringToFront');
    } catch (e) {}
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
    let posts = [];
    try {
      posts = JSON.parse(raw || '[]');
    } catch (e) {}
    const ownRe = new RegExp('/@' + username.replace(/\./g, '\\.') + '/post/', 'i');
    const pool = posts.filter((p) => ownRe.test(p.href));
    const list = pool.length ? pool : posts;
    let pick = keywords.length ? list.find((p) => matchesTopic(p.text, keywords, 'any')) : null;
    if (!pick) pick = list[0];
    if (pick)
      console.log(
        `    [threads] pilih post ${keywords.length && list.indexOf(pick) >= 0 && matchesTopic(pick.text, keywords, 'any') ? '(match keyword)' : '(terbaru)'}: ${pick.href}`,
      );
    return pick ? { url: pick.href, platform: 'threads' } : null;
  } finally {
    c.close();
  }
}

// PostRecord -> MainCandidate shape ranking/setMainTo already expect. thumbnail is always '' here:
// discover() never exposes a poster/thumbnail (only the raw media CDN url) -- same gap coverOf()
// works around with a social-card crop; per-candidate crops aren't done here (10-30 candidates per
// run x an extra navigation each is a real cost the old thumbnail-bearing scrapers didn't pay), so
// describeEvidence's vision-evidence step degrades to '' for these two sources. Upgrade path: an
// adapter-level poster field, or a capped per-candidate captureSocialCard if that cost is worth it.
function candidateFromDiscovery(record: PostRecord, uploader: string): MainCandidate {
  return {
    url: record.canonical_url,
    platform: record.platform,
    caption: record.text || '',
    thumbnail: '',
    uploader: record.owner_handle || uploader,
    isVideo: record.media.some((m) => m.kind === 'video'),
  };
}

// Find the ORIGINAL on Instagram by PROFILE: discover() 'profile' request → newest video posts.
// The creator's own post is the authentic source (vs a curator repost with baked overlay). IG reels
// are downloadable by Thoth via firefox cookies.
async function findOriginalInstagramCandidates(
  username,
  context: AcquisitionRunContext,
): Promise<MainCandidate[]> {
  const { items } = await context.service.discover({
    platform: 'instagram',
    kind: 'profile',
    value: username,
    limit: 10,
  });
  return items
    .filter((item) => item.media.some((m) => m.kind === 'video'))
    .map((item) => candidateFromDiscovery(item, username));
}

// Find the ORIGINAL on TikTok by PROFILE (not search): discover() 'profile' request over the video
// grid, returning every profile video so the shared gate can evaluate and rank them against the story.
async function findOriginalTiktokCandidates(
  username,
  context: AcquisitionRunContext,
): Promise<MainCandidate[]> {
  let items: PostRecord[] = [];
  try {
    ({ items } = await context.service.discover({
      platform: 'tiktok',
      kind: 'profile',
      value: username,
      limit: 30,
    }));
  } catch (e) {
    return [];
  }
  if (!items.length) {
    console.log(`    [tiktok] profil @${username}: 0 video terbaca (login/tab?).`);
    return [];
  }
  return items.map((item) => candidateFromDiscovery(item, username));
}

// Detect a camera-emoji credit ("[📸 @user]", "📷 @user", "🎥 cr: @user") → the original is on
// INSTAGRAM (common IG-repost convention the LLM may miss). Returns username (no @) or ''.
function detectCameraCredit(text) {
  const m = (text || '').match(
    /(?:📸|📷|🎥|🎬|🎞️|📹)\s*(?:cr\.?|credit|by)?\s*[:-]?\s*@([A-Za-z0-9._]{2,30})/iu,
  );
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
  const slug =
    q
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40) || 'q';
  const extra = gateKw ? ['--keywords', gateKw] : [];
  try {
    execFileSync(
      process.execPath,
      [
        path.join(import.meta.dirname, 'topic_to_urls.ts'),
        q,
        '--platforms',
        'tiktok,tw,ig,fb',
        '--max',
        '4',
        ...extra,
      ],
      { stdio: 'pipe', timeout: 200000 },
    );
  } catch (e) {
    /* exit!=0 tolerated */
  }
  const f = outPath(`topic_urls_${slug}.json`);
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')).all || [];
  } catch (e) {
    return [];
  }
}

// Preserve every matching handle result so suitability/ranking happens only in the shared gate.
function findOriginalHandleCandidates(username, topic): MainCandidate[] {
  const queryUser = username.replace(/[._]+/g, ' ').trim();
  const all = searchAll((topic ? `${queryUser} ${topic}` : queryUser).trim());
  const normalized = cleanUser(username);
  return all
    .filter((entry) => handleMatch(entry.url, normalized))
    .map((entry) => ({
      url: entry.url,
      platform: entry.platform,
      uploader: username,
    }));
}

// Find all originals on YouTube by CHANNEL NAME (watch URLs lack the handle).
async function findOriginalYouTubeCandidates(username, topic): Promise<MainCandidate[]> {
  const query = `${username.replace(/[._]+/g, ' ')} ${topic || ''}`.trim();
  let c: Awaited<ReturnType<typeof connect>>;
  try {
    c = await connect({ match: 'youtube.com', requireMatch: true });
  } catch (e) {
    return [];
  }
  try {
    try {
      await c.cmd('Page.bringToFront');
    } catch (e) {}
    await c.navigate(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      6000,
    );
    await sleep(2000);
    const raw = await c.evaluate(
      `(() => { const out=[]; document.querySelectorAll('ytd-video-renderer').forEach(v=>{ const a=v.querySelector('a#video-title'); const ch=v.querySelector('ytd-channel-name #text, .ytd-channel-name'); const cn=((ch&&ch.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean)[0])||''; if(a && a.href.includes('watch')) out.push({u:a.href.split('&')[0], ch:cn}); }); return JSON.stringify(out.slice(0,12)); })()`,
    );
    let items = [];
    try {
      items = JSON.parse(raw || '[]');
    } catch (e) {}
    const wanted = normHandle(username);
    return items
      .filter((item) => normHandle(item.ch) === wanted)
      .map((item) => ({
        url: item.u,
        platform: 'youtube',
        uploader: username,
        isVideo: true,
      }));
  } finally {
    c.close();
  }
}

// Handle in a post URL (the @username for TikTok/X/Threads, the path-user for IG). '' if none.
function urlHandle(url) {
  const u = url || '';
  const m =
    u.match(/tiktok\.com\/@([\w.-]+)/i) ||
    u.match(/threads\.(?:com|net)\/@([\w.-]+)/i) ||
    u.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i) ||
    u.match(/instagram\.com\/([A-Za-z0-9_.]+)\//i);
  let h = m ? m[1] : '';
  if (/^(p|reel|reels|tv|share|video|status|home|explore|i)$/i.test(h)) h = ''; // path segment, not a handle
  return h;
}

// Discover raw replacement candidates only. Suitability evaluation, ranking, and final selection belong
// to evaluateMainSuitability and main_gate.
async function probeGenericViaService(url: string, context: AcquisitionRunContext) {
  try {
    const record = await context.service.inspectPost(url);
    return {
      isVideo: record.media.some((m) => m.kind === 'video'),
      caption: record.text || '',
      thumbnail: '',
      uploader: record.owner_handle || '',
      webpageUrl: record.canonical_url || url,
    };
  } catch (e) {
    return { isVideo: false, caption: '', thumbnail: '', uploader: '', webpageUrl: url };
  }
}

async function findStoryCandidates(
  keywords,
  storyText,
  opts: any = {},
  context: AcquisitionRunContext,
): Promise<MainCandidate[]> {
  const kws = (keywords || []).map((value) => String(value).trim()).filter(Boolean);
  const query = tightenQuery(
    (opts.query || '').trim() ||
      kws.slice(0, 3).join(' ') ||
      String(storyText || '')
        .split(/\s+/)
        .slice(0, 6)
        .join(' '),
  );
  if (!query) return [];
  const entries = searchAll(query, kws[0] || query.split(/\s+/)[0]);
  return admitSearchCandidates(entries, {
    downloadablePlatforms: DLABLE,
    probeGeneric: async (entry) => probeGenericViaService(entry.url, context),
    youtubeMeta: async (url) => {
      const meta = await youtubeOembed(url);
      return meta ? { title: meta.title || '', thumbnail: meta.thumbnail || '' } : null;
    },
    tiktokMeta: async (url) => {
      const meta = await tiktokOembed(url);
      return meta ? { title: meta.title || '', thumbnail: meta.thumbnail || '' } : null;
    },
    threadsVideoSrc: (url) => threadsVideoSrc(url),
  });
}

async function discoverReplacementCandidates({
  username,
  platHint,
  searchTopic,
  keywords,
  storyText,
  query,
  cliKeywords,
  context,
}): Promise<MainCandidate[]> {
  const credited: MainCandidate[] = [];
  if (username && platHint === 'instagram') {
    credited.push(...(await findOriginalInstagramCandidates(username, context)));
  } else if (username && platHint === 'tiktok') {
    credited.push(...(await findOriginalTiktokCandidates(username, context)));
    credited.push(...findOriginalHandleCandidates(username, searchTopic));
  } else if (username && platHint === 'youtube') {
    credited.push(...(await findOriginalYouTubeCandidates(username, searchTopic)));
  } else if (username && platHint === 'threads') {
    const post = await findOriginalThreads(username, keywords.length ? keywords : cliKeywords);
    if (post) {
      const videoSrc = await threadsVideoSrc(post.url);
      if (videoSrc) {
        credited.push({
          url: post.url,
          platform: 'threads',
          videoSrc,
          uploader: username,
          isVideo: true,
        });
      }
    }
  } else if (username) {
    credited.push(...findOriginalHandleCandidates(username, searchTopic));
    credited.push(...(await findOriginalYouTubeCandidates(username, searchTopic)));
  }

  const generic = await findStoryCandidates(
    keywords.length ? keywords : cliKeywords,
    storyText,
    { credited: username, query },
    context,
  );
  const seen = new Set<string>();
  return [...credited, ...generic].filter(
    (candidate) => candidate.url && !seen.has(candidate.url) && Boolean(seen.add(candidate.url)),
  );
}
async function setMainTo(set, orig, username, noDl) {
  clearVideoOcrMetadata(set.main);
  set.main.url = orig.url;
  set.main.platform = orig.platform;
  // tiktok/youtube are video by definition; twitter/instagram carry a probed isVideo flag.
  set.main.is_video = typeof orig.isVideo === 'boolean' ? orig.isVideo : VIDEO.has(orig.platform);
  if (
    orig.platform === 'twitter' ||
    orig.platform === 'instagram' ||
    orig.platform === 'facebook'
  ) {
    // yt-dlp downloads the post URL directly (cookies via ytdlp.rs for IG/FB) — not ephemeral, so no CDN
    // resolve / local backup needed. Trust yt-dlp's CANONICAL page url (handles Twitter's post-nesting/
    // repost & t.co redirects → the real video page) and the REAL uploader (the actual video author,
    // which can differ from the wrapper account on a cross-account quote/repost).
    if (orig.pageUrl && orig.pageUrl !== orig.url) {
      set.main.source_url = orig.url;
      set.main.url = orig.pageUrl;
      console.log(
        `    🔗 url kanonik (yt-dlp) → ${orig.pageUrl}\n       (dari wrapper: ${orig.url})`,
      );
    }
    if (orig.uploader) {
      set.main.source_traced = orig.uploader;
      set.main.profile = {
        name: orig.uploader,
        handle: orig.uploader,
        followers: '',
        avatar_url: '',
      };
    }
    if (orig.caption) {
      if (!(set.main.title || '').trim()) set.main.title = orig.caption.slice(0, 120);
      if (!(set.main.description || '').trim()) set.main.description = orig.caption;
    }
  } else if (orig.platform === 'threads') {
    // Threads PAGE can't be yt-dlp'd → resolve to its fbcdn <video> src (downloadable). fbcdn URL is
    // ephemeral → keep a local mp4 backup. source_url = the Threads post (credit; survives expiry).
    const vurl = orig.videoSrc || (await threadsVideoSrc(orig.url));
    if (vurl) {
      set.main.source_url = orig.url;
      set.main.url = vurl;
      set.main.is_video = true;
      if (!noDl) {
        const code = (orig.url.split('/post/')[1] || 'thr').replace(/[/?#].*$/, '');
        const out = outPath(`threads_${code}.mp4`);
        if (downloadThreads(vurl, out)) set.main.source_local = out;
      }
      console.log(
        ui.amber(
          `    🧵 Threads → video CDN${set.main.source_local ? ' + mp4 lokal' : ''}. ${ui.WARN} fbcdn ephemeral → thoth SEGERA.`,
        ),
      );
    } else {
      set.main.is_video = false;
      console.log(ui.amber(`    ${ui.WARN} Threads tak ada <video> src → tak bisa di-ingest.`));
    }
  } else if (orig.platform === 'tiktok') {
    // Fill title/description from oEmbed only when EMPTY — keep a curated news-style description
    // (it grounds narration far better than a creator's casual hashtag caption).
    const m = await tiktokOembed(orig.url);
    if (m && m.title) {
      if (!(set.main.title || '').trim()) set.main.title = m.title;
      if (!(set.main.description || '').trim()) set.main.description = m.title;
    }
    // yt-dlp tak bisa download PAGE TikTok → resolve ke URL CDN mp4 langsung (tikwm→CDP) + simpan mp4
    // lokal (cadangan krn CDN ephemeral). main.url=CDN (yt-dlp generic bisa), source_url=page TikTok asli.
    try {
      const d = await tiktokDirectUrl(orig.url);
      if (d && d.url) {
        set.main.source_url = orig.url;
        set.main.url = d.url;
        if (!noDl) {
          const id = (orig.url.match(/video\/(\d+)/) || [])[1] || 'tt';
          const out = outPath(`tiktok_${id}.mp4`);
          const local = await downloadTiktok(orig.url, out);
          if (local) set.main.source_local = local;
        }
        console.log(
          ui.amber(
            `    🎬 TikTok → URL CDN (${d.via})${set.main.source_local ? ' + mp4 lokal' : ''}. ${ui.WARN} CDN ephemeral → thoth SEGERA.`,
          ),
        );
      } else {
        console.log(
          ui.amber(
            `    ${ui.WARN} TikTok tak bisa resolve URL CDN (tikwm/CDP gagal) → yt-dlp kemungkinan gagal download.`,
          ),
        );
      }
    } catch (e) {}
  } else if (orig.platform === 'youtube') {
    const m = await youtubeOembed(orig.url);
    if (m && m.title) {
      if (!(set.main.title || '').trim()) set.main.title = m.title;
      if (!(set.main.description || '').trim()) set.main.description = m.title;
    }
  }
  // username (credited path) wins; otherwise keep a branch-set identity (e.g. twitter uploader) and
  // only default to '' when nothing set it — don't clobber the real video-owner attribution.
  if (username) {
    set.main.profile = { name: username, handle: username, followers: '', avatar_url: '' };
    set.main.source_traced = username;
  } else if (typeof set.main.source_traced !== 'string') set.main.source_traced = '';
  delete set.main.rewrap;
  delete set.main.rewrap_source;
  carryCurrentOcrMetadata(set.main, orig);
}

export async function runTraceSource(
  options: TraceSourceOptions,
  context: AcquisitionRunContext,
): Promise<void> {
  const { file, keywords: cliKeywords, username: forceUser, model, noDl } = options;
  const set = JSON.parse(fs.readFileSync(file, 'utf8'));
  const main = set.main;
  if (!main || !main.url) {
    throw new Error('content-set tanpa main.url.');
  }
  const topic = cliKeywords[0] || (main.query || main.title || '').split(/\s+/)[0] || '';

  console.log(ui.rule());
  console.log('  Trace Source (LLM) — MAIN');
  console.log(ui.rule());
  console.log('main:', main.platform, main.url);

  // Vision/text signals — hoisted so the [5] curated-aggregator enforce can reuse them to compose a
  // search query (caption alone is often vague; vision describes what the clip actually shows).
  let caption = '',
    headline = '',
    scene = '';
  let username = '',
    platHint = '',
    keywords = [];
  if (forceUser) {
    username = cleanUser(forceUser);
    console.log(`[force] username=@${username}`);
  } else {
    let record: PostRecord | null = null;
    try {
      record = await context.service.inspectPost(main.url);
    } catch (e) {
      record = null;
    }
    caption = record?.text || '';
    const fallbackCover = record ? await coverOf(main, record, context) : '';
    const selectedCover = await selectTraceVisionInput(main, fallbackCover, {
      log: (line) => console.log(line),
    });
    const signals = await readVisionSignals(selectedCover.input, {
      headline: (input) => visionHeadline(input, novitaKey(), model),
      scene: (input) => visionCover(input, novitaKey(), model),
    });
    headline = signals.headline;
    scene = signals.scene;
    console.log(`[1] caption: ${(caption || '(kosong)').slice(0, 60)}`);
    console.log(`[2] headline(vision): ${(headline || '(kosong)').slice(0, 70)}`);
    console.log(`[2b] scene(vision): ${(scene || '(kosong)').slice(0, 70)}`);
    const res = await resolveSource({
      description: main.description || main.title || '',
      caption,
      headline: [headline, scene].filter(Boolean).join(' — '),
    });
    console.log(
      `[3] LLM → source: ${res.source ? '@' + res.source.account + (res.source.platform ? '/' + res.source.platform : '') : 'null'} | keywords: ${res.keywords.join(', ') || '-'}`,
    );
    if (res.source && res.source.account) {
      username = cleanUser(res.source.account);
      platHint = res.source.platform || '';
    }
    keywords = res.keywords || [];
  }

  // Camera-emoji credit ("[📸 @user]") = original is on Instagram (IG-repost convention the LLM often
  // misses → returns account without platform). Force IG unless the LLM was confident about another.
  const credText = (main.description || '') + ' ' + (main.title || '');
  const cam = detectCameraCredit(credText);
  if (cam && !['tiktok', 'youtube', 'threads', 'twitter'].includes(platHint)) {
    username = cam;
    platHint = 'instagram';
    console.log(`[3b] kredit kamera [📸 @${cam}] → platform instagram`);
  }

  // "tt/{username}" credit = original is on TikTok (TikTok-repost shorthand the LLM often misses).
  // Force TikTok unless the LLM was already confident about another platform (incl. IG via camera credit).
  const tt = detectTiktokCredit(credText);
  if (tt && !['instagram', 'youtube', 'threads', 'twitter'].includes(platHint)) {
    username = tt;
    platHint = 'tiktok';
    console.log(`[3b] kredit tt/${tt} → platform tiktok`);
  }

  // Search topic for source lookup: the LLM keywords (specific entities) beat the title's first word
  // ("Sebuah …"), which made the by-handle search a useless "@user Sebuah" query. Fall back to the
  // --keywords flag / first-word topic only when no LLM keywords exist.
  const searchTopic = keywords && keywords.length ? keywords.slice(0, 2).join(' ') : topic;

  // Rich story context for SOURCE-VIDEO RANKING (not just by-handle search). A creator posts many clips
  // about the same person/place; what discriminates the RIGHT one is the ACTIVITY, which lives in the
  // on-screen HEADLINE + SCENE (vision) — far more specific than title/desc/keywords (often empty or
  // just subject+location). Feed all signals so ranking favours the matching activity, not just subject.
  const storyCtx = [headline, scene, main.title, main.description, (keywords || []).join(', ')]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join('. ')
    .trim();

  const storyEvidence: MainStoryEvidence = {
    caption: caption || '',
    headline: headline || '',
    scene: scene || '',
    title: main.title || '',
    description: main.description || '',
    keywords: keywords || [],
    storyText: storyCtx,
  };
  const runtimeDeps = createMainCandidateRuntimeDeps({
    describeEvidence: async (candidate) => {
      if (!candidate.thumbnail) return '';
      const result = await visionCoverKind(candidate.thumbnail, novitaKey(), model);
      return result.desc || '';
    },
    classifyImage: async (image) => {
      const result = await visionCoverKind(image, novitaKey(), model);
      return result.kind === 'footage' || result.kind === 'commentary' ? result.kind : 'unknown';
    },
  });
  const evaluate = (
    candidate: MainCandidate,
    evidence: MainStoryEvidence,
    origin: MainCandidateOrigin,
  ) => evaluateMainSuitability(candidate, evidence, origin, runtimeDeps);
  const inputCandidate: MainCandidate = {
    ...main,
    url: main.url,
    platform: main.platform || '',
    caption,
    isVideo: main.is_video !== false,
  };

  const decision = await chooseInputOrReplacement(inputCandidate, storyEvidence, {
    evaluate,
    // No credited account (step 3 came back empty, or with the "@akun" placeholder resolve_source
    // now strips): the search had nothing to aim at, so an empty result is not evidence against the
    // input post. Keep it as main instead of failing the run.
    retainInputWhenUncredited: !username,
    appendDiagnostic: appendMainCandidateDiagnostic,
    search: () =>
      discoverReplacementCandidates({
        username,
        platHint,
        searchTopic,
        keywords,
        storyText: storyCtx,
        query: '',
        cliKeywords,
        context,
      }),
    rankAccepted: (results) =>
      rankAcceptedMainCandidates(results, {
        credited: username,
        repostHandle: urlHandle(main.url),
        preferFootage: process.env.THOTH_SOURCE_PREFER_FOOTAGE !== '0',
      }),
  });

  if (keywords.length) set.main.source_keywords = keywords;
  if (decision.status === 'retain') {
    carryCurrentOcrMetadata(set.main, decision.candidate);
    if (decision.confidence === 'low') {
      set.main.source_low_confidence = true;
    } else {
      delete set.main.source_low_confidence;
    }
    console.log(`[main-gate] input ${decision.suitability} confidence=${decision.confidence}`);
  } else {
    const oldUrl = set.main.url;
    await setMainTo(set, decision.candidate, username, noDl);
    if (decision.confidence === 'low') {
      set.main.source_low_confidence = true;
    } else {
      delete set.main.source_low_confidence;
    }
    console.log(
      ui.gold(
        `    ${ui.OK} GANTI main → ${decision.candidate.platform} ${decision.candidate.url}\n       (dari: ${oldUrl})`,
      ),
    );
  }
  // ── ENSURE main is DOWNLOADABLE: a TikTok PAGE url (tiktok.com/@/video/) can't be fetched by
  // yt-dlp (HTTP 403) → resolve to a direct CDN mp4 (tikwm→CDP), same as setMainTo does on a re-trace.
  // Runs even when main was NOT re-traced (main is its own original) — otherwise Thoth ingest 403s.
  try {
    if (/tiktok\.com\/@[^/]+\/video\//.test(set.main.url || '') && !set.main.source_url) {
      const page = set.main.url;
      const d = await tiktokDirectUrl(page);
      if (d && d.url) {
        set.main.source_url = page;
        set.main.url = d.url;
        if (!noDl) {
          const id = (page.match(/video\/(\d+)/) || [])[1] || 'tt';
          const out = outPath(`tiktok_${id}.mp4`);
          const local = await downloadTiktok(page, out);
          if (local) set.main.source_local = local;
        }
        console.log(
          ui.amber(
            `    🎬 main TikTok PAGE → URL CDN (${d.via})${set.main.source_local ? ' + mp4 lokal' : ''}. ${ui.WARN} CDN ephemeral → thoth SEGERA.`,
          ),
        );
      } else {
        console.log(
          ui.amber(
            `    ${ui.WARN} main TikTok PAGE tak bisa resolve URL CDN (tikwm/CDP) → yt-dlp kemungkinan 403.`,
          ),
        );
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
        set.main.source_url = page;
        set.main.url = vurl;
        set.main.is_video = true;
        if (!noDl) {
          const code = (page.split('/post/')[1] || 'thr').replace(/[/?#].*$/, '');
          const out = outPath(`threads_${code}.mp4`);
          if (downloadThreads(vurl, out)) set.main.source_local = out;
        }
        console.log(
          ui.amber(
            `    🧵 main Threads PAGE → video CDN${set.main.source_local ? ' + mp4 lokal' : ''}. ${ui.WARN} fbcdn ephemeral → thoth SEGERA.`,
          ),
        );
      } else {
        set.main.is_video = false;
        console.log(
          ui.amber(`    ${ui.WARN} main Threads PAGE tanpa <video> → post teks/foto (image-card).`),
        );
      }
    }
  } catch (e) {}

  // ── Real PROFILE-CARD crop (any platform) → Thoth pastes it instead of the synthetic card.
  // TikTok already cropped in its branch above (image_path set → skipped here); this covers IG and,
  // as more platforms land in profile_crop.ts, X/FB/YT too. Best-effort: failure keeps synthetic card.
  try {
    set.main.profile = set.main.profile || {};
    const handle = cleanUser(
      set.main.profile.handle ||
        urlHandle(set.main.url) ||
        urlHandle(set.main.source_url || '') ||
        set.main.source_traced ||
        '',
    );
    // ALWAYS record the creator identity from the handle — even when the crop fails. Thoth needs
    // name/handle to render the creator card; without it the card is skipped (and previously it fell
    // back to the story SUBJECT, e.g. "Moka", instead of the uploader). The crop, if it succeeds,
    // upgrades the synthetic card to the real profile screenshot.
    if (handle) {
      if (!set.main.profile.handle) set.main.profile.handle = handle;
      if (!set.main.profile.name) set.main.profile.name = handle;
    }
    const haveCrop = set.main.profile.image_path && fs.existsSync(set.main.profile.image_path);
    if (!haveCrop && handle) {
      const png = outPath(`profile_${handle || set.main.platform || 'main'}.png`);
      const cropped = await cropProfile(set.main.platform, handle, png, {
        url: set.main.source_url || set.main.url,
      });
      if (cropped) {
        set.main.profile.image_path = cropped;
        console.log(`    🪪 crop kartu profil ${set.main.platform} @${handle} → ${cropped}`);
      } else {
        console.log(
          `    ℹ️ crop profil ${set.main.platform} gagal → kartu nama @${handle} (tanpa screenshot).`,
        );
      }
    }
  } catch (e) {}

  // Ground narration: if nothing filled main title/description (e.g. an X/text post that stayed as
  // main because no source video was traced), fall back to the caption we extracted from the post.
  // Empty main.description → narration has no topic and invents one (CLAUDE.md grounding contract).
  if (caption) {
    if (!(set.main.title || '').trim()) set.main.title = caption.slice(0, 120);
    if (!(set.main.description || '').trim()) set.main.description = caption;
  }

  // Subtitle-vision fallback on the FINALIZED main (post any CDN-URL resolution above): a cover/headline
  // intro gets trimmed; continuous burned-in subtitles (no better source existed → ranking penalty above
  // couldn't avoid it) get muted + blur-censored at render instead of silently shipping the reaction upload.
  if (shouldAttachVideoOcr(set.main) && set.main.url) {
    // Resolve to a direct stream first so the check works on YT/Twitter/IG/FB mains too (not just a
    // TikTok CDN url already resolved upstream); fall back to set.main.url for already-direct sources.
    await attachVideoOcr(set.main);
  }

  fs.writeFileSync(file, JSON.stringify(set, null, 2), 'utf8');
  console.log(ui.rule('thin'));
  console.log(`📄 ${file}`);
}

if (import.meta.main) {
  runAcquisitionCli(async () => {
    const options = parseTraceSourceArgs(process.argv.slice(2));
    const context = await createStandaloneAcquisitionContext();
    await runTraceSource(options, context);
  });
}
