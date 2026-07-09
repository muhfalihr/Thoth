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

export { curatedHandles, isCuratedAggregator, urlHandle, norm as normHandle };
