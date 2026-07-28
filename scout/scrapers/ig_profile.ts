// ig_profile.js — scrape a creator's reels (URL + view count, optionally caption) from their profile.
// Shared by trace_source (pick the SPECIFIC source reel) and build_footage (pull relevant footage from
// the same creator). The reels grid exposes view counts but NO caption, so caption needs opening each
// reel (og:description). Sorted by views desc — the reposted-viral video is usually the top-views one.
//
//   import { igProfileReels } from './ig_profile.ts';
//   await igProfileReels('bejomuhajir', { max: 8, captions: true }) → [{url, views, caption}]

import { connect, sleep } from '../lib/cdp.ts';

// og:description = '<n> likes, <n> comments - <user> on <date>: "CAPTION' — often truncated, so the
// closing quote may be missing. Everything after `: "` is the caption.
function igCaptionFromOg(og: string) {
  const s = og || '';
  const i = s.indexOf(': "');
  return (i >= 0 ? s.slice(i + 3).replace(/"\s*$/, '') : s).trim();
}

// One IG post page carries BOTH the caption (og:description) and the cover frame (og:image), and
// only a logged-in tab renders them — oEmbed doesn't cover IG. One CDP read serves every caller;
// cached per-url so caption + cover don't navigate the same post twice.
// ponytail: 1-entry cache, callers handle one post at a time.
let _igOg = { url: '', text: '', image: '' };
async function igPostOg(url: string) {
  if (_igOg.url === url) return _igOg;
  const res = { url, text: '', image: '' };
  let c;
  try {
    c = await connect({ match: 'instagram.com', requireMatch: true });
  } catch (e) {
    return res; // CDP browser down / no instagram tab — not cached, a later call may find one
  }
  try {
    try {
      await c.cmd('Page.bringToFront');
    } catch (e) {}
    await c.navigate(url, 6000);
    await sleep(3000);
    const meta = await c.evaluate(`(() => {
      const g = (p) => (document.querySelector('meta[property="' + p + '"]')||{}).content || '';
      return JSON.stringify({ og: g('og:description'), image: g('og:image') });
    })()`);
    const mj = JSON.parse(meta || '{}');
    res.text = igCaptionFromOg(mj.og);
    res.image = mj.image || '';
  } catch (e) {
  } finally {
    try {
      c.close();
    } catch (e) {}
  }
  _igOg = res;
  return res;
}

function parseViews(s) {
  s = (s || '').trim().replace(/,/g, '');
  const m = s.match(/([\d.]+)\s*([KMB]?)/i);
  if (!m) return 0;
  let n = parseFloat(m[1]) || 0;
  const u = (m[2] || '').toUpperCase();
  if (u === 'K') n *= 1e3;
  else if (u === 'M') n *= 1e6;
  else if (u === 'B') n *= 1e9;
  return Math.round(n);
}

// includePosts:true → scrape the MAIN profile grid (shows BOTH feed posts /p/ AND reels /reel/) instead
// of the /reels/ tab (which filters /p/ out). Needed when the creator published the source as a feed
// VIDEO post, not a Reel — those live only at /p/<code> and never appear under /reels/. Each item carries
// `isVideo` (reels are always video; /p/ verified via og:video / <video> when captions:true).
async function igProfileReels(
  username: string,
  {
    max = 8,
    captions = true,
    client,
    includePosts = false,
  }: { max?: number; captions?: boolean; client?: any; includePosts?: boolean } = {},
) {
  let c = client,
    own = false;
  if (!c) {
    c = await connect({ match: 'instagram.com', requireMatch: true });
    own = true;
  }
  try {
    try {
      await c.cmd('Page.bringToFront');
    } catch (e) {}
    await c.navigate(
      'https://www.instagram.com/' + username + (includePosts ? '/' : '/reels/'),
      6000,
    );
    await sleep(3000);
    // IG VIRTUALIZES the profile grid: only ~6 thumbnail <a> nodes are mounted in the DOM at any instant
    // and get RECYCLED as you scroll, so a single querySelectorAll snapshot sees only whichever ~6 are on
    // screen (e.g. it caught DVn,DTr,DaHd,DaFj,DaC6,DaCS but DROPPED the interleaved DaFm/DaDS/... — the
    // relevant follow-up VIDEO). Fix: UNION codes across each scroll step until we have ~`max` or the grid
    // stops growing. (scrollBy is harmless on short profiles where it's a no-op; the per-step re-snapshot
    // is what matters — virtualization re-mounts a different slice each tick.)
    const collectExpr = `(() => {
      const HANDLE = ${JSON.stringify(username)}.toLowerCase();
      const POSTS = ${includePosts ? 'true' : 'false'};
      const out = [];
      const sel = POSTS ? 'a[href*="/reel/"], a[href*="/p/"]' : 'a[href*="/reel/"]';
      Array.from(document.querySelectorAll(sel)).forEach(a => {
        const href = a.getAttribute('href') || '';
        const m = new URL(href, location.origin).pathname.match(/^\\/(?:([\\w.]+)\\/)?(p|reel)\\/([\\w-]+)/);
        if (!m) return;
        const owner = (m[1] || '').toLowerCase();          // '' = bare /<type>/<code>; else the post owner
        // Reels-only (trace_source): strict — want the CREATOR's own reel, drop other-account leaks.
        // Posts mode (build_footage): KEEP cross-owner posts — collab/tagged posts (e.g. a co-post with
        // @malakaproject.id or @anugrahlindu) appear on the creator's grid under the OTHER owner's handle
        // and are usually the most on-topic footage. build_footage's similarity gate drops true off-topic
        // leaks (e.g. a /juventus/ injection), so admitting them here is safe.
        if (!POSTS && owner && owner !== HANDLE) return;
        const type = m[2], code = m[3];
        if (!POSTS && type !== 'reel') return;
        out.push({ type, code, owner, v: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 20) });
      });
      return JSON.stringify(out);
    })()`;
    const want = Math.max(max, 12);
    const acc = new Map(); // code -> {type, code, v} (union across scrolls)
    let stale = 0;
    for (let i = 0; i < 10; i++) {
      let batch = [];
      try {
        batch = JSON.parse((await c.evaluate(collectExpr).catch(() => '[]')) || '[]');
      } catch (e) {}
      const before = acc.size;
      for (const it of batch) if (!acc.has(it.code)) acc.set(it.code, it);
      if (acc.size >= want) break;
      if (acc.size === before) {
        if (++stale >= 2) break;
      } else stale = 0; // grid exhausted (no new in 2 ticks)
      await c.evaluate('window.scrollBy(0, document.body.scrollHeight)').catch(() => {});
      await sleep(1500);
    }
    let items = Array.from(acc.values())
      // Preserve the real owner in the URL (collab/tagged posts are owned by another account) so
      // downstream aggregator exclusion can see it; bare /p|reel/<code>/ when owner is unknown.
      .map((it) => ({
        url:
          'https://www.instagram.com/' +
          (it.owner ? it.owner + '/' : '') +
          (it.type === 'p' ? 'p' : 'reel') +
          '/' +
          it.code +
          '/',
        type: it.type,
        views: parseViews(it.v),
        caption: '',
        isVideo: it.type === 'reel',
      }));
    // Reels-only mode (trace_source): rank by views to find the viral one. includePosts mode
    // (build_footage): KEEP grid/recency order — /p/ feed posts have no grid view count (views=0),
    // so view-sort would bury every /p/ post below the reels and slice() could cut the relevant ones.
    // build_footage re-ranks these by topic similarity afterward, so recency order is the right cap here.
    if (!includePosts) items.sort((a, b) => b.views - a.views);
    items = items.slice(0, max);
    if (captions) {
      for (const it of items) {
        try {
          await c.navigate(it.url, 5000);
          await sleep(1800);
          const meta = await c.evaluate(`(() => {
            const og = (document.querySelector('meta[property="og:description"]')||{}).content||'';
            const ogv = (document.querySelector('meta[property="og:video"]')||{}).content||'';
            return JSON.stringify({ og, isVideo: !!ogv || !!document.querySelector('video') });
          })()`);
          let mj: any = {};
          try {
            mj = JSON.parse(meta || '{}');
          } catch (e) {}
          it.caption = igCaptionFromOg(mj.og).slice(0, 300);
          if (it.type === 'p') it.isVideo = !!mj.isVideo; // reels are always video; /p/ must be verified
        } catch (e) {
          it.caption = '';
        }
      }
    }
    return items;
  } finally {
    if (own) c.close();
  }
}

export { igProfileReels, parseViews, igPostOg, igCaptionFromOg };
