// resolve_source.js — LLM decides the ORIGINAL source of a (reposted) video from its text signals.
//
// Many curator reels/reposts hint at the original source in their DESCRIPTION / CAPTION / on-screen
// HEADLINE text — sometimes naming the account (username) + which platform it came from. This feeds
// those three text signals to an LLM and returns EITHER:
//   - source: { account, platform }  (when the text credits a source), OR
//   - keywords: [...]                (when there is no source → terms to SEARCH the source video).
//
//   module: import { resolveSource } from './resolve_source.ts';
//           await resolveSource({ description, caption, headline });
//             → { source: {account,platform}|null, keywords: [], reason }
//   CLI:    bun resolve_source.js --headline "..." [--caption "..."] [--desc "..."]
//
// Uses Novita (THOTH_NOVITA_API_KEY via lib/env.js); model via env THOTH_LLM_MODEL (default qwen3-vl-30b-a3b-instruct, works
// text-only on the OpenAI-compatible endpoint; 8b deprecated Novita 2026-07).

import fs from 'node:fs';
import path from 'node:path';

import { isPlaceholderHandle } from '../lib/aggregators.ts';
import { chatCompletion, chatKey } from '../lib/llm.ts';
import {
  accountHasEvidence,
  type HandleHit,
  isReplyMentionOnly,
  platformHasEvidence,
} from '../lib/source_credit.ts';
const KEY = chatKey();
const MODEL = process.env.THOTH_LLM_MODEL || 'qwen/qwen3-vl-30b-a3b-instruct';
const PLATFORMS = ['tiktok', 'instagram', 'twitter', 'youtube', 'facebook', 'threads'];

// Bukti yang dibaca dari PIXEL (cover / detik pertama), bukan dari caption — lihat
// pipeline/source_credit_scan.ts. Kosong untuk pemanggil yang tak melakukan scan.
export type CreditSignals = {
  handles?: HandleHit[];
  /**
   * Teks OCR mentah dari frame. Watermark TikTok mencetak username TANPA "@"
   * ("vincentius.christ76"), jadi `handles` saja membuang kredit yang justru paling sering muncul.
   */
  frameText?: string;
  /** Platform hasil pencocokan ikon ke tabel `platform_logos` di Supabase. */
  logoPlatform?: string;
  /** Akun PENGUNGGAH repost-nya (dari URL main). Dia yang me-repost, jadi bukan sumber. */
  poster?: string;
};

// Blok bukti visual: apa yang benar-benar TERBACA di cover / detik pertama. Ditaruh di prompt sebagai
// blok terpisah supaya model tahu mana yang bersumber dari pixel dan mana yang cuma caption.
const visualBlock = (credit: CreditSignals): string => {
  const lines: string[] = [];
  if (credit.handles?.length) {
    lines.push(
      `[KREDIT TERBACA di cover/detik pertama]: ${credit.handles
        .map((hit) => `@${hit.handle}${hit.credited ? ' (di belakang penanda kredit)' : ''}`)
        .join(', ')}`,
    );
  }
  if (credit.frameText) {
    lines.push(`[TEKS TERBACA di cover/detik pertama (OCR)]: ${credit.frameText.slice(0, 400)}`);
  }
  if (credit.logoPlatform) {
    lines.push(
      `[IKON PLATFORM di frame]: ${credit.logoPlatform} (dikenali dari katalog logo, bukan tebakan)`,
    );
  }
  if (credit.poster) {
    lines.push(`[AKUN PENGUNGGAH repost ini]: ${credit.poster} — dia yang me-repost, BUKAN sumber.`);
  }
  return lines.length ? `\n${lines.join('\n')}` : '';
};

