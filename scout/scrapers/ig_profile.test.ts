import assert from 'node:assert/strict';
import { igCaptionFromOg } from './ig_profile.ts';

// IG hides the caption inside og:description behind a likes/comments/author preamble. Three callers
// (trace_source captionOf + coverOf, run_pipeline fetchCaption, igProfileReels) unwrap it the same
// way — an empty result here means main.description ships blank and narration invents its topic.
{
  const og =
    '2,148 likes, 63 comments - dagelan on July 27, 2026: "Jujur, Bal. Pendalaman karakternya dalem banget inimah 🗿"';
  assert.equal(igCaptionFromOg(og), 'Jujur, Bal. Pendalaman karakternya dalem banget inimah 🗿');
}

// Long captions get truncated by IG — the closing quote never arrives.
assert.equal(igCaptionFromOg('someone on July 1, 2026: "hook line and then it cuts'), 'hook line and then it cuts');

// No preamble → the whole string is the caption, not ''.
assert.equal(igCaptionFromOg('plain text'), 'plain text');

// Missing tag / CDP read failed.
assert.equal(igCaptionFromOg(''), '');
assert.equal(igCaptionFromOg(undefined as any), '');

console.log('ok ig_profile');
