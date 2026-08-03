// scrape_comments_x.js — extract REPLY comments from an X/Twitter status, via the
// logged-in DOM (CDP). Reply tweets are stable: article[data-testid="tweet"] (the FIRST
// article is the main tweet → skipped), author from User-Name, body from tweetText, like
// count from the like button's aria-label, avatar from Tweet-User-Avatar.
//
//   bun scrape_comments_x.js <tweet_url> [out.json] [--max N]
//   (tab x.com / twitter.com harus login & ter-attach relay)

import { run } from '../lib/cdp.ts';
import { scrapeComments, parseArgs, pollCount } from '../lib/comment_engine.ts';

const COUNT_JS = 'document.querySelectorAll(\'article[data-testid="tweet"]\').length';

const EXTRACT_JS = `(() => {
  const arts = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  // Main tweet author → skip its SELF-REPLIES. News/brand accounts thread their own promos
  // (e.g. @mvppictures replying with its trailer, @kliksumut with another article) — those are
  // NOT audience comments and pollute the comment cards.
  let mainAuthor = '';
  { const mu = arts[0] && arts[0].querySelector('[data-testid="User-Name"]');
    if (mu) { const h = mu.innerText.split('\\n').find(s => s.trim().startsWith('@')); mainAuthor = (h || '').trim().replace(/^@/, '').toLowerCase(); } }
  const out = [];
  arts.slice(1).forEach((a, i) => {                       // slice(1): skip the main tweet
    a.setAttribute('data-clip-idx', String(i));
    let author = '';
    const un = a.querySelector('[data-testid="User-Name"]');
    if (un) { const h = un.innerText.split('\\n').find(s => s.trim().startsWith('@')); author = (h || '').trim().replace(/^@/, ''); }
    if (mainAuthor && author.toLowerCase() === mainAuthor) return;   // skip self-reply / self-promo
    const tx = a.querySelector('[data-testid="tweetText"]');
    const text = tx ? tx.innerText.trim() : '';
    let likes_raw = '';
    const like = a.querySelector('[data-testid="like"], [data-testid="unlike"]');
    if (like) { const m = (like.getAttribute('aria-label') || '').match(/([\\d.,]+)/); likes_raw = m ? m[1] : ''; }
    const av = a.querySelector('[data-testid="Tweet-User-Avatar"] img') || a.querySelector('img');
    let key = '';
    const tl = Array.from(a.querySelectorAll('a[href*="/status/"]')).map(x => x.getAttribute('href')).find(h => /\\/status\\/\\d+/.test(h));
    if (tl) { const m = tl.match(/status\\/(\\d+)/); key = m ? m[1] : ''; }
    out.push({ idx: i, key, author, text, likes_raw, avatar_url: av ? (av.currentSrc || av.src || '') : '' });
  });
  return JSON.stringify(out);
})()`;

export { EXTRACT_JS, COUNT_JS };

if (import.meta.main) {
  const { url, out, max } = parseArgs(process.argv.slice(2));
  if (!url) {
    console.log('Usage: bun scrape_comments_x.ts <tweet_url> [out.json] [--max N]');
    process.exit(1);
  }

  const id = (url.match(/status\/(\d+)/) || [, ''])[1];
  const user = (url.match(/(?:x|twitter)\.com\/([^/?#]+)/) || [, 'user'])[1];

  run(() =>
    scrapeComments({
      url,
      platform: 'twitter',
      label: 'X/Twitter',
      match: ['x.com', 'twitter.com'],
      idToken: id,
      ensureLoaded: (client) => pollCount(client, COUNT_JS, 8, 1000),
      extractJs: EXTRACT_JS,
      scrollJs: 'window.scrollBy(0, 1400)',
      buildMain: (u) => ({
        url: u,
        platform: 'twitter',
        title: `X @${user} #${id}`,
        is_video: false,
        duration_sec: 0,
        profile: { name: user, handle: user, followers: '', avatar_url: '' },
      }),
      max: max || 12,
      out: out || 'thoth_content_set.json',
    }),
  );
}
