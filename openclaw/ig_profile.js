// ig_profile.js — scrape a creator's reels (URL + view count, optionally caption) from their profile.
// Shared by trace_source (pick the SPECIFIC source reel) and build_footage (pull relevant footage from
// the same creator). The reels grid exposes view counts but NO caption, so caption needs opening each
// reel (og:description). Sorted by views desc — the reposted-viral video is usually the top-views one.
//
//   const { igProfileReels } = require('./ig_profile');
//   await igProfileReels('bejomuhajir', { max: 8, captions: true }) → [{url, views, caption}]

const { connect, sleep } = require('./cdp');

function parseViews(s) {
  s = (s || '').trim().replace(/,/g, '');
  const m = s.match(/([\d.]+)\s*([KMB]?)/i);
  if (!m) return 0;
  let n = parseFloat(m[1]) || 0;
  const u = (m[2] || '').toUpperCase();
  if (u === 'K') n *= 1e3; else if (u === 'M') n *= 1e6; else if (u === 'B') n *= 1e9;
  return Math.round(n);
}

async function igProfileReels(username, { max = 8, captions = true, client } = {}) {
  let c = client, own = false;
  if (!c) { c = await connect({ match: 'instagram.com', requireMatch: true }); own = true; }
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    await c.navigate('https://www.instagram.com/' + username + '/reels/', 6000);
    await sleep(3000);
    const raw = await c.evaluate(`(() => {
      const HANDLE = ${JSON.stringify(username)}.toLowerCase();
      const seen = new Set(); const out = [];
      Array.from(document.querySelectorAll('a[href*="/reel/"]')).forEach(a => {
        const href = a.getAttribute('href') || '';
        const m = new URL(href, location.origin).pathname.match(/^\\/(?:([\\w.]+)\\/)?reel\\/([\\w-]+)/);
        if (!m) return;
        const owner = (m[1] || '').toLowerCase();          // '' = bare /reel/<code> (own grid)
        if (owner && owner !== HANDLE) return;              // drop IG "Suggested"/other-account leaks
        const code = m[2];
        if (seen.has(code)) return; seen.add(code);
        out.push({ code, v: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 20) });
      });
      return JSON.stringify(out.slice(0, 24));
    })()`);
    let items = []; try { items = JSON.parse(raw || '[]'); } catch (e) {}
    items = items
      .map(it => ({ url: 'https://www.instagram.com/reel/' + it.code, views: parseViews(it.v), caption: '' }))
      .sort((a, b) => b.views - a.views)
      .slice(0, max);
    if (captions) {
      for (const it of items) {
        try {
          await c.navigate(it.url, 5000); await sleep(1800);
          const og = (await c.evaluate(`(document.querySelector('meta[property="og:description"]')||{}).content||''`)) || '';
          const i = og.indexOf(': "'); // '<user> on <date>: "CAPTION'
          it.caption = (i >= 0 ? og.slice(i + 3).replace(/"\s*$/, '') : og).trim().slice(0, 300);
        } catch (e) { it.caption = ''; }
      }
    }
    return items;
  } finally { if (own) c.close(); }
}

module.exports = { igProfileReels, parseViews };
