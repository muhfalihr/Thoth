// crop_post.js — pixel-perfect crop of the MAIN (non-video) post on X / Instagram / Facebook,
// straight from the logged-in DOM via CDP. Robust replacement for vision_crop.js when we can
// drive the browser: the post is a real DOM element, so we measure its exact box and screenshot
// just that — no vision model guessing (qwen3-vl boxes the nav/sidebar).
//
//   CLI:    node crop_post.js <post_url> [out.png]
//   module: const { cropPost, inferPlatform } = require('./crop_post');
//           await cropPost({ url, out });   // → { ok, image_path, platform, w, h, reason }
//
// vision_crop.js stays as the LAST-RESORT fallback for screenshots we can't reach via CDP.
// Output PNG → output/crops/ by default.

const fs = require('fs');
const { execSync } = require('child_process');
const { connect, sleep, run } = require('./cdp');
const { cropPath } = require('./paths');

const FFMPEG = process.env.THOTH_FFMPEG || 'C:\\Users\\mfr\\Documents\\MyTools\\CLIPPER\\ffmpeg.exe';

// Per-platform: domain(s) to attach + how to find the MAIN post element in the page.
const PLATFORMS = {
  // X main tweet = article[data-testid="tweet"]. A QUOTED tweet embedded inside is a nested
  // div[role="link"] that has its OWN <time> (the main tweet's timestamp is an <a>, not a div[role=link]).
  // Hide those before cropping so the card shows only the main tweet — a quoted tweet's image (e.g. an
  // unrelated photo) otherwise lands on screen as an out-of-context visual.
  twitter: { match: ['x.com', 'twitter.com'], idRe: /status\/(\d+)/, find: `(() => {
    const art = document.querySelector('article[data-testid="tweet"]');
    if (!art) return null;
    art.querySelectorAll('div[role="link"]').forEach(d => { if (d.querySelector('time')) d.style.display = 'none'; });
    return art;
  })()` },
  // IG removed <article> for posts. Anchor = biggest media, then climb to the smallest ancestor
  // that holds BOTH a username link (/user/) and a <time> — that's the full post card.
  instagram: { match: ['instagram.com'], idRe: /\/(?:p|reel|tv)\/([\w-]+)/, find: `(() => {
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
  })()` },
  // idRe must capture the actual id (pfbid…/numeric/story_fbid), NOT the word "posts" — else a
  // tab already on /search/posts?q=… is mistaken for "already there" and navigation is skipped.
  // FB's role=article is only the media block; the full post (author header + caption + media +
  // actions) is an ancestor with a profile link + substantial text, above where comments begin.
  facebook: { match: ['facebook.com'], idRe: /(?:\/(?:posts|videos|reel)\/|story_fbid=)(\w+)/, find: `(() => {
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
  })()` },
  // Threads (Meta). URL: threads.com|net/@user/post/<code>. ⚠️ DOM selektor BEST-EFFORT (belum
  // diverifikasi dgn tab Threads): coba data-pressable-container (pola Meta) lalu role=article.
  threads: { match: ['threads.com', 'threads.net'], idRe: /\/post\/([\w-]+)/, find: `(() => {
    const cand = Array.from(document.querySelectorAll('[data-pressable-container="true"], div[role="article"]'));
    return cand.find(a => { const b = a.getBoundingClientRect(); return b.width > 200 && b.height > 80; }) || null;
  })()` },
};

function inferPlatform(url) {
  if (/threads\.(com|net)/.test(url || '')) return 'threads';
  if (/(?:x|twitter)\.com/.test(url || '')) return 'twitter';
  if (/instagram\.com/.test(url || '')) return 'instagram';
  if (/facebook\.com/.test(url || '')) return 'facebook';
  return null;
}

