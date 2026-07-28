// verify.js — caption-based topic verification for the GATE RELEVANSI in content-sourcing.
//
// PROBLEM: search_tiktok_v2 grabbed the first N /video/ links from a feed that often
// ignores the query (logged-out → "feed generik"). The skill mandates verifying each
// candidate's caption actually mentions the topic, but no tool could fetch a caption.
//
// FIX: TikTok exposes a PUBLIC oEmbed endpoint (no login) returning title (caption) +
// author. Use it to confirm a candidate is on-topic before marking relevance:"match".
//
//   Module:  import { tiktokOembed, matchesTopic } from './verify.ts';
//   CLI:     bun verify.ts <tiktok_url> [keyword1 keyword2 ...]
//            → prints caption + author + whether all/any keywords are present.

import fs from 'node:fs';
import { execFileSync, execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pool } from './async_pool.ts';
const execFileP = promisify(_execFile);

// Bounded timeout for every yt-dlp metadata probe. A healthy `-J`/`--dump-single-json` probe
// returns in <5s; the old 45s only prolonged the DEAD cases (login-wall, geoblock) that will
// fail anyway. 20s keeps a generous margin for a slow-but-real probe while capping the stall.
const PROBE_TIMEOUT = 20000;
// yt-dlp -J on a fat carousel can print a large JSON blob → lift the child stdout cap (default
// 1 MB) so a big-but-valid response isn't truncated into a parse error.
const PROBE_MAXBUF = 1 << 24; // 16 MB
import { ui } from './ui.ts';

// Fetch TikTok caption/author via public oEmbed. Returns {title,author,thumbnail} or null.
async function tiktokOembed(url) {
  try {
    const r = await fetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(url), {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return {
      title: d.title || '',
      author: d.author_name || d.author_unique_id || '',
      thumbnail: d.thumbnail_url || '',
    };
  } catch (_) {
    return null;
  }
}

// Fetch YouTube title via public oEmbed (no login). Returns {title,author} or null.
async function youtubeOembed(url) {
  try {
    const r = await fetch(
      'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url),
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      },
    );
    if (!r.ok) return null;
    const d = await r.json();
    return { title: d.title || '', author: d.author_name || '', thumbnail: d.thumbnail_url || '' };
  } catch (_) {
    return null;
  }
}

// Probe ANY url with yt-dlp metadata (no download) → { isVideo, caption }. Used to admit Twitter/IG
// posts as MAIN candidates: yt-dlp confirms the post actually carries a video (a text-only tweet
// errors → isVideo:false → caller drops it) and returns its title/description for relevance ranking.
// Cookies optional via env YTDLP_COOKIES_BROWSER (IG usually needs it; Twitter public usually not —
// missing cookies just yields isVideo:false, which degrades gracefully). Sync (execFileSync) like
// the other yt-dlp helpers; bounded timeout so one slow probe can't stall the run.
// Cookie args for yt-dlp: prefer a cookies.txt FILE (env YTDLP_COOKIES_FILE — what Thoth's ingest uses,
// reliably carries IG HttpOnly `sessionid`) over live browser extraction (env YTDLP_COOKIES_BROWSER,
// which fails DPAPI on chromium here). Empty when neither is set.
function ytdlpCookieArgs() {
  const file = (process.env.YTDLP_COOKIES_FILE || '').trim();
  if (file && fs.existsSync(file)) return ['--cookies', file];
  const browser = (process.env.YTDLP_COOKIES_BROWSER || '').trim();
  return browser ? ['--cookies-from-browser', browser] : [];
}

