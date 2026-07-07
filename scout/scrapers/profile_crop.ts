// profile_crop.js — screenshot a creator's PROFILE-CARD header (avatar + name + @handle + follower
// count) per platform, so Thoth pastes the REAL platform card instead of its synthetic drawn one.
// Generalises tiktok_profile.cropTiktokProfile to every platform via one dispatcher:
//
//   import { cropProfile } from './profile_crop.ts';
//   await cropProfile('instagram', 'andiabdllh', outPng);        // by handle
//   await cropProfile('instagram', '', outPng, { url: reelUrl }); // resolve handle from a reel URL
//
// Returns the PNG path on success, '' on failure (caller leaves the synthetic card). Needs the
// platform's tab logged-in & attached to the CDP relay. Per-platform DOM selectors are the fragile
// part (same caveat as crop_post.js) — retune if a platform changes layout.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { connect, sleep } from '../lib/cdp.ts';
import { ui } from '../lib/ui.ts';

const YTDLP = process.env.YTDLP || 'yt-dlp';

const MATCH = {
  instagram: 'instagram.com',
  twitter: ['x.com', 'twitter.com'],
  facebook: 'facebook.com',
  youtube: 'youtube.com',
  tiktok: 'tiktok.com',
};

// Screenshot a viewport rect → PNG. Rejects implausibly small rects.
// `beyondViewport`: render to a fresh off-screen surface (captureBeyondViewport) — forces a repaint
// that rasterizes images an OCCLUDED tab otherwise leaves blank (X avatar bg-image). Clip is then in
// PAGE coords, so add the current scroll offset.
async function captureRect(c, rect, outPng, { pad = 12, beyondViewport = false } = {}) {
  if (!rect || rect.w < 80 || rect.h < 40) return '';
  let ox = 0, oy = 0;
  if (beyondViewport) {
    try { ox = (await c.evaluate('window.scrollX')) || 0; oy = (await c.evaluate('window.scrollY')) || 0; } catch (e) {}
  }
  // page-coords rect (viewport + scroll) → device-pixel clip handled by captureClip (dpr-correct).
  const data = await c.captureClip(
    { x: rect.x + ox, y: rect.y + oy, w: rect.w, h: rect.h }, pad,
    { beyondViewport });
  if (!data) return '';
  fs.writeFileSync(outPng, Buffer.from(data, 'base64'));
  return outPng;
}

// Resolve the @handle that posted an IG reel/post from its URL via yt-dlp's `%(channel)s` (the
// uploader handle). Reliable + works for public reels WITHOUT cookies — unlike scraping the
// logged-in /reels/ feed DOM, which only exposes the VIEWER's own profile link (would crop the wrong
// person). Returns '' on failure → caller keeps the synthetic card (never a wrong profile).
function igResolveHandle(url) {
  if (!url) return '';
  try {
    const out = execFileSync(YTDLP, ['--skip-download', '--no-warnings', '--print', '%(channel)s', '--', url],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 40000 }).toString().trim().split(/\r?\n/)[0].trim();
    const h = out.replace(/^@/, '');
    return /^[A-Za-z0-9._]{2,40}$/.test(h) ? h : '';
  } catch (e) { return ''; }
}

// Instagram: crop the profile <header> (avatar + username + name + stats + bio).
async function cropInstagram(c, user, outPng) {
  await c.navigate('https://www.instagram.com/' + user + '/', 7000);
  await sleep(2500);
  for (let i = 0; i < 8; i++) { if (await c.evaluate(`!!document.querySelector('main header, header')`)) break; await sleep(800); }
  try { await c.evaluate('window.scrollTo(0,0)'); } catch (e) {}
  await sleep(300);
  const rectJson = await c.evaluate(`(() => {
    const h = document.querySelector('main header') || document.querySelector('header');
    if (!h) return '';
    const r = h.getBoundingClientRect();
    if (r.width < 80 || r.height < 40) return '';
    // Cap the bottom to exclude the story-highlights row (round circles) that sits under the bio:
    // crop down to just below the Follow/Message action buttons when present.
    let bottom = r.bottom;
    const btns = Array.from(h.querySelectorAll('button, [role=button], a[role=button]'))
      .filter(b => /\\b(follow|following|message|mengikuti|ikuti|pesan|kirim pesan)\\b/i.test((b.innerText || '').trim()));
    if (btns.length) {
      const bb = Math.max.apply(null, btns.map(b => b.getBoundingClientRect().bottom));
      if (bb > r.top + 60) bottom = Math.min(bottom, bb + 14);
    }
    return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: bottom - r.top });
  })()`);
  let rect; try { rect = JSON.parse(rectJson || 'null'); } catch (e) {}
  if (!rect) { console.log('    [instagram] crop profil: header tak terbaca.'); return ''; }
  return captureRect(c, rect, outPng);
}

