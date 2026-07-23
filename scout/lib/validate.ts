// validate.js — shared URL validators + content-set linting for the Thoth hand-off.
//
// Single source of truth for the URL shapes content-sourcing/SKILL.md mandates, plus a
// linter that checks a content-set BEFORE `thoth run --content` so 404 / off-topic /
// missing-image hand-offs never reach the Rust pipeline. Used by search_social_v2.js,
// search_tiktok_v2.js and validate_content_set.js.

import fs from 'node:fs';
import {
  configuredOcrModel,
  OCR_ANALYZER_VERSION,
  OCR_SCHEMA_VERSION,
} from './ocr_contract.ts';
import type { ContentSet } from './types.ts';
import { okCrop } from './crop_guard.ts';

// A crop is unusable if it's gone from disk OR is a flat black/blank PNG (see crop_guard.ts).
// Returns '' when fine, else a human reason. Catches stale black cards merged forward from an
// older run — the exact failure that put a black comment card into a rendered video.
function cropStatus(p: string): string {
  if (!fs.existsSync(p)) return 'hilang di disk';
  try {
    if (!okCrop(fs.readFileSync(p))) return 'hitam/blank (piksel kosong)';
  } catch (e) {
    return 'tak terbaca';
  }
  return '';
}

// --- URL validators (gate: reject fabricated / handle-as-shortcode URLs) -----------
// Accept both canonical (instagram.com/reel/CODE) and account-prefixed
// (instagram.com/<user>/reel/CODE) forms — both are real & downloadable. Still rejects
// bare-handle fabrications (no /reel|p|tv/CODE segment).
const IG_RE =
  /^https?:\/\/(www\.)?instagram\.com\/([A-Za-z0-9_.]+\/)?(reel|reels|p|tv)\/[A-Za-z0-9_-]{5,}\/?(\?|$)/;
const TW_RE = /^https?:\/\/(x|twitter)\.com\/[^/]+\/status\/\d{15,}(\?|$)/;
const TK_RE = /^https?:\/\/(www\.)?tiktok\.com\/@[\w.-]+\/video\/\d{8,}/;
const YT_RE =
  /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/)[\w-]{6,}|youtu\.be\/[\w-]{6,})/;
const FB_RE = /^https?:\/\/(www\.|web\.|m\.)?facebook\.com\/.+\/(videos|posts|reel)\/.+/;

const PLATFORM_RE = {
  instagram: IG_RE,
  twitter: TW_RE,
  tiktok: TK_RE,
  youtube: YT_RE,
  facebook: FB_RE,
};

const validIG = (u) => IG_RE.test(u);
const validTW = (u) => TW_RE.test(u);
const validTK = (u) => TK_RE.test(u);

// Infer platform from a URL when the JSON omits/mismatches the `platform` field.
function inferPlatform(url) {
  const u = String(url || '');
  if (/tiktok\.com/.test(u)) return 'tiktok';
  if (/instagram\.com/.test(u)) return 'instagram';
  if (/(x|twitter)\.com/.test(u)) return 'twitter';
  if (/(youtube\.com|youtu\.be)/.test(u)) return 'youtube';
  if (/facebook\.com/.test(u)) return 'facebook';
  return null;
}

// Direct media/CDN URL (not a platform PAGE) — yt-dlp downloads these via its generic extractor.
// Legit when a page can't be downloaded directly: TikTok via tikwm (tiktokcdn), Threads via fbcdn,
// IG via cdninstagram, or any plain .mp4. Skip the platform-page regex for these.
const MEDIA_RE =
  /tiktokcdn|fbcdn\.net|cdninstagram|akamaized|googlevideo|\.mp4(\?|$)|mime_type=video_mp4/i;

// Validate one URL against the regex for its (inferred or declared) platform.
function validUrlFor(url, platform) {
  const p = platform || inferPlatform(url);
  if (MEDIA_RE.test(String(url)))
    return { ok: true, platform: p, note: 'URL media/CDN langsung — regex page dilewati' };
  const re = PLATFORM_RE[p];
  if (!re) return { ok: true, platform: p, note: 'platform tak dikenal — regex dilewati' };
  return { ok: re.test(String(url)), platform: p };
}

