// resolve_source.test.ts — jaga dua tebakan yang pernah mengirim trace_source ke sumber yang salah.
//
// Kejadian nyatanya: video TikTok @detikjatim dengan caption "Membalas @E N O L A ..." membuat LLM
// menjawab source `@E N O L A / instagram`. Keduanya salah — "E N O L A" cuma komentator yang
// dibalas, dan kata "instagram" tak pernah muncul di teks mana pun. Akibatnya pencarian sumber
// dikirim ke finder Instagram untuk sebuah handle yang tak ada.
import assert from 'node:assert/strict';
import { isReplyMentionOnly, platformHasEvidence } from '../lib/source_credit.ts';
import { resolveSource } from './resolve_source.ts';

const CAPTION =
  'Membalas @E N O L A Pengemudi Mitsubishi Outlander yang menabrak beruntun di Surabaya ' +
  'ditetapkan sebagai tersangka. #detikjatim';

// Mention di belakang "Membalas" = sasaran balasan, bukan kredit.
assert.equal(isReplyMentionOnly('E N O L A', CAPTION), true);
assert.equal(isReplyMentionOnly('enola', CAPTION), true);
assert.equal(isReplyMentionOnly('Replying to', 'Replying to @jonoo mantap'), false);
assert.equal(isReplyMentionOnly('jonoo', 'Replying to @jonoo mantap'), true);
console.log('ok reply_mention_is_not_a_source');

// Akun yang memang dikredit tetap dipakai — walau juga muncul sebagai sasaran balasan.
assert.equal(isReplyMentionOnly('enola', 'Membalas @enola — cr: @enola'), false);
assert.equal(isReplyMentionOnly('enola', 'video asli via @enola'), false);
assert.equal(isReplyMentionOnly('detikjatim', CAPTION), false);
console.log('ok credited_account_survives');

// Handle super pendek terlalu mudah cocok dengan awal kalimat apa pun → jangan diklaim.
assert.equal(isReplyMentionOnly('ab', 'Membalas @ab si paling tahu'), false);
console.log('ok short_handle_not_claimed');

// Platform harus punya jejak di teks. Caption di atas tak menyebut Instagram sama sekali.
assert.equal(platformHasEvidence('instagram', CAPTION), false);
assert.equal(platformHasEvidence('tiktok', CAPTION), false);
assert.equal(platformHasEvidence('tiktok', 'sumber tt/@enola'), true);
assert.equal(platformHasEvidence('instagram', 'repost dari instagram @enola'), true);
assert.equal(platformHasEvidence('instagram', 'kredit 📸 @enola'), true);
console.log('ok platform_needs_evidence');

const llmSaying = (payload: unknown) =>
  (async () =>
    ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    }) as unknown as Response) as unknown as typeof fetch;

// End-to-end: jawaban LLM yang persis bikin run kemarin gagal, sekarang jatuh ke keywords.
{
  const result = await resolveSource({
    caption: CAPTION,
    key: 'test-key',
    fetchImpl: llmSaying({
      source: { account: 'E N O L A', platform: 'instagram' },
      keywords: ['Mitsubishi Outlander', 'Surabaya', 'kecelakaan beruntun'],
      reason: 'disebut di caption',
    }),
    log: () => {},
  });
  assert.equal(result.source, null, 'balasan komentar tak boleh jadi source');
  assert.deepEqual(result.keywords, ['Mitsubishi Outlander', 'Surabaya', 'kecelakaan beruntun']);
  console.log('ok bad_answer_falls_back_to_keywords');
}

// Platform tebakan dibuang, tapi akun yang dikredit tetap jalan lintas platform.
{
  const result = await resolveSource({
    caption: 'video asli cr: @enola, keren banget',
    key: 'test-key',
    fetchImpl: llmSaying({
      source: { account: 'enola', platform: 'instagram' },
      keywords: ['enola'],
      reason: 'cr',
    }),
    log: () => {},
  });
  assert.deepEqual(result.source, { account: 'enola', platform: '' });
  console.log('ok guessed_platform_dropped_account_kept');
}

