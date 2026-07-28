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