function lintVideoOcr(
  record,
  tag: string,
  kind: 'main' | 'footage',
  errors: string[],
  configuredModel: string,
) {
  if (record.is_video === false) return;

  if (record.ocr_status == null) {
    errors.push(`${tag}.ocr_status: not analyzed.`);
    return;
  }
  if (record.ocr_status === 'failed') {
    errors.push(`${tag}.ocr_status: analysis failed.`);
    return;
  }
  if (record.ocr_status !== 'analyzed') {
    errors.push(`${tag}.ocr_status: malformed value.`);
    return;
  }

  if (record.ocr_schema_version !== OCR_SCHEMA_VERSION) {
    errors.push(
      `${tag}: stale OCR schema "${String(record.ocr_schema_version ?? '')}".`,
    );
  }
  if (record.ocr_model !== configuredModel) {
    errors.push(`${tag}: stale OCR model "${String(record.ocr_model || '')}".`);
  }
  if (record.ocr_analyzer_version !== OCR_ANALYZER_VERSION) {
    errors.push(
      `${tag}: stale OCR analyzer "${String(record.ocr_analyzer_version || '')}".`,
    );
  }
  if (
    typeof record.ocr_analyzed_at !== 'string' ||
    !record.ocr_analyzed_at ||
    !Number.isFinite(Date.parse(record.ocr_analyzed_at))
  ) {
    errors.push(`${tag}: malformed OCR analyzed_at.`);
  }

  const requested = record.ocr_requested_frames;
  const valid = record.ocr_valid_frames;
  if (
    !Number.isInteger(requested) ||
    requested <= 0 ||
    !Number.isInteger(valid) ||
    valid !== requested
  ) {
    errors.push(`${tag}: malformed OCR frame counts.`);
  }

  if (!['clean', 'cover', 'subtitle'].includes(record.ocr_outcome)) {
    errors.push(`${tag}: malformed OCR outcome.`);
  } else if (kind === 'footage' && record.ocr_outcome === 'subtitle') {
    errors.push(`${tag}: subtitle-classified footage must be rejected.`);
  }

  if (
    typeof record.trim_start !== 'number' ||
    !Number.isFinite(record.trim_start) ||
    record.trim_start < 0
  ) {
    errors.push(`${tag}: malformed trim_start directive.`);
  }
  if (typeof record.mute_audio !== 'boolean') {
    errors.push(`${tag}: malformed mute_audio directive.`);
  }
  if (!Array.isArray(record.subtitle_blur)) {
    errors.push(`${tag}: malformed subtitle_blur directive.`);
    return;
  }

  record.subtitle_blur.forEach((region, ri) => {
    const numbers = ['x', 'y', 'w', 'h'].map((key) => region?.[key]);
    const [x, y, w, h] = numbers;
    const invalidGeometry =
      numbers.some((value) => typeof value !== 'number' || !Number.isFinite(value)) ||
      x < 0 ||
      y < 0 ||
      w <= 0 ||
      h <= 0 ||
      x + w > 1 ||
      y + h > 1;
    const hasStart = region?.start != null;
    const hasEnd = region?.end != null;
    const invalidWindow =
      hasStart !== hasEnd ||
      (hasStart &&
        (typeof region.start !== 'number' ||
          !Number.isFinite(region.start) ||
          region.start < 0 ||
          typeof region.end !== 'number' ||
          !Number.isFinite(region.end) ||
          region.end < region.start));
    if (invalidGeometry || invalidWindow) {
      errors.push(`${tag}: malformed subtitle_blur[${ri}] directive.`);
    }
  });

  if (record.ocr_outcome === 'clean') {
    if (record.trim_start !== 0 || record.mute_audio || record.subtitle_blur.length) {
      errors.push(`${tag}: inconsistent clean directives.`);
    }
  } else if (record.ocr_outcome === 'cover') {
    if (!(record.trim_start > 0)) {
      errors.push(`${tag}: inconsistent cover trim directive.`);
    }
    if (record.mute_audio || record.subtitle_blur.length) {
      errors.push(`${tag}: inconsistent cover subtitle directives.`);
    }
  } else if (record.ocr_outcome === 'subtitle') {
    if (record.mute_audio !== true) {
      errors.push(`${tag}: inconsistent subtitle mute directive.`);
    }
    if (!record.subtitle_blur.length) {
      errors.push(`${tag}: inconsistent subtitle blur directive.`);
    }
  }
}

