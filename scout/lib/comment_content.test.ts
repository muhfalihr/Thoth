import assert from 'node:assert';
import { parseArgs } from './comment_engine.ts';
import { finalizeCommentContentSet } from './comment_content.ts';

assert.deepEqual(
  parseArgs([
    'https://example.test/post',
    'comments.json',
    '--max',
    '6',
    '--comments-only',
  ]),
  {
    url: 'https://example.test/post',
    out: 'comments.json',
    max: 6,
    commentsOnly: true,
  },
);

const contentSet = {
  main: {
    url: 'https://example.test/video.mp4',
    is_video: true,
  },
  footage: [],
  comments: [{ text: 'comment survives', author: 'viewer' }],
};

{
  let ocrCalls = 0;
  const result = await finalizeCommentContentSet(contentSet, {
    commentsOnly: true,
    attach: async () => {
      ocrCalls++;
      throw new Error('OCR must not run while collecting comments');
    },
  });
  assert.equal(ocrCalls, 0);
  assert.deepEqual(result.comments, contentSet.comments);
}

await assert.rejects(
  () =>
    finalizeCommentContentSet(contentSet, {
      commentsOnly: false,
      attach: async () => {
        throw new Error('standalone OCR failure');
      },
    }),
  /standalone OCR failure/,
);
