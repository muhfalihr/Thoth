# Instagram Carousel First-Slide Headline Vision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Instagram `/p/` carousel headline and scene vision read the actual first slide, including the first usable frame when slide 1 is a video.

**Architecture:** A new `ig_first_slide` module converts the active first-slide media into a vision-ready PNG data URL: photo slides are captured directly through CDP, while video slides resolve playlist item 1 and extract the earliest valid frame. A small `trace_source_vision` module owns carousel gating, fallback selection, data-URL normalization, and reuse of the same selected input by the existing headline and scene calls. Footage harvesting remains untouched.

**Tech Stack:** TypeScript executed by Bun, Chrome DevTools Protocol, yt-dlp, FFmpeg, Novita OpenAI-compatible vision API, `node:assert/strict` script tests.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-07-28-ig-carousel-first-slide-headline-vision-design.md`.
- Reference carousel: `https://www.instagram.com/p/DbQoG9IjzGX`.
- The new path applies only when platform is `instagram`, the permalink contains `/p/`, and `postShape(url).shape === 'carousel'`.
- Photo-first uses the actual displayed slide-1 media element. Video-first tries exactly `0`, `0.1`, `0.25`, and `0.5` seconds in that order.
- `og:image` remains the first fallback. Exhausted fallback returns empty vision text and never aborts `trace_source`.
- The same selected slide-1 input feeds both `visionHeadline` and `visionCover`.
- Do not change `dropCoverSlide`, carousel footage selection, OCR subtitle filtering, story-gate behavior, Reel behavior, single-media behavior, or non-Instagram behavior.
- Never log signed Instagram image or video URLs. Diagnostics contain only stable source names, timestamps, and reason codes.
- Tests are plain Bun scripts with top-level `assert` calls and one final
  `console.log('ok ig_first_slide')` or
  `console.log('ok trace_source_vision')`.
- No Rust is touched. Verification is the Scout test set plus `bun run typecheck`; do not run `build_cuda.bat`.
- Follow the repository `AGENTS.md`: prefix every shell command with `rtk`.

---

### Task 1: Resolve the first carousel slide into a vision-ready image

**Files:**
- Create: `scout/lib/ig_first_slide.ts`
- Test: `scout/lib/ig_first_slide.test.ts`
- Reuse: `scout/lib/cdp.ts`, `scout/lib/crop_guard.ts`, `scout/lib/verify.ts`

**Interfaces:**
- Consumes:
  - `connect({ match: 'instagram.com', requireMatch: true })` from `scout/lib/cdp.ts`.
  - `okCrop(buf: Buffer): boolean` from `scout/lib/crop_guard.ts`.
  - `igSlideDirectUrl(postUrl: string, index: number): string` from `scout/lib/verify.ts`.
- Produces:

```ts
export const FIRST_VIDEO_FRAME_TIMES = [0, 0.1, 0.25, 0.5] as const;

export type FirstSlideVisionInput = {
  dataUrl: string;
  kind: 'photo' | 'video';
  source: 'ig-slide1-photo' | 'ig-slide1-video';
  sampledAt: number | null;
};

export type FirstSlideProbe =
  | { kind: 'photo'; dataUrl: string }
  | { kind: 'video' };

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

export async function resolveIgFirstSlideVisionInput(
  postUrl: string,
  deps?: Partial<IgFirstSlideDeps>,
): Promise<FirstSlideVisionInput | null>;
```

- The default dependency implementation owns CDP capture, yt-dlp slide resolution, FFmpeg PNG extraction, blank-frame rejection, and temporary-file cleanup.

- [ ] **Step 1: Write the resolver behavior tests**

Create `scout/lib/ig_first_slide.test.ts`:

```ts
import assert from 'node:assert/strict';
import {
  FIRST_VIDEO_FRAME_TIMES,
  resolveIgFirstSlideVisionInput,
  type IgFirstSlideDeps,
} from './ig_first_slide.ts';

const POST = 'https://www.instagram.com/p/DbQoG9IjzGX';
const PHOTO = 'data:image/png;base64,photo-slide-one';
const FRAME = 'data:image/png;base64,video-frame';

assert.deepEqual([...FIRST_VIDEO_FRAME_TIMES], [0, 0.1, 0.25, 0.5]);

function deps(overrides: Partial<IgFirstSlideDeps>): IgFirstSlideDeps {
  return {
    inspectFirstSlide: async () => null,
    resolveSlideVideo: () => '',
    extractFrame: () => '',
    diagnostic: () => {},
    ...overrides,
  };
}

{
  let videoResolveCalls = 0;
  const result = await resolveIgFirstSlideVisionInput(
    POST,
    deps({
      inspectFirstSlide: async () => ({ kind: 'photo', dataUrl: PHOTO }),
      resolveSlideVideo: () => {
        videoResolveCalls += 1;
        return '';
      },
    }),
  );
  assert.deepEqual(result, {
    dataUrl: PHOTO,
    kind: 'photo',
    source: 'ig-slide1-photo',
    sampledAt: null,
  });
  assert.equal(videoResolveCalls, 0);
}

{
  const attempted: number[] = [];
  const result = await resolveIgFirstSlideVisionInput(
    POST,
    deps({
      inspectFirstSlide: async () => ({ kind: 'video' }),
      resolveSlideVideo: (_url, index) => {
        assert.equal(index, 1);
        return 'https://video.invalid/slide1.mp4';
      },
      extractFrame: (_url, at) => {
        attempted.push(at);
        return at === 0.25 ? FRAME : '';
      },
    }),
  );
  assert.deepEqual(attempted, [0, 0.1, 0.25]);
  assert.deepEqual(result, {
    dataUrl: FRAME,
    kind: 'video',
    source: 'ig-slide1-video',
    sampledAt: 0.25,
  });
}

{
  const attempted: number[] = [];
  const reasons: string[] = [];
  const result = await resolveIgFirstSlideVisionInput(
    POST,
    deps({
      inspectFirstSlide: async () => ({ kind: 'video' }),
      resolveSlideVideo: () => 'https://video.invalid/slide1.mp4',
      extractFrame: (_url, at) => {
        attempted.push(at);
        return '';
      },
      diagnostic: (reason) => reasons.push(reason),
    }),
  );
  assert.deepEqual(attempted, [...FIRST_VIDEO_FRAME_TIMES]);
  assert.equal(result, null);
  assert.deepEqual(reasons, ['frame_extract_failed']);
}

{
  const reasons: string[] = [];
  const result = await resolveIgFirstSlideVisionInput(
    POST,
    deps({
      inspectFirstSlide: async () => ({ kind: 'video' }),
      resolveSlideVideo: () => '',
      diagnostic: (reason) => reasons.push(reason),
    }),
  );
  assert.equal(result, null);
  assert.deepEqual(reasons, ['slide1_stream_unavailable']);
}

{
  const reasons: string[] = [];
  const result = await resolveIgFirstSlideVisionInput(
    POST,
    deps({
      inspectFirstSlide: async () => null,
      diagnostic: (reason) => reasons.push(reason),
    }),
  );
  assert.equal(result, null);
  assert.deepEqual(reasons, ['slide1_dom_missing']);
}

{
  const reasons: string[] = [];
  const result = await resolveIgFirstSlideVisionInput(
    POST,
    deps({
      inspectFirstSlide: async () => ({ kind: 'photo', dataUrl: '' }),
      diagnostic: (reason) => reasons.push(reason),
    }),
  );
  assert.equal(result, null);
  assert.deepEqual(reasons, ['photo_capture_failed']);
}

console.log('ok ig_first_slide');
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
rtk bun scout/lib/ig_first_slide.test.ts
```

Expected: FAIL with `Cannot find module './ig_first_slide.ts'`.

- [ ] **Step 3: Implement the dependency-driven resolver**

Create the exported constants and types exactly as listed in **Interfaces**. Implement the orchestration:

```ts
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
```

For this first GREEN run, define explicit temporary defaults:

```ts
const defaultDeps: IgFirstSlideDeps = {
  inspectFirstSlide: async () => null,
  resolveSlideVideo: () => '',
  extractFrame: () => '',
  diagnostic: () => {},
};
```

Steps 5–6 replace only the first three stubs with the real CDP, yt-dlp, and
FFmpeg implementations. Do not add automatic retries beyond the four
specified timestamps.

- [ ] **Step 4: Run the resolver test and verify GREEN**

Run:

```powershell
rtk bun scout/lib/ig_first_slide.test.ts
```

Expected: PASS and print `ok ig_first_slide`.

- [ ] **Step 5: Implement media-only CDP inspection**

In `scout/lib/ig_first_slide.ts`, implement `inspectFirstSlide(postUrl)` as follows:

