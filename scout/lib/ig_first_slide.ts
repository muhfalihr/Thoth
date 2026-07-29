// ig_first_slide.ts — resolve an Instagram carousel's ACTUAL first slide into a
// vision-ready image, instead of the unreliable `og:image` (which for carousels
// often reflects the wrong slide or a stale share-card render).
//
// Photo-first: capture the real displayed slide-1 media element via CDP.
// Video-first: resolve slide 1's direct CDN URL (yt-dlp) and grab the first
// decodable frame at 0/0.1/0.25/0.5s (no extra retries beyond these four).
//
// Never throws: any resolution failure returns null with a stable diagnostic
// reason code. Never logs signed IG URLs — only reason codes/timestamps.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, sleep, type CdpClient } from './cdp.ts';
import { okCrop } from './crop_guard.ts';
import { igSlideDirectUrl } from './verify.ts';

export const FIRST_VIDEO_FRAME_TIMES = [0, 0.1, 0.25, 0.5] as const;

export type FirstSlideVisionInput = {
  dataUrl: string;
  kind: 'photo' | 'video';
  source: 'ig-slide1-photo' | 'ig-slide1-video';
  sampledAt: number | null;
};

export type FirstSlideProbe = { kind: 'photo'; dataUrl: string } | { kind: 'video' };

export type IgFirstSlideDiagnostic =
  | 'slide1_dom_missing'
  | 'slide1_wrong_post'
  | 'photo_capture_failed'
  | 'slide1_stream_unavailable'
  | 'frame_extract_failed';

export type IgFirstSlideDeps = {
  inspectFirstSlide: (
    postUrl: string,
    diagnostic?: (reason: IgFirstSlideDiagnostic) => void,
  ) => Promise<FirstSlideProbe | null>;
  resolveSlideVideo: (postUrl: string, index: number) => string;
  extractFrame: (videoUrl: string, atSeconds: number) => string;
  diagnostic: (reason: IgFirstSlideDiagnostic) => void;
};

// Extract the /p|reel|tv/<code> shortcode from an IG post URL, same pattern
// crop_post.ts's instagram.idRe uses. Used to verify the live tab is actually
// showing the requested post before trusting anything selected from it.
const IG_SHORTCODE_RE = /\/(?:p|reel|tv)\/([\w-]+)/;
function extractShortcode(postUrl: string): string | null {
  return (postUrl.match(IG_SHORTCODE_RE) || [])[1] || null;
}

// Locate the post's own hero media, scoped by real containment — not a
// vacuous ancestor check. IG renders no <article> for posts (confirmed live),
// and a single post-detail page can ALSO have a "more posts by this creator"
// suggestion grid mounted lower on the same page whose tiles independently
// satisfy a naive "big image with a time ancestor somewhere above it" test —
// that grid is exactly what the old vacuous check (and an early version of
// this fix) ended up capturing instead of the real carousel image.
//
// Real anchor: the post's HEADER — the element wrapping a <time>, a
// profile-username link, AND a "Follow" affordance. Verified live to be
// UNIQUE per post-detail page (a suggestion tile has no Follow button), so
// climbing from THIS element (not from an arbitrary media candidate) to the
// smallest ancestor whose subtree holds a big visible media element lands
// tightly on the current post's own card, not the suggestion grid rendered
// elsewhere on the page. If no header or container resolves, returns ''
// (never widens to a page-wide search) so the caller's retry loop gets
// another pass instead of confidently grabbing an unrelated large asset.
function mediaSelectExpr(): string {
  return `(() => {
    const isUserLink = (href) => /^\\/[A-Za-z0-9._]+\\/$/.test(href || '');
    const isBigVisible = (rect) =>
      rect.width > 120 &&
      rect.height > 120 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth;

    const findHeader = () => {
      for (const t of document.querySelectorAll('time')) {
        let w = t;
        for (let k = 0; k < 10 && w.parentElement; k++) {
          w = w.parentElement;
          const links = [...w.querySelectorAll('a[href]')];
          if (links.some((a) => isUserLink(a.getAttribute('href'))) && /follow/i.test(w.innerText || '')) {
            return w;
          }
        }
      }
      return null;
    };
    const header = findHeader();
    if (!header) return '';

    let container = null;
    let w = header;
    for (let k = 0; k < 12 && w; k++) {
      const hasMedia = [...w.querySelectorAll('img,video')].some((el) => isBigVisible(el.getBoundingClientRect()));
      if (hasMedia) {
        container = w;
        break;
      }
      w = w.parentElement;
    }
    if (!container) return '';

    // First slide = topmost, then leftmost — carousel slides can be
    // pre-rendered side by side in the DOM (tied top); the leftmost one is
    // slide index 0.
    const media = [...container.querySelectorAll('img,video')]
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => isBigVisible(rect))
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0]?.el;
    if (!media) return '';
    media.scrollIntoView({ block: 'center', inline: 'center' });
    media.setAttribute('data-ig-first-slide', '1');
    return media.tagName.toLowerCase();
  })()`;
}

