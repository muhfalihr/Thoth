# Deep Research — Context-Enrichment for Narration (jangan "awam", paham diskursus)

> Ditulis 2026-06-26. Sumber masalah: run `ee7ae8fb-…` — narasi MENYALAHKAN netizen
> karena LLM tak paham konteks budaya/politik di balik komentar. Dokumen ini = hasil
> riset + strategi/algoritma pengembangan tools agar konteks ke LLM kaya & "in-the-know".
> Berpasangan dengan `BLUEPRINT.md` (Priority 3–6: Trend-Aware Editing).

---

## 1. Diagnosis (grounded di kode)

**Apa yang sekarang dikirim ke LLM narasi** (`src/pipeline/mod.rs::generate_narration`, ~baris 201–308):
blok `source_text` = `[Judul] + [Deskripsi] + [Tokoh] + [Komentar Netizen Teratas] + [Deskripsi Visual] + [Analisa Momen] + [Transkrip Audio] + [Video Terkait]`.

**Komentar dikirim MENTAH** (baris 247–257): hanya `- {author} ({likes} like): {text}`. Tidak ada:
- resolusi **named-entity** ("pak nadim" → siapa?),
- resolusi **meme/kode** ("10 + 6 = ?", "konoha"),
- normalisasi **slang** ("q"=aku, "bg"=bang, "jgn"),
- **sentimen/maksud kolektif** komentar.

Prompt narasi (`src/narration/mod.rs::SYSTEM` + `generate_script`) menyuruh LLM "PILIH 1-2 komentar
representatif", tapi LLM (qwen/deepseek) **tak punya konteks** → salah baca → menyalahkan netizen.

### Studi kasus (run ee7ae8fb) — semua komentar sebetulnya SATU subteks
Topik: orang Indonesia (diaspora) memimpin tim chip AI di NVIDIA. Komentar:

| Komentar | Yang LLM lihat | Subteks SEBENARNYA |
|---|---|---|
| "jangan bang, sudah ada **pak nadim** di indo pliss🙏 q gak tega." | keluhan acak | **Nadiem Makarim** (pendiri Gojek → Mendikbud → tersangka korupsi Chromebook, ditahan 4 Sep 2025, dituntut 18 thn Mei 2026). Maksud: "jangan pulang — negeri ini memenjarakan talentanya." |
| "Suka matematika dan fisika? Tes dulu donk kk **10 + 6 =?** 😁" | pertanyaan random | Sindiran ke **gaffe Prabowo** "10+6=17" di Munas HIPMI (10 Jun 2026) → meme. Maksud: "pemimpinnya aja gini." |
| "pokoknya jgn ke **konohaaaa** titiik" | typo/spam | **Konoha** = nama satir untuk Indonesia (korupsi/nepotisme). Maksud: "jangan ke Indonesia." |
| "ngapain back.. nanti ada inovasi dikit dijadiin tersangka" | sinis | Senada: takut kriminalisasi inovator (lihat kasus Nadiem). |

**Kesimpulan diskursus:** bukan netizen "julid" — ini **sarkasme protektif**: warganet
menyarankan sang engineer **JANGAN pulang** karena Indonesia dianggap menyia-nyiakan/menjerat
talentanya. Narasi yang benar harus SE-FREKUENSI subteks ini, bukan menyalahkan komentator.

> Bukti riset (lihat §8 Sumber): Nadiem (Jakarta Globe / Indonesia Business Post), gaffe Prabowo
> 10+6 (IDN Times / Tribun), "konoha" (Tempo / Wiktionary).

---

## 2. Dua kebutuhan berbeda (penting dibedakan)

1. **Enrichment per-video (episodik):** resolve entitas/meme/slang/peristiwa yang DISEBUT di
   video ini + komentarnya, lalu sintesis maksud kolektifnya → suntik ke konteks narasi.
   *(Ini saja sudah memperbaiki bug yang dilaporkan.)*
2. **Cultural/Trend Pulse (hidup, harian):** pengetahuan "apa yang sedang ramai / meme apa yang
   lagi hidup" — TIDAK dari index trend eksternal, tapi dari **scraping konten+komentar tool
   sendiri** (mensimulasikan "scrolling reels tiap hari"), didistilasi jadi knowledge yang dipakai
   ulang. Plus algoritma agar cepat meski tools terbatas.