function probeVideo(url) {
  const YTDLP = process.env.YTDLP || 'yt-dlp';
  const args = [
    '--no-warnings',
    '--skip-download',
    '--dump-single-json',
    '--playlist-items',
    '1',
    ...ytdlpCookieArgs(),
    url,
  ];
  try {
    const out = execFileSync(YTDLP, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT,
      maxBuffer: PROBE_MAXBUF,
    });
    const d = JSON.parse(out.toString('utf8'));
    const isVideo = !!(
      d &&
      (d.duration || d.ext || d._type === 'video' || (Array.isArray(d.formats) && d.formats.length))
    );
    const caption = String((d && (d.title || d.description)) || '')
      .replace(/\s+/g, ' ')
      .trim();
    const thumbnail = String(
      (d && d.thumbnail) ||
        (d &&
          Array.isArray(d.thumbnails) &&
          d.thumbnails.length &&
          d.thumbnails[d.thumbnails.length - 1].url) ||
        '',
    );
    // yt-dlp resolves Twitter's post-nesting/repost to the REAL video owner — webpage_url is the
    // canonical downloadable page (handles t.co/redirect), uploader_id is the actual video author.
    const uploader = String((d && (d.uploader_id || d.uploader || d.channel_id)) || '').replace(
      /^@/,
      '',
    );
    const webpageUrl = String((d && d.webpage_url) || '');
    return { isVideo, caption, thumbnail, uploader, webpageUrl };
  } catch (_) {
    return { isVideo: false, caption: '', thumbnail: '', uploader: '', webpageUrl: '' };
  }
}

// Resolve ONE carousel slide (1-based index n) of an IG/X/FB post to a DIRECT CDN .mp4 URL via
// yt-dlp --playlist-items. Returns the signed URL or '' if that slide is a PHOTO (yt-dlp errors
// "No video formats found") / unresolvable. Same ephemeral-CDN pattern as tiktokDirectUrl: Thoth's
// generic yt-dlp downloads the signed URL without IG cookies, so run thoth soon (URL expires).
function igSlideDirectUrl(postUrl, n) {
  const YTDLP = process.env.YTDLP || 'yt-dlp';
  const args = [
    '--no-warnings',
    '--skip-download',
    '--playlist-items',
    String(n),
    '-f',
    'best[ext=mp4]/best',
    '-g',
    ...ytdlpCookieArgs(),
    postUrl,
  ];
  try {
    const out = execFileSync(YTDLP, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT,
      maxBuffer: PROBE_MAXBUF,
    });
    const url =
      out
        .toString('utf8')
        .trim()
        .split(/\r?\n/)
        .find((l) => /^https?:\/\//.test(l)) || '';
    return url;
  } catch (_) {
    return '';
  }
}

// Resolve ANY post URL (TikTok/YouTube/Twitter/IG/FB page) to a DIRECT, ffmpeg-openable stream URL
// via yt-dlp -g. Needed because analyzeSubtitles() frame-grabs with `ffmpeg -i <url>`, and ffmpeg
// cannot open a platform *page* URL (youtube.com/watch, x.com/…/status) — only a signed CDN media
// URL. Returns '' on failure (photo-only post, unresolvable, timeout, or an already-direct CDN URL
// yt-dlp doesn't recognize) so callers can fail-open to the original URL. Same ephemeral-CDN caveat
// as tiktokDirectUrl/igSlideDirectUrl: the signed URL expires, use it promptly.
// Args extracted (like shapeArgs) so the flag set is assertable without spawning yt-dlp.
// `--playlist-items 1` alone resolved ONLY slide 1: a photo-first IG/FB carousel then errored
// ("No video formats found"), fell open to the page URL, and ffprobe read an HTML page as
// 0-duration media → a bogus `duration_probe_failed`. Scan the first slides instead and let
// --ignore-no-formats-error skip past photos to the first real video, the same flag postShape
// already relies on. Bounded to 5 so a playlist URL can't fan out.
function directStreamArgs(pageUrl, maxSlides = 5) {
  return [
    '--no-warnings',
    '--skip-download',
    '--ignore-no-formats-error',
    '--playlist-items',
    '1-' + maxSlides,
    '-f',
    'best[ext=mp4]/best',
    '-g',
    ...ytdlpCookieArgs(),
    pageUrl,
  ];
}

function directStreamUrl(pageUrl) {
  const YTDLP = process.env.YTDLP || 'yt-dlp';
  const args = directStreamArgs(pageUrl);
  try {
    const out = execFileSync(YTDLP, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT,
      maxBuffer: PROBE_MAXBUF,
    });
    return (
      out
        .toString('utf8')
        .trim()
        .split(/\r?\n/)
        .find((l) => /^https?:\/\//.test(l)) || ''
    );
  } catch (_) {
    return '';
  }
}

