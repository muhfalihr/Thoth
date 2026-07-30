// aggregators.js — the curated topic-discovery accounts (ig_accounts.json) are AGGREGATORS/curators.
// Their reels only signal WHAT topic to cover; their video must NEVER become the main or footage.
// This module is the single source of truth for "is this handle one of our curated aggregators?",
// shared by trace_source.js (main) and build_footage.js (footage). Matching is platform-agnostic:
// a curator that cross-posts the SAME handle to TikTok/X (e.g. @jktlogy) is excluded everywhere.

import fs from 'node:fs';
import path from 'node:path';

// Normalise a handle for fuzzy compare: drop @, lowercase, strip . _ - spaces. "jkt.logy" == "jktlogy".
const norm = (s) =>
  (s || '')
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[\s._\-]/g, '');

let _set = null;
// Set of normalised curated handles from ig_accounts.json (cached). Empty set if the file is missing.
function curatedHandles() {
  if (_set) return _set;
  _set = new Set();
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'ig_accounts.json'), 'utf8'),
    );
    const arr = Array.isArray(j) ? j : j.accounts || [];
    arr.forEach((h) => {
      const clean = String(h)
        .trim()
        .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
        .replace(/[/?#].*$/, '');
      const n = norm(clean);
      if (n) _set.add(n);
    });
  } catch (e) {}
  return _set;
}

function isCuratedAggregator(handle) {
  const n = norm(handle);
  return !!n && curatedHandles().has(n);
}

// The @username encoded in a post URL (TikTok/X/Threads handle, or IG /<user>/ path). '' if none —
// e.g. IG /p/<code> and /reel/<code> URLs carry no handle, and tiktokcdn mp4 URLs have none either.
function urlHandle(url) {
  const u = url || '';
  const m =
    u.match(/tiktok\.com\/@([\w.\-]+)/i) ||
    u.match(/threads\.(?:com|net)\/@([\w.\-]+)/i) ||
    u.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i) ||
    u.match(/instagram\.com\/([A-Za-z0-9_.]+)\//i);
  let h = m ? m[1] : '';
  if (/^(p|reel|reels|tv|share|video|status|home|explore|i)$/i.test(h)) h = ''; // path segment, not a handle
  return h;
}

// The source-resolving LLM answers in Indonesian and, when it cannot identify the poster, fills the
// account field with a PLACEHOLDER rather than leaving it out — "@akun" ("account") is the one seen
// in the wild. Accepted as a real handle it sends the by-handle search after an account that does
// not exist, and makes the credited tier of rankAcceptedMainCandidates rank against a fiction.
// A placeholder means "no account found", which is a different answer from "found this account".
const PLACEHOLDER_HANDLES = new Set([
  'akun',
  'akunnya',
  'namaakun',
  'pengguna',
  'penggunanya',
  'user',
  'username',
  'unknown',
  'tidakdiketahui',
  'na',
  'none',
  'null',
  'nil',
  'anonim',
  'anonymous',
  'contoh',
  'example',
]);

// Exact match only: a handle that merely CONTAINS a placeholder word ("akunpedia", "user_gaming99")
// is a perfectly real account.
function isPlaceholderHandle(handle) {
  // Strip punctuation beyond what norm() removes, so "nama_akun", "n/a" and "-" collapse onto the
  // same keys as their bare forms.
  const key = norm(handle).replace(/[^a-z0-9]/g, '');
  return !key || PLACEHOLDER_HANDLES.has(key);
}

export { curatedHandles, isCuratedAggregator, isPlaceholderHandle, urlHandle, norm as normHandle };
