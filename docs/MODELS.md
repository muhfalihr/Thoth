# Thoth — Models Reference

Daftar **semua model AI** yang dipakai Thoth + scout, di mana dikonfigurasi, dan cara
menggantinya. Hampir semua berjalan di **cloud** (Novita / OpenRouter / Groq / ElevenLabs);
satu-satunya yang bisa **lokal** adalah Whisper (transkripsi, CUDA).

> Ringkasnya: **analisis & narasi = teks-LLM**, **deskripsi frame & crop = vision-LLM**,
> **cover = image-gen + face-swap**, **suara = TTS**, **RAG = embedding**, **transkripsi = Whisper**.

---

## 1. Pipeline inti Thoth (Rust) — diatur via `config.toml`

| Stage / fungsi | Key di `config.toml` | Model default | Provider |
|---|---|---|---|
| **Analyze** (ekstraksi momen viral → JSON) | `[llm] default_provider` + `novita_model` | `deepseek/deepseek-v3.1` | Novita |
| **Narration** (naskah narator) | `[narration] model` (provider dari `--provider`) | `deepseek/deepseek-v3.1` | Novita |
| **Vision** (deskripsi frame, `describe_video`) | `[vision] novita_model` | `qwen/qwen3-vl-235b-a22b-instruct` | Novita |
| **Embedding** (RAG momen + struktur narasi) | `[vector_db] embed_model` | `qwen/qwen3-embedding-8b` (4096-d) | Novita |
| **Cover image** (background) | `[cover] image_engine` + `image_model` | `google/gemini-2.5-flash-image` (engine `openrouter`) | OpenRouter |
| **Cover background (alt)** | `[cover] image_engine="flux"` | **FLUX.1 [schnell]** (`/v3beta/flux-1-schnell`) | Novita |
| **Cover face-swap** | otomatis saat `face_swap=true` | **merge-face** (`/v3/merge-face`) | Novita |
| **Cover subjek cutout** | `[cover] rembg_model` | `u2net_human_seg` (rembg, lokal) | lokal |
| **Cover chat/vision** (prompt + deskripsi subjek) | ikut `[llm]` + `[vision]` | `deepseek-v3.1` + `qwen3-vl-235b-a22b` | Novita |
| **TTS** (suara narator/reaksi) | `[reaction.tts] provider` + `*_model` | `eleven_multilingual_v2` (ElevenLabs) | ElevenLabs |
| **Transcribe** | `[whisper] model_size` | `large-v3` | Groq API / **lokal CUDA** |

### Provider analyze lain (kalau `default_provider` diganti)
Tersimpan di `[llm]` (aktif hanya yang dipilih `default_provider`):

| Provider | Key | Default |
|---|---|---|
| groq | `groq_model` | `llama-3.3-70b-versatile` |
| openai | `openai_model` | `gpt-4o-mini` |
| claude | `claude_model` | `claude-sonnet-4-5` |
| gemini | `gemini_model` | `gemini-2.0-flash` |
| vllm | `vllm_model` | `Qwen/Qwen2.5-72B-Instruct` (self-host) |
| ollama | `ollama_model` | `llama3:70b` (self-host) |

### Pilihan TTS lain
`minimax` (`minimax_model=speech-02-hd`) · `fish` (`fish_audio_model=s2-pro`) ·
`openai` (`openai_model=tts-1-hd`) · `edge` (Edge-TTS, gratis, default fallback).

---

## 2. scout (content sourcing, TypeScript) — diatur via **env var**

scout berjalan via `node scout/cli.ts <cmd>` (full TypeScript, native Node ≥24 type
stripping). Semua secret — termasuk `THOTH_NOVITA_API_KEY`/`THOTH_SUPABASE_URL` —
hidup di **satu `.env` root** lewat `scout/lib/env.ts`. File kunci lama per-folder
(`.novita_key`/`.groq_key`/`.supabase_url`) **TIDAK dibaca lagi**. Model di-override
lewat env; default tertanam di script.