const FFMPEG = process.env.THOTH_FFMPEG || 'C:\\Users\\mfr\\Documents\\MyTools\\CLIPPER\\ffmpeg.exe';

// Download an avatar via the unavatar.io proxy (platform-agnostic, no auth, tab-independent) — works
// from Node where X's page CSP (which blocks an injected external <img>) doesn't apply. Returns path|''.
async function downloadAvatar(provider, handle, outPng) {
  const slugs = provider === 'twitter' ? ['twitter', 'x'] : [provider];
  for (const slug of slugs) {
    const u = `https://unavatar.io/${slug}/${encodeURIComponent(handle)}?fallback=false`;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
        if (r.ok && /image\//.test(r.headers.get('content-type') || '')) {
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 500) { fs.writeFileSync(outPng, buf); return outPng; }
        }
      } catch (e) {}
      await sleep(700);
    }
  }
  return '';
}

// Composite `avatar` as a CIRCLE of diameter `d` at (ax,ay) onto `base` via ffmpeg → outPng.
function overlayCircleAvatar(base, avatar, ax, ay, d, outPng) {
  const c2 = (d / 2).toFixed(1);
  const fc = `[1:v]scale=${d}:${d},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':`
    + `a='if(lte(hypot(X-${c2},Y-${c2}),${c2}),255,0)'[av];`
    + `[0:v][av]overlay=${Math.round(ax)}:${Math.round(ay)}`;
  try {
    execFileSync(FFMPEG, ['-y', '-i', base, '-i', avatar, '-filter_complex', fc, '-frames:v', '1', outPng],
      { stdio: 'pipe', timeout: 30000 });
    return fs.existsSync(outPng) ? outPng : '';
  } catch (e) { return ''; }
}

// X / Twitter: crop the profile header (name + @handle + bio + join + follow stats) scoped to
// primaryColumn, then composite the avatar (unavatar.io, downloaded in Node) as a circle over the
// placeholder. X renders the native avatar as a CSS bg-image that Chromium won't paint in an occluded
// tab, AND page CSP blocks injecting an external <img> — so compositing in Node is the reliable path.
async function cropTwitter(c, user, outPng) {
  await c.navigate('https://x.com/' + user, 7000);
  await sleep(2800);
  for (let i = 0; i < 10; i++) { if (await c.evaluate(`!!document.querySelector('[data-testid="primaryColumn"] [role="tablist"]')`)) break; await sleep(700); }
  // Wait for the LARGE header avatar (≈142px) to render — tweet avatars (≈40px) appear first and would
  // give a tiny, mis-placed overlay.
  for (let i = 0; i < 12; i++) {
    const mw = await c.evaluate(`(() => { const col = document.querySelector('[data-testid="primaryColumn"]'); if (!col) return 0; let mw = 0; col.querySelectorAll('[data-testid^="UserAvatar-Container"]').forEach(a => { const w = a.getBoundingClientRect().width; if (w > mw) mw = w; }); return mw; })()`);
    if (mw > 100) break;
    await sleep(600);
  }
  try { await c.evaluate('window.scrollTo(0,0)'); } catch (e) {}
  await sleep(300);
  const data = await c.evaluate(`(() => {
    const col = document.querySelector('[data-testid="primaryColumn"]'); if (!col) return '';
    const name = col.querySelector('[data-testid="UserName"]');
    const tablist = col.querySelector('[role="tablist"]');
    let av = null, area = 0;
    col.querySelectorAll('[data-testid^="UserAvatar-Container"]').forEach(a => { const r = a.getBoundingClientRect(); const A = r.width * r.height; if (A > area && r.width > 40) { area = A; av = a; } });
    if (!name || !tablist || !av) return '';
    const cr = col.getBoundingClientRect(), ar = av.getBoundingClientRect();
    const top = ar.top, bottom = tablist.getBoundingClientRect().top;
    if (bottom - top < 60) return '';
    return JSON.stringify({ cropX: cr.left, cropY: top, cropW: cr.width, cropH: bottom - top, avX: ar.left, avY: ar.top, avW: ar.width, avH: ar.height });
  })()`);
  let m; try { m = JSON.parse(data || 'null'); } catch (e) {}
  if (!m) { console.log('    [twitter] crop profil: header tak terbaca.'); return ''; }

  const pad = 12;
  const base = await captureRect(c, { x: m.cropX, y: m.cropY, w: m.cropW, h: m.cropH }, outPng, { pad });
  if (!base) return '';

  const dpr = (await c.evaluate('window.devicePixelRatio')) || 1;
  const avFile = await downloadAvatar('twitter', user, outPng + '.av.png');
  if (avFile) {
    const ox = Math.max(0, m.cropX - pad), oy = Math.max(0, m.cropY - pad);
    const ax = (m.avX - ox) * dpr, ay = (m.avY - oy) * dpr, d = Math.round(Math.min(m.avW, m.avH) * dpr);
    console.log(`    [twitter] dbg dpr=${dpr} col.left=${Math.round(m.cropX)} av=(${Math.round(m.avX)},${Math.round(m.avY)},${Math.round(m.avW)}) → ax=${Math.round(ax)} ay=${Math.round(ay)} d=${d}`);
    const composed = overlayCircleAvatar(base, avFile, ax, ay, d, outPng + '.tmp.png');
    try { fs.unlinkSync(avFile); } catch (e) {}
    if (composed) { try { fs.renameSync(composed, outPng); } catch (e) {} }
    else console.log('    [twitter] overlay avatar gagal → kartu tanpa foto.');
  } else {
    console.log('    [twitter] avatar (unavatar.io) tak didapat → kartu tanpa foto.');
  }
  return outPng;
}