Keduanya berbagi satu **Cultural Knowledge Base (CKB)**: per-video MENGISI & MEMBACA dari CKB;
pulse harian MENGISI CKB secara masif → per-video makin sering "hit lokal" (murah, tanpa web call).

---

## 3. Arsitektur berlapis

```
            ┌─────────────────────── Cultural Knowledge Base (Supabase) ───────────────────────┐
            │  entities · memes · slang_lexicon · pulse(term,freq,recency) · embeddings         │
            └───────▲───────────────────────────────▲──────────────────────────────────────────┘
                    │ read/write                     │ bulk write (harian)
   ┌────────────────┴───────────────┐      ┌─────────┴───────────────────────────────┐
   │  PER-VIDEO ENRICH (run_pipeline)│      │  CULTURAL PULSE HARVESTER (scheduled)   │
   │  L1 detect → L2 resolve →       │      │  discover trending → scrape KOMENTAR    │
   │  L3 discourse synth → content-set│      │  massal → L1/L2 → agregasi term+recency │
   └────────────────┬───────────────┘      └─────────────────────────────────────────┘
                    │ writes comments[].context, main.references[], discourse{}
                    ▼
   Rust generate_narration → blok baru [Konteks Budaya] + [Maksud Komentar] → prompt narasi
```

### L1 — Reference Detection (deteksi)
Input: `main.title/description` + `comments[].text` + transkrip. Keluarkan kandidat referensi:
- **NER** (orang/org/tempat/peristiwa) — via LLM ekstraktor (sudah ada pola di `footage_objects`/`extract_figures`).
- **Slang/alay normalization** — lexicon `kamus-alay` (3.592 token, CSV) → normalisasi ("q"→aku,
  "bg/bang", "jgn", "donk") supaya NER & makna lebih akurat. (Bootstrap, lihat §8.)
- **Meme/kode markers** — heuristik + lexicon: angka-meme ("10+6"), kata-kode ("konoha","wakanda"),
  pola "X = ?", catchphrase. Tandai sebagai "perlu dijelaskan".

### L2 — Reference Resolution (inti)
Untuk tiap referensi → **explainer 1–2 kalimat**:
1. **CKB lookup** (exact alias / embedding-nearest + cek freshness).
2. **Miss → web-grounded resolver:** Google News/Search via OpenClaw CDP (sudah ada `search_news.js`)
   ATAU Serper/WebSearch → ambil 1–3 hasil → ringkas LLM → simpan ke CKB (dengan `updated_at` + TTL,
   karena status berubah: "tersangka"→"divonis"). Untuk peristiwa, simpan TANGGAL.
3. Output entry: `{term, type, summary, status, as_of_date, source_url, confidence}`.

### L3 — Discourse / Sentiment Synthesis (yang bikin "tidak awam")
Satu panggilan LLM: input = komentar + referensi ter-resolve → output JSON terstruktur:
```json
{
  "audience_stance": "sarkasme protektif: menyarankan diaspora JANGAN pulang karena Indonesia dinilai menjerat/menyia-nyiakan talenta",
  "themes": ["kriminalisasi inovator (kasus Nadiem)", "krisis kepercayaan pemimpin (meme 10+6)", "sinisme negara (konoha)"],
  "comments": [
    {"text":"...nadim...","tone":"warning+sarcasm","subtext":"takut bernasib seperti Nadiem","refs":["nadiem_makarim"]}
  ],
  "narration_guidance": "Selami sudut pandang warganet; jangan menyalahkan mereka; jadikan ironi 'pulang = berisiko' sebagai tension."
}
```
Blok ini disuntik sebagai `[Maksud Komentar]` + `[Konteks Budaya]`.

### L4 — Narration prompt upgrade (`src/narration/mod.rs`)
- Tambah konsumsi blok baru; instruksi: **gunakan subteks & status terkini dengan benar; perlakukan
  sarkasme sebagai sarkasme; selaras dengan `audience_stance`; JANGAN menyalahkan komentator;
  referensikan peristiwa nyata secara akurat (pakai `as_of_date`)**.
- Larangan baru: jangan menafsir komentar secara harfiah bila `tone` = sarkasme/joke.