// Re-read the tagged element's page-space rect + readiness after the scroll.
const RECT_EXPR = `(() => {
  const media = document.querySelector('[data-ig-first-slide="1"]');
  if (!media) return '';
  const r = media.getBoundingClientRect();
  return JSON.stringify({
    kind: media.tagName.toLowerCase() === 'video' ? 'video' : 'photo',
    x: r.x + scrollX,
    y: r.y + scrollY,
    w: r.width,
    h: r.height,
    ready: media.tagName.toLowerCase() === 'video'
      ? media.readyState >= 2
      : media.complete && media.naturalWidth > 0,
  });
})()`;

type RectProbe = { kind: 'photo' | 'video'; x: number; y: number; w: number; h: number; ready: boolean };

// Reads the tagged <img>'s DECODED pixels straight out of the page via an
// in-page <canvas> + toDataURL, instead of screenshotting the composited
// page (Page.captureScreenshot, with or without captureBeyondViewport).
// Live testing proved this necessary: repeated captures of the exact same
// static, non-animated element via CDP screenshot/clip differed by dozens to
// hundreds of bytes run to run — even from two consecutive screenshots with
// no DOM change in between — which is GPU compositor/downsampling jitter,
// not a selection bug (confirmed separately: canvas-read pixel hashes of the
// same <img> were bit-identical across independent navigations). Reading the
// bitmap directly sidesteps compositing entirely and is fully deterministic.
const CANVAS_EXPORT_EXPR = `(() => {
  const media = document.querySelector('[data-ig-first-slide="1"]');
  if (!media || media.tagName.toLowerCase() !== 'img') return '';
  try {
    // Draw 1:1 and never rescale here. Scaling this canvas goes through the
    // GPU resampler, which is NOT bit-deterministic across runs -- that jitter
    // destroys the stable-hash invariant we rely on to detect wrong-post
    // captures. Encode as JPEG instead to keep the vision payload sane: a
    // natural-resolution PNG slide can exceed 2.8MB of base64.
    const nw = media.naturalWidth;
    const nh = media.naturalHeight;
    if (!nw || !nh) return '';
    const c = document.createElement('canvas');
    c.width = nw;
    c.height = nh;
    const ctx = c.getContext('2d');
    ctx.drawImage(media, 0, 0);
    return c.toDataURL('image/jpeg', 0.9);
  } catch (_) {
    return '';
  }
})()`;

// Retry the candidate SEARCH itself on every attempt, not just readiness of
// an already-found element: live acceptance showed the real slide-1 media
// can still be unmounted / zero-sized well past a single post-navigate
// settle wait (an `og:image`-replacement carousel image is fetched after
// the surrounding post chrome, sometimes 10s+ later). Instagram is an
// aggressive SPA — it can replace the DOM subtree between our tag and our
// next read, which wipes the `data-ig-first-slide` attribute along with the
// old node, so a "tag once, then poll readiness" design ends up polling for
// an element that no longer exists. `crop_post.ts` hit exactly this and
// fixed it by re-running its `find` before every retry (see its comment at
// crop_post.ts around the `place()` retry loop); this mirrors that: each
// iteration below re-runs mediaSelectExpr() (re-tagging, so a replaced node
// is re-acquired) and then RECT_EXPR, succeeding only once the rect is
// present AND ready (or is a video, which doesn't need paint-readiness).
const SELECT_TRIES = 12;
const SELECT_RETRY_SLEEP_MS = 1000;

// `connect({ match: 'instagram.com' })` attaches to ANY existing instagram.com
// tab — after issuing navigate() there is no guarantee the live page is
// actually showing `postUrl` yet (IG is an SPA; the previous post's DOM can
// still be mounted, or navigation is still in flight). Poll `location.pathname`
// for the requested shortcode before trusting anything selected from the page.
async function waitForPostBinding(client: CdpClient, shortcode: string): Promise<boolean> {
  for (let attempt = 0; attempt < SELECT_TRIES; attempt++) {
    const pathname = await client.evaluate('window.location.pathname');
    if (typeof pathname === 'string' && pathname.includes(shortcode)) return true;
    await sleep(SELECT_RETRY_SLEEP_MS);
  }
  return false;
}

