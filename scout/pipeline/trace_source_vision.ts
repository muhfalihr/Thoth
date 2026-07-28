// trace_source_vision.ts — select the image trace_source's vision readers (headline/scene) look
// at. Instagram carousel posts (`/p/`) get the ACTUAL first slide instead of the unreliable
// `og:image` (which for carousels often reflects the wrong slide or a stale share-card render);
// every other shape/platform keeps using the existing cover-URL fallback unchanged.

import {
  resolveIgFirstSlideVisionInput,
  type FirstSlideVisionInput,
  type IgFirstSlideDiagnostic,
} from '../lib/ig_first_slide.ts';
import { postShape } from '../lib/verify.ts';

export type TraceVisionSelection = {
  input: string;
  source: 'ig-slide1-photo' | 'ig-slide1-video' | 'cover-url' | 'none';
  sampledAt: number | null;
};

export type TraceVisionDeps = {
  shapeOf: (url: string) => { ok: boolean; shape?: string };
  firstSlide: (
    url: string,
    diagnostic: (reason: IgFirstSlideDiagnostic) => void,
  ) => Promise<FirstSlideVisionInput | null>;
  log: (line: string) => void;
};

const defaultDeps: TraceVisionDeps = {
  shapeOf: (url) => postShape(url),
  firstSlide: (url, diagnostic) =>
    resolveIgFirstSlideVisionInput(url, { diagnostic }),
  log: (line) => console.log(line),
};

export async function selectTraceVisionInput(
  main: { platform?: string; url?: string },
  fallbackCover: string,
  deps: Partial<TraceVisionDeps> = {},
): Promise<TraceVisionSelection> {
  const { shapeOf, firstSlide, log } = { ...defaultDeps, ...deps };

  const isCarouselCandidate =
    main.platform === 'instagram' && !!main.url && main.url.includes('/p/');
  if (isCarouselCandidate) {
    const shape = shapeOf(main.url as string);
    if (!shape.ok) {
      log('[cover] shape probe gagal -> fallback og:image');
    } else if (shape.shape === 'carousel') {
      let reason: IgFirstSlideDiagnostic = 'slide1_dom_missing';
      const first = await firstSlide(main.url as string, (r) => {
        reason = r;
      });
      if (first) {
        log(
          first.source === 'ig-slide1-video'
            ? `[cover] source=ig-slide1-video sampled_at=${first.sampledAt}s`
            : '[cover] source=ig-slide1-photo',
        );
        return { input: first.dataUrl, source: first.source, sampledAt: first.sampledAt };
      }
      log(`[cover] slide1 gagal (${reason}) -> fallback og:image`);
    }
  }

  if (fallbackCover) {
    return { input: fallbackCover, source: 'cover-url', sampledAt: null };
  }
  return { input: '', source: 'none', sampledAt: null };
}

export async function visionInputDataUrl(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!input) return '';
  if (input.startsWith('data:')) return input;
  try {
    const res = await fetchImpl(input);
    if (!res.ok) return '';
    const ct = res.headers.get('content-type') || 'image/jpeg';
    const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    return `data:${ct};base64,${b64}`;
  } catch (_) {
    return '';
  }
}

export async function readVisionSignals(
  input: string,
  readers: {
    headline: (input: string) => Promise<string>;
    scene: (input: string) => Promise<string>;
  },
): Promise<{ headline: string; scene: string }> {
  if (!input) return { headline: '', scene: '' };
  const headline = await readers.headline(input);
  const scene = await readers.scene(input);
  return { headline, scene };
}
