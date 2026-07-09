// x_profile.js — ambil tweet TERBARU milik sebuah handle dari timeline x.com/<handle> via CDP
// (butuh tab x.com login). Selector tweet sama dgn scrape_comments_x.js (terbukti stabil):
// article[data-testid="tweet"] + [data-testid="tweetText"] + anchor <time> = permalink+datetime.
// Retweet/quote orang lain terfilter: permalink harus /<handle>/status/. Pinned tweet ikut
// (timeline menaruhnya pertama) — pemanggil yang menyaring by time/cutoff.
//
//   import { xProfileTweets } from './x_profile.ts';
//   await xProfileTweets('jktinfo', { max: 8 })
//   → [{ url, text, time (ISO), hasVideo, hasPhoto }]
//
// Topik tweet = TEKSNYA LANGSUNG (tak perlu vision/audio) — platform termudah setelah scraper ada.

import { connect, sleep } from '../lib/cdp.ts';

async function xProfileTweets(handle, { max = 8, client = null } = {}) {
  const h = String(handle).trim().replace(/^@/, '');
  let c = client,
    own = false;
  if (!c) {
    c = await connect({ match: ['x.com', 'twitter.com'], requireMatch: true });
    own = true;
  }
  const byId = new Map();
  try {
    await c.navigate(`https://x.com/${h}`, 6000);
    await sleep(3500);
    // Timeline virtualized → beberapa langkah scroll, UNION hasil tiap snapshot (pola ig_profile).
    for (let step = 0; step < 4 && byId.size < max; step++) {
      if (step) {
        try {
          await c.evaluate('window.scrollBy(0, 1500)');
        } catch (e) {}
        await sleep(1800);
      }
      const raw = await c.evaluate(`(() => {
        const H = ${JSON.stringify(h)}.toLowerCase();
        const out = [];
        document.querySelectorAll('article[data-testid="tweet"]').forEach(a => {
          const t = a.querySelector('time'); if (!t) return;
          const link = t.closest('a[href*="/status/"]');
          const href = link && link.getAttribute('href'); if (!href) return;
          const m = href.match(/^\\/([\\w_]+)\\/status\\/(\\d+)/); if (!m) return;
          if (m[1].toLowerCase() !== H) return;               // retweet/quote akun lain → drop
          const tx = a.querySelector('[data-testid="tweetText"]');
          out.push({
            id: m[2],
            url: 'https://x.com' + m[0],
            text: tx ? (tx.innerText || '').trim() : '',
            time: t.getAttribute('datetime') || '',
            hasVideo: !!a.querySelector('video, [data-testid="videoPlayer"]'),
            hasPhoto: !!a.querySelector('[data-testid="tweetPhoto"]'),
          });
        });
        return JSON.stringify(out);
      })()`);
      let list = [];
      try {
        list = JSON.parse(raw || '[]');
      } catch (e) {}
      for (const tw of list) if (!byId.has(tw.id)) byId.set(tw.id, tw);
    }
  } finally {
    if (own) {
      try {
        c.close();
      } catch (e) {}
    }
  }
  return [...byId.values()].slice(0, max);
}

export { xProfileTweets };
