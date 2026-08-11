// discover_reels.js — discover potential-viral TOPICS from curator IG accounts' RECENT posts.
// Despite the name it now scans BOTH reels (/reel/) AND feed posts (/p/ — photos, carousels, video
// posts), so the topic net is wider than reels-only. These accounts (stories/commentary) surface hot
// angles before X/YT trends, BUT the topic lives in the VOICEOVER (audio) or the on-screen HOOK text
// — almost never in the caption (which shows the song). So we read the topic from the cover/opening
// frame's hook (vision). For VIDEO items only, if that's vague we transcribe ~30s of audio (Groq
// Whisper — guarded: only if a GROQ key exists). Image posts (the headline-card kind) read from the
// cover image alone — no audio.
//
//   bun discover_reels.js [--accounts h1,h2,..] [--max-per N] [--hours 48] [--include reels,posts] [--out file]
//   --include : which item types to scan — "reels,posts" (default) | "reels" | "posts"
//
// Needs a logged-in instagram.com tab attached. Output → output/reel_topics.json (ranked views+recency).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { outPath } from '../lib/paths.ts';
import { normalizeLikes } from '../lib/comments.ts';
import { fetchTrending } from './discover_tiktok_trending.ts';
import { ytdlpCookieArgs } from '../lib/verify.ts';
import {
  createStandaloneAcquisitionContext,
  runAcquisitionCli,
} from '../acquisition/index.ts';
import type { AcquisitionRunContext, PostRecord, Platform } from '../acquisition/index.ts';
import { scrapeIgProfileGrid } from './ig_grid_scrape.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const getFlag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
// Default akun = ig_accounts.json (daftar terkurasi user — satu sumber kebenaran, dipakai juga
// oleh discover_topics --platforms instagram). --accounts meng-override. Fallback: daftar lama.
function defaultAccounts() {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'ig_accounts.json'), 'utf8'),
    );
    const arr = Array.isArray(j) ? j : j.accounts || [];
    const list = arr
      .map((s) =>
        String(s)
          .trim()
          .replace(/^@/, '')
          .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
          .replace(/[/?#].*$/, ''),
      )
      .filter(Boolean);
    if (list.length) return list.join(',');
  } catch (e) {}
  return 'sadampermana.w,jktlogy,basevox,unexplnd';
}
// Kurator multi-platform: curator_accounts.json { "instagram":[], "tiktok":[], "x":[] }.
// ig_accounts.json (legacy, juga sumber aggregator-exclusion) di-MERGE ke bagian instagram —
// jangan dihapus. Flag --accounts (IG), --tiktok-accounts, --x-accounts meng-override per platform.
function curatorAccounts() {
  const norm = (s) =>
    String(s)
      .trim()
      .replace(/^@/, '')
      .replace(/^https?:\/\/[^/]+\//i, '')
      .replace(/[/?#].*$/, '');
  let cfg: any = {};
  try {
    cfg =
      JSON.parse(
        fs.readFileSync(
          path.join(import.meta.dirname, '..', 'config', 'curator_accounts.json'),
          'utf8',
        ),
      ) || {};
  } catch (e) {}
  const ig = [
    ...new Set(
      [...(cfg.instagram || []).map(norm), ...defaultAccounts().split(',')].filter(Boolean),
    ),
  ];
  return {
    instagram: ig,
    tiktok: (cfg.tiktok || []).map(norm).filter(Boolean),
    x: (cfg.x || []).map(norm).filter(Boolean),
  };
}
const CURATORS = curatorAccounts();
const ACCOUNTS = getFlag('--accounts', CURATORS.instagram.join(','))
  .split(',')
  .map((s) => s.trim().replace(/^@/, ''))
  .filter(Boolean);
const TT_ACCOUNTS = getFlag('--tiktok-accounts', CURATORS.tiktok.join(','))
  .split(',')
  .map((s) => s.trim().replace(/^@/, ''))
  .filter(Boolean);
const X_ACCOUNTS = getFlag('--x-accounts', CURATORS.x.join(','))
  .split(',')
  .map((s) => s.trim().replace(/^@/, ''))
  .filter(Boolean);
const MAX_PER = parseInt(getFlag('--max-per', '5'), 10);
const HOURS = parseInt(getFlag('--hours', '48'), 10);
const OUT = getFlag('--out', null);
// Which item types to scan. Default = both reels AND feed posts (broader topic net). Accepts e.g.
// "reels", "posts", "reels,posts". MAX_PER applies PER TYPE (up to MAX_PER reels + MAX_PER posts).
const INC_RAW = getFlag('--include', 'reels,posts').toLowerCase();
const INCLUDE = { reels: /reel/.test(INC_RAW), posts: /post|\/p\b|\bp\b/.test(INC_RAW) };
if (!INCLUDE.reels && !INCLUDE.posts) {
  INCLUDE.reels = true;
  INCLUDE.posts = true;
} // empty → both
// --tiktok: also pull TikTok Studio's trending topics (needs a logged-in tiktok.com tab) and write
// them as a `tiktok_trending` section — an extra viral-topic seed pool alongside the IG reels/posts.
const WANT_TIKTOK = args.includes('--tiktok');
const TIKTOK_MAX = parseInt(getFlag('--tiktok-max', '25'), 10);
const TIKTOK_REGION = getFlag('--tiktok-region', 'Indonesia'); // 'all' = unfiltered
// qwen3-vl-8b & qwen2.5-vl-72b di-deprecate Novita (MODEL_NOT_AVAILABLE, 2026-07) — pakai 30b-a3b.
const MODEL = process.env.THOTH_VISION_MODEL || 'qwen/qwen3-vl-30b-a3b-instruct';

// Recency-decay ranking (OPT-IN): score = views * 0.5^(ageHours / halfLife). Views are cumulative,
// so a pure-views sort favours OLDER reels; decay rewards reels that gathered views FAST (fresher).
// Gate via env THOTH_REEL_HALFLIFE_H (hours). 0/unset = legacy ranking (pure views, recency only as
// gate + tie-break). half-life ≈ window/2 is a sensible default if you turn it on.
const HALFLIFE_H = parseFloat(process.env.THOTH_REEL_HALFLIFE_H || '0');
const DECAY_ON = HALFLIFE_H > 0;
function ageHoursOf(r) {
  const ts = r && r.time ? Date.parse(r.time) : NaN;
  return isNaN(ts) ? NaN : Math.max(0, (Date.now() - ts) / 3600000);
}
// Ranking score. Decay off → raw views. Decay on → views * 0.5^(age/halfLife); unknown age = no
// penalty (factor 1) so a missing timestamp never silently buries a high-views reel.
function scoreOf(r) {
  const v = (r && r.views_n) || 0;
  if (!DECAY_ON) return v;
  const ah = ageHoursOf(r);
  // IG grid tak pernah render view-count (views_n=0 semua) → tanpa (v||1) score jadi 0 konstan
  // dan half-life yang di-set user tak berefek; decay murni tetap mengurutkan by recency.
  return (v || 1) * (isNaN(ah) ? 1 : Math.pow(0.5, ah / HALFLIFE_H));
}
// Score kecil (decay murni, 0..1) tampil 3 desimal — Math.round akan menyamarkan semuanya jadi 0/1.
const fmtScore = (r) => {
  const s = scoreOf(r);
  return s >= 10 ? Math.round(s) : +s.toFixed(3);
};
const rankCmp = (a, b) =>
  scoreOf(b) - scoreOf(a) || Date.parse(b.time || 0) - Date.parse(a.time || 0);

import * as env from '../lib/env.ts';
import { ui } from '../lib/ui.ts';
const NOVITA_KEY = env.novitaKey();
const GROQ_KEY = env.groqKey();
const YTDLP = process.env.YTDLP || 'yt-dlp';
// Cookies so yt-dlp can fetch login-walled IG audio (voiceover fallback). Prefer cookies.txt via
// verify.js::ytdlpCookieArgs() (env YTDLP_COOKIES_FILE — run_full.ps1 exports it; carries HttpOnly
// sessionid); legacy THOTH_YTDLP_COOKIES=firefox|brave|.. still honoured as browser fallback.
// Empty string = no cookie source → IG audio pre-skipped (vision hook stays the primary source).
const YTDLP_COOKIES = (process.env.THOTH_YTDLP_COOKIES || '').trim();
function cookieArgStr() {
  const a = ytdlpCookieArgs();
  if (a.length) return ' ' + a.map((s) => (/\s/.test(s) ? `"${s}"` : s)).join(' ');
  return YTDLP_COOKIES ? ` --cookies-from-browser ${YTDLP_COOKIES}` : '';
}

// Read the on-screen HOOK/headline text from a reel's opening frame (base64 PNG) via Novita vision.
// API failure is logged ONCE per run — otherwise a dead/deprecated model masquerades as
// "(tak terbaca)" on every item and looks like an OCR problem (2026-07: qwen3-vl-8b deprecated).
let visionFailLogged = false;
async function visionHook(b64, key, model) {
  if (!key) return '';
  const prompt = `Ini frame PEMBUKA sebuah reel Instagram. Banyak reel menempel TEKS HOOK/HEADLINE besar
(judul atau pancingan cerita) di atas video. Baca teks hook itu apa adanya. Kembalikan HANYA teksnya
(1 kalimat ringkas, tanpa tanda kutip), atau string kosong kalau memang tak ada teks overlay.`;
  try {
    const resp = await fetch('https://api.novita.ai/v3/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        max_tokens: 120,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
            ],
          },
        ],
      }),
    });
    if (!resp.ok) {
      if (!visionFailLogged) {
        visionFailLogged = true;
        let msg = '';
        try {
          msg = (await resp.text()).slice(0, 140);
        } catch (e) {}
        console.log(
          ui.amber(`\n${ui.WARN}  vision API gagal (model=${model}): HTTP ${resp.status} ${msg}`),
        );
      }
      return '';
    }
    const d = await resp.json();
    return (
      (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) ||
      ''
    )
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .slice(0, 160);
  } catch (e) {
    if (!visionFailLogged) {
      visionFailLogged = true;
      console.log(
        ui.amber(
          `\n${ui.WARN}  vision API error (model=${model}): ${String((e && e.message) || e).slice(0, 120)}`,
        ),
      );
    }
    return '';
  }
}