| Script | Env override | Default | Tugas |
|---|---|---|---|
| `lib/footage_objects.ts` | `THOTH_LLM_MODEL` | `deepseek/deepseek-v3.1` | ekstrak subject/object (teks) |
| `pipeline/extract_figures.ts` | `THOTH_LLM_MODEL` | `deepseek/deepseek-v3.1` | ekstrak tokoh (teks) |
| `enrich/enrich_context.ts` | `THOTH_CONTEXT_MODEL` | `deepseek/deepseek-v3.1` | decode subteks komentar (teks) |
| `enrich/pulse_harvest.ts` | `THOTH_CONTEXT_MODEL` | `deepseek/deepseek-v3.1` | distilasi tren diskursus (teks) |
| `pipeline/resolve_source.ts` | `THOTH_LLM_MODEL` | `qwen/qwen3-vl-30b-a3b-instruct` | tentukan sumber asli |
| `scrapers/vision_crop.ts` | `THOTH_VISION_MODEL` | `qwen/qwen3-vl-30b-a3b-instruct` | bounding-box crop (vision) — **fallback terakhir saja**; crop utama kini `scrapers/crop_post.ts` (DOM pixel-perfect, tanpa LLM) |
| `pipeline/trace_source.ts` | `THOTH_VISION_MODEL` | `qwen/qwen3-vl-30b-a3b-instruct` | vision |
| `pipeline/discover_reels.ts` | `THOTH_VISION_MODEL` | `qwen/qwen3-vl-30b-a3b-instruct` | baca headline cover |
| `lib/comments.ts` | `THOTH_VISION_MODEL` | `qwen/qwen3-vl-30b-a3b-instruct` | vision |
| `lib/embed.ts` | `THOTH_EMBED_MODEL` | `qwen/qwen3-embedding-8b` | embedding (CKB/RAG) |
| `enrich/web_grounding.ts` | — | — (scrape Google News, tanpa LLM) | status entitas terkini |
| `scrapers/crop_post.ts` | — | — (DOM crop via CDP, tanpa LLM) | crop kartu postingan non-video (X/IG/FB) — jalur utama |

> CKB (`enrich/ckb.ts`) menyimpan ke **Supabase Postgres** — bukan model, tapi butuh `npm install pg` +
> `THOTH_SUPABASE_URL` di `.env` root. Lihat
> [scout/README.md](../scout/README.md).

---

## 3. Script Python (`scripts/`)

| Script | Model | Catatan |
|---|---|---|
| `scripts/media/annotate_assets.py` | Novita vision `qwen/qwen3-vl-235b-a22b-instruct` **atau** OpenRouter `google/gemini-2.5-flash` (`--backend`) | anotasi SFX/meme/font |
| `scripts/narration/analyze_narration_structure.py` | LLM via **Novita** (`qwen/qwen-2.5-72b-instruct` default, ikut `[llm] novita_model` bila di-set) + embedding `qwen/qwen3-embedding-8b`. Groq (`THOTH_GROQ_API_KEY`) hanya dipakai untuk fallback transkripsi Whisper, bukan analisis struktur | isi korpus `narration_structures` (RAG) |
| `scripts/render/render_cover.py` | FLUX.1 schnell + merge-face + chat/vision dari spec | dipanggil stage cover |

---

## 4. Cara mengganti model

- **Pipeline inti**: edit `config.toml` (lihat [config.toml.example](../config.toml.example) untuk semua field + komentar).
- **scout**: set env sebelum menjalankan, mis. `THOTH_VISION_MODEL=qwen/qwen3-vl-235b-a22b-instruct`.
- **Provider lain**: ganti `[llm] default_provider` + isi `<provider>_model` + API key di `.env`.

## 5. Rekomendasi (performa terbaik per dolar)

- **Analyze / narasi / task teks**: `deepseek/deepseek-v3.1` (chat non-reasoning → JSON andal).
  HINDARI varian `*-flash`/reasoning (sering memotong JSON). Alternatif: `qwen/qwen3-235b-a22b-instruct-2507`,
  `zai-org/glm-4.6`, atau (OpenRouter) `google/gemini-2.5-flash`, `anthropic/claude-sonnet-4-5`.
- **Vision frame-desc** (grounding visual narasi): `qwen/qwen3-vl-235b-a22b-instruct` (paling akurat).
  Lebih murah: `qwen/qwen3-vl-30b-a3b-instruct`. ⚠️ `qwen2.5-vl-72b` & `qwen3-vl-8b` DEPRECATED di
  Novita (MODEL_NOT_AVAILABLE, 2026-07) — jangan dipakai lagi.
- **Vision crop scout**: `qwen3-vl-30b-a3b` cukup (jalur fallback; crop utama via DOM). Naikkan via `THOTH_VISION_MODEL` bila perlu.
- **Cover**: `gemini-2.5-flash-image` (identitas bagus, murah). 
- **Embedding**: jangan ganti tanpa re-index (dimensi kolom Supabase = 4096 untuk `qwen3-embedding-8b`).

---

## 6. Lokal vs Cloud

| Berjalan LOKAL | Berjalan di CLOUD |
|---|---|
| Whisper (`large-v3`, CUDA) · rembg cutout · FFmpeg/NVENC · wgpu color-grade/transition · SadTalker (avatar) | Analyze · Narration · Vision · Embedding · Cover image (FLUX/Gemini) · face-swap · TTS (ElevenLabs/MiniMax/Fish) · scout (Novita) |

Self-host penuh dimungkinkan via `vllm`/`ollama` (LLM) + `[vision] vllm_model` + Edge-TTS.