async function inspectFirstSlide(
  postUrl: string,
  diagnostic: (reason: IgFirstSlideDiagnostic) => void = () => {},
): Promise<FirstSlideProbe | null> {
  let client: CdpClient | null = null;
  try {
    const shortcode = extractShortcode(postUrl);
    client = await connect({ match: 'instagram.com', navigate: postUrl, requireMatch: true });
    // Mirror crop_post.ts: IG defers hydrating the real post media behind
    // visibility/focus signals — without this, the hero image can stay
    // stuck at 0x0 while an unrelated "more posts" suggestion grid lower on
    // the page finishes loading first and wins any size-based selection.
    try {
      await client.cmd('Page.bringToFront');
    } catch (_) {}
    try {
      await client.cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (_) {}

    if (shortcode) {
      const bound = await waitForPostBinding(client, shortcode);
      if (!bound) {
        diagnostic('slide1_wrong_post');
        return null;
      }
    }

    // Photo selection can race IG's own hydration: the real hero image can
    // still be mounting (and briefly loses out to an already-loaded "more
    // posts" suggestion tile elsewhere in the container search) even after
    // the container/header scoping above. Rather than trust the first
    // "ready" read, require the SAME rect on two consecutive attempts before
    // accepting — a still-hydrating page naturally fails this and keeps
    // retrying until the selection settles on the real element.
    const selectExpr = mediaSelectExpr();
    let parsed: RectProbe | null = null;
    let prevPhotoKey: string | null = null;
    for (let attempt = 0; attempt < SELECT_TRIES; attempt++) {
      await client.evaluate(selectExpr);
      const rectJson = await client.evaluate(RECT_EXPR);
      parsed = null;
      if (rectJson) {
        try {
          parsed = JSON.parse(rectJson);
        } catch (_) {
          parsed = null;
        }
      }
      if (parsed && parsed.kind === 'video') break;
      if (parsed && parsed.kind === 'photo' && parsed.ready) {
        const key = `${Math.round(parsed.x)}:${Math.round(parsed.y)}:${Math.round(parsed.w)}:${Math.round(parsed.h)}`;
        if (key === prevPhotoKey) break;
        prevPhotoKey = key;
      } else {
        prevPhotoKey = null;
      }
      await sleep(SELECT_RETRY_SLEEP_MS);
    }
    if (!parsed) return null;
    if (parsed.kind === 'video') return { kind: 'video' };
    if (!parsed.ready) return { kind: 'photo', dataUrl: '' };

    // `complete && naturalWidth > 0` can go true the instant a progressive
    // image's header is parsed, slightly ahead of every scan pass finishing
    // decode — a short settle margin before reading pixels out.
    await sleep(700);

    const dataUrl = await client.evaluate(CANVAS_EXPORT_EXPR);
    // Photos come back as JPEG (see CANVAS_EXPORT_EXPR); the video path still
    // produces PNG. Accept either rather than pinning one encoding here.
    if (!dataUrl || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) {
      return { kind: 'photo', dataUrl: '' };
    }
    const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    if (!okCrop(buf)) return { kind: 'photo', dataUrl: '' };
    return { kind: 'photo', dataUrl };
  } catch (_) {
    return null;
  } finally {
    client?.close();
  }
}

function resolveSlideVideo(postUrl: string, index: number): string {
  return igSlideDirectUrl(postUrl, index);
}

function extractFrame(videoUrl: string, atSeconds: number): string {
  const ffmpeg =
    process.env.THOTH_FFMPEG || path.join(import.meta.dirname, '..', '..', 'ffmpeg.exe');
  const tmpPng = path.join(os.tmpdir(), `ig-first-slide-${randomUUID()}.png`);
  try {
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-ss',
        String(atSeconds),
        '-i',
        videoUrl,
        '-frames:v',
        '1',
        '-vf',
        'scale=960:-1',
        '-f',
        'image2',
        tmpPng,
      ],
      { stdio: 'pipe', timeout: 30_000 },
    );
    const buf = fs.readFileSync(tmpPng);
    if (!okCrop(buf)) return '';
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (_) {
    return '';
  } finally {
    try {
      fs.unlinkSync(tmpPng);
    } catch (_) {
      /* nothing to clean up */
    }
  }
}

const defaultDeps: IgFirstSlideDeps = {
  inspectFirstSlide,
  resolveSlideVideo,
  extractFrame,
  diagnostic: () => {},
};

export async function resolveIgFirstSlideVisionInput(
  postUrl: string,
  overrides: Partial<IgFirstSlideDeps> = {},
): Promise<FirstSlideVisionInput | null> {
  const deps: IgFirstSlideDeps = { ...defaultDeps, ...overrides };
  let innerReason: IgFirstSlideDiagnostic | null = null;
  const first = await deps.inspectFirstSlide(postUrl, (r) => {
    innerReason = r;
  });
  if (!first) {
    deps.diagnostic(innerReason ?? 'slide1_dom_missing');
    return null;
  }
  if (first.kind === 'photo') {
    if (!first.dataUrl) {
      deps.diagnostic('photo_capture_failed');
      return null;
    }
    return {
      dataUrl: first.dataUrl,
      kind: 'photo',
      source: 'ig-slide1-photo',
      sampledAt: null,
    };
  }

  const stream = deps.resolveSlideVideo(postUrl, 1);
  if (!stream) {
    deps.diagnostic('slide1_stream_unavailable');
    return null;
  }
  for (const at of FIRST_VIDEO_FRAME_TIMES) {
    const dataUrl = deps.extractFrame(stream, at);
    if (dataUrl) {
      return {
        dataUrl,
        kind: 'video',
        source: 'ig-slide1-video',
        sampledAt: at,
      };
    }
  }
  deps.diagnostic('frame_extract_failed');
  return null;
}