1. Connect only to the Instagram tab with `requireMatch: true`.
2. Navigate to `postUrl` and wait for the page to settle.
3. Locate the largest visible `img` or `video` with both dimensions greater than `120`.
4. Scroll that element into the center of the viewport.
5. Re-read its rectangle, page scroll, tag name, image readiness, and video readiness.
6. For a video return `{ kind: 'video' }`.
7. For a photo use `client.captureClip` with page coordinates, validate the PNG with `okCrop`, and return a data URL.
8. Always close the CDP client.

Use this DOM expression after scrolling:

```ts
const mediaJson = await client.evaluate(`(() => {
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
})()`);
```

After the scroll settle, read the tagged element's page rectangle:

```ts
const rectJson = await client.evaluate(`(() => {
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
})()`);
```

If the element is missing or smaller than the minimum, return `null`. Once the
element is known to be a photo, a readiness timeout or failed `okCrop` returns
`{ kind: 'photo', dataUrl: '' }` so the resolver emits
`photo_capture_failed` rather than misreporting `slide1_dom_missing`. Do not
capture the ancestor post card.

- [ ] **Step 6: Implement first-frame PNG extraction**

Implement the default `resolveSlideVideo` as `igSlideDirectUrl(postUrl, index)`.

Implement `extractFrame(videoUrl, atSeconds)` with:

```ts
const args = [
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
];
```

Use `process.env.THOTH_FFMPEG` or repo-root `ffmpeg.exe`, a unique PNG under
`os.tmpdir()`, a `30_000ms` timeout, and `stdio: 'pipe'`. Read the output
buffer, return a `data:image/png;base64,...` URL only when `okCrop(buf)` is
true, and remove the temporary file in `finally`.

The default diagnostic callback is a no-op; Task 2 supplies the user-facing
logger.

- [ ] **Step 7: Verify Task 1**

Run:

```powershell
rtk bun scout/lib/ig_first_slide.test.ts
rtk proxy powershell -NoProfile -Command 'Set-Location -LiteralPath "scout"; & rtk bun run typecheck; exit $LASTEXITCODE'
```

Expected: `ok ig_first_slide`; typecheck exit 0 with no diagnostics.

- [ ] **Step 8: Commit Task 1**

```powershell
rtk git add scout/lib/ig_first_slide.ts scout/lib/ig_first_slide.test.ts
rtk git commit -m "feat(scout): resolve Instagram carousel first-slide vision input"
```

---

### Task 2: Route trace-source headline and scene through the first-slide input

**Files:**
- Create: `scout/pipeline/trace_source_vision.ts`
- Test: `scout/pipeline/trace_source_vision.test.ts`
- Modify: `scout/pipeline/trace_source.ts` (new helper import near the top, vision input loading around current lines 209–305, main signal selection around current lines 1001–1024)

**Interfaces:**
- Consumes:
  - `resolveIgFirstSlideVisionInput(postUrl, deps?)` from Task 1.
  - `postShape(postUrl)` from `scout/lib/verify.ts`.
- Produces:

```ts
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

export async function selectTraceVisionInput(
  main: { platform?: string; url?: string },
  fallbackCover: string,
  deps?: Partial<TraceVisionDeps>,
): Promise<TraceVisionSelection>;

export async function visionInputDataUrl(
  input: string,
  fetchImpl?: typeof fetch,
): Promise<string>;

export async function readVisionSignals(
  input: string,
  readers: {
    headline: (input: string) => Promise<string>;
    scene: (input: string) => Promise<string>;
  },
): Promise<{ headline: string; scene: string }>;
```

- [ ] **Step 1: Write the trace vision selection tests**

Create `scout/pipeline/trace_source_vision.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
rtk bun scout/pipeline/trace_source_vision.test.ts
```

Expected: FAIL with `Cannot find module './trace_source_vision.ts'`.

- [ ] **Step 3: Implement selection, normalization, and shared-signal reading**

Create `scout/pipeline/trace_source_vision.ts` with the interfaces above.
Import `postShape` from `../lib/verify.ts` and
`resolveIgFirstSlideVisionInput` plus `IgFirstSlideDiagnostic` from
`../lib/ig_first_slide.ts`. The default dependency object is:

```ts
const defaultDeps: TraceVisionDeps = {
  shapeOf: (url) => postShape(url),
  firstSlide: (url, diagnostic) =>
    resolveIgFirstSlideVisionInput(url, { diagnostic }),
  log: (line) => console.log(line),
};
```

`selectTraceVisionInput` must:

1. Return the fallback cover immediately unless the platform is exactly
   `instagram` and the URL contains `/p/`.
2. Call `shapeOf(url)` and use the first-slide resolver only for
   `{ ok: true, shape: 'carousel' }`.
