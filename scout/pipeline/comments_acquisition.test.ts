// scout/pipeline/comments_acquisition.test.ts
import assert from 'node:assert/strict';
import { collectNormalizedComments } from './collect_comments.ts';

const calls: string[] = [];
const comments = await collectNormalizedComments(
  [{ url: 'https://x.com/owner/status/1', platform: 'twitter' }],
  {
    perSource: 3,
    cap: 2,
    collect: async () => [
      { id: 'a', author: 'one', text: 'first', likes: 10 },
      { id: 'b', author: 'two', text: 'second', likes: 5 },
      { id: 'c', author: 'three', text: 'third', likes: 1 },
    ],
    capture: async (_url, comment) => {
      calls.push(comment.id);
      return { path: `${comment.id}.png`, kind: 'social-card', source: 'dom', bytes: 1 };
    },
  },
);
assert.deepEqual(comments.map((item) => item.image_path), ['a.png', 'b.png']);
assert.deepEqual(calls, ['a', 'b']);
console.log('ok comments_acquisition');
