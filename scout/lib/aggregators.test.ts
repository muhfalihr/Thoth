import assert from 'node:assert/strict';
import { isPlaceholderHandle, normHandle, urlHandle } from './aggregators.ts';

// The source-resolving LLM answers in Indonesian and, when it CANNOT identify the poster, fills the
// account field with a placeholder instead of omitting it — "@akun" being the one seen in the wild.
// Those were accepted as real handles, so the by-handle search chased an account that does not
// exist and the credited tier in rankAcceptedMainCandidates keyed off a fiction.
for (const placeholder of [
  '@akun',
  'akun',
  'nama_akun',
  'namaAkun',
  '@username',
  'user',
  'pengguna',
  'unknown',
  'tidak diketahui',
  'n/a',
  'none',
  'null',
  '-',
  '',
  '   ',
]) {
  assert.equal(
    isPlaceholderHandle(placeholder),
    true,
    `${JSON.stringify(placeholder)} is not a real account`,
  );
}

// Real handles must survive, including ones that merely CONTAIN a placeholder word.
for (const real of [
  '@imajinari.id',
  'dagelan',
  'jkt.logy',
  'akunpedia',
  'user_gaming99',
  'bigmo',
]) {
  assert.equal(isPlaceholderHandle(real), false, `${real} is a real account`);
}

// normHandle/urlHandle are relied on by the same callers; pin the sharing of the normaliser.
assert.equal(normHandle('@JKT.Logy'), 'jktlogy');
assert.equal(urlHandle('https://www.instagram.com/reels/DbYbDAatkFf/'), '');

console.log('ok aggregators');