// Enumerate an IG/X/FB carousel's slides via yt-dlp (RELIABLE — no DOM, unlike cropPost whose
// biggest-media+ancestor heuristic fails on many carousel layouts). Returns [{index, kind}], 1-based,
// kind='video' when the slide carries a duration (video), else 'photo'. [] on failure / single media.
// Lets footage pick up all-video carousels (e.g. a 6-clip post) even when the DOM crop can't.
function igCarouselSlides(postUrl, maxSlides = 5) {
  const YTDLP = process.env.YTDLP || 'yt-dlp';
  const args = [
    '--no-warnings',
    '--skip-download',
    '--flat-playlist',
    '-J',
    '--playlist-items',
    '1-' + maxSlides,
    ...ytdlpCookieArgs(),
    postUrl,
  ];
  try {
    const out = execFileSync(YTDLP, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT,
      maxBuffer: PROBE_MAXBUF,
    });
    const d = JSON.parse(out.toString('utf8'));
    const entries = Array.isArray(d.entries) && d.entries.length ? d.entries : [d];
    return entries.map((e, i) => ({ index: i + 1, kind: e && e.duration ? 'video' : 'photo' }));
  } catch (_) {
    return [];
  }
}

// Classify ANY post URL's SHAPE via ONE yt-dlp -J probe — platform-agnostic (works wherever
// yt-dlp has an extractor: IG, TikTok, X, FB, YT). Returns
//   { ok, shape: 'video'|'photo'|'carousel', slides: [{index, kind, duration}], caption, time }
// time = epoch DETIK upload (0 kalau extractor tak menyediakan) — satu-satunya sumber recency
// untuk platform yang grid-nya tanpa <time> (TikTok).
// entries[] > 1 → carousel (slide kind from per-entry duration); single → duration ? video : photo.
// --ignore-no-formats-error keeps PHOTO posts from erroring ("No video formats found" — the exact
// failure that broke discover's audio fallback on photo-first carousels). caption = description
// (curator photo posts carry the topic THERE, not in an overlay). ok:false on any failure →
// caller falls back to its legacy heuristic. Cached per-run: discover probes one URL per item.
const shapeCache = new Map();
// Arg builder + JSON parser extracted so the sync `postShape` and the async `warmPostShapes`
// share ONE implementation (no drift). parseShape maps yt-dlp -J → the shape record.
function shapeArgs(postUrl, maxSlides = 10) {
  return [
    '--no-warnings',
    '--skip-download',
    '--ignore-no-formats-error',
    '--flat-playlist',
    '-J',
    '--playlist-items',
    '1-' + maxSlides,
    ...ytdlpCookieArgs(),
    postUrl,
  ];
}
function parseShape(jsonText: string): any {
  const d = JSON.parse(jsonText);
  const caption = String((d && (d.description || d.title)) || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  const time =
    (d && d.timestamp) || (Array.isArray(d.entries) && d.entries[0] && d.entries[0].timestamp) || 0;
  if (Array.isArray(d.entries) && d.entries.length > 1) {
    const slides = d.entries.map((e, i) => ({
      index: i + 1,
      kind: e && e.duration ? 'video' : 'photo',
      duration: (e && e.duration) || 0,
    }));
    return { ok: true, shape: 'carousel', slides, caption, time };
  }
  const one = (Array.isArray(d.entries) && d.entries[0]) || d;
  const kind = one && one.duration ? 'video' : 'photo';
  return {
    ok: true,
    shape: kind,
    slides: [{ index: 1, kind, duration: (one && one.duration) || 0 }],
    caption,
    time,
  };
}
function postShape(postUrl, maxSlides = 10) {
  if (shapeCache.has(postUrl)) return shapeCache.get(postUrl);
  const YTDLP = process.env.YTDLP || 'yt-dlp';
  let res: any = { ok: false, shape: '', slides: [], caption: '' };
  try {
    const out = execFileSync(YTDLP, shapeArgs(postUrl, maxSlides), {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT,
      maxBuffer: PROBE_MAXBUF,
    });
    res = parseShape(out.toString('utf8'));
  } catch (_) {}
  shapeCache.set(postUrl, res);
  return res;
}

// Warm `shapeCache` for many URLs CONCURRENTLY (bounded) before a serial admission loop probes
// them one-by-one. Each `postShape(url)` in the loop then hits the cache instantly. Turns N
// serial yt-dlp roundtrips into ceil(N/concurrency) waves. Best-effort: a failed probe caches
// the same {ok:false} sentinel the sync path uses, so the caller's legacy fallback still fires.
async function warmPostShapes(urls: string[], concurrency = 5): Promise<void> {
  const YTDLP = process.env.YTDLP || 'yt-dlp';
  const todo = [...new Set(urls)].filter((u) => u && !shapeCache.has(u));
  if (!todo.length) return;
  await pool(todo, concurrency, async (u) => {
    let res: any = { ok: false, shape: '', slides: [], caption: '' };
    try {
      const { stdout } = await execFileP(YTDLP, shapeArgs(u), {
        timeout: PROBE_TIMEOUT,
        maxBuffer: PROBE_MAXBUF,
      });
      res = parseShape(stdout.toString());
    } catch (_) {}
    shapeCache.set(u, res);
  });
}

// Does `text` mention the topic? mode 'all' (default) requires every keyword; 'any' needs one.
// Case-insensitive, accent-naive substring match (good enough for id/en captions).
function matchesTopic(text, keywords, mode = 'all') {
  if (!keywords || !keywords.length) return true;
  const hay = String(text || '').toLowerCase();
  const hits = keywords.filter((k) => hay.includes(String(k).toLowerCase()));
  return mode === 'any' ? hits.length > 0 : hits.length === keywords.length;
}

// Verify a TikTok URL against keywords. Returns {url,ok,caption,author,hits,missing}.
// ok=null when the caption couldn't be fetched (oEmbed miss) → caller should treat as
// "unverified", never silently as "match".
async function verifyTikTok(url, keywords = []) {
  const meta = await tiktokOembed(url);
  if (!meta) return { url, ok: null, caption: '', author: '', hits: [], missing: keywords };
  const hay = (meta.title || '').toLowerCase();
  const hits = keywords.filter((k) => hay.includes(String(k).toLowerCase()));
  const missing = keywords.filter((k) => !hay.includes(String(k).toLowerCase()));
  return {
    url,
    ok: keywords.length ? hits.length === keywords.length : true,
    caption: meta.title,
    author: meta.author,
    hits,
    missing,
  };
}

export {
  tiktokOembed,
  youtubeOembed,
  matchesTopic,
  verifyTikTok,
  probeVideo,
  directStreamArgs,
  directStreamUrl,
  igSlideDirectUrl,
  igCarouselSlides,
  ytdlpCookieArgs,
  postShape,
  warmPostShapes,
};

// --- CLI ------------------------------------------------------------------------
if (import.meta.main) {
  (async () => {
    const url = process.argv[2];
    const keywords = process.argv.slice(3);
    if (!url) {
      console.log('Usage: bun verify.ts <tiktok_url> [keyword ...]');
      process.exit(1);
    }
    const res = await verifyTikTok(url, keywords);
    if (res.ok === null) {
      console.log(
        ui.amber(
          `${ui.WARN}  Caption tak terambil (oEmbed miss). Perlakukan sebagai UNVERIFIED, jangan "match".`,
        ),
      );
      process.exitCode = 2;
      return;
    }
    console.log('Caption :', res.caption);
    console.log('Author  :', res.author);
    if (keywords.length) {
      console.log('Hits    :', res.hits.join(', ') || '(none)');
      console.log('Missing :', res.missing.join(', ') || '(none)');
      console.log(
        res.ok
          ? ui.gold(`${ui.OK} ON-TOPIC (semua keyword cocok) → boleh "match"`)
          : ui.red(`${ui.ERR} OFF-TOPIC / sebagian → "unverified" atau buang`),
      );
    }
    process.exitCode = res.ok ? 0 : 1;
  })();
}