// AUDIO FALLBACK (best-effort): topic from the voiceover. The on-screen hook (vision) is the PRIMARY
// source; this only runs when the hook is too short, and a failure NEVER kills the entry (Bug 5). IG
// reels are login-walled → yt-dlp can't fetch their audio without cookies, so we pre-skip IG cleanly
// unless THOTH_YTDLP_COOKIES points yt-dlp at a logged-in browser (avoids a doomed ~minute download
// per hookless reel and the noisy "Command failed: yt-dlp …" message that looked like a crash).
// slideIndex (opsional): carousel — transcribe slide video ke-N, bukan item pertama (--no-playlist
// ambil slide-1; kalau slide-1 foto, yt-dlp -x mati "No video formats found").
async function audioTopic(reelUrl: string, slideIndex?: number) {
  if (!GROQ_KEY) return { text: '', note: 'audio-off (no GROQ key)' };
  const cookieArg = cookieArgStr();
  if (/instagram\.com/i.test(reelUrl) && !cookieArg) {
    return {
      text: '',
      note: 'audio-skip (IG login-wall — set YTDLP_COOKIES_FILE atau THOTH_YTDLP_COOKIES)',
    };
  }
  const tmp = path.join(os.tmpdir(), 'reel_' + Date.now());
  const itemArg = slideIndex ? ` --playlist-items ${slideIndex}` : ' --no-playlist';
  try {
    execSync(
      `"${YTDLP}" -x --audio-format mp3 --no-warnings${itemArg}${cookieArg} -o "${tmp}.%(ext)s" "${reelUrl}"`,
      { stdio: 'pipe', timeout: 45000 },
    );
    const mp3 = tmp + '.mp3';
    if (!fs.existsSync(mp3)) return { text: '', note: 'audio-skip (yt-dlp tak hasilkan audio)' };
    // Groq Whisper transcription (multipart)
    const buf = fs.readFileSync(mp3);
    const fd = new FormData();
    fd.append('file', new Blob([buf]), 'a.mp3');
    fd.append('model', 'whisper-large-v3-turbo');
    fd.append('response_format', 'text');
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + GROQ_KEY },
      body: fd,
    });
    try {
      fs.unlinkSync(mp3);
    } catch (e) {}
    if (!r.ok) return { text: '', note: 'audio-skip (Groq ' + r.status + ')' };
    const t = (await r.text()).trim();
    return {
      text: t
        .split(/(?<=[.!?])\s/)
        .slice(0, 2)
        .join(' ')
        .slice(0, 200),
      note: 'audio',
    };
  } catch (e) {
    // yt-dlp failed (IG login-wall is the usual cause). Keep it clean + best-effort — don't leak the
    // raw command, don't kill the reel (vision hook already carried the topic where it could).
    const err = String((e && (e.stderr || e.message)) || e);
    const why = /sign ?in|log ?in|cookies|private|rate.?limit|429/i.test(err)
      ? 'login-wall/akses'
      : /timed out|ETIMEDOUT|timeout/i.test(err)
        ? 'timeout'
        : 'yt-dlp gagal';
    return { text: '', note: `audio-skip (${why}${cookieArg ? '' : ' — set YTDLP_COOKIES_FILE'})` };
  }
}

