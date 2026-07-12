# Models Reference

A list of **every AI model** Thoth + scout use, where each is configured, and how to
swap it. Almost everything runs in the **cloud** (Novita / OpenRouter / Groq /
ElevenLabs); the only thing that can run **locally** is Whisper (transcription, CUDA).

> In short: **analysis & narration = text-LLM**, **frame description & crop = vision-LLM**,
> **cover = image-gen + face-swap**, **voice = TTS**, **RAG = embedding**,
> **transcription = Whisper**.

---

## 1. Thoth core pipeline (Rust) — configured via `config.toml`

| Stage / function | Key in `config.toml` | Default model | Provider |
|---|---|---|---|
| **Analyze** (viral-moment extraction → JSON) | `[llm] default_provider` + `novita_model` | `deepseek/deepseek-v3.1` | Novita |
| **Narration** (narrator script) | `[narration] model` (provider from `--provider`) | `deepseek/deepseek-v3.1` | Novita |
| **Vision** (frame description, `describe_video`) | `[vision] novita_model` | `qwen/qwen3-vl-235b-a22b-instruct` | Novita |
| **Embedding** (moment + narration-structure RAG) | `[vector_db] embed_model` | `qwen/qwen3-embedding-8b` (4096-d) | Novita |
| **Cover image** (background) | `[cover] image_engine` + `image_model` | `google/gemini-2.5-flash-image` (engine `openrouter`) | OpenRouter |
| **Cover background (alt)** | `[cover] image_engine="flux"` | **FLUX.1 [schnell]** (`/v3beta/flux-1-schnell`) | Novita |
| **Cover face-swap** | automatic when `face_swap=true` | **merge-face** (`/v3/merge-face`) | Novita |
| **Cover subject cutout** | `[cover] rembg_model` | `u2net_human_seg` (rembg, local) | local |
| **Cover chat/vision** (prompt + subject description) | follows `[llm]` + `[vision]` | `deepseek-v3.1` + `qwen3-vl-235b-a22b` | Novita |
| **TTS** (narrator/reaction voice) | `[reaction.tts] provider` + `*_model` | `eleven_multilingual_v2` (ElevenLabs) | ElevenLabs |
| **Transcribe** | `[whisper] model_size` | `large-v3` | Groq API / **local CUDA** |

### Other analyze providers (if you change `default_provider`)

Stored in `[llm]` (only the one selected by `default_provider` is active):

| Provider | Key | Default |
|---|---|---|
| groq | `groq_model` | `llama-3.3-70b-versatile` |
| openai | `openai_model` | `gpt-4o-mini` |
| claude | `claude_model` | `claude-sonnet-4-5` |
| gemini | `gemini_model` | `gemini-2.0-flash` |
| vllm | `vllm_model` | `Qwen/Qwen2.5-72B-Instruct` (self-host) |
| ollama | `ollama_model` | `llama3:70b` (self-host) |

### Other TTS choices

`minimax` (`minimax_model=speech-02-hd`) · `fish` (`fish_audio_model=s2-pro`) ·
`openai` (`openai_model=tts-1-hd`) · `edge` (Edge-TTS, free, default fallback).

---

## 2. scout (content sourcing, TypeScript) — configured via **env vars**

scout runs via `node scout/cli.ts <cmd>` (full TypeScript, native Node ≥ 24 type
stripping). All secrets — including `THOTH_NOVITA_API_KEY` / `THOTH_SUPABASE_URL` — live
in the **single root `.env`** via `scout/lib/env.ts`. Models are overridden through env
vars; defaults are embedded in the scripts.

