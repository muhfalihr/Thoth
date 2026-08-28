// platform_logo.test.ts — menamai platform dari deskripsi ikon lewat tabel `platform_logos`.
//
// Yang dijaga: penamaan ini dipakai untuk MENGARAHKAN pencarian sumber ke satu platform, jadi
// jawaban yang setengah yakin lebih mahal daripada tidak menjawab. Dua gerbang diuji di sini —
// skor absolut (deskripsinya memang tentang logo?) dan margin atas platform lain (dua logo sedang
// tertukar?) — plus semua jalur degradasi, karena tabel yang belum di-seed adalah keadaan normal
// sebelum `scripts/vision/embed_platform_logos.py` pernah dijalankan.
import assert from 'node:assert/strict';
import { matchPlatformLogo } from './platform_logo.ts';

const ICON = 'not musik kecil dengan bayangan cyan dan magenta di pojok kiri bawah';
const vector = [0.1, 0.2, 0.3];
const embedText = async () => vector;

// Kandidat teratas jauh di atas platform lain → dipakai.
{
  const match = await matchPlatformLogo(ICON, {
    embedText,
    queryRows: async () => [
      { platform: 'tiktok', variant: '__centroid__', score: 0.81 },
      { platform: 'instagram', variant: '__centroid__', score: 0.52 },
    ],
  });
  assert.deepEqual(
    { platform: match?.platform, variant: match?.variant },
    { platform: 'tiktok', variant: '__centroid__' },
  );
  console.log('ok confident_icon_named');
}

// Di bawah ambang → tak menjawab. Deskripsi yang bukan tentang logo mendarat di sini.
{
  const match = await matchPlatformLogo(ICON, {
    embedText,
    queryRows: async () => [{ platform: 'tiktok', variant: 'glyph', score: 0.31 }],
  });
  assert.equal(match, null);
  console.log('ok weak_match_refused');
}

// Dua platform terlalu rapat → tak menjawab, walau skornya tinggi. Ini pasangan logo yang juga
// diperingatkan seeder saat pengelompokan.
{
  const lines: string[] = [];
  const match = await matchPlatformLogo(ICON, {
    embedText,
    log: (line) => lines.push(line),
    queryRows: async () => [
      { platform: 'tiktok', variant: 'glyph', score: 0.79 },
      { platform: 'threads', variant: 'glyph', score: 0.78 },
    ],
  });
  assert.equal(match, null);
  assert.match(lines.join('\n'), /rapat/);
  console.log('ok ambiguous_pair_refused');
}

// Beberapa varian dari platform yang sama bukan keraguan — margin dihitung ke platform BERBEDA.
{
  const match = await matchPlatformLogo(ICON, {
    embedText,
    queryRows: async () => [
      { platform: 'tiktok', variant: 'glyph', score: 0.79 },
      { platform: 'tiktok', variant: 'wordmark', score: 0.785 },
      { platform: 'youtube', variant: 'play', score: 0.4 },
    ],
  });
  assert.equal(match?.platform, 'tiktok');
  console.log('ok same_platform_variants_not_ambiguous');
}

// Baris umpan `__none__` (bug stasiun TV, chyron berita, jam layar, isi adegan) menang → itu JAWABAN
// "tak ada ikon platform", bukan platform bernama `__none__`. Tanpa baris ini setiap deskripsi
// dipaksa memilih satu dari enam platform: logo bulat stasiun TV pernah terbaca youtube 0.595.
{
  const lines: string[] = [];
  const match = await matchPlatformLogo('logo stasiun televisi berbentuk bulat di pojok', {
    embedText,
    log: (line) => lines.push(line),
    queryRows: async () => [
      { platform: '__none__', variant: 'tv_station_bug', score: 0.71 },
      { platform: 'youtube', variant: '__centroid__', score: 0.6 },
    ],
  });
  assert.equal(match, null);
  assert.match(lines.join('\n'), /bukan logo/);
  console.log('ok decoy_win_means_no_icon');
}

// Degradasi: tabel kosong / belum di-seed, embedding gagal, deskripsi kosong → null, bukan lempar.
assert.equal(await matchPlatformLogo(ICON, { embedText, queryRows: async () => [] }), null);
assert.equal(
  await matchPlatformLogo(ICON, { embedText: async () => null, queryRows: async () => [] }),
  null,
);
assert.equal(await matchPlatformLogo('', { embedText }), null);
assert.equal(await matchPlatformLogo('   ', { embedText }), null);
console.log('ok degrades_to_null');
