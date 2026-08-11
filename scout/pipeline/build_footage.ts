// build_footage.ts — build footage[] from VISUAL OBJECTS (footage_objects) instead of the topic query.
//
// Footage = cutaway b-roll of the concrete things in the story. For each object (e.g. gojek, grab,
// indofest senayan) we search all platforms and take `--per` items as a MIX of video b-roll
// (TikTok/YouTube → is_video:true) and posts (X/IG/FB/Threads → cropped to image_path). Each footage
// is gated to ITS object (relevance:"match", query=object) so Thoth keeps it.
//
//   bun build_footage.ts <content_set.json> [--objects "a,b,c"] [--per 2] [--max 3] [--no-crop]
//
// Without --objects, subjects/objects/people are extracted from main.title + main.description + top
// comments via footage_objects (LLM). Each search query = object + primary subject ("chip ai" +
// "nvidia" → "chip ai nvidia"; +1 enriched query with a known person, e.g. "… jensen huang"). Drops
// content identical to main (url/id/caption) and reaction/repost videos (face-cam over a clip ≠ b-roll).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { footageObjects } from '../lib/footage_objects.ts';
import { cropPost, inferPlatform } from '../scrapers/crop_post.ts';
import { igCarouselSlides, igSlideDirectUrl, dropCoverSlide } from '../lib/verify.ts';
import { rankBySimilarity, embed, cosine } from '../lib/embed.ts';
import { outPath } from '../lib/paths.ts';
import { isCuratedAggregator, urlHandle } from '../lib/aggregators.ts';
import {
  formatMediaDropSummary,
  selectCarouselFootageVideoCandidate,
  selectFootageVideoCandidate,
  selectTikTokFootageVideoCandidate,
} from '../lib/footage_candidate_selection.ts';
import { resolveFootageTasks } from './footage_queries.ts';
import { ui } from '../lib/ui.ts';
import type { AcquisitionRunContext, LocalAsset, MediaAsset, PostRecord } from '../acquisition/index.ts';
import { createStandaloneAcquisitionContext, runAcquisitionCli } from '../acquisition/index.ts';
import { scrapeIgProfileGrid } from './ig_grid_scrape.ts';

// ── Footage admission seam ──────────────────────────────────────────────────────────────────────
// Every footage candidate must pass non-media gates BEFORE any downloader/materializer call.
// `post` here is an already-inspected PostRecord (service.inspectPost() — cheap, 6h-cached), never
// bytes fetched for the candidate itself: gating on post.text costs no download. Only an admitted
// candidate ever reaches deps.materialize(). A video candidate is admitted WITHOUT materializing
// here — OCR (attachFootageOcrCandidate via selectFootageVideoCandidate) decides for itself whether
// it needs local media, unchanged.
export interface FootageAdmissionDeps {
  query: string;
  isRelevant(text: string, query: string): boolean;
  isMain(url: string, text: string): boolean;
  looksReaction(text: string): boolean;
  materialize(asset: MediaAsset): Promise<LocalAsset>;
}

export type FootageAdmissionResult =
  | { status: 'accepted'; entry: Record<string, unknown> }
  | { status: 'rejected'; reason: 'main' | 'irrelevant' | 'reaction' | 'no-media' };

export async function admitAndMaterializeFootage(
  post: PostRecord,
  deps: FootageAdmissionDeps,
): Promise<FootageAdmissionResult> {
  const text = post.text || '';
  if (deps.isMain(post.canonical_url, text)) return { status: 'rejected', reason: 'main' };
  if (deps.looksReaction(text)) return { status: 'rejected', reason: 'reaction' };
  if (!deps.isRelevant(text, deps.query)) return { status: 'rejected', reason: 'irrelevant' };
  const asset = post.media[0];
  if (!asset) return { status: 'rejected', reason: 'no-media' };

  const base = {
    url: post.canonical_url,
    platform: post.platform,
    query: deps.query,
    relevance: 'match',
    description: text,
  };
  if (asset.kind === 'video') {
    return { status: 'accepted', entry: { ...base, is_video: true } };
  }
  const local = await deps.materialize(asset);
  return { status: 'accepted', entry: { ...base, is_video: false, image_path: local.path } };
}

