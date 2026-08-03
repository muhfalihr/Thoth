// crop_post.js — pixel-perfect crop of the MAIN (non-video) post on X / Instagram / Facebook,
// straight from the logged-in DOM via CDP. Robust replacement for vision_crop.js when we can
// drive the browser: the post is a real DOM element, so we measure its exact box and screenshot
// just that — no vision model guessing (qwen3-vl boxes the nav/sidebar).
//
//   CLI:    bun crop_post.js <post_url> [out.png]
//   module: import { cropPost, inferPlatform } from './crop_post.ts';
//           await cropPost({ url, out });   // → { ok, image_path, platform, w, h, reason }
//
// vision_crop.js stays as the LAST-RESORT fallback for screenshots we can't reach via CDP.
// Output PNG → output/crops/ by default.

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { connect, sleep, run } from '../lib/cdp.ts';
import type { CdpClient } from '../lib/cdp.ts';
import { cropPath } from '../lib/paths.ts';
import { okCrop } from '../lib/crop_guard.ts';
import { ui } from '../lib/ui.ts';

const FFMPEG =
  process.env.THOTH_FFMPEG || 'C:\\Users\\mfr\\Documents\\MyTools\\CLIPPER\\ffmpeg.exe';

// Per-platform: domain(s) to attach + how to find the MAIN post element in the page.
const PLATFORMS = {
  // X main tweet = article[data-testid="tweet"]. A QUOTED tweet embedded inside is a nested
  // div[role="link"] that has its OWN <time> (the main tweet's timestamp is an <a>, not a div[role=link]).
  // Hide those before cropping so the card shows only the main tweet — a quoted tweet's image (e.g. an
  // unrelated photo) otherwise lands on screen as an out-of-context visual.
  twitter: {
    match: ['x.com', 'twitter.com'],
    idRe: /status\/(\d+)/,
    find: `(() => {
    const art = document.querySelector('article[data-testid="tweet"]');
    if (!art) return null;
    art.querySelectorAll('div[role="link"]').forEach(d => { if (d.querySelector('time')) d.style.display = 'none'; });
    return art;
  })()`,
  },
  // IG removed <article> for posts. Anchor = biggest media, then climb to the smallest ancestor
  // that holds BOTH a username link (/user/) and a <time> — that's the full post card.
  instagram: {
    match: ['instagram.com'],
    idRe: /\/(?:p|reel|tv)\/([\w-]+)/,
    find: `(() => {
    let big = null, area = 0;
    document.querySelectorAll('img,video').forEach(m => { const b = m.getBoundingClientRect(); const a = b.width * b.height; if (a > area && b.width > 120) { area = a; big = m; } });
    if (!big) return null;
    const isUser = h => /^\\/[A-Za-z0-9._]+\\/$/.test(h || '');
    let w = big;
    for (let k = 0; k < 16 && w.parentElement; k++) {
      w = w.parentElement;
      const hasUser = !!Array.from(w.querySelectorAll('a[href]')).find(a => isUser(a.getAttribute('href')));
      if (hasUser && w.querySelector('time')) return w;
    }
    return null;
  })()`,
  },
  // idRe must capture the actual id (pfbid…/numeric/story_fbid), NOT the word "posts" — else a
  // tab already on /search/posts?q=… is mistaken for "already there" and navigation is skipped.
  // FB's role=article is only the media block; the full post (author header + caption + media +
  // actions) is an ancestor with a profile link + substantial text, above where comments begin.
  facebook: {
    match: ['facebook.com'],
    idRe: /(?:\/(?:posts|videos|reel)\/|story_fbid=)(\w+)/,
    find: `(() => {
    const media = Array.from(document.querySelectorAll('[role="article"]')).find(a => { const b = a.getBoundingClientRect(); return b.width > 200 && b.height > 80; });
    if (!media) return null;
    const mh = media.getBoundingClientRect().height;
    let w = media;
    for (let k = 0; k < 10 && w.parentElement; k++) {
      w = w.parentElement;
      const b = w.getBoundingClientRect();
      const prof = Array.from(w.querySelectorAll('a[href]')).some(a => /facebook\\.com\\/[^/]+\\/?$/.test(a.href) || /\\/profile\\.php/.test(a.href));
      const txt = (w.innerText || '').replace(/\\s+/g, ' ').trim().length;
      if (prof && txt > 200 && b.height > mh) return w;
    }
    return media;
  })()`,
  },
  // Threads (Meta). URL: threads.com|net/@user/post/<code>. ⚠️ DOM selektor BEST-EFFORT (belum
  // diverifikasi dgn tab Threads): coba data-pressable-container (pola Meta) lalu role=article.
  threads: {
    match: ['threads.com', 'threads.net'],
    idRe: /\/post\/([\w-]+)/,
    find: `(() => {
    const cand = Array.from(document.querySelectorAll('[data-pressable-container="true"], div[role="article"]'));
    return cand.find(a => { const b = a.getBoundingClientRect(); return b.width > 200 && b.height > 80; }) || null;
  })()`,
  },
};

