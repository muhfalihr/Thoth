import assert from 'node:assert/strict';
import { sourceOrder } from './policy.ts';

const all = new Set(['network', 'public-metadata', 'gallery-dl', 'yt-dlp', 'direct-http', 'dom']);
assert.deepEqual(sourceOrder('instagram', 'inspect', undefined, all as any), [
  'network',
  'public-metadata',
  'dom',
]);
assert.deepEqual(sourceOrder('instagram', 'media', 'image', all as any), [
  'gallery-dl',
  'direct-http',
  'dom',
]);
assert.deepEqual(sourceOrder('youtube', 'media', 'video', all as any), ['yt-dlp']);
assert.deepEqual(sourceOrder('twitter', 'social-card', undefined, all as any), ['dom']);
console.log('ok acquisition_policy');