// Tolerant wrapper for admitAndMaterializeFootage() — for loops that iterate several
// candidates (e.g. the twitter-card loop below): a materialize() failure (AcquisitionError,
// transient network blip, etc.) for ONE candidate must never abort processing of the rest.
export type FootageMaterializeOutcome =
  | { status: 'ok'; result: FootageAdmissionResult }
  | { status: 'error'; error: unknown };

export async function admitAndMaterializeFootageTolerant(
  post: PostRecord,
  deps: FootageAdmissionDeps,
): Promise<FootageMaterializeOutcome> {
  try {
    return { status: 'ok', result: await admitAndMaterializeFootage(post, deps) };
  } catch (error) {
    return { status: 'error', error };
  }
}

export interface BuildFootageOptions {
  file: string;
  objects: string[] | null;
  per: number;
  max: number;
  noCrop: boolean;
  profile: string | null;
}

export function parseBuildFootageArgs(argv: string[]): BuildFootageOptions {
  const getFlag = (n: string, d: string | null) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : d;
  };
  const file = argv.find(
    (a, i) =>
      !a.startsWith('--') && !['--objects', '--per', '--max', '--profile'].includes(argv[i - 1]),
  );
  const objFlag = getFlag('--objects', null);
  const objects = objFlag
    ? objFlag
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  const per = parseInt(getFlag('--per', '2'), 10);
  const max = parseInt(getFlag('--max', '3'), 10);
  const noCrop = argv.includes('--no-crop');
  const profile = getFlag('--profile', null); // IG username to also pull relevant footage from
  if (!file) {
    console.log(
      'Usage: bun build_footage.ts <content_set.json> [--objects "a,b"] [--per 2] [--max 3] [--no-crop]',
    );
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.log(ui.red(`${ui.ERR} File tak ada: ${file}`));
    process.exit(1);
  }
  return { file, objects, per, max, noCrop, profile };
}

const VIDEO = new Set(['tiktok', 'youtube']);
const slugify = (q) =>
  q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'q';

// A footage hit is RELEVANT to its object when the caption/post text contains the object's
// significant tokens. Drops generic/off-topic search noise — especially uncurated X/IG/FB posts
// (topic_to_urls only caption-gates TikTok at search time, not posts).
function relevant(text, obj) {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return false;
  // Require ALL significant tokens (≥3 chars) present — multi-word objects must match fully so a
  // single generic token (e.g. "pictures") can't let off-topic noise through ("mvp pictures" must
  // have BOTH "mvp" AND "pictures", not just "pictures").
  const toks = obj
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  if (!toks.length) return true;
  return toks.every((w) => t.includes(w));
}

// Promo/spam post: link-first or carrying a known spam/shortener domain. Such posts ride a topic's
// hashtags but aren't real footage of it (e.g. "Yang lagi viral di mobil vidku.fun … #Gempa").
function looksSpam(text) {
  const t = (text || '').toLowerCase().trim();
  return (
    /^https?:\/\//.test(t) || /vidku\.|t\.me\/|bit\.ly|tinyurl|cutt\.ly|\.fun\b|\.xyz\b/i.test(t)
  );
}

// Reaction/repost content = someone REACTING to other footage (face-cam over a clip), not original
// b-roll of the subject → useless as cutaway. Conservative markers (NOT bare "nonton" — over-filters).
const REACTION_RE =
  /\b(reaction|reaksi|bereaksi|ngereact|nge-?react|react(?:ing|s|ed)?|reupload|nonton bareng)\b/i;
const looksReaction = (t) => REACTION_RE.test(t || '');

// Platform video/post id → content-identity dedup (a repost of MAIN under a different URL still counts).
function videoId(u) {
  if (!u) return '';
  const m =
    u.match(/\/video\/(\d{6,})/) ||
    u.match(/[?&]v=([\w-]{6,})/) ||
    u.match(/youtu\.be\/([\w-]+)/) ||
    u.match(/\/(?:reel|reels|p|tv)\/([\w-]+)/);
  return m ? m[1] : '';
}

const norm = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Top comments text (by likes) → enrich object/subject extraction (names/brands often surface there).
function topComments(set, n = 12) {
  return (set.comments || [])
    .slice()
    .sort((a, b) => (b.likes || 0) - (a.likes || 0))
    .slice(0, n)
    .map((c) => (c.text || '').trim())
    .filter(Boolean)
    .join(' • ')
    .slice(0, 600);
}

