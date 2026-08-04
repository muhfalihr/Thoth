// scrape_comments_fb.js — extract comments from a Facebook post (DOM/CDP).
//
// FB classes are hashed, but each comment is a div[role="article"] whose aria-label starts
// with "Comment by <name>" ("Komentar oleh <nama>" when the UI is Indonesian). We use that
// as the anchor: author from the aria-label, body = the longest dir="auto" text block in the
// row, avatar from its img. Like/reaction counts are unreliable in FB's DOM → left blank.
// Fragile by nature — retune the selectors in EXTRACT_JS if FB changes layout.
//
//   bun scrape_comments_fb.js <post_url> [out.json] [--max N]
//   (tab facebook.com harus login & ter-attach relay; pastikan komentar sudah tampil)

import { run } from '../lib/cdp.ts';
import { scrapeComments, parseArgs, pollCount } from '../lib/comment_engine.ts';

const COUNT_JS = `Array.from(document.querySelectorAll('div[role="article"]'))
  .filter(a => /^(Comment|Komentar)/i.test(a.getAttribute('aria-label') || '')).length`;

const EXTRACT_JS = `(() => {
  const arts = Array.from(document.querySelectorAll('div[role="article"]'))
    .filter(a => /^(Comment|Komentar)/i.test(a.getAttribute('aria-label') || ''));
  const out = [];
  arts.forEach((a, i) => {
    a.setAttribute('data-clip-idx', String(i));
    const lbl = a.getAttribute('aria-label') || '';
    const author = lbl.replace(/^(Comment by|Komentar oleh)\\s*/i, '').split(/\\s{2,}|\\s+\\d/)[0].trim();
    let text = '';
    Array.from(a.querySelectorAll('div[dir="auto"], span[dir="auto"]')).forEach(d => {
      const t = (d.innerText || '').trim();
      if (t && t !== author && t.length > text.length) text = t;
    });
    const img = a.querySelector('img');
    out.push({ idx: i, author, text, likes_raw: '', avatar_url: img ? (img.src || '') : '' });
  });
  return JSON.stringify(out);
})()`;

export { EXTRACT_JS, COUNT_JS };

if (import.meta.main) {
  const { url, out, max } = parseArgs(process.argv.slice(2));
  if (!url) {
    console.log('Usage: bun scrape_comments_fb.ts <post_url> [out.json] [--max N]');
    process.exit(1);
  }

  run(() =>
    scrapeComments({
      url,
      platform: 'facebook',
      label: 'Facebook',
      match: 'facebook.com',
      idToken: '',
      ensureLoaded: (client) => pollCount(client, COUNT_JS, 10, 1000),
      extractJs: EXTRACT_JS,
      // FB loads more comments via a "View more comments" button, not infinite scroll. Click it
      // when present (EN/ID), otherwise scroll.
      scrollJs: `(() => {
    const want = /(view\\s+\\d*\\s*more\\s+comment|view\\s+more\\s+comment|more comments|lihat\\s+.*komentar|komentar lainnya|komentar sebelumnya)/i;
    const btn = Array.from(document.querySelectorAll('[role="button"], span, div'))
      .find(b => want.test((b.innerText || '').trim()) && b.offsetParent !== null);
    if (btn) { btn.click(); return; }
    window.scrollBy(0, 1100);
  })()`,
      buildMain: (u) => ({
        url: u,
        platform: 'facebook',
        title: 'Facebook post',
        is_video: false,
        duration_sec: 0,
        profile: { name: '', handle: '', followers: '', avatar_url: '' },
      }),
      max: max || 12,
      out: out || 'thoth_content_set.json',
    }),
  );
}