// Dispatcher. TikTok delegates to the existing dedicated cropper.
async function cropProfile(platform: string, username: string, outPng: string, { client, url }: { client?: any; url?: string } = {}) {
  platform = (platform || '').toLowerCase();
  if (!MATCH[platform] || !outPng) return '';
  if (platform === 'tiktok') { const { cropTiktokProfile } = await import('./tiktok_profile.ts'); return cropTiktokProfile(username, outPng, { client }); }

  let c = client, own = false;
  if (!c) { try { c = await connect({ match: MATCH[platform], requireMatch: true }); own = true; } catch (e) { return ''; } }
  try {
    try { await c.cmd('Page.bringToFront'); } catch (e) {}
    let user = (username || '').replace(/^@/, '');
    if (platform === 'instagram') {
      if (!user && url) user = igResolveHandle(url);
      if (!user) { console.log('    [instagram] crop profil: handle tak diketahui.'); return ''; }
      return await cropInstagram(c, user, outPng);
    }
    if (platform === 'twitter') {
      // Layout crop works, but X renders the avatar as a CSS background-image that Chromium does NOT
      // rasterize in an occluded/background tab → blank avatar (worse than the synthetic card). Gated
      // OFF until the avatar is composited reliably (download URL + overlay). Enable: THOTH_PROFILE_X=1.
      if (process.env.THOTH_PROFILE_X !== '1') { console.log('    [twitter] crop profil WIP (avatar occluded-tab) → kartu sintetis. Set THOTH_PROFILE_X=1 utk paksa.'); return ''; }
      if (!user) { console.log('    [twitter] crop profil: handle tak diketahui.'); return ''; }
      return await cropTwitter(c, user, outPng);
    }
    // TODO: facebook / youtube — ditambah satu per satu.
    console.log(`    [${platform}] crop profil belum didukung.`);
    return '';
  } catch (e) { return ''; } finally { if (own) c.close(); }
}

export { cropProfile, igResolveHandle };

// ---- CLI (testing) ----
if (import.meta.main) {
  const [platform, username, out] = process.argv.slice(2);
  if (!platform || !out) { console.log('Usage: node profile_crop.ts <platform> <username|""> <out.png> [reelUrl]'); process.exit(1); }
  const url = process.argv[5];
  cropProfile(platform, username, out, { url }).then(r => {
    if (r) console.log(ui.gold(`${ui.OK} crop → ${r}`));
    else { console.log(ui.amber(`${ui.WARN} gagal`)); process.exit(2); }
  });
}