// A reel belongs to `handle` only if its href path is `/<handle>/reel/...` or a bare
// canonical `/reel/<code>/` (grid links are usually bare). Anchors that EXPLICITLY name a
// DIFFERENT account (`/<other>/reel/...`) are IG "Suggested"/related leaks — the root cause of
// cross-account bleed (e.g. indozone.id reels showing up under jktlogy). Those are dropped.
// Reject junk the vision model returns when there is no real hook overlay: its meta-answer
// ("Tak ada teks overlay di atas video."), or a watermark/domain it OCR'd off the footage
// (e.g. "WWW.INDOZONE.ID", "indozone.id"). These were being recorded as topics.
function cleanTopic(t) {
  t = (t || '').trim();
  if (!t) return '';
  if (/\b(tak ada|tidak ada|tanpa)\b.*\bteks\b|no (text|overlay)/i.test(t)) return '';
  const words = t.split(/\s+/);
  if (words.length <= 2 && /(^www\.)|([\w-]+\.(id|com|net|tv|co|org)\b\.?$)/i.test(t)) return '';
  return t;
}

// Legacy candidate-row shape this pipeline's downstream loops/ranking/checkpoint code expects
// (mirrors what the old per-platform DOM scrapers used to hand back). `kind` is derived from
// canonical_url instead of a caller-supplied flag so a single mapping works for every platform.
export interface DiscoveryPostRow {
  account: string;
  kind: string;
  url: string;
  views: string;
  time: string | undefined;
  caption: string;
}