const PROMPT = ({
  description,
  caption,
  headline,
  credit,
}) => `Kamu menganalisis sebuah video REPOST/REACTION (mis. reel kurator). Dari teks di bawah, tentukan
SUMBER ASLI video tersebut.

ATURAN:
1. Kalau teks MENYEBUT sumber asli — username akun (mis. "@akun", "cr: akun", "sumber: akun",
   "via akun", logo channel) DAN/ATAU platform-nya — kembalikan "source": {"account","platform"}.
   - "platform" HARUS salah satu: ${PLATFORMS.join(' | ')} (atau "" kalau platform tak jelas).
   - "account" = username tanpa "@" (atau "" kalau cuma platform yang disebut).
   - KREDIT EMOJI KAMERA ("[📸 @user]", "📷 @user", "🎥 cr: @user") → platform-nya "instagram"
     (konvensi repost IG yang mengkredit akun IG asli).
   - KREDIT "tt/{user}" ("tt/user", "tt/@user", "tt: @user") → platform-nya "tiktok"
     ("tt" = singkatan TikTok; konvensi repost yang mengkredit akun TikTok asli).
   - "Membalas @x" / "Balas @x" / "Replying to @x" BUKAN kredit sumber — itu jawaban untuk
     KOMENTATOR. Jangan pernah jadikan @x di belakang kata itu sebagai "account".
   - Isi "platform" HANYA kalau teks benar-benar menyebutnya (nama platform, URL-nya, atau
     konvensi 📸 / tt/ di atas). Kalau tak disebut → "" — jangan menebak.
   - Blok [KREDIT TERBACA], [TEKS TERBACA] & [IKON PLATFORM] (kalau ada) dibaca dari PIXEL
     cover/detik pertama. Itu bukti paling kuat: utamakan account/platform dari sana daripada
     tebakan dari caption.
   - Di [TEKS TERBACA] username sering tercetak TANPA "@" — watermark platform menempelkan nama
     akun polos (mis. "vincentius.christ76", "budi_wartawan"). Token bergaya username (huruf kecil
     menyatu, ada titik/garis bawah/angka, bukan kata Indonesia biasa) SAH dipakai sebagai "account".
   - Kalau [AKUN PENGUNGGAH] disebut, akun itu DILARANG jadi "account" — dia yang me-repost.
     Kalau satu-satunya nama yang terbaca adalah pengunggah, berarti tak ada kredit sumber → "".
   - "account" WAJIB benar-benar muncul di salah satu blok di bawah. Dilarang mengarang handle
     yang tak tertulis di mana pun — kalau tak ada, isi "" dan andalkan "keywords".
2. SELALU isi "keywords": 3-6 kata/frasa kunci PALING SPESIFIK dari teks (nama orang/tempat/
   peristiwa/objek) untuk MENCARI video sumbernya — WAJIB diisi baik "source" ada MAUPUN null.
   Urut dari yang paling menentukan dulu (entitas/peristiwa inti, mis. "damkar padang"). Jangan
   masukkan kata generik ("video","viral","detik-detik","sebuah","aksi","memperlihatkan").
3. Jangan mengarang sumber yang tak ada di teks. Kalau ragu → perlakukan sebagai tanpa-sumber (keywords).

TEKS:
[DESKRIPSI]: ${(description || '').slice(0, 600) || '(kosong)'}
[CAPTION]: ${(caption || '').slice(0, 400) || '(kosong)'}
[HEADLINE/HOOK on-screen]: ${(headline || '').slice(0, 300) || '(kosong)'}${visualBlock(credit || {})}

Keluarkan HANYA JSON valid persis format ini:
{"source": {"account": "", "platform": ""} , "keywords": [], "reason": ""}
(set "source": null bila tak ada sumber.)`;