function inferPlatform(url) {
  if (/threads\.(com|net)/.test(url || '')) return 'threads';
  if (/(?:x|twitter)\.com/.test(url || '')) return 'twitter';
  if (/instagram\.com/.test(url || '')) return 'instagram';
  if (/facebook\.com/.test(url || '')) return 'facebook';
  return null;
}

// Crop one post to a PNG. Connects its own CDP session (per platform tab) UNLESS a `client` is
// supplied (acquisition kernel's Instagram adapter passes its own visit's already-connected,
// already-navigated client + `navigate:false` — this function then reads/crops the loaded page
// and never closes that borrowed client; `own` tracks who is responsible for closing it).
// Throws on relay-not-attached (err.relay) so the caller can decide; returns {ok:false,reason}
// for soft failures.
async function cropPost({
  url,
  out,
  pad = 8,
  navWaitMs = 6000,
  tries = 12,
  maxSlides = 1,
  log = (..._a: any[]) => {},
  client: injectedClient,
  navigate = true,
}: {
  url: string;
  out?: string;
  pad?: number;
  navWaitMs?: number;
  tries?: number;
  maxSlides?: number;
  log?: (...a: any[]) => void;
  client?: CdpClient;
  navigate?: boolean;
}) {
  const platform = inferPlatform(url);
  if (!platform)
    return { ok: false, reason: 'platform tak didukung (hanya x/twitter, instagram, facebook)' };
  const cfg = PLATFORMS[platform];
  const id = (url.match(cfg.idRe) || [])[1] || Date.now() + '';
  const outFile = out || cropPath(`post_${platform}_${id}.png`);

  const own = !injectedClient;
  const client = injectedClient ?? (await connect({ match: cfg.match, requireMatch: true }));
  try {
    try {
      await client.cmd('Page.bringToFront');
    } catch (e) {}
    try {
      await client.cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (e) {}

    if (navigate) {
      const cur = await client.evaluate('window.location.href');
      if (!cur || (id && !cur.includes(id))) {
        log('  navigasi ke target...');
        await client.navigate(url, navWaitMs);
      }
    }

    let tagged = 0;
    for (let t = 0; t < tries; t++) {
      tagged = await client.evaluate(
        `(() => { const el = ${cfg.find}; if (el) { el.setAttribute('data-crop-post','1'); return 1; } return 0; })()`,
      );
      if (tagged) break;
      await sleep(1000);
    }
    if (!tagged)
      return {
        ok: false,
        platform,
        reason: 'post utama tak ketemu di DOM (tab login & URL benar?)',
      };

    const dpr = (await client.evaluate('window.devicePixelRatio')) || 1;

    // Scroll the element just below the sticky top bar, then read its VIEWPORT rect (+ scroll/size).
    const place = async () => {
      await client.evaluate(
        `(() => { const el = document.querySelector('[data-crop-post="1"]'); if (el) { const top = el.getBoundingClientRect().top + window.scrollY; window.scrollTo(0, Math.max(0, top - 64)); } })()`,
      );
      // Wait for the post's images (avatar/photo) to decode before reading/capturing — an unpainted
      // bun captures as a solid-black clip. Poll from Node (evaluate doesn't awaitPromise); break
      // early once painted, cap ~1.3s for lazy media.
      const imgsReady = `(() => { const el = document.querySelector('[data-crop-post="1"]'); if (!el) return true; return [...el.querySelectorAll('img')].every(im => im.complete && im.naturalWidth > 0); })()`;
      for (let i = 0; i < 8; i++) {
        await sleep(160);
        try {
          if ((await client.evaluate(imgsReady)) === true) break;
        } catch (e) {}
      }
      const rj = await client.evaluate(
        `(() => { const el = document.querySelector('[data-crop-post="1"]'); if (!el) return ''; const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,sx:window.scrollX,sy:window.scrollY,ih:window.innerHeight}); })()`,
      );
      try {
        return JSON.parse(rj);
      } catch (e) {
        return null;
      }
    };
    // Retry reading the rect until it's a real, laid-out box. Two transient causes this guards:
    //  (a) the tweet/post isn't fully rendered yet → height ~0 on the first read;
    //  (b) X/IG are aggressive SPAs that re-render after we tagged → our data-crop-post attribute
    //      gets wiped → place() finds nothing. We re-tag (re-run `find`) before each retry.
    let m = await place();
    for (let t = 0; t < tries && (!m || m.w <= 30 || m.h <= 12); t++) {
      await client.evaluate(
        `(() => { if (!document.querySelector('[data-crop-post="1"]')) { const el = ${cfg.find}; if (el) el.setAttribute('data-crop-post','1'); } })()`,
      );
      await sleep(800);
      m = await place();
    }
    if (!m || m.w <= 30 || m.h <= 12)
      return {
        ok: false,
        platform,
        reason:
          'rect post tak valid (element 0-size setelah retry — login-wall / age-gate / re-render?)',
      };

    // Caption/text of the post (for relevance gating by the caller). Read AFTER the rect is valid
    // so a mid-flight SPA re-render (which we re-tagged through) doesn't leave this empty.
    const text = await client.evaluate(
      `(() => { const el = document.querySelector('[data-crop-post="1"]'); return el ? (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : ''; })()`,
    );

    // Capture strategy:
    //  - FITS in viewport → plain screenshot (NO clip/beyondViewport) + local ffmpeg crop. WYSIWYG:
    //    avoids captureBeyondViewport's horizontal reflow that left-clipped X tweet text.
    //  - TALLER than viewport → captureBeyondViewport page-coords (reliable on IG/FB/YT; only a very
    //    tall X tweet might shift slightly, which is rare).
    // Capture the currently-tagged card (using the current rect `m`) to `dest`. Returns the bytes.
    const captureToFile = async (dest) => {
      const tmp = dest + '.full.png';
      if (m.y >= 0 && m.y + m.h <= m.ih) {
        const shot = await client.cmd('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
        });
        fs.writeFileSync(tmp, Buffer.from(shot.data, 'base64'));
        const cx = Math.round(Math.max(0, m.x - pad) * dpr),
          cy = Math.round(Math.max(0, m.y - pad) * dpr);
        const cw = Math.round((m.w + pad * 2) * dpr),
          ch = Math.round((m.h + pad * 2) * dpr);
        try {
          execSync(`"${FFMPEG}" -i "${tmp}" -vf "crop=${cw}:${ch}:${cx}:${cy}" -y "${dest}"`, {
            stdio: 'pipe',
            timeout: 15000,
          });
        } catch (e) {}
        try {
          fs.unlinkSync(tmp);
        } catch (e) {}
        return fs.existsSync(dest) ? fs.readFileSync(dest) : null;
      }
      const data = await client.captureClip({ x: m.x + m.sx, y: m.y + m.sy, w: m.w, h: m.h }, pad, {
        beyondViewport: true,
      });
      const buf = data ? Buffer.from(data, 'base64') : Buffer.alloc(0);
      if (okCrop(buf)) fs.writeFileSync(dest, buf);
      return buf;
    };

    // Slide 1 (3 attempts: re-place between tries for SPA settle + image decode).
    let buf = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) {
        await sleep(300);
        m = (await place()) || m;
      }
      buf = await captureToFile(outFile);
      if (okCrop(buf)) break;
    }
    if (!okCrop(buf)) return { ok: false, platform, reason: 'crop blank/hitam setelah retry' };

    // Is the currently-tagged slide's biggest media a <video> (not a photo)? Video slides must NOT be
    // cropped to a still — caller resolves them to a direct CDN mp4 via yt-dlp --playlist-items <index>.
    const slideKind = async () =>
      client
        .evaluate(
          `(() => { const c = document.querySelector('[data-crop-post="1"]'); if (!c) return 'photo'; let big = null, area = 0; c.querySelectorAll('video,img').forEach(m => { const b = m.getBoundingClientRect(); const a = b.width * b.height; if (a > area && b.width > 120) { area = a; big = m; } }); return (big && big.tagName.toLowerCase() === 'video') ? 'video' : 'photo'; })()`,
        )
        .catch(() => 'photo');

    // slides[]: per-slide media. photo → {kind:'photo', index, image_path}; video → {kind:'video', index}
    // (1-based index = yt-dlp --playlist-items). For single posts (maxSlides=1) we keep the old behavior
    // (always a photo card) — only IG carousels need per-slide video detection.
    const slides = [];
    {
      const k1 = maxSlides > 1 && platform === 'instagram' ? await slideKind() : 'photo';
      if (k1 === 'video') {
        try {
          fs.unlinkSync(outFile);
        } catch (e) {}
        slides.push({ kind: 'video', index: 1 });
      } else slides.push({ kind: 'photo', index: 1, image_path: outFile });
    }
    // CAROUSEL/slide (IG only): click "Next" and inspect each slide. Photo → crop the card; video →
    // record its index (no crop). Card element persists; its inner media swaps. Stop when Next is gone
    // / maxSlides. Best-effort: any failure ends the loop with the slides gathered so far.
    if (maxSlides > 1 && platform === 'instagram') {
      for (let s = 1; s < maxSlides; s++) {
        const clicked = await client
          .evaluate(
            `(() => { const b = document.querySelector('button[aria-label="Next"], [aria-label="Next"][role="button"]'); if (b) { b.click(); return 1; } return 0; })()`,
          )
          .catch(() => 0);
        if (!clicked) break;
        await sleep(900);
        // Re-tag if the SPA wiped our marker, then read the rect.
        await client
          .evaluate(
            `(() => { if (!document.querySelector('[data-crop-post="1"]')) { const el = ${cfg.find}; if (el) el.setAttribute('data-crop-post','1'); } })()`,
          )
          .catch(() => {});
        if ((await slideKind()) === 'video') {
          slides.push({ kind: 'video', index: s + 1 });
          log(`  slide ${s + 1} (video) ✓`);
          continue;
        }
        const m2 = await place();
        if (!m2 || m2.w <= 30 || m2.h <= 12) break;
        m = m2;
        const dest = outFile.replace(/\.png$/i, `_s${s + 1}.png`);
        const b2 = await captureToFile(dest);
        if (b2 && okCrop(b2)) {
          slides.push({ kind: 'photo', index: s + 1, image_path: dest });
          log(`  slide ${s + 1} ✓`);
        } else break;
      }
    }
    const images = slides.filter((s) => s.kind === 'photo').map((s) => s.image_path);
    return {
      ok: true,
      platform,
      image_path: images[0] || null,
      images,
      slides,
      w: Math.round(m.w),
      h: Math.round(m.h),
      bytes: buf.length,
      text,
    };
  } finally {
    if (own) client.close();
  }
}

export { cropPost, inferPlatform, PLATFORMS };

// ---- CLI ----
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const url = argv[0];
  if (!url) {
    console.log('Usage: bun crop_post.ts <post_url> [out.png]');
    process.exit(1);
  }
  run(async () => {
    console.log(ui.rule());
    console.log(`  Crop Post (DOM/CDP) — ${inferPlatform(url) || '??'}`);
    console.log(ui.rule());
    console.log('URL:', url);
    const r = await cropPost({ url, out: argv[1], log: console.log });
    if (r.ok) {
      console.log(
        ui.gold(
          `${ui.OK} Crop → ${r.image_path} (${r.w}x${r.h}, ${(r.bytes / 1024).toFixed(1)} KB)`,
        ),
      );
      console.log('image_path:', r.image_path);
    } else console.log(ui.amber(`${ui.WARN}  ${r.reason}`));
  });
}