// Crop one post to a PNG. Connects its own CDP session (per platform tab). Throws on relay-not-
// attached (err.relay) so the caller can decide; returns {ok:false,reason} for soft failures.
async function cropPost({ url, out, pad = 8, navWaitMs = 6000, tries = 12, log = () => {} }) {
  const platform = inferPlatform(url);
  if (!platform) return { ok: false, reason: 'platform tak didukung (hanya x/twitter, instagram, facebook)' };
  const cfg = PLATFORMS[platform];
  const id = ((url.match(cfg.idRe) || [])[1]) || (Date.now() + '');
  const outFile = out || cropPath(`post_${platform}_${id}.png`);

  const client = await connect({ match: cfg.match, requireMatch: true });
  try {
    try { await client.cmd('Page.bringToFront'); } catch (e) {}
    try { await client.cmd('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}

    const cur = await client.evaluate('window.location.href');
    if (!cur || (id && !cur.includes(id))) { log('  navigasi ke target...'); await client.navigate(url, navWaitMs); }

    let tagged = 0;
    for (let t = 0; t < tries; t++) {
      tagged = await client.evaluate(`(() => { const el = ${cfg.find}; if (el) { el.setAttribute('data-crop-post','1'); return 1; } return 0; })()`);
      if (tagged) break;
      await sleep(1000);
    }
    if (!tagged) return { ok: false, platform, reason: 'post utama tak ketemu di DOM (tab login & URL benar?)' };

    const dpr = (await client.evaluate('window.devicePixelRatio')) || 1;

    // Scroll the element just below the sticky top bar, then read its VIEWPORT rect (+ scroll/size).
    const place = async () => {
      await client.evaluate(`(() => { const el = document.querySelector('[data-crop-post="1"]'); if (el) { const top = el.getBoundingClientRect().top + window.scrollY; window.scrollTo(0, Math.max(0, top - 64)); } })()`);
      await sleep(450);
      const rj = await client.evaluate(`(() => { const el = document.querySelector('[data-crop-post="1"]'); if (!el) return ''; const r = el.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,sx:window.scrollX,sy:window.scrollY,ih:window.innerHeight}); })()`);
      try { return JSON.parse(rj); } catch (e) { return null; }
    };
    // Retry reading the rect until it's a real, laid-out box. Two transient causes this guards:
    //  (a) the tweet/post isn't fully rendered yet → height ~0 on the first read;
    //  (b) X/IG are aggressive SPAs that re-render after we tagged → our data-crop-post attribute
    //      gets wiped → place() finds nothing. We re-tag (re-run `find`) before each retry.
    let m = await place();
    for (let t = 0; t < tries && (!m || m.w <= 30 || m.h <= 12); t++) {
      await client.evaluate(`(() => { if (!document.querySelector('[data-crop-post="1"]')) { const el = ${cfg.find}; if (el) el.setAttribute('data-crop-post','1'); } })()`);
      await sleep(800);
      m = await place();
    }
    if (!m || m.w <= 30 || m.h <= 12) return { ok: false, platform, reason: 'rect post tak valid (element 0-size setelah retry — login-wall / age-gate / re-render?)' };

    // Caption/text of the post (for relevance gating by the caller). Read AFTER the rect is valid
    // so a mid-flight SPA re-render (which we re-tagged through) doesn't leave this empty.
    const text = await client.evaluate(`(() => { const el = document.querySelector('[data-crop-post="1"]'); return el ? (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : ''; })()`);

    // Capture strategy:
    //  - FITS in viewport → plain screenshot (NO clip/beyondViewport) + local ffmpeg crop. WYSIWYG:
    //    avoids captureBeyondViewport's horizontal reflow that left-clipped X tweet text.
    //  - TALLER than viewport → captureBeyondViewport page-coords (reliable on IG/FB/YT; only a very
    //    tall X tweet might shift slightly, which is rare).
    const tmp = outFile + '.full.png';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) { await sleep(300); m = (await place()) || m; }
      let buf = null;
      if (m.y >= 0 && (m.y + m.h) <= m.ih) {
        const shot = await client.cmd('Page.captureScreenshot', { format: 'png', fromSurface: true });
        fs.writeFileSync(tmp, Buffer.from(shot.data, 'base64'));
        const cx = Math.round(Math.max(0, m.x - pad) * dpr), cy = Math.round(Math.max(0, m.y - pad) * dpr);
        const cw = Math.round((m.w + pad * 2) * dpr), ch = Math.round((m.h + pad * 2) * dpr);
        try { execSync(`"${FFMPEG}" -i "${tmp}" -vf "crop=${cw}:${ch}:${cx}:${cy}" -y "${outFile}"`, { stdio: 'pipe', timeout: 15000 }); } catch (e) {}
        try { fs.unlinkSync(tmp); } catch (e) {}
        buf = fs.existsSync(outFile) ? fs.readFileSync(outFile) : null;
      } else {
        const clip = { x: Math.max(0, m.x + m.sx - pad), y: Math.max(0, m.y + m.sy - pad), width: m.w + pad * 2, height: m.h + pad * 2, scale: dpr };
        const shot = await client.cmd('Page.captureScreenshot', { format: 'png', clip, fromSurface: true, captureBeyondViewport: true });
        buf = Buffer.from(shot.data, 'base64');
        if (buf.length >= 2048) fs.writeFileSync(outFile, buf);
      }
      if (buf && buf.length >= 2048) return { ok: true, platform, image_path: outFile, w: Math.round(m.w), h: Math.round(m.h), bytes: buf.length, text };
    }
    return { ok: false, platform, reason: 'crop blank/gagal setelah retry' };
  } finally {
    client.close();
  }
}

module.exports = { cropPost, inferPlatform, PLATFORMS };

// ---- CLI ----
if (require.main === module) {
  const argv = process.argv.slice(2);
  const url = argv[0];
  if (!url) { console.log('Usage: node crop_post.js <post_url> [out.png]'); process.exit(1); }
  run(async () => {
    console.log('='.repeat(60));
    console.log(`  Crop Post (DOM/CDP) — ${inferPlatform(url) || '??'}`);
    console.log('='.repeat(60));
    console.log('URL:', url);
    const r = await cropPost({ url, out: argv[1], log: console.log });
    if (r.ok) { console.log(`✅ Crop → ${r.image_path} (${r.w}x${r.h}, ${(r.bytes / 1024).toFixed(1)} KB)`); console.log('image_path:', r.image_path); }
    else console.log('⚠️ ', r.reason);
  });
}
