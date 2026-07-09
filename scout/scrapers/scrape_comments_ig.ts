// scrape_comments_ig.js — extract comments from an Instagram post/reel (DOM/CDP).
//
// IG has NO stable test ids (classes are hashed), so this uses a structural heuristic:
// every comment row carries a "Reply" button and a username link (href "/<user>/") plus an
// avatar img. We climb from each Reply button to the smallest ancestor that holds the
// username link + an img, tag it, and read author/text/likes from there. Fragile by nature
// — if IG changes layout this is the file to retune (selectors are all in EXTRACT_JS).
//
//   bun scrape_comments_ig.js <post_or_reel_url> [out.json] [--max N]
//   (tab instagram.com harus login & ter-attach relay)

import { run } from '../lib/cdp.ts';
import { scrapeComments, parseArgs, pollCount, sleep } from '../lib/comment_engine.ts';

// Reels open in the FULLSCREEN viewer (/reels/<code>) with comments HIDDEN — you must click the
// "Comment"/"Komentar" icon to open the panel/dialog. (Regular /p/ posts show comments inline.)
const OPEN_COMMENTS_JS = `(() => {
  const svg = Array.from(document.querySelectorAll('svg[aria-label]'))
    .find(s => /^(comment|komentar)$/i.test((s.getAttribute('aria-label') || '').trim()));
  if (!svg) return false;
  let el = svg;
  for (let k = 0; k < 6 && el; k++) {
    if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') { el.click(); return true; }
    el = el.parentElement;
  }
  (svg.closest('div') || svg).click();
  return true;
})()`;

// Scroll the open comment dialog's list (reel) or the article (inline post) to lazy-load more.
const SCROLL_JS = `(() => {
  const dlg = document.querySelector('[role="dialog"]');
  const d = (dlg && dlg.querySelector('ul')) || dlg || document.querySelector('article') || document.scrollingElement;
  if (d && d.scrollBy) d.scrollBy(0, 800); else window.scrollBy(0, 800);
})()`;

// Count "Reply"/"Balas" buttons ≈ number of loaded comments.
const COUNT_JS = `Array.from(document.querySelectorAll('[role="button"], button'))
  .filter(b => /^(Reply|Balas)$/i.test((b.innerText || '').trim())).length`;

const EXTRACT_JS = `(() => {
  const isUser = h => /^\\/[A-Za-z0-9._]+\\/$/.test(h || '');
  const out = [];
  const seen = new Set();
  Array.from(document.querySelectorAll('[role="button"], button'))
    .filter(b => /^(Reply|Balas)$/i.test((b.innerText || '').trim()))
    .forEach(btn => {
      let w = btn, row = null, link = null;
      for (let k = 0; k < 8 && w.parentElement; k++) {
        w = w.parentElement;
        const a = Array.from(w.querySelectorAll('a[href]')).find(x => isUser(x.getAttribute('href')));
        if (a && w.querySelector('img')) { row = w; link = a; break; }
      }
      if (!row || seen.has(row)) return;
      seen.add(row);
      const idx = out.length;
      row.setAttribute('data-clip-idx', String(idx));
      const author = (link.getAttribute('href') || '').replace(/\\//g, '');
      let text = '';
      Array.from(row.querySelectorAll('span')).forEach(s => {
        const t = (s.innerText || '').trim();
        if (!t || t === author) return;
        if (/^\\d+\\s*(likes?|reply|replies|w|d|h|m|s)$/i.test(t)) return; // skip meta/time
        if (t.length > text.length) text = t;
      });
      let likes_raw = '';
      const lk = Array.from(row.querySelectorAll('span,button,a')).map(e => (e.innerText || '').trim())
        .find(t => /^[\\d.,]+\\s*likes?$/i.test(t));
      if (lk) { const m = lk.match(/([\\d.,]+)/); likes_raw = m ? m[1] : ''; }
      const img = row.querySelector('img');
      out.push({ idx, author, text, likes_raw, avatar_url: img ? (img.src || '') : '' });
    });
  return JSON.stringify(out);
})()`;

const { url, out, max } = parseArgs(process.argv.slice(2));
if (!url) { console.log('Usage: bun scrape_comments_ig.ts <post_or_reel_url> [out.json] [--max N]'); process.exit(1); }

const code = (url.match(/\/(?:p|reel|tv)\/([\w-]+)/) || [, ''])[1];

run(() => scrapeComments({
  url, platform: 'instagram', label: 'Instagram',
  match: 'instagram.com', idToken: code,
  ensureLoaded: async client => {
    let n = await pollCount(client, COUNT_JS, 2, 800);
    if (!n) { await client.evaluate(OPEN_COMMENTS_JS); await sleep(1600); n = await pollCount(client, COUNT_JS, 10, 1000); }
    return n;
  },
  extractJs: EXTRACT_JS,
  scrollJs: SCROLL_JS,
  buildMain: u => ({ url: u, platform: 'instagram', title: `Instagram ${code}`, is_video: false, duration_sec: 0,
    profile: { name: '', handle: '', followers: '', avatar_url: '' } }),
  max: max || 12, out: out || 'thoth_content_set.json',
}));