### L5 — Cultural Pulse Harvester (trend tanpa index eksternal)
Scheduled (cron harian) di OpenClaw:
1. Ambil N video trending dari yang SUDAH ADA: `discover_reels.js` + `discover_tiktok_trending.js`.
2. Untuk tiap video → **scrape komentar + caption** (pakai `scrape_comments`/`comment_engine`).
3. Jalankan L1→L2 pada gabungan teks → ekstrak entitas/meme/frasa.
4. **Agregasi** lintas video: hitung frekuensi + recency tiap term → tabel `pulse`.
5. **Decay**: skor = freq × exp(-Δhari/τ); term basi (last_seen lama) turun/di-archive.
6. Tulis ke CKB → per-video runs makin sering hit lokal (hemat web call).

> Inilah "trend dari benar-benar menonton", bukan index: sinyalnya lahir dari **apa yang
> warganet TULIS** di banyak video, bukan dari angka view yang dikurasi platform.

---

## 4. Algoritma "pulse" cepat (mengakali keterbatasan tools)

Manusia scrolling = lambat & tak ter-skala. Ganti dengan pipeline budget-terbatas + caching agresif:

```
HARIAN (budget mis. 30 video, 20 komentar/video = 600 komentar):
  trending = discover(reels + tiktok_studio, region=ID, max=30)
  for v in trending (paralel, pool kecil):           # I/O-bound → konkuren
      txt = caption(v) + topComments(v, 20)
      terms = detect(txt)                            # L1 lokal, 0 biaya LLM utk slang/meme regex
  agg = countby(term) across all v  (+first/last_seen, sample_urls)
  new_terms = agg.keys NOT in CKB  (atau stale)
  resolve(new_terms) ONLY                            # L2 web/LLM HANYA utk yang baru → biaya teramortisasi
  upsert CKB.pulse(agg) + CKB.entities/memes(resolved)
  decay & archive stale
```

Kunci efisiensi:
- **Cache-first**: 90%+ term harian = repeat → 0 web call. Hanya term BARU yang di-resolve.
- **Deteksi murah dulu** (regex/lexicon) sebelum LLM; LLM hanya untuk yang ambigu.
- **Konkuren** scraping (I/O-bound), pool kecil agar tak kena anti-bot.
- **Budget keras** (N video, M komentar) → biaya harian terprediksi.
- **Embedding-dedup**: "konoha"/"wakanda"/"negara +62" → satu konsep.

---

## 5. Data model (CKB — reuse Supabase yang sudah dipakai narration_structures/moments)

```sql
entities(id, name, aliases text[], type, summary, status, as_of_date, source_url,
         confidence, embedding vector(4096), updated_at)
memes(id, key, trigger_patterns text[], meaning, origin_event, origin_date,
      first_seen, last_seen, freq, embedding, updated_at)
slang_lexicon(token PRIMARY KEY, normalized, note)          -- bootstrap kamus-alay
pulse(term, kind, freq_7d, score, first_seen, last_seen, sample_urls text[])
```
Gating env (ikuti pola yang ada): `THOTH_SUPABASE_URL` + flag `[context] enrich` (default true),
degrade diam bila tak ada (run `--url` biasa tetap jalan).

---

## 6. Kontrak content-set baru (OpenClaw → Thoth) — additive, `#[serde(default)]`

```jsonc
"comments": [{ "...": "...",
  "context": { "subtext": "...", "tone": "warning+sarcasm", "refs": ["nadiem_makarim"] } }],
"references": [                                  // entitas/meme ter-resolve utk video ini
  {"term":"Nadiem Makarim","type":"person","summary":"Pendiri Gojek, eks-Mendikbud, tersangka korupsi Chromebook (ditahan 2025, dituntut 18thn 2026).","as_of_date":"2026-05-13","source_url":"..."},
  {"term":"konoha","type":"meme","summary":"Nama satir untuk Indonesia (sindiran korupsi/nepotisme)."}
],
"discourse": { "audience_stance":"...", "themes":[...], "narration_guidance":"..." }
```
Diisi oleh OpenClaw `enrich_context.js` (baru), dibaca Rust `generate_narration`.
Tak dikenal versi lama → diabaikan (forward-compat, sesuai kontrak yang ada di CLAUDE.md).