async function resolveSource({
  description = '',
  caption = '',
  headline = '',
  key = KEY,
  model = MODEL,
  credit = {} as CreditSignals,
  fetchImpl = undefined,
  log = (line: string) => console.log(line),
} = {}) {
  if (!key) return { source: null, keywords: [], reason: 'no llm key' };
  if (!(description || caption || headline))
    return { source: null, keywords: [], reason: 'no text' };
  let txt = '';
  try {
    const resp = await chatCompletion(
      {
        model,
        max_tokens: 400,
        temperature: 0,
        messages: [{ role: 'user', content: PROMPT({ description, caption, headline, credit }) }],
      },
      { fetchImpl },
    );
    if (!resp.ok) return { source: null, keywords: [], reason: 'llm ' + resp.status };
    const d = await resp.json();
    txt = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  } catch (e) {
    return { source: null, keywords: [], reason: 'llm err ' + String(e.message || e).slice(0, 40) };
  }

  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { source: null, keywords: [], reason: 'parse fail' };
  let o;
  try {
    o = JSON.parse(m[0]);
  } catch (e) {
    return { source: null, keywords: [], reason: 'json fail' };
  }

  // Normalise. Bukti = semua yang model lihat: teks postingan + apa yang terbaca dari pixel.
  const visualHandles = (credit.handles || []).map((hit) => `@${hit.handle}`).join(' ');
  const evidence = [description, caption, headline, visualHandles, credit.frameText]
    .filter(Boolean)
    .join('\n');
  let source = null;
  if (o.source && (o.source.account || o.source.platform)) {
    // A placeholder account ("@akun") is the model saying it could NOT identify the poster. Passing
    // it on as a handle sends the by-handle search after an account that does not exist; drop it so
    // downstream sees the same empty account it would have seen had the model omitted the field.
    const rawAccount = String(o.source.account || '')
      .replace(/^@/, '')
      .trim();
    let account = isPlaceholderHandle(rawAccount) ? '' : rawAccount;
    let platform = String(o.source.platform || '')
      .toLowerCase()
      .trim();
    if (platform === 'x' || platform === 'x/twitter') platform = 'twitter';
    if (!PLATFORMS.includes(platform)) platform = '';
    // Balasan komentar bukan kredit: buang akun DAN platform yang menempel padanya, karena platform
    // itu ditebak dari mention yang salah sejak awal.
    if (account && isReplyMentionOnly(account, evidence)) {
      log(`    ⚠ "@${account}" cuma sasaran balasan komentar → bukan sumber, diabaikan.`);
      account = '';
      platform = '';
    }
    // Pengunggah repost-nya sendiri bukan sumber. Handle-nya tercetak di watermark tiap frame, jadi
    // dia justru kandidat paling "berbukti" — tanpa guard ini trace berhenti di reposter-nya.
    if (account && credit.poster && account.toLowerCase() === credit.poster.toLowerCase()) {
      log(`    ⚠ "@${account}" adalah pengunggah repost ini → bukan sumber, diabaikan.`);
      account = '';
      platform = '';
    }
    // Handle yang tak tertulis di mana pun = karangan model (pernah: "@niscayabernostro" untuk klip
    // detikjatim). Mengejarnya berarti mencari akun yang tak ada, sekaligus membuang jalur keyword.
    if (account && !accountHasEvidence(account, evidence)) {
      log(`    ⚠ "@${account}" tak ada di teks/cover mana pun → karangan, diabaikan.`);
      account = '';
      platform = '';
    }
    // Ikon platform yang cocok ke katalog logo = bukti pixel; pakai itu saat teks bungkam.
    if (!platform && credit.logoPlatform && PLATFORMS.includes(credit.logoPlatform)) {
      platform = credit.logoPlatform;
      log(`    · platform "${platform}" dari ikon di frame (katalog logo).`);
    }
    // Platform tanpa jejak di teks MAUPUN di ikon = tebakan. Kosongkan supaya pencarian sumber tidak
    // dikirim ke platform yang keliru; handle-nya (kalau ada) tetap dicari lintas platform.
    if (platform && platform !== credit.logoPlatform && !platformHasEvidence(platform, evidence)) {
      log(`    ⚠ platform "${platform}" tak disebut di teks → tebakan, diabaikan.`);
      platform = '';
    }
    if (account || platform) source = { account, platform };
  }
  const keywords = Array.isArray(o.keywords)
    ? o.keywords
        .map((k) => String(k).trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];
  return { source, keywords, reason: String(o.reason || '').slice(0, 120) };
}

