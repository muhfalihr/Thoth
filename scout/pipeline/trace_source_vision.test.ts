import assert from 'node:assert/strict';
import {
  readVisionSignals,
  selectTraceVisionInput,
  visionInputDataUrl,
  type TraceVisionDeps,
} from './trace_source_vision.ts';

const CAROUSEL = 'https://www.instagram.com/p/DbQoG9IjzGX';
const SLIDE = 'data:image/png;base64,slide-one';
const OG = 'https://image.invalid/cover.jpg';

function deps(overrides: Partial<TraceVisionDeps>): TraceVisionDeps {
  return {
    shapeOf: () => ({ ok: true, shape: 'carousel' }),
    firstSlide: async () => ({
      dataUrl: SLIDE,
      kind: 'photo',
      source: 'ig-slide1-photo',
      sampledAt: null,
    }),
    log: () => {},
    ...overrides,
  };
}

{
  const result = await selectTraceVisionInput(
    { platform: 'instagram', url: CAROUSEL },
    OG,
    deps({}),
  );
  assert.deepEqual(result, {
    input: SLIDE,
    source: 'ig-slide1-photo',
    sampledAt: null,
  });
}

for (const main of [
  { platform: 'instagram', url: 'https://www.instagram.com/reel/abc/' },
  { platform: 'instagram', url: 'https://www.instagram.com/p/single/' },
  { platform: 'tiktok', url: 'https://www.tiktok.com/@u/video/1' },
]) {
  let firstSlideCalls = 0;
  const result = await selectTraceVisionInput(
    main,
    OG,
    deps({
      shapeOf: () => ({
        ok: true,
        shape: main.url.includes('/single/') ? 'photo' : 'carousel',
      }),
      firstSlide: async () => {
        firstSlideCalls += 1;
        return null;
      },
    }),
  );
  assert.deepEqual(result, {
    input: OG,
    source: 'cover-url',
    sampledAt: null,
  });
  assert.equal(firstSlideCalls, 0);
}

{
  const lines: string[] = [];
  const result = await selectTraceVisionInput(
    { platform: 'instagram', url: CAROUSEL },
    OG,
    deps({
      firstSlide: async (_url, diagnostic) => {
        diagnostic('frame_extract_failed');
        return null;
      },
      log: (line) => lines.push(line),
    }),
  );
  assert.deepEqual(result, {
    input: OG,
    source: 'cover-url',
    sampledAt: null,
  });
  assert.deepEqual(lines, [
    '[cover] slide1 gagal (frame_extract_failed) -> fallback og:image',
  ]);
}

{
  const lines: string[] = [];
  const result = await selectTraceVisionInput(
    { platform: 'instagram', url: CAROUSEL },
    OG,
    deps({
      shapeOf: () => ({ ok: false }),
      log: (line) => lines.push(line),
    }),
  );
  assert.deepEqual(result, {
    input: OG,
    source: 'cover-url',
    sampledAt: null,
  });
  assert.deepEqual(lines, [
    '[cover] shape probe gagal -> fallback og:image',
  ]);
}

{
  let fetchCalls = 0;
  assert.equal(
    await visionInputDataUrl(SLIDE, async () => {
      fetchCalls += 1;
      throw new Error('must not fetch data URL');
    }),
    SLIDE,
  );
  assert.equal(fetchCalls, 0);
}

{
  const loaded = await visionInputDataUrl(
    OG,
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
  );
  assert.equal(loaded, 'data:image/jpeg;base64,AQID');
}

{
  assert.equal(
    await visionInputDataUrl(OG, async () => new Response('', { status: 403 })),
    '',
  );
  assert.deepEqual(
    await selectTraceVisionInput(
      { platform: 'instagram', url: CAROUSEL },
      '',
      deps({ firstSlide: async () => null }),
    ),
    { input: '', source: 'none', sampledAt: null },
  );
}

{
  const seen: string[] = [];
  const signals = await readVisionSignals(SLIDE, {
    headline: async (input) => {
      seen.push(input);
      return 'headline';
    },
    scene: async (input) => {
      seen.push(input);
      return 'scene';
    },
  });
  assert.deepEqual(seen, [SLIDE, SLIDE]);
  assert.deepEqual(signals, { headline: 'headline', scene: 'scene' });
}

{
  let calls = 0;
  assert.deepEqual(
    await readVisionSignals('', {
      headline: async () => {
        calls += 1;
        return 'unexpected';
      },
      scene: async () => {
        calls += 1;
        return 'unexpected';
      },
    }),
    { headline: '', scene: '' },
  );
  assert.equal(calls, 0);
}

console.log('ok trace_source_vision');
