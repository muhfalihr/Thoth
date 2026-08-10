// pipeline/ig_grid_scrape.ts — direct-DOM Instagram profile-grid scrape for pipeline code that needs
// a creator's REELS *and* feed POSTS together. The frozen acquisition/adapters/instagram.ts's
// discover(kind:'profile') only fetches reels (includePosts is not part of its contract), and pipeline
// files may not import scrapers/ig_profile.ts directly (Task 16 acquisition boundary). This duplicates
// just the grid-scan/caption logic those callers need, and only ever runs against a CdpClient handed
// in by AcquisitionService.browse() — never a raw lib/cdp.ts connect().
import type { CdpClient } from '../acquisition/types.ts';

export interface IgGridItem {
  url: string;
  type: 'p' | 'reel';
  owner: string;
  views: number;
  caption: string;
  isVideo: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseViews(s: string): number {
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

// og:description = '<n> likes, <n> comments - <user> on <date>: "CAPTION' — everything after `: "`.
function captionFromOg(og: string): string {
  const s = og || '';
  const i = s.indexOf(': "');
  return (i >= 0 ? s.slice(i + 3).replace(/"\s*$/, '') : s).trim();
}

// includePosts:true → scrape the MAIN profile grid (feed posts /p/ AND reels /reel/) instead of the
// /reels/ tab (which filters /p/ out). `client` must already be a live, navigable session (supplied
// by AcquisitionService.browse()); this function does its own internal navigations (grid scroll +
// per-item caption fetch) inside that one browse() visit.
export async function scrapeIgProfileGrid(
  client: CdpClient,
  username: string,
  opts: { max?: number; captions?: boolean; includePosts?: boolean } = {},
): Promise<IgGridItem[]> {
  const { max = 8, captions = true, includePosts = false } = opts;
  try {
    await client.cmd('Page.bringToFront');
  } catch (e) {}
  await client.navigate(
    'https://www.instagram.com/' + username + (includePosts ? '/' : '/reels/'),
    6000,
  );
  await sleep(3000);
  // IG virtualizes the grid (only ~6 thumbnails mounted at once, recycled on scroll) — union codes
  // across scroll steps until we have ~max or the grid stops growing.
  const collectExpr = `(() => {
    const HANDLE = ${JSON.stringify(username.toLowerCase())};
    const POSTS = ${includePosts ? 'true' : 'false'};
    const out = [];
    const sel = POSTS ? 'a[href*="/reel/"], a[href*="/p/"]' : 'a[href*="/reel/"]';
    Array.from(document.querySelectorAll(sel)).forEach(a => {
      const href = a.getAttribute('href') || '';
      const m = new URL(href, location.origin).pathname.match(/^\\/(?:([\\w.]+)\\/)?(p|reel)\\/([\\w-]+)/);
      if (!m) return;
      const owner = (m[1] || '').toLowerCase();
      if (!POSTS && owner && owner !== HANDLE) return;
      const type = m[2], code = m[3];
      if (!POSTS && type !== 'reel') return;
      out.push({ type, code, owner, v: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 20) });
    });
    return JSON.stringify(out);
  })()`;
  const want = Math.max(max, 12);
  const acc = new Map<string, { type: string; code: string; owner: string; v: string }>();
  let stale = 0;
  for (let i = 0; i < 10; i++) {
    let batch: any[] = [];
    try {
      batch = JSON.parse((await client.evaluate(collectExpr).catch(() => '[]')) || '[]');
    } catch (e) {}
    const before = acc.size;
    for (const it of batch) if (!acc.has(it.code)) acc.set(it.code, it);
    if (acc.size >= want) break;
    if (acc.size === before) {
      if (++stale >= 2) break;
    } else stale = 0;
    await client.evaluate('window.scrollBy(0, document.body.scrollHeight)').catch(() => {});
    await sleep(1500);
  }
  let items: IgGridItem[] = Array.from(acc.values()).map((it) => ({
    url:
      'https://www.instagram.com/' +
      (it.owner ? it.owner + '/' : '') +
      (it.type === 'p' ? 'p' : 'reel') +
      '/' +
      it.code +
      '/',
    type: it.type as 'p' | 'reel',
    owner: it.owner,
    views: parseViews(it.v),
    caption: '',
    isVideo: it.type === 'reel',
  }));
  // Reels-only mode: rank by views (find the viral one). includePosts mode: keep grid/recency order
  // (feed posts have no grid view count) — callers re-rank by topic similarity afterward.
  if (!includePosts) items.sort((a, b) => b.views - a.views);
  items = items.slice(0, max);
  if (captions) {
    for (const it of items) {
      try {
        await client.navigate(it.url, 5000);
        await sleep(1800);
        const meta = await client.evaluate(`(() => {
          const og = (document.querySelector('meta[property="og:description"]')||{}).content||'';
          const ogv = (document.querySelector('meta[property="og:video"]')||{}).content||'';
          return JSON.stringify({ og, isVideo: !!ogv || !!document.querySelector('video') });
        })()`);
        let mj: any = {};
        try {
          mj = JSON.parse(meta || '{}');
        } catch (e) {}
        it.caption = captionFromOg(mj.og).slice(0, 300);
        if (it.type === 'p') it.isVideo = !!mj.isVideo; // reels are always video; /p/ must be verified
      } catch (e) {
        it.caption = '';
      }
    }
  }
  return items;
}