// Run topic_to_urls for an object, gated to that object, return the merged `all` list.
function searchObject(query, max) {
  try {
    execFileSync(
      process.execPath,
      [
        path.join(import.meta.dirname, 'topic_to_urls.ts'),
        query,
        '--platforms',
        'tiktok,tw,ig,fb',
        '--max',
        String(max),
        '--keywords',
        query,
      ],
      { stdio: 'pipe', timeout: 200000 },
    );
  } catch (e) {
    /* exit!=0 tolerated */
  }
  const f = outPath(`topic_urls_${slugify(query)}.json`);
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')).all || [];
  } catch (e) {
    return [];
  }
}

// Push one footage entry per cropped slide of an IG/FB post: PHOTO → image-card (is_video:false);
// VIDEO slide → igSlideDirectUrl CDN .mp4 (is_video:true) so Thoth downloads real video, not a frozen
// frame. Distinct url (#slideN / CDN) keeps dedup happy. Caller crops + gates first.
type PushSlidesResult = { added: number; mediaDropped: number };

async function pushSlides(set, postUrl, slides, plat, query, description): Promise<PushSlidesResult> {
  let added = 0;
  let mediaDropped = 0;
  for (const s of slides) {
    if (s.kind === 'video') {
      const analyzed = await selectCarouselFootageVideoCandidate(
        {
          url: postUrl,
          platform: plat,
          query,
          is_video: true,
          relevance: 'match',
          description,
        },
        () => igSlideDirectUrl(postUrl, s.index),
      );
      mediaDropped += analyzed.mediaDropped;
      if (analyzed.result.status === 'unavailable') continue;
      if (analyzed.result.entry.ocr_outcome === 'subtitle') continue;
      set.footage.push(analyzed.result.entry);
    } else {
      if (!s.image_path) continue; // photo slide with no cropped image → skip (no broken card)
      set.footage.push({
        url: postUrl + (s.index > 1 ? `#slide${s.index}` : ''),
        platform: plat,
        query,
        is_video: false,
        relevance: 'match',
        image_path: s.image_path,
        description,
      });
    }
    added++;
  }
  return { added, mediaDropped };
}