// Compose ONE search query (3-7 words) to find the ORIGINAL source video of the same event.
// Unlike resolveSource (which extracts an account + loose keywords), this returns a ready-to-search
// phrase and LEANS ON VISION (on-screen headline + scene description) because a curator reel's caption
// is often vague/motivational and doesn't describe the actual incident. Used by trace_source when a
// curated-aggregator main must be replaced by a non-aggregator source.
async function composeSearchQuery({
  description = '',
  caption = '',
  headline = '',
  scene = '',
  key = KEY,
  model = MODEL,
} = {}) {
  if (!key) return '';
  if (!(description || caption || headline || scene)) return '';
  const prompt = `Dari sinyal sebuah video repost/kurator di bawah, buat SATU query pencarian paling efektif
untuk menemukan VIDEO SUMBER ASLI (berita/eyewitness) dari PERISTIWA yang sama.
PENTING: query ini dipakai di pencarian X/Twitter/TikTok/IG/FB yang memperlakukan SETIAP kata sebagai
WAJIB-ADA (AND). Maka kata kerja/penghubung/deskriptif (mis. "berjalan", "dengan", "menuju", "terlihat")
akan MEMBUNUH hasil → 0 tweet. Pakai HANYA kata benda ENTITAS.
ATURAN:
- Query = 3-5 kata, HANYA nama-entitas PALING menentukan: nama orang + tempat (+ 1 objek/lembaga inti).
  Contoh BAIK: "Simon Carman Nong Pattaya". Contoh BURUK: "Simon Carman berjalan dengan Nong di hotel".
- DILARANG: kata kerja (berjalan/ditangkap/menikam/terlihat), kata penghubung (dengan/dan/yang),
  kata depan (di/ke/dari/menuju/pada), kata sifat & generik (mesra/keji/video/viral/sebuah/aksi/momen).
- UTAMAKAN entitas dari [HEADLINE on-screen] & [DESKRIPSI VISUAL] (apa yang TERLIHAT) — [CAPTION] sering
  generik/motivasional.
- Bahasa Indonesia/asli sesuai nama. Keluarkan HANYA query-nya (tanpa tanda kutip, tanpa penjelasan).
[DESKRIPSI]: ${(description || '').slice(0, 500) || '(kosong)'}
[CAPTION]: ${(caption || '').slice(0, 300) || '(kosong)'}
[HEADLINE on-screen]: ${(headline || '').slice(0, 300) || '(kosong)'}
[DESKRIPSI VISUAL]: ${(scene || '').slice(0, 300) || '(kosong)'}`;
  try {
    const resp = await chatCompletion({
        model,
        max_tokens: 60,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      });
    if (!resp.ok) return '';
    const d = await resp.json();
    let q =
      (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    return tightenQuery(q);
  } catch (e) {
    return '';
  }
}

// Strip function words (prepositions/conjunctions/common verbs) the LLM may still emit. Search treats
// every token as required (AND), so one filler word ("dengan", "berjalan") yields zero hits — drop them
// so only ENTITY nouns remain. Conservative list: never strips a name/place. Keeps ≤6 tokens.
const QUERY_STOP = new Set(
  (
    'dengan dan di ke dari yang untuk pada atau saat dalam oleh akan telah sudah ' +
    'menuju kepada serta juga itu ini sang para si adalah berjalan terlihat memperlihatkan bergandengan ' +
    'mesra bersama sedang usai setelah sebelum karena hingga sambil while with and the of to in at on a an'
  ).split(' '),
);
function tightenQuery(q) {
  const cleaned = String(q || '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const toks = cleaned.split(' ').filter((t) => t && !QUERY_STOP.has(t.toLowerCase()));
  return toks.slice(0, 6).join(' ').slice(0, 120);
}

export { resolveSource, composeSearchQuery, tightenQuery };

// ---- CLI ----
if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : '';
  };
  const input = {
    description: get('--desc'),
    caption: get('--caption'),
    headline: get('--headline'),
  };
  if (!input.description && !input.caption && !input.headline) {
    console.log('Usage: bun resolve_source.ts --headline "..." [--caption "..."] [--desc "..."]');
    process.exit(1);
  }
  (async () => {
    const r = await resolveSource(input);
    console.log(JSON.stringify(r, null, 2));
  })();
}