---

## 7. Rencana implementasi bertahap (ROI tinggi dulu)

**Fase 1 — Per-video enrichment (PERBAIKI BUG YANG DILAPORKAN). Murah, ~1–2 LLM call + web cache.** ✅ SELESAI 2026-06-27
> Implementasi: `openclaw/enrich_context.js` (1 LLM call → references/discourse/comment.context) di-wire
> di `run_pipeline` (setelah figures). Rust: struct `Reference`/`Discourse` + `CommentInfo.context`
> (additive `#[serde(default)]`); `generate_narration` blok `[Konteks Budaya]`+`[Maksud Komentar]`;
> prompt `narration/mod.rs` (baca sarkasme, jangan salahkan netizen). build_cuda ✅ + test 6/6 ✅.
> Live test pada run ee7ae8fb: discourse benar ("bangga tapi pesimis… JANGAN menyalahkan netizen").
> Keterbatasan teramati: ringkasan entitas current-event masih sesuai cutoff model (Nadiem belum
> "tersangka 2026") → ditangani Fase 2 (web-grounding). Discourse/komentar tetap akurat.

- `openclaw/enrich_context.js` (baru): L1 detect → L2 resolve (CKB→web) → L3 discourse synth →
  tulis `comments[].context`, `references[]`, `discourse{}` ke content-set.
- Pasang di `run_pipeline.js` SETELAH `collect_comments`, SEBELUM validate.
- Rust `generate_narration`: baca field baru → blok `[Konteks Budaya]` + `[Maksud Komentar]`.
- Rust `narration/mod.rs` SYSTEM/prompt: instruksi pakai subteks, jangan menyalahkan, akurat tanggal.
- Struct content_search: tambah `context/references/discourse` (`#[serde(default)]`).
- **Verifikasi:** re-run ee7ae8fb → narasi harus ber-frame "warganet menyarankan jangan pulang",
  bukan menyalahkan.

**Fase 2a — Web-grounding status terkini.** ✅ SELESAI 2026-06-27
> `openclaw/web_grounding.js` (`groundTerms` → Google News headlines via CDP, text-only, reuse teknik
> search_news). `enrich_context.js`: Pass B me-rewrite ringkasan entitas/org/event/place dari headline
> terbaru + `as_of_date`/`source_url` (anchor tanggal hari ini). Rust `Reference` + blok `[Konteks Budaya]`
> tampilkan "(per <date>)". Verified: Nadiem → "terdakwa kasus Chromebook menunggu vonis" (sourced
> detik.com). Gating `THOTH_GROUND=0`. Meme/slang tak di-ground (benar).

**Fase 2b — CKB persistence di SUPABASE.** ✅ SELESAI 2026-06-27
> `openclaw/ckb.js` — Cultural Knowledge Base di **Supabase Postgres** (klien `pg` + SSL): tabel
> `ckb_entities` / `ckb_memes` / `ckb_pulse` (auto-`CREATE TABLE IF NOT EXISTS`). Cache entitas/meme
> ter-resolve lintas-run **dan lintas-mesin** (TTL entitas 14h, meme 120h). `enrich_context`: cek CKB
> → cache-hit SKIP web/LLM grounding; tulis hasil resolve balik. API: `await load()`/`await save()`
> (async, flush hanya baris dirty), `get/put/bumpPulse/topPulse` sync in-memory.
> Koneksi: `CLIPPER_SUPABASE_URL` (atau `THOTH_SUPABASE_URL`) env, file `.supabase_url` (pola
> `.novita_key`), atau `.env` terdekat. **Degrade** ke lokal-JSON bila URL/pg/koneksi tak ada → tool
> tetap jalan. Setup workspace: `npm install pg` + sediakan URL.
> Verified live: cold-run tulis ke Supabase (`backend: supabase`, Nadiem grounded), warm-run "CKB hit:
> 3 term, skip grounding" baca dari DB.
> Slang `kamus-alay`: DITUNDA — model sudah men-decode slang ID dengan baik di test.

