// source_credit.test.ts — memanen @handle dari teks postingan DAN dari OCR cover/detik pertama.
//
// Yang dijaga: watermark "@akun" di frame ditulis dengan format yang sama seperti di caption, jadi
// satu pemanen dipakai untuk keduanya — termasuk aturan bahwa sasaran balasan komentar tak pernah
// ikut terpanen, dan bahwa handle yang tak tertulis di mana pun tak punya bukti apa pun.
import assert from 'node:assert/strict';
import { accountHasEvidence, extractHandles } from './source_credit.ts';

// Watermark biasa: satu handle, tanpa penanda kredit.
{
  const hits = extractHandles('@detikjatim', 'cover');
  assert.deepEqual(hits, [{ handle: 'detikjatim', origin: 'cover', credited: false }]);
  console.log('ok watermark_handle_harvested');
}

// Penanda kredit di depan mention → ditandai credited, itu sinyal terkuat untuk sumber.
{
  const [hit] = extractHandles('video asli cr: @enolaofficial mantap', 't=0.8s');
  assert.equal(hit.handle, 'enolaofficial');
  assert.equal(hit.credited, true);
  console.log('ok credit_marker_flagged');
}

// Sasaran balasan tak pernah dipanen — inilah yang dulu jadi "source" palsu.
assert.deepEqual(extractHandles('Membalas @enola soal mobilnya', 'caption'), []);
console.log('ok reply_target_not_harvested');

// Nama tampilan berspasi ("@E N O L A") bukan handle: hanya "e" yang cocok pola, dan itu terlalu
// pendek untuk diklaim.
assert.deepEqual(extractHandles('Membalas @E N O L A pengemudi', 'caption'), []);
console.log('ok spaced_display_name_is_not_a_handle');

// Chrome UI platform ("@tiktok", "@reels") bentuknya handle tapi tak mengkredit siapa pun.
assert.deepEqual(extractHandles('@tiktok @reels', 'cover'), []);
console.log('ok ui_noise_skipped');

// Handle yang sama muncul dua kali → satu entri, dan status credited-nya yang menang.
{
  const hits = extractHandles('@enola tadi, sumber: @enola', 'cover');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].credited, true);
  console.log('ok duplicate_collapses_to_strongest');
}

// Bukti akun: cocok lintas spasi/tanda baca, tapi karangan tetap tak punya jejak.
assert.equal(accountHasEvidence('enola', 'Membalas @E N O L A pengemudi'), true);
assert.equal(accountHasEvidence('detikjatim', 'OCR: @ detik jatim'), true);
assert.equal(accountHasEvidence('niscayabernostro', 'Pengemudi Outlander di Surabaya'), false);
assert.equal(accountHasEvidence('ab', 'ab ab ab'), false);
console.log('ok account_evidence_requires_a_trace');
