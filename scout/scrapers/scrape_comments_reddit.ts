// scrape_comments_reddit.js — extract top-level comments from a Reddit post (new Reddit /
// shreddit, DOM/CDP). The <shreddit-comment> web component exposes author + score as
// attributes and slots its body in [slot="comment"]; depth="0" = a top-level comment.
// Nested replies are hidden before measuring so each crop is just that one comment.
//
//   node scrape_comments_reddit.js <post_url> [out.json] [--max N]
//   (komentar publik — login opsional; tab reddit.com ter-attach relay)

import { run } from '../lib/cdp.ts';
import { scrapeComments, parseArgs, pollCount } from '../lib/comment_engine.ts';

const COUNT_JS = 'document.querySelectorAll(\'shreddit-comment[depth="0"]\').length';

const EXTRACT_JS = `(() => {
  const tops = Array.from(document.querySelectorAll('shreddit-comment'))
    .filter(c => (c.getAttribute('depth') || '0') === '0');
  const out = [];
  tops.forEach((c, i) => {
    c.querySelectorAll('shreddit-comment').forEach(n => { n.style.display = 'none'; }); // hide nested replies
    c.setAttribute('data-clip-idx', String(i));
    const author = c.getAttribute('author') || '';
    const likes_raw = c.getAttribute('score') || '';
    const body = c.querySelector('[slot="comment"]');
    const text = body ? body.innerText.trim() : '';
    out.push({ idx: i, author, text, likes_raw, avatar_url: '' });
  });
  return JSON.stringify(out);
})()`;

const { url, out, max } = parseArgs(process.argv.slice(2));
if (!url) { console.log('Usage: node scrape_comments_reddit.ts <post_url> [out.json] [--max N]'); process.exit(1); }

const id = (url.match(/comments\/(\w+)/) || [, ''])[1];

run(() => scrapeComments({
  url, platform: 'reddit', label: 'Reddit',
  match: 'reddit.com', idToken: id,
  ensureLoaded: client => pollCount(client, COUNT_JS, 10, 1000),
  extractJs: EXTRACT_JS,
  scrollJs: 'window.scrollBy(0, 1400)',
  buildMain: u => ({ url: u, platform: 'reddit', title: `Reddit ${id}`, is_video: false, duration_sec: 0,
    profile: { name: '', handle: '', followers: '', avatar_url: '' } }),
  max: max || 12, out: out || 'thoth_content_set.json',
}));