**Fase 3 — Cultural Pulse Harvester (scheduled).** ✅ SELESAI 2026-06-27
> `openclaw/pulse_harvest.js`: scan feed trending hasil discovery (`reel_topics.json .reels[]` =
> hasil scan akun, BUKAN index) → scrape komentar berbudget (`--max`/`--per-video`) → distilasi 1 LLM
> call → hitung frekuensi LINTAS-video (term harus berulang ≥`--min-freq`, default 2) → `ckb.pulse`
> (+decay recency `exp(-age/τ)`, prune `--ttl`). `ckb.js`: `bumpPulse/prunePulse/topPulse`.
> **3b surface:** `enrich_context` tulis `discourse.trends` (top pulse) → Rust `Discourse.trends` →
> blok `[Maksud Komentar]` baris "Tren diskursus (gaya/jargon, JANGAN paksakan topik)". Verified:
> harvester jalan end-to-end (3 video IG → scrape → distilasi 12 → +0 karena 3 video topik beda;
> threshold anti-noise benar). Cron harian = jalankan `node pulse_harvest.js` (setelah discover_reels).
> CATATAN: pakai sumber komentar (discourse), bukan view-index — sesuai kehendak user.

**Fase 4 — Voice/register adaptation.** Dari pulse, ekstrak register/gaya bahasa terkini → panduan
nada narator (tetap: gaya, bukan jiplak). Tie ke Style Profiles (BLUEPRINT Priority 1).

---

## 8. Risiko & mitigasi
- **Halusinasi resolver** → wajib sertakan `source_url` + `confidence`; low-confidence tak disuntik
  sebagai fakta, hanya sebagai "kemungkinan referensi".
- **Status basi** (tersangka→vonis) → `as_of_date` + TTL; pulse decay.
- **Sensitivitas politik/defamasi** → narator menyampaikan sebagai *sentimen warganet/konteks publik*,
  pakai sumber berita; hindari klaim hukum sebagai fakta absolut.
- **Biaya/anti-bot** → budget harian, konkuren terbatas, cache-first.
- **Region/bahasa** → fokus ID; lexicon + sumber berita ID.
- **Degrade** → semua additive + gated; run lama/`--url` tak terpengaruh.

---

## 9. Sumber riset
- Nadiem Makarim: [Jakarta Globe](https://jakartaglobe.id/news/nadiem-makarims-journey-startup-visionary-reformist-minister-and-now-corruption-suspect) · [Indonesia Business Post](https://indonesiabusinesspost.com/6647/financial-crimes/indonesia-s-18-year-sentencing-demand-against-gojek-founder-sparks-backlash-from-public) · [Chromebook scandal (Wikipedia)](https://en.wikipedia.org/wiki/Chromebook_procurement_scandal)
- Prabowo 10+6 gaffe: [IDN Times](https://www.idntimes.com/news/indonesia/momen-prabowo-salah-hitung-di-munas-hipmi-10-6-17-ujungnya-jadi-8-00-rgfwk-9gjf47) · [Tribunnews](https://www.tribunnews.com/nasional/7840829/hitungan-matematika-prabowo-saat-pidato-di-munas-hipmi-menang-5885-persen-di-pilpres-dan-hut-himpi)
- "Konoha": [Tempo](https://en.tempo.co/read/1815556/the-reasons-why-indonesian-netizens-call-their-country-konoha) · [Wiktionary](https://en.wiktionary.org/wiki/Konoha) · [Indonesian slang (Wikipedia)](https://en.wikipedia.org/wiki/Indonesian_slang)
- Bootstrap lexicon: [kamus-alay (Colloquial Indonesian Lexicon, 3592 token)](https://github.com/nasalsabila/kamus-alay) · [parallel-corpus-for-lexical-normalization](https://github.com/ir-nlp-csui/parallel-corpus-for-lexical-normalization) · [Awesome-Indonesia-NLP](https://github.com/irfnrdh/Awesome-Indonesia-NLP)

---

## 10. Rekomendasi langkah berikut
Mulai **Fase 1** (paling kecil, langsung memperbaiki bug). Aku belum mengubah kode apa pun — dokumen
ini murni rencana. Bila setuju, urutan kerja Fase 1: `enrich_context.js` → wiring `run_pipeline` →
struct Rust → `generate_narration` blok → prompt `narration/mod.rs` → build_cuda → re-run ee7ae8fb.