function kindForPost(platform: Platform, url: string): string {
  if (platform === 'instagram') return /\/p\//.test(url) ? 'post' : 'reel';
  if (platform === 'twitter') return 'tweet';
  if (platform === 'tiktok') return 'tiktok';
  return platform;
}

// Pure mapping: AcquisitionService.discover()'s PostRecord[] (thin — engagement/text come from
// the discovery scan itself, media/published_at are usually NOT backfilled yet — that needs a
// separate inspectPost() per URL) -> the flat row shape used below. No service/browser/network
// calls in here — that's the whole point (testability seam per Task 13's brief); keep it that way.
export function mapDiscoveryPosts(account: string, items: PostRecord[]): DiscoveryPostRow[] {
  return items.map((it) => {
    const v = it.engagement && it.engagement.views;
    return {
      account,
      kind: kindForPost(it.platform, it.canonical_url),
      url: it.canonical_url,
      views: v == null ? '' : String(v),
      time: it.published_at,
      caption: it.text,
    };
  });
}

// Pure per-row recency decision, extracted so the cutoff logic is unit-testable without a live
// browser/CDP client. `rows` (built above) is reel rows (newest-first) ++ post rows (grid/recency
// order — igProfileReels's includePosts:true preserves DOM/grid order, and filtering to
// type==='p' keeps that order as a subsequence, so posts ARE recency-ordered exactly like reels).
// staleFlags is keyed PER KIND: once a list's first stale item is hit, every later item of THAT
// list is stale too (newest-first), but the other list is a separate concatenated list and must
// keep going — a single shared flag would let one stale reel silently drop every post after it.
export function isRowStale(
  kind: string,
  ts: number,
  cutoff: number,
  staleFlags: Record<string, boolean>,
): boolean {
  if (staleFlags[kind]) return true;
  if (!isNaN(ts) && ts < cutoff) {
    staleFlags[kind] = true;
    return true;
  }
  return false;
}

// Open a reel OR post, return {time, frameB64, isVideo}. For video items it pauses at t=0 to grab the
// opening (hook) frame; for image posts (no <video>) it captures the largest cover image (where the
// headline card lives). isVideo gates the audio fallback (image posts have no audio to transcribe).
async function itemFrame(client, url) {
  await client.navigate(url, 6000);
  await sleep(2500);
  await client.evaluate(
    `(() => { const v = document.querySelector('video'); if (v) { try { v.pause(); v.currentTime = 0; } catch (e) {} } })()`,
  );
  await sleep(600);
  const meta = await client.evaluate(`(() => {
    const t = document.querySelector('time');
    const v = document.querySelector('article video') || document.querySelector('main video') || document.querySelector('video');
    let el = v; const isVideo = !!v;
    if (!el) {                                  // image post: pick the largest cover image
      let best = null, area = 0;
      const scope = document.querySelector('article') || document.querySelector('main') || document;
      scope.querySelectorAll('img').forEach(im => {
        const r = im.getBoundingClientRect(); const a = r.width * r.height;
        if (a > area && r.width > 150 && r.height > 150) { area = a; best = im; }
      });
      el = best;
    }
    const r = el && el.getBoundingClientRect();
    return JSON.stringify({ time: t ? t.getAttribute('datetime') : null, isVideo, rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null });
  })()`);
  let m;
  try {
    m = JSON.parse(meta);
  } catch (e) {
    m = {};
  }
  let frameB64 = '';
  if (m.rect && m.rect.w > 30) {
    frameB64 = await client.captureClip({ x: m.rect.x, y: m.rect.y, w: m.rect.w, h: m.rect.h }, 0);
  }
  return { time: m.time, frameB64, isVideo: !!m.isVideo };
}

