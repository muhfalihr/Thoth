// scrape_comments_yt.js — extract top-level comments from a YouTube watch page (DOM/CDP).
// Comments lazy-load below the player, so we scroll until ytd-comment-thread-renderer
// elements appear. Per thread: author #author-text, body #content-text, likes
// #vote-count-middle, avatar #author-thumbnail img. The crop targets the top comment
// (#comment) so replies are excluded.
//
//   node scrape_comments_yt.js <watch_url> [out.json] [--max N]
//   (komentar publik — login opsional; tab youtube.com ter-attach relay)

const { run, sleep } = require('./cdp');
const { scrapeComments, parseArgs } = require('./comment_engine');

const EXTRACT_JS = `(() => {
  // Watch pages wrap each comment in ytd-comment-thread-renderer; the Shorts panel may render
  // bare ytd-comment-view-model. Try threads first, fall back to view-models.
  let items = Array.from(document.querySelectorAll('ytd-comment-thread-renderer'));
  if (!items.length) items = Array.from(document.querySelectorAll('ytd-comment-view-model'));
  const out = [];
  items.forEach((th, i) => {
    const c = th.querySelector('#comment') || th;
    c.setAttribute('data-clip-idx', String(i));
    const a = th.querySelector('#author-text');
    const author = a ? a.innerText.trim().replace(/^@/, '') : '';
    const t = th.querySelector('#content-text');
    const text = t ? t.innerText.trim() : '';
    const v = th.querySelector('#vote-count-middle');
    const likes_raw = v ? v.innerText.trim() : '';
    const img = th.querySelector('#author-thumbnail img');
    out.push({ idx: i, author, text, likes_raw, avatar_url: img ? (img.src || '') : '' });
  });
  return JSON.stringify(out);
})()`;

const THREAD_COUNT = 'document.querySelectorAll("ytd-comment-thread-renderer, ytd-comment-view-model").length';

// Watch pages: comments mount once you scroll the page (relative scrollBy — absolute scrollTo
// fights YT's layout). Shorts: the page doesn't scroll; you must click the Comments button to
// open the side panel, then comments render there.
async function ensureLoaded(client) {
  const isShort = await client.evaluate("location.href.includes('/shorts/')");
  if (isShort) {
    await client.evaluate(`(() => {
      const b = document.querySelector('#comments-button button, ytd-reel-player-overlay-renderer button[aria-label*="omment"], button[aria-label*="omment"]');
      if (b) { b.click(); return true; } return false;
    })()`);
    for (let t = 0; t < 14; t++) {
      const n = await client.evaluate(THREAD_COUNT);
      if (n > 0) return n;
      await sleep(1000);
    }
    return 0;
  }
  for (let t = 0; t < 14; t++) {
    const n = await client.evaluate(THREAD_COUNT);
    if (n > 0) return n;
    await client.evaluate('window.scrollBy(0, 1000)');
    await sleep(1200);
  }
  return 0;
}

const { url, out, max } = parseArgs(process.argv.slice(2));
if (!url) { console.log('Usage: node scrape_comments_yt.js <watch_url> [out.json] [--max N]'); process.exit(1); }

const id = (url.match(/[?&]v=([\w-]+)/) || url.match(/youtu\.be\/([\w-]+)/) || url.match(/shorts\/([\w-]+)/) || [, ''])[1];

run(() => scrapeComments({
  url, platform: 'youtube', label: 'YouTube',
  match: 'youtube.com', idToken: id,
  ensureLoaded,
  extractJs: EXTRACT_JS,
  scrollJs: 'window.scrollBy(0, 1600)',
  buildMain: u => ({ url: u, platform: 'youtube', title: `YouTube ${id}`, is_video: true, duration_sec: 0,
    profile: { name: '', handle: '', followers: '', avatar_url: '' } }),
  max: max || 12, out: out || 'clipper_content_set.json',
}));
