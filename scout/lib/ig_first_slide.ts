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
  | 'photo_capture_failed'
  | 'slide1_stream_unavailable'
  | 'frame_extract_failed';

export type IgFirstSlideDeps = {
  inspectFirstSlide: (postUrl: string) => Promise<FirstSlideProbe | null>;
  resolveSlideVideo: (postUrl: string, index: number) => string;
  extractFrame: (videoUrl: string, atSeconds: number) => string;
  diagnostic: (reason: IgFirstSlideDiagnostic) => void;
};

// Locate the largest visible img/video (>120px both dims), scroll it to
// center, tag it so the follow-up read targets the exact same element.
const MEDIA_SELECT_EXPR = `(() => {
  const candidates = [...document.querySelectorAll('img,video')]
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ rect }) =>
      rect.width > 120 &&
      rect.height > 120 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth
    )
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
  const media = candidates[0]?.el;
  if (!media) return '';
  media.scrollIntoView({ block: 'center', inline: 'center' });
  media.setAttribute('data-ig-first-slide', '1');
  return media.tagName.toLowerCase();
})()`;

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

// Poll the tagged element's readiness a few times so a slow-loading photo
// gets a chance to finish painting before we give up (video never needs
// this — its pixels come from the resolved CDN stream, not the DOM element).
const READY_POLL_ATTEMPTS = 8;
const READY_POLL_INTERVAL_MS = 160;

async function inspectFirstSlide(postUrl: string): Promise<FirstSlideProbe | null> {
  let client: CdpClient | null = null;
  try {
    client = await connect({ match: 'instagram.com', navigate: postUrl, requireMatch: true });
    const tag = await client.evaluate(MEDIA_SELECT_EXPR);
    if (!tag) return null;

    let parsed: RectProbe | null = null;
    for (let attempt = 0; attempt < READY_POLL_ATTEMPTS; attempt++) {
      const rectJson = await client.evaluate(RECT_EXPR);
      parsed = null;
      if (rectJson) {
        try {
          parsed = JSON.parse(rectJson);
        } catch (_) {
          parsed = null;
        }
      }
      if (parsed && (parsed.kind === 'video' || parsed.ready)) break;
      await sleep(READY_POLL_INTERVAL_MS);
    }
    if (!parsed) return null;
    if (parsed.kind === 'video') return { kind: 'video' };
    if (!parsed.ready) return { kind: 'photo', dataUrl: '' };

    const b64 = await client.captureClip(
      { x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h },
      0,
      { beyondViewport: true },
    );
    const buf = b64 ? Buffer.from(b64, 'base64') : null;
    if (!okCrop(buf)) return { kind: 'photo', dataUrl: '' };
    return { kind: 'photo', dataUrl: `data:image/png;base64,${b64}` };
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
  const first = await deps.inspectFirstSlide(postUrl);
  if (!first) {
    deps.diagnostic('slide1_dom_missing');
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