export async function runBuildFootage(
  options: BuildFootageOptions,
  context: AcquisitionRunContext,
): Promise<void> {
  const { file, objects, per, max, noCrop, profile } = options;
  const set = JSON.parse(fs.readFileSync(file, 'utf8'));
  set.footage = set.footage || [];
  const main = set.main || {};

  // OPSI A — main = carousel IG (/p/) multi-video → footage = slide-slide carousel itu SAJA (skip cari
  // eksternal). Slide-2..N dari post yang SAMA = liputan multi-angle kreator: dijamin satu event/topik,
  // jadi tak perlu similarity gate / pencarian eksternal (sumber footage off-topik & inkonsisten). Slide
  // #1 = main (ingest pakai --no-playlist → ambil item pertama) → dibuang dari footage. <2 video → pool
  // kekecilan → jatuh ke alur build-footage biasa di bawah.
  if (/instagram/i.test(main.platform || '') && /\/p\//.test(main.url || '')) {
    const allSlides = igCarouselSlides(main.url, 10);
    if (allSlides.filter((s) => s.kind === 'video').length >= 2) {
      console.log(ui.rule());
      console.log('  Build Footage dari SLIDE CAROUSEL main (opsi A: slide-only)');
      console.log(ui.rule());
      let slides = dropCoverSlide(allSlides); // slide #1 = cover/main → buang
      if (slides.some((s) => s.kind === 'photo') && !noCrop) {
        try {
          const cr = await cropPost({ url: main.url, maxSlides: 10 }); // crop HANYA buat panen gambar photo-slide
          if (cr.ok) {
            const imgByIdx = new Map(
              (cr.slides || []).filter((s) => s.image_path).map((s) => [s.index, s.image_path]),
            );
            slides = slides.map((s) =>
              s.kind === 'photo' ? { ...s, image_path: imgByIdx.get(s.index) } : s,
            );
          }
        } catch (e) {}
      }
      slides = slides.filter((s) => s.kind === 'video' || s.image_path); // photo tanpa gambar → buang
      const slideResult = await pushSlides(
        set,
        main.url,
        slides,
        'instagram',
        'slide post utama',
        main.description || '',
      );
      fs.writeFileSync(file, JSON.stringify(set, null, 2), 'utf8');
      console.log(
        `Selesai: +${slideResult.added} footage dari ${slides.length} slide carousel main → footage total ${set.footage.length}. (skip cari eksternal)` +
          formatMediaDropSummary(slideResult.mediaDropped),
      );
      return;
    }
  }

  // IG creator to ALSO pull footage from: explicit --profile, else auto from a traced IG source.
  const profileUser =
    profile ||
    (main.source_traced && /instagram/i.test(main.platform || '') ? main.source_traced : '');

  // --objects manual override bypasses resolveFootageTasks (query = obj verbatim); otherwise
  // dossier.search_queries (Task 1) drives tasks, falling back to footageObjects extraction.
  const tasks = objects
    ? objects.map((obj) => ({ obj, query: obj }))
    : await resolveFootageTasks(
        set,
        (input) => footageObjects(input),
        (s) => topComments(s),
      );
  console.log(ui.rule());
  console.log(
    '  Build Footage' +
      (set.dossier?.search_queries?.length ? ' (dossier-driven)' : ' (footageObjects fallback)') +
      (profileUser ? ' + PROFIL @' + profileUser : ''),
  );
  console.log(ui.rule());
  console.log('Query  :', tasks.map((t) => t.query).join(' | ') || '(kosong)');
  if (!tasks.length && !profileUser) {
    console.log('Tak ada query/objek. Selesai.');
    return;
  }

  const have = new Set(set.footage.map((f) => f.url));
  [main.url, main.source_url, main.source_traced].forEach((u) => u && have.add(u));
  const mainId = videoId(main.url) || videoId(main.source_url);
  const mainCap = norm(`${main.title || ''} ${main.description || ''}`);
  // True when a candidate IS the main content (same url/id, or near-identical caption) — never re-use main.
  // sameAsMain = content-identity only (no `have` check) — used INSIDE add*() which mark `have` up-front,
  // so an `isMain` (which also returns true for anything in `have`) would self-reject the current candidate.
  const sameAsMain = (url, caption) => {
    const id = videoId(url);
    if (id && mainId && id === mainId) return true;
    const c = norm(caption);
    return !!(
      c &&
      c.length > 20 &&
      mainCap &&
      (mainCap.includes(c) || c.includes(mainCap.slice(0, 80)))
    );
  };
  const isMain = (url, caption) => have.has(url) || sameAsMain(url, caption);
  let addedV = 0,
    addedP = 0;

  // FOOTAGE dari profil SUMBER (creator asli): reel-reel creator yang RELEVAN ke topik (selain main) —
  // konten autentik & on-topik. IG reel downloadable Thoth via cookies. Cap biar tetap variatif.
  const REL_MIN = 0.3; // cosine floor: on-topic reels ≥~0.33, off-topic ≤~0.27 (qwen3-embedding).
  if (profileUser && isCuratedAggregator(profileUser)) {
    console.log(`• profil @${profileUser} = akun kurator (ig_accounts) → skip footage profil`);
  } else if (profileUser) {
    process.stdout.write(`• profil @${profileUser} … `);
    let added = 0;
    let mediaDropped = 0;
    try {
      // includePosts:true → also scan feed posts (/p/), since creators often publish the topic as a
      // carousel/slide feed post (photo+video), not a Reel. max bumped: the grid mixes photos+reels.
      // ponytail: pipeline files may not import scrapers/ig_profile.ts directly (Task 16
      // acquisition boundary) — pipeline/ig_grid_scrape.ts duplicates just the grid-scan logic,
      // navigated through this ONE kernel browse() visit to the profile root.
      const reels = await context.service.browse(
        'instagram',
        `https://www.instagram.com/${profileUser}/`,
        (client) => scrapeIgProfileGrid(client, profileUser, { max: 12, captions: true, includePosts: true }),
        'ig-grid',
      );
      // Topic text = task queries + title (the EVENT), NOT figure names. We're ranking the creator's OWN
      // posts, so the figure's name matches EVERY post and discriminates nothing — it lets the creator's
      // off-topic posts (e.g. a sales rant) score above the floor. Rank by event relevance only.
      const taskQueries = tasks.map((t) => t.query);
      const topic = [...taskQueries, main.title || ''].filter(Boolean).join(', ');
      const ranked = await rankBySimilarity(topic, reels, (r) => r.caption || '');
      // No embeddings (sim all 0) → fall back to literal token overlap so we still add something useful.
      const useSim = ranked.some((r) => r.sim > 0);
      const toks = new Set();
      const addToks = (s) =>
        (s || '')
          .toLowerCase()
          .split(/\s+/)
          .forEach((w) => w.length >= 4 && toks.add(w));
      taskQueries.forEach(addToks);
      addToks(main.title); // event tokens only (no figure name — see above)
      for (const r of ranked) {
        if (added >= per + 1) break;
        if (r.url === main.url || have.has(r.url)) continue;
        if (useSim) {
          if (r.sim < REL_MIN) continue;
        } else {
          const cap = (r.caption || '').toLowerCase();
          if (toks.size && ![...toks].some((t) => cap.includes(t))) continue;
        }
        have.add(r.url);
        if (r.type === 'p') {
          // creator FEED post (/p/) — often a carousel mixing PHOTO + VIDEO slides on the topic.
          // Enumerate slides via yt-dlp (RELIABLE; cropPost's DOM heuristic fails on many carousels,
          // e.g. an all-video 6-clip post). Video slides → CDN mp4 (igSlideDirectUrl in pushSlides).
          // Crop the post ONLY to harvest images for PHOTO slides; never block on it for videos.
          let desc = r.caption || '';
          // cover dulu, BARU cap — biar cap-nya berisi slide 2..4, bukan cover + 2 slide
          let slides = dropCoverSlide(igCarouselSlides(r.url, 5)).slice(0, 3); // cap so one post can't flood footage
          const needPhotos = slides.some((s) => s.kind === 'photo') || !slides.length;
          if (needPhotos && !noCrop) {
            try {
              const cr = await cropPost({ url: r.url, maxSlides: 5 });
              if (cr.ok) {
                if ((cr.text || '').trim()) desc = cr.text.trim();
                const imgByIdx = new Map(
                  (cr.slides || []).filter((s) => s.image_path).map((s) => [s.index, s.image_path]),
                );
                if (cr.image_path && !imgByIdx.size) imgByIdx.set(1, cr.image_path);
                if (slides.length)
                  slides = slides.map((s) =>
                    s.kind === 'photo' ? { ...s, image_path: imgByIdx.get(s.index) } : s,
                  );
                else
                  slides = dropCoverSlide(
                    cr.slides ||
                      (cr.image_path ? [{ kind: 'photo', index: 1, image_path: cr.image_path }] : []),
                  ).slice(0, 3); // enum failed → use crop
              }
            } catch (e2) {}
          }
          slides = slides.filter((s) => s.kind === 'video' || s.image_path); // drop photo slides w/o an image
          const slideResult = await pushSlides(
            set,
            r.url,
            slides,
            'instagram',
            'profil @' + profileUser,
            desc,
          );
          mediaDropped += slideResult.mediaDropped;
          const n = slideResult.added;
          if (n) {
            added++;
            addedP++;
          } else {
            for (const s of slides)
              if (s.image_path) {
                try {
                  fs.rmSync(s.image_path);
                } catch (e3) {}
              }
          }
        } else {
          // preAdmit: this branch previously had no main/reaction gate at all before OCR's
          // downloader ran (only the earlier cosine/token relevance floor on r.caption) — closed
          // via the same seam every other candidate site uses, so a reel that IS the main content
          // or a reaction/repost of it never reaches attachFootageOcrCandidate's download.
          const analyzed = await selectFootageVideoCandidate(
            {
              url: r.url,
              platform: 'instagram',
              query: 'profil @' + profileUser,
              is_video: true,
              relevance: 'match',
              description: r.caption || '',
            },
            undefined,
            () => !isMain(r.url, r.caption || '') && !looksReaction(r.caption || ''),
          );
          mediaDropped += analyzed.mediaDropped;
          if (analyzed.result.status === 'unavailable') continue;
          if (analyzed.result.entry.ocr_outcome === 'subtitle') continue;
          set.footage.push(analyzed.result.entry);
          added++;
          addedV++;
        }
      }
      fs.writeFileSync(file, JSON.stringify(set, null, 2), 'utf8');
    } catch (e) {
      throw e;
    }
    console.log(
      `+${added} reel relevan` + formatMediaDropSummary(mediaDropped),
    );
  }

  for (const { obj, query } of tasks) {
    try {
      process.stdout.write(`• "${query}" … `);
      const rawAll = searchObject(query, max);
      const all = rawAll.filter((e) => !isCuratedAggregator(urlHandle(e.url))); // never footage from ig_accounts curators / their cross-posts
      const aggSkip = rawAll.length - all.length;
      const vids = all.filter(
        (e) => VIDEO.has(e.platform) && !have.has(e.url) && !isMain(e.url, ''),
      );
      const posts = all.filter(
        (e) => inferPlatform(e.url) && !have.has(e.url) && !isMain(e.url, ''),
      ); // x/ig/fb/threads croppable
      // Aim for a video/post MIX. CRITICAL: do NOT give up after the first pick — many TOP
      // candidates fail the relevance/main gate, so iterate ALL candidates until the quota is
      // filled (or we run out), then cross-fill any shortfall from the other type. (Old code
      // sliced only the top nVid/nPost and quit, yielding 0 footage when those few failed.)
      const wantV = Math.ceil(per / 2),
        wantP = per - Math.ceil(per / 2);
      let pv = 0,
        pp = 0,
        dropped = 0,
        dropReact = 0,
        mediaDropped = 0;

      const addVideo = async (e) => {
        have.add(e.url);
        // description = caption asli footage (via kernel inspectPost) → di-embed Thoth utk
        // cocokkan ke narasi. tiktok.ts's inspect() is a pure oEmbed HTTP call; youtube.ts's is
        // the analogous metadata fetch — neither does a CDP navigation.
        let description = '';
        if (e.platform === 'tiktok' || e.platform === 'youtube') {
          const record = await context.service.inspectPost(e.url).catch(() => null);
          description = record?.text || '';
        }
        if (sameAsMain(e.url, description)) {
          dropped++;
          return false;
        } // konten sama dengan main → skip
        if (looksReaction(description)) {
          dropReact++;
          return false;
        } // video reaction/repost → bukan b-roll
        // NB: TIDAK ada re-gate relevant() utk video — TikTok/YT sudah di-keyword-gate saat search
        // (topic_to_urls --keywords), dan story-gate cosine di akhir yang menyaring off-topic. Re-gate
        // pakai caption oEmbed rapuh: oEmbed flaky/rate-limit → caption salah/tak ada kata objek →
        // video VALID ke-drop (gejala: "+0v" padahal kandidat bagus). Percaya search-gate + story-gate.
        // TikTok page URLs resolve to CDN media before OCR. A failed resolution is unavailable,
        // consumes no quota, and is never retried by attachVideoOcr.
        // OCR is a required safety gate: subtitle footage is rejected, cover footage
        // is trimmed, and analysis failure aborts content-set construction.
        const candidate = {
          url: e.url,
          platform: e.platform,
          query: obj,
          is_video: true,
          relevance: 'match',
          description,
        };
        // ponytail: kernel replacement for the old raw tiktokDirectUrl scraper call —
        // registerIntent('media') gates tiktok.ts's inspect() into resolving ephemeral_url at
        // all (see acquisition/adapters/tiktok.ts). Pure oEmbed/HTTP, no CDP navigation.
        const resolveDirect = async (u: string) => {
          try {
            context.service.registerIntent(u, 'media');
            const record = await context.service.inspectPost(u);
            const direct = record.media[0]?.ephemeral_url;
            return direct ? { url: direct } : null;
          } catch (err) {
            return null;
          }
        };
        const analyzed =
          e.platform === 'tiktok'
            ? await selectTikTokFootageVideoCandidate(candidate, resolveDirect)
            : await selectFootageVideoCandidate(candidate);
        mediaDropped += analyzed.mediaDropped;
        if (analyzed.result.status === 'unavailable') return false;
        if (analyzed.result.entry.ocr_outcome === 'subtitle') {
          dropReact++;
          return false;
        }
        set.footage.push(analyzed.result.entry);
        pv++;
        addedV++;
        return true;
      };
      const addPost = async (e) => {
        have.add(e.url);
        const isIG = e.platform === 'ig' || e.platform === 'instagram';
        let slides = [],
          description = '';
        // Gate on the post's OWN text (service.inspectPost — cheap, 6h-cached, no screenshot)
        // BEFORE cropPost's CDP screenshot capture, so a candidate that is main/reaction/off-topic
        // never triggers that capture at all. Falls back to the legacy crop-first gate below when
        // inspect is unsupported/fails for this platform/url, so recall never regresses.
        try {
          const inspected = await context.service.inspectPost(e.url);
          const text = inspected.text || '';
          if (sameAsMain(e.url, text) || looksReaction(text)) {
            if (looksReaction(text)) dropReact++;
            else dropped++;
            return false;
          }
          if (!relevant(text, obj) || looksSpam(text)) {
            dropped++;
            return false;
          }
        } catch (inspectErr) {
          // inspect unsupported/failed → defer entirely to the post-crop gate below (unchanged).
        }
        // IG posts can be a carousel mixing PHOTO + VIDEO slides → capture up to 5 slides; cropPost marks
        // each as {kind:'photo',image_path} or {kind:'video',index}.
        if (!noCrop) {
          try {
            const r = await cropPost({ url: e.url, maxSlides: isIG ? 5 : 1 });
            if (r.ok) {
              slides =
                r.slides ||
                (r.image_path ? [{ kind: 'photo', index: 1, image_path: r.image_path }] : []);
              description = (r.text || '').trim();
            }
          } catch (err) {}
        }
        const rmAll = () => {
          for (const s of slides) {
            if (s.image_path) {
              try {
                fs.rmSync(s.image_path);
              } catch (e2) {}
            }
          }
        };
        // GATE: post (X/IG/FB) TIDAK di-gate saat search → wajib teks-nya cocok ke objek + bukan spam/reaction/main.
        if (sameAsMain(e.url, description) || looksReaction(description)) {
          rmAll();
          if (looksReaction(description)) dropReact++;
          else dropped++;
          return false;
        }
        if (!relevant(description, obj) || looksSpam(description)) {
          rmAll();
          dropped++;
          return false;
        }
        const plat = e.platform === 'tw' ? 'twitter' : isIG ? 'instagram' : e.platform;
        if (noCrop) {
          set.footage.push({
            url: e.url,
            platform: plat,
            query: obj,
            is_video: false,
            relevance: 'match',
            image_path: '',
            description,
          });
          pp++;
          addedP++;
          return true;
        }
        // One footage entry per slide (URL CDN ephemeral → run thoth soon).
        const slideResult = await pushSlides(set, e.url, slides, plat, obj, description);
        mediaDropped += slideResult.mediaDropped;
        const added = slideResult.added;
        if (!added) {
          rmAll();
          return false;
        }
        pp++;
        addedP++;
        return true; // one post = one quota unit regardless of slide count
      };

      // Pass 1: fill each type's quota by trying candidates IN ORDER until enough PASS the gates.
      for (const e of vids) {
        if (pv >= wantV) break;
        if (!have.has(e.url)) await addVideo(e);
      }
      for (const e of posts) {
        if (pp >= wantP) break;
        if (!have.has(e.url)) await addPost(e);
      }
      // Pass 2: cross-fill shortfall (e.g. no croppable posts) from leftover candidates of EITHER type.
      for (const e of vids) {
        if (pv + pp >= per) break;
        if (!have.has(e.url)) await addVideo(e);
      }
      for (const e of posts) {
        if (pv + pp >= per) break;
        if (!have.has(e.url)) await addPost(e);
      }
      console.log(
        `+${pv}v/${pp}p` +
          (dropped ? ` (${dropped} drop tak-relevan)` : '') +
          (dropReact ? ` (${dropReact} drop reaction)` : '') +
          formatMediaDropSummary(mediaDropped) +
          (aggSkip ? ` (${aggSkip} drop akun-kurator)` : ''),
      );
      fs.writeFileSync(file, JSON.stringify(set, null, 2), 'utf8'); // persist after EACH object (crash-resilient)
    } catch (e) {
      throw e;
    }
  }

  // ── TWITTER non-video posts → crop as footage cards (user request) ─────────────────────────────
  // Twitter usually has related NON-video posts about the story (eyewitness/news/threads). Crop them as
  // image-cards. LOOSE admit (no object-token gate) — the story-gate cosine below drops off-topic. Video
  // tweets self-skip: cropPost returns no image_path for a video slide (we only want NON-video here).
  if (!noCrop) {
    const twQuery = (main.title || '').trim() || (tasks[0]?.query || '');
    if (twQuery) {
      process.stdout.write(`• twitter "${twQuery.slice(0, 50)}" … `);
      let tw = 0;
      try {
        const cands = searchObject(twQuery, max).filter(
          (e) => /(?:x|twitter)\.com/.test(e.url) && !have.has(e.url) && !sameAsMain(e.url, ''),
        );
        for (const e of cands) {
          if (tw >= per) break;
          have.add(e.url);

          // Gate + materialize via the shared seam: inspectPost (cheap, cached, no screenshot)
          // supplies the tweet's own text AND its media list. A photo-attached tweet that passes
          // the gates never needs cropPost's CDP screenshot at all — service.materialize() fetches
          // the attachment directly (direct-http/gallery-dl). Only a gated-through text-only tweet
          // ('no-media' — no attachment to fetch, but still wanted as a screenshotted "card") falls
          // through to the legacy cropPost path, and only AFTER admission, never before.
          let inspected = null;
          try {
            inspected = await context.service.inspectPost(e.url);
          } catch (inspectErr) {
            inspected = null;
          }
          if (inspected) {
            if (looksSpam(inspected.text || '')) continue;
            const outcome = await admitAndMaterializeFootageTolerant(inspected, {
              query: 'twitter',
              isRelevant: () => true, // LOOSE admit (existing behavior) — story-gate below drops off-topic
              isMain: (url, text) => sameAsMain(url, text),
              looksReaction,
              materialize: (asset) => context.service.materialize(asset, 'footage'),
            });
            if (outcome.status === 'error') {
              // One bad candidate (e.g. transient network blip) must not abort the remaining
              // ones — matches the pre-existing per-candidate tolerance of the cropPost fallback below.
              console.log(
                ui.amber(
                  `  ${ui.WARN} materialize gagal (${e.url}): ${String((outcome.error as Error)?.message || outcome.error).slice(0, 80)}`,
                ),
              );
              continue;
            }
            const admission = outcome.result;
            if (admission.status === 'accepted') {
              if (admission.entry.is_video) continue; // video tweet — this branch wants non-video only
              set.footage.push(admission.entry as any);
              tw++;
              addedP++;
              continue;
            }
            if (admission.reason !== 'no-media') continue; // main/reaction rejected before any download
            // else: no attachment to fetch → fall through to the screenshot-card path below.
          }

          let cr;
          try {
            cr = await cropPost({ url: e.url, maxSlides: 1 });
          } catch (e2) {
            cr = null;
          }
          if (!cr || !cr.ok || !cr.image_path) continue; // video tweet / crop failed → skip (want non-video)
          const desc = (cr.text || '').trim();
          if (!desc || looksReaction(desc) || looksSpam(desc) || sameAsMain(e.url, desc)) {
            try {
              fs.rmSync(cr.image_path);
            } catch (e3) {}
            continue;
          }
          set.footage.push({
            url: e.url,
            platform: 'twitter',
            query: 'twitter',
            is_video: false,
            relevance: 'match',
            image_path: cr.image_path,
            description: desc,
          });
          tw++;
          addedP++;
        }
        fs.writeFileSync(file, JSON.stringify(set, null, 2), 'utf8');
      } catch (e) {}
      console.log(`+${tw} kartu twitter`);
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
    const gated = set.footage.filter((f) => (f.description || '').trim());
    if (story && gated.length) {
      const vecs = await embed([story, ...gated.map((f) => f.description)]);
      const q = vecs[0];
      if (q) {
        const drop = new Set<any>();
        gated.forEach((f, i) => {
          const s = cosine(q, vecs[i + 1]);
          if (vecs[i + 1] && s < STORY_MIN) {
            drop.add(f);
            console.log(
              `  ✂️ story-gate drop (${s.toFixed(3)}<${STORY_MIN}): ${(f.description || '').slice(0, 55)}`,
            );
          }
        });
        if (drop.size) {
          for (const f of drop) {
            if (f.image_path) {
              try {
                fs.rmSync(f.image_path);
              } catch (e) {}
            }
          }
          set.footage = set.footage.filter((f) => !drop.has(f));
        }
      }
    }
  } catch (e) {}

  fs.writeFileSync(file, JSON.stringify(set, null, 2), 'utf8');
  console.log(ui.rule('thin'));
  console.log(
    `Selesai: +${addedV} video b-roll, +${addedP} kartu post → footage total ${set.footage.length}. (${file})`,
  );
  console.log('Lalu: bun validate_content_set.ts "' + file + '"');
}

if (import.meta.main) {
  runAcquisitionCli(async () => {
    const options = parseBuildFootageArgs(process.argv.slice(2));
    const context = await createStandaloneAcquisitionContext();
    await runBuildFootage(options, context);
  });
}