// ponytail: kernel replacement for the old yt-dlp-subprocess shape probe (formerly named
// postShape). Maps AcquisitionService.inspectPost()'s PostRecord onto the {ok, shape, caption,
// slides, publishedAt} shape this file's topic-detection cascade expects. A thrown OR
// wrong-shaped inspectPost result is treated as ok:false — the call site has a caption-only
// fallback for that case (this never blocks an item, only downgrades its topic source).
// TikTok-only: tiktok.ts's inspect() is pure HTTP oEmbed, so it costs no browser navigation.
// The Instagram loop must NOT call this — inspect() there navigates, and itemFrame()'s browse()
// has already spent this run's one allowed navigation for that URL.
async function postShapeViaInspect(
  url: string,
  context: AcquisitionRunContext,
): Promise<{
  ok: boolean;
  shape: string;
  caption: string;
  slides: { kind: string; index: number }[];
  publishedAt?: string;
}> {
  try {
    const record = await context.service.inspectPost(url);
    if (record?.outcome?.status !== 'resolved') {
      return { ok: false, shape: '', caption: '', slides: [] };
    }
    const media = record.media || [];
    const shape = media.length > 1 ? 'carousel' : media[0]?.kind === 'video' ? 'video' : 'photo';
    return {
      ok: true,
      shape,
      caption: record.text || '',
      slides: media.map((m) => ({ kind: m.kind, index: m.index })),
      publishedAt: record.published_at,
    };
  } catch (e) {
    return { ok: false, shape: '', caption: '', slides: [] };
  }
}

