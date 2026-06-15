// tiktok_video.js — resolve a TikTok page URL to a DIRECT CDN mp4 URL that yt-dlp (CLIPPER) can
// download. yt-dlp's TikTok extractor is currently broken ("Unable to extract universal data for
// rehydration") and TikTok pages 403 — but a direct tiktokcdn .mp4 URL downloads fine via yt-dlp's
// generic extractor (verified with CLIPPER's exact --download-sections path).
//
// Strategy (user-chosen): tikwm.com API first (fast, no-login, no-watermark), fallback to CDP capture
// from the already-authenticated relay browser. Mirrors the threads_video.js pattern.
//
//   const { tiktokDirectUrl, downloadTiktok } = require('./tiktok_video');
//   await tiktokDirectUrl('https://www.tiktok.com/@u/video/123')  → { url, title, duration, via } | null
//   await downloadTiktok(pageUrl, 'output/tt_123.mp4')            → local path | ''

const fs = require('fs');

// --- tikwm.com: GET /api/?url=<tiktok> → { data:{ play, hdplay, wmplay, title, duration } } ---
async function viaTikwm(pageUrl) {
  try {
    const r = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(pageUrl) + '&hd=1', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || j.code !== 0 || !j.data) return null;
    let p = j.data.hdplay || j.data.play || j.data.wmplay;
    if (!p) return null;
    if (!/^https?:\/\//.test(p)) p = 'https://www.tikwm.com' + p; // tikwm sometimes returns a relative path
    return { url: p, title: (j.data.title || '').trim(), duration: j.data.duration || 0, via: 'tikwm' };
  } catch (e) { return null; }
}

// --- CDP fallback: open the page in the relay browser, read <video>.currentSrc. Only usable when the
// player exposes a direct http(s) source (not a blob:/MSE stream). Best-effort. ---
async function viaCdp(pageUrl) {
  let connect, sleep;
  try { ({ connect, sleep } = require('./cdp')); } catch (e) { return null; }
  let c;
  try { c = await connect({ match: ['tiktok.com'], requireMatch: true }); } catch (e) { return null; }
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    await c.navigate(pageUrl, 8000);
    await sleep(3500);
    const src = (await c.evaluate(`(() => {
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
  } catch (e) { return null; }
  finally { c.close(); }
}

// Resolve a TikTok page URL → direct CDN mp4 descriptor (tikwm first, CDP fallback). null on failure.
async function tiktokDirectUrl(pageUrl) {
  return (await viaTikwm(pageUrl)) || (await viaCdp(pageUrl)) || null;
}

// Download a TikTok video to `out` (resolves direct URL first). Returns the local path or ''.
async function downloadTiktok(pageUrl, out) {
  const d = await tiktokDirectUrl(pageUrl);
  if (!d) return '';
  try {
    const r = await fetch(d.url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tikwm.com/' } });
    if (!r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 10000) return ''; // too small → likely an error page, not a video
    fs.writeFileSync(out, buf);
    return out;
  } catch (e) { return ''; }
}

module.exports = { tiktokDirectUrl, downloadTiktok };