// Lint a content-set (single object {main,footage,comments} or an array of them).
// Returns { errors:[], warnings:[], info:[], ok:boolean }. errors → unsafe to hand off.
function lintContentSet(
  data: ContentSet,
  env: Record<string, string | undefined> = process.env,
) {
  const errors = [],
    warnings = [],
    info = [];
  const sets = Array.isArray(data) ? data : [data];
  const configuredModel = configuredOcrModel(env);

  if (!sets.length) errors.push('content-set kosong.');

  sets.forEach((set, si) => {
    const tag = sets.length > 1 ? `set[${si}]` : 'set';
    if (!set || typeof set !== 'object') {
      errors.push(`${tag}: bukan objek.`);
      return;
    }

    // --- main ---
    const main = set.main;
    if (!main || !main.url) {
      errors.push(`${tag}.main.url: WAJIB ada.`);
    } else {
      const v = validUrlFor(main.url, main.platform);
      if (!v.ok)
        errors.push(`${tag}.main.url: bentuk URL tidak valid untuk ${v.platform} → ${main.url}`);
      if (main.is_video === false) {
        if (!main.image_path) errors.push(`${tag}.main: is_video:false TANPA image_path.`);
        else {
          const s = cropStatus(main.image_path);
          if (s) errors.push(`${tag}.main.image_path ${s}: ${main.image_path}`);
        }
      }
      lintVideoOcr(main, `${tag}.main`, 'main', errors, configuredModel);
      if (!main.description)
        warnings.push(
          `${tag}.main.description kosong — narasi bisa berhalusinasi (kontrak: WAJIB).`,
        );
      if (!main.title) warnings.push(`${tag}.main.title kosong.`);
    }

    // --- footage[] ---
    const footage = Array.isArray(set.footage) ? set.footage : [];
    footage.forEach((f, fi) => {
      const ft = `${tag}.footage[${fi}]`;
      if (!f.url) {
        errors.push(`${ft}.url: WAJIB ada.`);
        return;
      }
      const v = validUrlFor(f.url, f.platform);
      if (!v.ok) errors.push(`${ft}.url: bentuk URL tidak valid untuk ${v.platform} → ${f.url}`);
      if (f.relevance && !['match', 'unverified'].includes(f.relevance))
        warnings.push(`${ft}.relevance="${f.relevance}" tak dikenal (harap match|unverified).`);
      if (f.relevance === 'unverified') info.push(`${ft}: unverified — Thoth akan membuangnya.`);
      if (!f.relevance)
        warnings.push(`${ft}.relevance kosong — set "match" hanya jika terverifikasi on-topic.`);
      if (!f.query) info.push(`${ft}.query kosong — sebaiknya isi keyword penemu footage.`);
      if (f.is_video === false) {
        if (!f.image_path) errors.push(`${ft}: is_video:false TANPA image_path.`);
        else {
          const s = cropStatus(f.image_path);
          if (s) errors.push(`${ft}.image_path ${s}: ${f.image_path}`);
        }
      }
      lintVideoOcr(f, ft, 'footage', errors, configuredModel);
    });
    if (!footage.length) info.push(`${tag}: tanpa footage (single-video — sah).`);

    // --- comments[] ---
    const comments = Array.isArray(set.comments) ? set.comments : [];
    comments.forEach((c, ci) => {
      const ct = `${tag}.comments[${ci}]`;
      if (!c.text) warnings.push(`${ct}.text kosong.`);
      if (!c.author) warnings.push(`${ct}.author kosong.`);
      // A bad comment crop isn't fatal (Thoth draws a synthetic card) but must not paste a black
      // box — flag it so the dead/black path gets cleared before render (collect_comments strips it).
      if (c.image_path) {
        const s = cropStatus(c.image_path);
        if (s)
          warnings.push(`${ct}.image_path ${s} → harus di-null (kartu sintetis): ${c.image_path}`);
      }
    });
  });

  return { errors, warnings, info, ok: errors.length === 0 };
}

export {
  IG_RE,
  TW_RE,
  TK_RE,
  YT_RE,
  FB_RE,
  PLATFORM_RE,
  validIG,
  validTW,
  validTK,
  inferPlatform,
  validUrlFor,
  lintContentSet,
};