3. Log `[cover] shape probe gagal -> fallback og:image` when the shape probe is
   not `ok`.
4. When the resolver succeeds, log exactly one of:

```text
[cover] source=ig-slide1-photo
[cover] source=ig-slide1-video sampled_at=${first.sampledAt}s
```

5. Initialize the failure reason to `slide1_dom_missing`, pass a callback to
   `firstSlide` that replaces it, and when resolution fails log
   `` `[cover] slide1 gagal (${reason}) -> fallback og:image` ``.
6. Return `{ input: '', source: 'none', sampledAt: null }` when no first-slide
   input and no fallback cover exist.

`visionInputDataUrl` must return a `data:image/...` input unchanged. For an
HTTP(S) input, fetch once, require `response.ok`, preserve the response
`content-type` with `image/jpeg` as fallback, and return a base64 data URL. On
any error return `''`.

`readVisionSignals` must pass the same input string to both readers in order
and return both strings. When `input` is empty, return
`{ headline: '', scene: '' }` without calling either reader.

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```powershell
rtk bun scout/pipeline/trace_source_vision.test.ts
```

Expected: PASS and print `ok trace_source_vision`.

- [ ] **Step 5: Integrate the selection into `trace_source.ts`**

```ts
import {
  readVisionSignals,
  selectTraceVisionInput,
  visionInputDataUrl,
} from './trace_source_vision.ts';
```

Replace the duplicated URL-fetch prologue inside `visionHeadline` and
`visionCover` with:

```ts
const dataUrl = await visionInputDataUrl(imgUrl);
if (!dataUrl || !key) return '';
```

In each Novita message, replace the constructed `data:${ct};base64,${b64}`
value with `dataUrl`. Leave both prompts, model, token limits, temperature,
response parsing, and graceful empty-string behavior unchanged.

Replace the current main cover block:

```ts
const fallbackCover = await coverOf(main);
const selectedCover = await selectTraceVisionInput(main, fallbackCover, {
  log: (line) => console.log(line),
});
const signals = await readVisionSignals(selectedCover.input, {
  headline: (input) => visionHeadline(input, novitaKey(), MODEL),
  scene: (input) => visionCover(input, novitaKey(), MODEL),
});
headline = signals.headline;
scene = signals.scene;
```

Keep `captionOf(main)` before cover selection so `igPostOg` still populates its
one-entry metadata cache. Do not persist the captured data URL into the
content-set JSON.

- [ ] **Step 6: Verify Task 2**

Run:

```powershell
rtk bun scout/lib/ig_first_slide.test.ts
rtk bun scout/pipeline/trace_source_vision.test.ts
rtk bun scout/lib/verify.test.ts
rtk bun scout/scrapers/ig_profile.test.ts
rtk proxy powershell -NoProfile -Command 'Set-Location -LiteralPath "scout"; & rtk bun run typecheck; exit $LASTEXITCODE'
```

Expected: all four scripts print their `ok` line; typecheck exit 0 with no
diagnostics.

- [ ] **Step 7: Commit Task 2**

```powershell
rtk git add scout/pipeline/trace_source.ts scout/pipeline/trace_source_vision.ts scout/pipeline/trace_source_vision.test.ts
rtk git commit -m "fix(scout): read carousel headline from the first slide"
```

---

### Task 3: Full regression and live acceptance

**Files:**
- Modify: `BLUEPRINT.md` (append one dated evidence entry only after successful live verification)
- No source changes expected. If acceptance exposes a source defect, add a focused failing test to the owning Task 1 or Task 2 test file before changing source.

**Interfaces:**
- Consumes:
  - `resolveIgFirstSlideVisionInput` from Task 1.
  - `selectTraceVisionInput`, `visionInputDataUrl`, and `readVisionSignals` from Task 2.
- Produces: full-suite and live evidence; no new code interface.

- [ ] **Step 1: Run all Scout tests**

From the repository root, run:

```powershell
rtk bun scout/enrich/dossier_parse.test.ts
rtk bun scout/lib/comment_content.test.ts
rtk bun scout/lib/footage_candidate_ocr.test.ts
rtk bun scout/lib/footage_candidate_selection.test.ts
rtk bun scout/lib/ig_first_slide.test.ts
rtk bun scout/lib/ocr_content.test.ts
rtk bun scout/lib/subtitle_vision.test.ts
rtk bun scout/lib/validate.test.ts
rtk bun scout/lib/verify.test.ts
rtk bun scout/pipeline/footage_queries.test.ts
rtk bun scout/pipeline/ocr_local.test.ts
rtk bun scout/pipeline/run_pipeline_step.test.ts
rtk bun scout/pipeline/trace_source_vision.test.ts
rtk bun scout/scrapers/ig_profile.test.ts
rtk bun scout/scrapers/tiktok_video.test.ts
```