| Script | Env override | Default | Task |
|---|---|---|---|
| `lib/footage_objects.ts` | `THOTH_LLM_MODEL` | `deepseek/deepseek-v3.1` | extract subject/object (text) |
| `pipeline/extract_figures.ts` | `THOTH_LLM_MODEL` | `deepseek/deepseek-v3.1` | extract figures (text) |
| `enrich/enrich_context.ts` | `THOTH_CONTEXT_MODEL` | `deepseek/deepseek-v3.1` | decode comment subtext (text) |
| `enrich/pulse_harvest.ts` | `THOTH_CONTEXT_MODEL` | `deepseek/deepseek-v3.1` | distill discourse trends (text) |
| `pipeline/resolve_source.ts` | `THOTH_LLM_MODEL` | `qwen/qwen3-vl-30b-a3b-instruct` | determine the original source |
| `scrapers/vision_crop.ts` | `THOTH_VISION_MODEL` | `qwen/qwen3-vl-30b-a3b-instruct` | bounding-box crop (vision) — **last-resort fallback only**; the primary crop is `scrapers/crop_post.ts` (DOM pixel-perfect, no LLM) |
| `pipeline/trace_source.ts` | `THOTH_VISION_MODEL` | `qwen/qwen3-vl-30b-a3b-instruct` | vision |
| `pipeline/discover_reels.ts` | `THOTH_VISION_MODEL` | `qwen/qwen3-vl-30b-a3b-instruct` | read cover headlines |
| `lib/comments.ts` | `THOTH_VISION_MODEL` | `qwen/qwen3-vl-30b-a3b-instruct` | vision |
| `lib/embed.ts` | `THOTH_EMBED_MODEL` | `qwen/qwen3-embedding-8b` | embedding (CKB/RAG) |
| `enrich/web_grounding.ts` | — | — (scrapes news, no LLM) | current entity status |
| `scrapers/crop_post.ts` | — | — (DOM crop via CDP, no LLM) | crop non-video post cards (X/IG/FB) — primary path |

> The CKB (`enrich/ckb.ts`) writes to **Supabase Postgres** — not a model, but it needs
> `npm install pg` + `THOTH_SUPABASE_URL` in the root `.env`. See
> [scout/README.md](../scout/README.md).

---

## 3. Python scripts (`scripts/`)

| Script | Model | Notes |
|---|---|---|
| `scripts/media/annotate_assets.py` | Novita vision `qwen/qwen3-vl-235b-a22b-instruct` **or** OpenRouter `google/gemini-2.5-flash` (`--backend`) | annotate SFX/meme/font |
| `scripts/narration/analyze_narration_structure.py` | LLM via **Novita** (`qwen/qwen-2.5-72b-instruct` default, follows `[llm] novita_model` if set) + embedding `qwen/qwen3-embedding-8b`. Groq (`THOTH_GROQ_API_KEY`) is used only for the Whisper transcription fallback, not for structure analysis | fill the `narration_structures` corpus (RAG) |
| `scripts/render/render_cover.py` | FLUX.1 schnell + merge-face + chat/vision from the spec | called by the cover stage |

---

## 4. How to change a model

- **Core pipeline**: edit `config.toml` (see [config.toml.example](../config.toml.example) for all fields + comments).
- **scout**: set an env var before running, e.g. `THOTH_VISION_MODEL=qwen/qwen3-vl-235b-a22b-instruct`.
- **Other provider**: change `[llm] default_provider`, fill `<provider>_model`, and set the API key in `.env`.

## 5. Recommendations (best performance per dollar)

- **Analyze / narration / text tasks**: `deepseek/deepseek-v3.1` (non-reasoning chat →
  reliable JSON). Avoid `*-flash`/reasoning variants (they often truncate JSON).
  Alternatives: `qwen/qwen3-235b-a22b-instruct-2507`, `zai-org/glm-4.6`, or (OpenRouter)
  `google/gemini-2.5-flash`, `anthropic/claude-sonnet-4-5`.
- **Vision frame description** (visual narration grounding): `qwen/qwen3-vl-235b-a22b-instruct`
  (most accurate). Cheaper: `qwen/qwen3-vl-30b-a3b-instruct`. ⚠️ `qwen2.5-vl-72b` &
  `qwen3-vl-8b` are DEPRECATED on Novita (MODEL_NOT_AVAILABLE) — do not use them.
- **scout vision crop**: `qwen3-vl-30b-a3b` is enough (fallback path; the primary crop is
  DOM-based). Raise it via `THOTH_VISION_MODEL` if needed.
- **Cover**: `gemini-2.5-flash-image` (good identity, cheap).
- **Embedding**: don't change without re-indexing (the Supabase column dimension is 4096
  for `qwen3-embedding-8b`).

---

## 6. Local vs Cloud

| Runs LOCALLY | Runs in the CLOUD |
|---|---|
| Whisper (`large-v3`, CUDA) · rembg cutout · FFmpeg/NVENC · wgpu color-grade/transition · talking-head avatar | Analyze · Narration · Vision · Embedding · Cover image (FLUX/Gemini) · face-swap · TTS (ElevenLabs/MiniMax/Fish) · scout (Novita) |

Full self-hosting is possible via `vllm`/`ollama` (LLM) + `[vision] vllm_model` + Edge-TTS.
