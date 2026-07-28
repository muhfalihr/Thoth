// tiktok_video.js — resolve a TikTok page URL to a DIRECT CDN mp4 URL that yt-dlp (Thoth) can
// download. yt-dlp's TikTok extractor is currently broken ("Unable to extract universal data for
// rehydration") and TikTok pages 403 — but a direct tiktokcdn .mp4 URL downloads fine via yt-dlp's
// generic extractor (verified with Thoth's exact --download-sections path).
//
// Strategy (user-chosen): tikwm.com API first (fast, no-login, no-watermark), fallback to CDP capture
// from the already-authenticated relay browser. Mirrors the threads_video.js pattern.
//
//   import { tiktokDirectUrl, downloadTiktok } from './tiktok_video.ts';
//   await tiktokDirectUrl('https://www.tiktok.com/@u/video/123')  → { url, title, duration, via } | null
//   await downloadTiktok(pageUrl, 'output/tt_123.mp4')            → local path | ''

import fs from 'node:fs';

const DEFAULT_MEDIA_TIMEOUT_MS = 15_000;

type TikTokMediaDescriptor = {
  url: string;
  title: string;
  duration: number;
  via: string;
};

type TikTokVideoDeps = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  cdpResolver?: (pageUrl: string) => Promise<TikTokMediaDescriptor | null>;
};

export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// --- tikwm.com: GET /api/?url=<tiktok> → { data:{ play, hdplay, wmplay, title, duration } } ---
async function viaTikwm(
  pageUrl: string,
  deps: TikTokVideoDeps,
): Promise<TikTokMediaDescriptor | null> {
  try {
    const fetchImpl = deps.fetch ?? fetch;
    const j = await withDeadline(
      async (signal) => {
        const r = await fetchImpl(
          'https://www.tikwm.com/api/?url=' + encodeURIComponent(pageUrl) + '&hd=1',
          {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
            signal,
          },
        );
        if (!r.ok) return null;
        return await r.json();
      },
      deps.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS,
    );
    if (!j || j.code !== 0 || !j.data) return null;
    let p = j.data.hdplay || j.data.play || j.data.wmplay;
    if (!p) return null;
    if (!/^https?:\/\//.test(p)) p = 'https://www.tikwm.com' + p; // tikwm sometimes returns a relative path
    return {
      url: p,
      title: (j.data.title || '').trim(),
      duration: j.data.duration || 0,
      via: 'tikwm',
    };
  } catch (e) {
    return null;
  }
}

// --- CDP fallback: open the page in the relay browser, read <video>.currentSrc. Only usable when the
// player exposes a direct http(s) source (not a blob:/MSE stream). Best-effort. ---
async function viaCdp(
  pageUrl: string,
  deps: TikTokVideoDeps,
): Promise<TikTokMediaDescriptor | null> {
  if (deps.cdpResolver) return deps.cdpResolver(pageUrl);
  let connect, sleep;
  try {
    ({ connect, sleep } = await import('../lib/cdp.ts'));
  } catch (e) {
    return null;
  }
  let c;
  try {
    c = await connect({ match: ['tiktok.com'], requireMatch: true });
  } catch (e) {
    return null;
  }
  try {
    try {
      await c.cmd('Page.bringToFront');
    } catch (e) {}
    await c.navigate(pageUrl, 8000);
    await sleep(3500);
    const src =
      (await c.evaluate(`(() => {
      let best = '', n = 0;
      document.querySelectorAll('video').forEach(v => {
        const s = v.currentSrc || v.src || '';
        const a = (v.clientWidth || 0) * (v.clientHeight || 0);
        if (/^https?:/.test(s) && a >= n) { best = s; n = a; }
      });
      return best;
    })()`)) || '';
    if (!/^https?:\/\//.test(src)) return null; // blob:/MSE → not downloadable here
    return { url: src, title: '', duration: 0, via: 'cdp' };
  } catch (e) {
    return null;
  } finally {
    c.close();
  }
}

// Resolve a TikTok page URL → direct CDN mp4 descriptor (tikwm first, CDP fallback). null on failure.
export async function tiktokDirectUrl(
  pageUrl: string,
  deps: TikTokVideoDeps = {},
): Promise<TikTokMediaDescriptor | null> {
  return (await viaTikwm(pageUrl, deps)) || (await viaCdp(pageUrl, deps)) || null;
}

// Download a TikTok video to `out` (resolves direct URL first). Returns the local path or ''.
export async function downloadTiktok(
  pageUrl: string,
  out: string,
  deps: TikTokVideoDeps = {},
): Promise<string> {
  const d = await tiktokDirectUrl(pageUrl, deps);
  if (!d) return '';
  try {
    const fetchImpl = deps.fetch ?? fetch;
    const body = await withDeadline(
      async (signal) => {
        const r = await fetchImpl(d.url, {
          headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tikwm.com/' },
          signal,
        });
        if (!r.ok) return null;
        return await r.arrayBuffer();
      },
      deps.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS,
    );
    if (!body) return '';
    const buf = Buffer.from(body);
    if (buf.length < 10000) return ''; // too small → likely an error page, not a video
    fs.writeFileSync(out, buf);
    return out;
  } catch (e) {
    return '';
  }
}