Expected: all 15 scripts exit 0.

- [ ] **Step 2: Run typecheck and diff hygiene**

```powershell
rtk proxy powershell -NoProfile -Command 'Set-Location -LiteralPath "scout"; & rtk bun run typecheck; exit $LASTEXITCODE'
rtk git diff --check
```

Expected: typecheck exit 0 with no diagnostics; `git diff --check` prints
nothing.

- [ ] **Step 3: Confirm the managed Instagram browser is ready**

From `scout/`:

```powershell
rtk bun cli.ts browser status
```

Expected: CDP is listening at `127.0.0.1:18800` and a logged-in Instagram tab
is available. If it is not available, stop live acceptance and report the
environmental blocker; do not weaken the acceptance criteria.

- [ ] **Step 4: Run trace-source against a minimal reference content set**

From `scout/`:

```powershell
rtk proxy powershell -NoProfile -Command '$set = @{ version = 1; main = @{ url = "https://www.instagram.com/p/DbQoG9IjzGX"; platform = "instagram"; title = ""; description = ""; is_video = $true }; footage = @(); comments = @(); figures = @() }; $set | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "output\acceptance_headline_DbQoG9IjzGX.json" -Encoding utf8'
rtk bun pipeline/trace_source.ts output/acceptance_headline_DbQoG9IjzGX.json
```

Expected trace-source evidence:

```text
[cover] source=ig-slide1-photo
```

The `[2] headline(vision):` and `[2b] scene(vision):` lines must each contain
non-empty text after the colon. Their exact wording is model-produced and is
not string-matched. Visually compare the headline with the displayed first
slide and record the observed text. The run must not print a signed CDN URL.

- [ ] **Step 5: Verify carousel footage behavior on a separate minimal set**

`trace_source` may replace the main with the discovered original reel, so do
not use its mutated acceptance file to test carousel footage. Create a second
minimal set and run only the footage stage:

```powershell
rtk proxy powershell -NoProfile -Command '$set = @{ version = 1; main = @{ url = "https://www.instagram.com/p/DbQoG9IjzGX"; platform = "instagram"; title = "IG carousel first-slide acceptance"; description = "IG carousel first-slide acceptance"; is_video = $true }; footage = @(); comments = @(); figures = @() }; $set | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "output\acceptance_footage_DbQoG9IjzGX.json" -Encoding utf8'
rtk bun cli.ts footage output/acceptance_footage_DbQoG9IjzGX.json
rtk proxy powershell -NoProfile -Command '$set = Get-Content -LiteralPath "output\acceptance_footage_DbQoG9IjzGX.json" -Raw | ConvertFrom-Json; $set.footage | Select-Object url,is_video,ocr_status | ConvertTo-Json -Depth 4'
```

Expected:

- no footage URL equals the bare reference main URL;
- no footage URL contains `#slide1`;
- every retained carousel URL uses one of `#slide2` through `#slide5`;
- every retained video has `ocr_status: analyzed`.

- [ ] **Step 6: Record live evidence**

Append a dated `2026-07-28` entry to the end of `BLUEPRINT.md` containing:

- reference post;
- selected source (`ig-slide1-photo`);
- the observed non-empty headline text;
- confirmation that scene used the same slide-1 input;
- 15/15 Scout tests and typecheck result;
- confirmation that slide 1 remained absent from footage.

Do not claim video-first live evidence; state that video-first is covered by
the deterministic resolver test over the four exact timestamps.

- [ ] **Step 7: Commit Task 3**

```powershell
rtk git add BLUEPRINT.md
rtk git commit -m "docs(blueprint): record first-slide headline vision acceptance"
```

---

## Deliberately Out of Scope

- Making `og:image` reliable as the primary Instagram carousel source.
- Reading a later carousel slide when slide 1 has no text.
- OCR-merging text across multiple carousel slides.
- Combining the headline and scene Novita requests.
- Persisting cover data URLs or temporary frame files in the content set.
- Changing `dropCoverSlide` or reintroducing slide 1 into footage.
- Applying first-slide capture to Reel, single-media `/p/`, TikTok, Facebook,
  X, Threads, or YouTube.