// ponytail: guarded like trace_source.ts's Task-12 migration — mapDiscoveryPosts is a pure,
// importable export (discovery_acquisition.test.ts imports it directly), so the live pipeline
// below must NOT run as a side effect of that import; only run it when this file is the entry
// point (`bun pipeline/discover_reels.ts`), not when something merely imports from it.
if (import.meta.main) {
runAcquisitionCli(async () => {
  const context = await createStandaloneAcquisitionContext();
  console.log(ui.rule());
  console.log('  Discover Topics (reels + posts dari akun kurator IG)');
  console.log(ui.rule());
  const incLabel = [INCLUDE.reels && 'reels', INCLUDE.posts && 'posts'].filter(Boolean).join('+');
  console.log(
    'Akun:',
    ACCOUNTS.join(', '),
    '| include:',
    incLabel,
    '| max/tipe/akun:',
    MAX_PER,
    '| window:',
    HOURS + 'h',
  );
  if (TT_ACCOUNTS.length) console.log('Kurator TikTok:', TT_ACCOUNTS.join(', '));
  if (X_ACCOUNTS.length) console.log('Kurator X:', X_ACCOUNTS.join(', '));
  if (WANT_TIKTOK)
    console.log(
      'TikTok Studio trending: ON (butuh tab tiktok.com login) | region:',
      TIKTOK_REGION,
      '| max:',
      TIKTOK_MAX,
    );
  console.log(
    'Ranking:',
    DECAY_ON
      ? `recency-decay (half-life ${HALFLIFE_H}h)`
      : 'views (set THOTH_REEL_HALFLIFE_H untuk recency-decay)',
  );
  if (!GROQ_KEY)
    console.log('ℹ️  audio-fallback OFF (belum ada GROQ key) — pakai hook-frame vision saja.');

  const cutoff = Date.now() - HOURS * 3600 * 1000;
  const found = [];
  let tiktokTrending = []; // filled at the end when --tiktok is set (separate viral-topic seed pool)
  // Checkpoint to disk after every reel/account so a SIGKILL from the runner's process timeout
  // (Bug 3) doesn't throw away everything scraped so far — partial progress stays usable, mirroring
  // run_pipeline's per-stage writes. Sorted on each flush so the file is always rank-ordered.
  const out = OUT || outPath('reel_topics.json');
  const ranking = DECAY_ON ? `recency-decay (half-life ${HALFLIFE_H}h)` : 'views';
  const writeRanked = (partial) => {
    const ranked = found
      .slice()
      .sort(rankCmp)
      .map((r) => (DECAY_ON ? { ...r, score: fmtScore(r) } : r));
    try {
      fs.writeFileSync(
        out,
        JSON.stringify(
          {
            fetched_at: new Date().toISOString(),
            accounts: ACCOUNTS,
            hours: HOURS,
            ranking,
            partial,
            reels: ranked,
            tiktok_trending: tiktokTrending,
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch (e) {}
  };
  const flush = () => writeRanked(true);
  for (const h of ACCOUNTS) {
    process.stdout.write(`\n• @${h}: ambil reel ... `);
    let rows: DiscoveryPostRow[] = [];
    try {
      if (INCLUDE.reels) {
        const disc = await context.service.discover({
          platform: 'instagram',
          kind: 'profile',
          value: h,
          limit: MAX_PER,
        });
        rows = mapDiscoveryPosts(h, disc.items);
      }
      // ponytail: instagram.ts's discover(kind:'profile') only fetches reels (includePosts isn't
      // part of its contract) and pipeline files may not import scrapers/ig_profile.ts directly
      // (Task 16 acquisition boundary) — so the mixed grid ("/p/" + "/reel/") is scraped via
      // pipeline/ig_grid_scrape.ts's scrapeIgProfileGrid(), navigated through this ONE extra
      // browse() visit.
      //
      // This IS the same canonical URL the adapter's discover() above already visited — it goes to
      // the profile ROOT, not to /<handle>/reels/, whatever an earlier version of this comment
      // claimed. The distinct 'ig-grid' purpose is what makes the second visit legal: the budget is
      // one navigation per (url, purpose). Keyed per URL, this browse() was refused outright and the
      // catch below `continue`d, dropping the account's REELS along with its grid — every Instagram
      // curator yielded nothing on any run that missed the 30-minute discovery cache.
      if (INCLUDE.posts) {
        const grid = await context.service.browse(
          'instagram',
          `https://www.instagram.com/${h}/`,
          (client) => scrapeIgProfileGrid(client, h, { max: MAX_PER, captions: true, includePosts: true }),
          'ig-grid',
        );
        const postRows: DiscoveryPostRow[] = (grid || [])
          .filter((it) => it.type === 'p')
          .map((it) => ({
            account: h,
            kind: 'post',
            url: it.url,
            views: it.views ? String(it.views) : '',
            time: undefined,
            caption: it.caption || '',
          }));
        rows = rows.concat(postRows);
      }
    } catch (e) {
      console.log(ui.amber(`${ui.WARN} ${String((e as Error).message || e).slice(0, 50)}`));
      continue;
    }
    const reelCount = rows.filter((r) => r.kind === 'reel').length;
    const postCount = rows.filter((r) => r.kind === 'post').length;
    console.log(`${rows.length} item (${reelCount} reel, ${postCount} post)`);
    if (!rows.length) {
      console.log(
        ui.amber(
          `    ${ui.WARN}  tak ada reel (atau semua leak antar-akun di-drop) — skip akun ini`,
        ),
      );
      continue;
    }
    let acctViews = 0;
    // rows = reel rows (newest-first) ++ post rows (grid/recency order, newest-first — see
    // scrapeIgProfileGrid: includePosts:true preserves DOM/grid order, and filtering to type==='p'
    // keeps that order as a subsequence, so posts ARE recency-ordered exactly like reels). Each
    // list gets its own stale flag (see isRowStale) — hitting a stale item in one list must only
    // stop THAT list, never break the whole loop or bleed into the other list's rows.
    const staleFlags: Record<string, boolean> = {};
    for (const r of rows) {
      const kind = r.kind;
      if (staleFlags[kind]) continue;
      let fr;
      try {
        fr = await context.service.browse(
          'instagram',
          r.url,
          (client) => itemFrame(client, r.url),
          'ig-item-frame',
        );
      } catch (e) {
        continue;
      }
      const ts = fr.time ? Date.parse(fr.time) : NaN;
      if (isRowStale(kind, ts, cutoff, staleFlags)) {
        console.log(`    ⏹  ${kind} >${HOURS}h → stop ${kind} akun ini`);
        continue;
      } // newest-first per list
      let topic = cleanTopic(await visionHook(fr.frameB64, NOVITA_KEY, MODEL));
      let via = 'hook';
      let shape = ''; // stays '' when the vision hook already produced the topic (unchanged)
      if (topic.length < 8) {
        // Tangga sumber topik: video → audio → caption; foto → caption.
        // Caption comes with the row already (grid scrape for /p/, discovery record for reels),
        // so there is NO second acquisition call for r.url here: itemFrame's browse() above
        // spent this run's one allowed navigation, and the coordinator now REFUSES to serve a
        // differently-purposed second visit rather than silently aliasing the frame object back
        // as a PostRecord (which is what used to make every Instagram inspect here come back
        // empty). Losing the shape probe also stops mattering: a photo+video carousel whose DOM
        // <video> false-positives to isVideo just fails audioTopic and lands on the caption,
        // which — unlike before — is now actually populated.
        const caption = cleanTopic(r.caption || '').slice(0, 200);
        shape = fr.isVideo ? 'video' : 'photo';
        if (fr.isVideo) {
          const a = await audioTopic(r.url);
          const at = cleanTopic(a.text);
          if (at) {
            topic = at;
            via = a.note;
          } else if (caption) {
            topic = caption;
            via = 'caption';
          } else via = a.note;
        } else if (caption) {
          topic = caption;
          via = 'caption';
        } else via = 'image-post (tanpa caption/teks)';
      }
      const ageH = isNaN(ts) ? '?' : ((Date.now() - ts) / 3600000).toFixed(1) + 'h';
      const vn = normalizeLikes(r.views);
      if (vn > 0) acctViews++;
      found.push({
        account: h,
        kind,
        url: r.url,
        views: r.views,
        views_n: vn,
        time: fr.time,
        age: ageH,
        topic,
        via,
        shape,
      });
      console.log(
        `    [${kind}, ${ageH}, ${r.views || '?'} views, ${via}] ${topic || '(tak terbaca)'}`,
      );
      flush(); // checkpoint after each item
    }
    if (rows.length && acctViews === 0)
      console.log(
        ui.amber(
          `    ${ui.WARN}  views 0 untuk semua item @${h} (grid view-count tak render) — ranking pakai recency saja`,
        ),
      );
    flush(); // checkpoint after each account
  }

  // ── Kurator TikTok (curator_accounts.json .tiktok) ──────────────────────────────────────
  // Grid TikTok expose VIEWS nyata (beda IG) → scoring dapat sinyal views betulan; tapi grid
  // tanpa <time> → recency diambil dari inspect (metadata oEmbed). Topik: caption → audio.
  // Vision hook sengaja DILEWATI di TikTok (butuh navigasi per-item di tab tiktok; caption+audio
  // sudah menutup) — tambah nanti kalau kurasi TikTok terbukti sering tanpa caption.
  for (const h of TT_ACCOUNTS) {
    process.stdout.write(`\n• @${h} (tiktok): ambil video ... `);
    let rows: DiscoveryPostRow[] = [];
    try {
      const disc = await context.service.discover({
        platform: 'tiktok',
        kind: 'profile',
        value: h,
        limit: MAX_PER,
      });
      rows = mapDiscoveryPosts(h, disc.items);
    } catch (e) {
      console.log(ui.amber(`${ui.WARN} ${String((e as Error).message || e).slice(0, 60)}`));
      continue;
    }
    console.log(`${rows.length} video`);
    for (const r of rows) {
      // tiktok.ts's inspect() is pure HTTP oEmbed (no CDP navigation) and only resolves
      // ephemeral_url when 'media' was registered first — register before the inspectPost()
      // call inside postShapeViaInspect() below.
      context.service.registerIntent(r.url, 'inspect');
      context.service.registerIntent(r.url, 'media');
      const ps = await postShapeViaInspect(r.url, context);
      const ts = ps.ok && ps.publishedAt ? Date.parse(ps.publishedAt) : NaN;
      if (!isNaN(ts) && ts < cutoff) continue; // pinned/lama tampil duluan → skip item, jangan break
      let topic = cleanTopic(r.caption || (ps.ok ? ps.caption : '')).slice(0, 200);
      let via = 'caption';
      if (topic.length < 8) {
        const a = await audioTopic(r.url);
        const at = cleanTopic(a.text);
        if (at) {
          topic = at;
          via = a.note;
        } else via = a.note;
      }
      const ageH = isNaN(ts) ? '?' : ((Date.now() - ts) / 3600000).toFixed(1) + 'h';
      const vn = Number(r.views) || 0;
      found.push({
        account: h,
        kind: 'tiktok',
        url: r.url,
        views: vn ? String(vn) : '',
        views_n: vn,
        time: isNaN(ts) ? null : new Date(ts).toISOString(),
        age: ageH,
        topic,
        via,
        shape: ps.ok ? ps.shape : 'video',
      });
      console.log(`    [tiktok, ${ageH}, ${vn || '?'} views, ${via}] ${topic || '(tak terbaca)'}`);
      flush();
    }
  }

  // ── Kurator X/Twitter (curator_accounts.json .x) ────────────────────────────────────────
  // Topik tweet = TEKSNYA langsung (tanpa vision/audio). Video tweet tanpa teks → tangga audio.
  for (const h of X_ACCOUNTS) {
    process.stdout.write(`\n• @${h} (x): ambil tweet ... `);
    let rows: DiscoveryPostRow[] = [];
    try {
      const disc = await context.service.discover({
        platform: 'twitter',
        kind: 'profile',
        value: h,
        limit: MAX_PER,
      });
      rows = mapDiscoveryPosts(h, disc.items);
    } catch (e) {
      console.log(ui.amber(`${ui.WARN} ${String((e as Error).message || e).slice(0, 60)}`));
      continue;
    }
    console.log(`${rows.length} tweet`);
    for (const r of rows) {
      // ponytail: twitter.ts's discover() intentionally returns media:[] and no published_at
      // (adapter comment: "Deferred; discover() callers that need media call inspect() on the
      // returned canonical_url") — this loop needs hasVideo/hasPhoto + a real timestamp for the
      // recency gate/shape, so X is the one candidate set that actually calls inspectPost()
      // (one navigation per tweet; discover() itself never visited this URL, so it stays at
      // most one navigation total for it). Best-effort: a failed inspect just falls back to
      // the thin discover() row instead of dropping the tweet.
      // Registered for coordinator bookkeeping only — NOT functionally consumed even though a
      // real navigation (inspectPost above) does follow: twitter.ts's inspect() only branches on
      // `.has('social-card')`, never on 'inspect'/'media', so it can't route by these intents.
      // Functional routing of these intents through the coordinator is deferred to Task 16
      // (acquisition-boundary enforcement).
      context.service.registerIntent(r.url, 'inspect');
      context.service.registerIntent(r.url, 'media');
      let full: PostRecord | null = null;
      try {
        full = await context.service.inspectPost(r.url);
      } catch (e) {}
      const text = (full ? full.text : '') || r.caption;
      const timeStr = full?.published_at || r.time || null;
      const hasVideo = !!full?.media.some((m) => m.kind === 'video');
      const hasPhoto = !!full?.media.some((m) => m.kind === 'image');
      const ts = timeStr ? Date.parse(timeStr) : NaN;
      if (!isNaN(ts) && ts < cutoff) continue; // pinned tampil pertama → skip item, jangan break
      let topic = cleanTopic(text).slice(0, 200);
      let via = 'tweet-text';
      if (topic.length < 8 && hasVideo) {
        const a = await audioTopic(r.url);
        const at = cleanTopic(a.text);
        if (at) {
          topic = at;
          via = a.note;
        } else via = a.note;
      }
      const shape = hasVideo ? 'video' : hasPhoto ? 'photo' : 'text';
      const ageH = isNaN(ts) ? '?' : ((Date.now() - ts) / 3600000).toFixed(1) + 'h';
      found.push({
        account: h,
        kind: 'tweet',
        url: r.url,
        views: '',
        views_n: 0,
        time: timeStr,
        age: ageH,
        topic,
        via,
        shape,
      });
      console.log(`    [tweet, ${ageH}, ${via}] ${topic || '(tak terbaca)'}`);
      flush();
    }
  }

  // TikTok Studio trending topics (opt-in) — a separate viral-topic seed pool. Best-effort: a
  // failure (no tiktok.com tab, layout change) leaves the section empty and never breaks the IG run.
  if (WANT_TIKTOK) {
    process.stdout.write('\n• TikTok Studio trending ... ');
    try {
      tiktokTrending = await fetchTrending({ max: TIKTOK_MAX, region: TIKTOK_REGION });
      console.log(`${tiktokTrending.length} topik (region ${TIKTOK_REGION})`);
    } catch (e) {
      console.log(ui.amber(`${ui.WARN} ${String(e.message || e).slice(0, 50)}`));
    }
  }

  found.sort(rankCmp);
  writeRanked(false); // final: drop the partial flag now that the run completed cleanly
  console.log('\n' + ui.rule('thin'));
  console.log(`PERINGKAT (${ranking}):`);
  found
    .slice(0, 10)
    .forEach((r, i) =>
      console.log(
        `  ${i + 1}. [@${r.account}, ${r.kind || 'reel'}, ${r.views || '?'} views, ${r.age}${DECAY_ON ? `, score ${fmtScore(r)}` : ''}] ${r.topic || '(tak terbaca)'}`,
      ),
    );
  if (tiktokTrending.length) {
    console.log('\nTIKTOK TRENDING (TikTok Studio):');
    tiktokTrending.slice(0, 10).forEach((t) => console.log(`  ${t.rank}. [${t.views}] ${t.title}`));
  }
  console.log(`📄 ${out}`);
});
}