// Platform yang benar-benar disebut tak diutak-atik.
{
  const result = await resolveSource({
    caption: 'sumber tt/@enola',
    key: 'test-key',
    fetchImpl: llmSaying({
      source: { account: 'enola', platform: 'tiktok' },
      keywords: ['enola'],
      reason: 'tt/',
    }),
    log: () => {},
  });
  assert.deepEqual(result.source, { account: 'enola', platform: 'tiktok' });
  console.log('ok evidenced_platform_kept');
}

// Handle karangan: model pernah menjawab "@niscayabernostro" untuk klip detikjatim — tak ada di teks
// mana pun. Mengejarnya berarti mencari akun yang tak ada sekaligus membuang jalur keyword.
{
  const result = await resolveSource({
    caption: CAPTION,
    key: 'test-key',
    fetchImpl: llmSaying({
      source: { account: 'niscayabernostro', platform: '' },
      keywords: ['Mitsubishi Outlander', 'Surabaya'],
      reason: 'ngarang',
    }),
    log: () => {},
  });
  assert.equal(result.source, null, 'handle yang tak tertulis di mana pun harus dibuang');
  console.log('ok hallucinated_handle_dropped');
}

// Kredit yang TERBACA di cover jadi bukti: akun yang sama kini punya jejak walau caption bungkam.
{
  const result = await resolveSource({
    caption: CAPTION,
    key: 'test-key',
    credit: { handles: [{ handle: 'enolaofficial', origin: 'cover', credited: true }] },
    fetchImpl: llmSaying({
      source: { account: 'enolaofficial', platform: '' },
      keywords: ['Surabaya'],
      reason: 'watermark',
    }),
    log: () => {},
  });
  assert.deepEqual(result.source, { account: 'enolaofficial', platform: '' });
  console.log('ok visual_handle_counts_as_evidence');
}

// Watermark TikTok mencetak username TANPA "@" ("vincentius.christ76"), jadi ia tak pernah masuk
// `handles`. Teks OCR mentah harus tetap jadi bukti — kalau tidak, kredit yang JELAS terbaca di frame
// dibuang sebagai karangan dan trace berakhir null (persis run 2026-08-26).
{
  const result = await resolveSource({
    caption: CAPTION,
    key: 'test-key',
    credit: { frameText: 'vincentius.christ76 detikjatim' },
    fetchImpl: llmSaying({
      source: { account: 'vincentius.christ76', platform: '' },
      keywords: ['Surabaya'],
      reason: 'watermark tanpa @',
    }),
    log: () => {},
  });
  assert.deepEqual(result.source, { account: 'vincentius.christ76', platform: '' });
  console.log('ok bare_watermark_username_is_evidence');
}

// Akun PENGUNGGAH juga tercetak di tiap frame, jadi dia kandidat paling "berbukti" — dan justru
// jawaban yang salah: dia yang me-repost. Trace harus jatuh ke keywords, bukan berhenti di reposter.
{
  const result = await resolveSource({
    caption: CAPTION,
    key: 'test-key',
    credit: { frameText: 'detikjatim', poster: 'detikjatim' },
    fetchImpl: llmSaying({
      source: { account: 'detikjatim', platform: 'tiktok' },
      keywords: ['Surabaya', 'Outlander'],
      reason: 'watermark',
    }),
    log: () => {},
  });
  assert.equal(result.source, null, 'pengunggah repost bukan sumber');
  assert.deepEqual(result.keywords, ['Surabaya', 'Outlander']);
  console.log('ok reposter_is_not_the_source');
}

// Ikon platform yang cocok ke katalog logo mengisi platform yang tak disebut teks — itu bukti pixel,
// bukan tebakan, jadi guard "platform tak disebut" tidak boleh membuangnya.
{
  const result = await resolveSource({
    caption: CAPTION,
    key: 'test-key',
    credit: {
      handles: [{ handle: 'enolaofficial', origin: 't=0.2s', credited: false }],
      logoPlatform: 'tiktok',
    },
    fetchImpl: llmSaying({
      source: { account: 'enolaofficial', platform: '' },
      keywords: ['Surabaya'],
      reason: 'watermark',
    }),
    log: () => {},
  });
  assert.deepEqual(result.source, { account: 'enolaofficial', platform: 'tiktok' });
  console.log('ok logo_platform_fills_silent_text');
}
