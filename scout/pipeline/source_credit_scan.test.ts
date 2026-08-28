// source_credit_scan.test.ts — kredit sumber yang cuma ada di pixel, bukan di caption.
//
// Yang dijaga: dua jalur bukti visual harus tetap terpisah dan tetap murah. Teks "@akun" di frame
// dipanen lewat OCR; ikon platform TIDAK BOLEH dinamai oleh model — model hanya mendeskripsikan, dan
// penamaannya datang dari tabel `platform_logos`. Semua dependensi disuntik, jadi tak ada ffmpeg,
// jaringan, atau Supabase yang tersentuh di sini.
import assert from 'node:assert/strict';
import { scanSourceCredit } from './source_credit_scan.ts';

const COVER = 'data:image/png;base64,AAAA';
const noIcon = async () => '';
const noOcr = async () => ({ text: '' });

// Watermark di cover: satu OCR, tanpa video, cukup untuk memberi bukti akun ke LLM.
{
  const scan = await scanSourceCredit(
    { coverInput: COVER },
    { ocr: async () => ({ text: 'cr @enolaofficial' }), describeIcon: noIcon },
  );
  assert.deepEqual(scan.handles, [{ handle: 'enolaofficial', origin: 'cover', credited: true }]);
  assert.equal(scan.framesRead, 1);
  assert.equal(scan.platform, '');
  console.log('ok cover_watermark_harvested');
}

// Username polos TANPA "@" (bentuk watermark TikTok) tak bisa dipanen jadi handle tanpa ikut memungut
// kata biasa — tapi teksnya WAJIB diteruskan apa adanya, biar LLM yang menilai dan guard yang mengecek.
{
  const scan = await scanSourceCredit(
    { coverInput: COVER, videoSrc: 'clip.mp4', sampleTimes: [0.2, 0.8] },
    {
      extractFrame: (_src, t) => `data:image/png;base64,F${t}`,
      // Frame mengulang watermark yang sama — teksnya tak boleh menumpuk berkali-kali.
      ocr: async () => ({ text: 'vincentius.christ76  detikjatim' }),
      describeIcon: noIcon,
    },
  );
  assert.deepEqual(scan.handles, []);
  assert.equal(scan.frameText, 'vincentius.christ76 detikjatim');
  assert.equal(scan.framesRead, 3);
  console.log('ok bare_username_kept_as_frame_text');
}

// Ikon tanpa teks: deskripsi prosa → tabel logo → nama platform. Yang dikirim ke matcher harus prosa
// mentah dari model, bukan nama platform apa pun.
{
  const seen: string[] = [];
  const scan = await scanSourceCredit(
    { coverInput: COVER },
    {
      ocr: noOcr,
      describeIcon: async () => 'not musik kecil dengan bayangan cyan dan magenta di pojok',
      matchLogo: async (description) => {
        seen.push(description);
        return { platform: 'tiktok', score: 0.82 };
      },
    },
  );
  assert.equal(scan.platform, 'tiktok');
  assert.equal(scan.platformScore, 0.82);
  assert.deepEqual(seen, ['not musik kecil dengan bayangan cyan dan magenta di pojok']);
  assert.deepEqual(scan.handles, []);
  console.log('ok icon_named_by_catalog');
}

// Tabel belum di-seed / ikon tak meyakinkan → platform kosong, prosanya tetap disimpan untuk log.
{
  const scan = await scanSourceCredit(
    { coverInput: COVER },
    { ocr: noOcr, describeIcon: async () => 'lingkaran putih samar', matchLogo: async () => null },
  );
  assert.equal(scan.platform, '');
  assert.equal(scan.iconNote, 'lingkaran putih samar');
  console.log('ok unseeded_catalog_names_nothing');
}

// Cover TikTok = thumbnail terpisah, BUKAN frame video: ia membawa headline berita tapi tak membawa
// watermark yang tercetak di detik pertama. Kalau vision cuma ditanyai cover, ikon yang jelas-jelas
// ada satu frame berikutnya dilaporkan "tak ada" — persis run 2026-08-26.
{
  const asked: string[] = [];
  const scan = await scanSourceCredit(
    { coverInput: COVER, videoSrc: 'clip.mp4', sampleTimes: [0.2, 0.8] },
    {
      extractFrame: (_src, t) => `data:image/png;base64,F${t}`,
      ocr: noOcr,
      describeIcon: async (image) => {
        asked.push(image);
        return image === COVER ? '' : 'not musik putih di lingkaran hitam, pojok kiri atas';
      },
      matchLogo: async () => ({ platform: 'tiktok', score: 0.65 }),
    },
  );
  assert.equal(scan.platform, 'tiktok');
  assert.deepEqual(asked, [COVER, 'data:image/png;base64,F0.2']);
  console.log('ok icon_found_on_frame_after_blank_cover');
}

// Tapi pencariannya tetap berbatas: video tanpa ikon di mana pun tak boleh membayar satu panggilan
// vision per frame.
{
  let visionCalls = 0;
  const scan = await scanSourceCredit(
    { coverInput: COVER, videoSrc: 'clip.mp4', sampleTimes: [0.2, 0.8, 1.5] },
    {
      extractFrame: (_src, t) => `data:image/png;base64,F${t}`,
      ocr: noOcr,
      describeIcon: async () => {
        visionCalls += 1;
        return '';
      },
    },
  );
  assert.equal(scan.framesRead, 4);
  assert.equal(visionCalls, 2, 'pencarian ikon dibatasi 2 panggilan vision');
  assert.equal(scan.platform, '');
  console.log('ok icon_search_is_capped');
}

// Frame video ikut dipindai, tapi vision berhenti di jawaban pertama yang berisi — watermark kredit
// sudah tampil sejak cover, panggilan lanjutan cuma menggandakan biaya.
{
  let visionCalls = 0;
  const scan = await scanSourceCredit(
    { coverInput: COVER, videoSrc: 'clip.mp4', sampleTimes: [0.2, 0.8] },
    {
      extractFrame: (_src, t) => `data:image/png;base64,F${t}`,
      ocr: async (image) => ({ text: image.endsWith('F0.8') ? '@enolaofficial' : '' }),
      describeIcon: async () => {
        visionCalls += 1;
        return 'not musik putih di pojok';
      },
      matchLogo: async () => null,
    },
  );
  assert.equal(scan.framesRead, 3);
  assert.equal(visionCalls, 1, 'berhenti di jawaban berisi pertama');
  assert.deepEqual(scan.handles, [{ handle: 'enolaofficial', origin: 't=0.8s', credited: false }]);
  console.log('ok video_frames_scanned_vision_once');
}

// Sasaran balasan di frame tetap tak terpanen — aturannya satu, dipakai teks caption maupun OCR.
{
  const scan = await scanSourceCredit(
    { coverInput: COVER },
    { ocr: async () => ({ text: 'Membalas @enola' }), describeIcon: noIcon },
  );
  assert.deepEqual(scan.handles, []);
  console.log('ok reply_target_not_credited');
}

// Tanpa gambar apa pun → scan kosong tanpa memanggil OCR/vision sama sekali.
{
  let touched = 0;
  const scan = await scanSourceCredit(
    {},
    {
      ocr: async () => {
        touched += 1;
        return { text: '@enolaofficial' };
      },
      describeIcon: async () => {
        touched += 1;
        return 'not musik';
      },
    },
  );
  assert.deepEqual(scan, {
    handles: [],
    frameText: '',
    platform: '',
    platformScore: 0,
    iconNote: '',
    framesRead: 0,
  });
  assert.equal(touched, 0);
  console.log('ok no_input_no_calls');
}
