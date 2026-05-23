# CLIPPER - AI-Powered Short-Form Video Strategist

CLIPPER is a Rust-based CLI tool that automates the creation of short-form videos (TikTok, Reels, Shorts) from long-form content. It uses advanced AI to analyze viral potential, create powerful hooks, and perform automated video editing using FFmpeg.

## ✨ Key Features

- **AI Viral Analysis:** Uses LLMs to detect the most viral-worthy moments.
- **Hook & Headline Generator:** Automatically creates a 3-second opening hook and a "news-ticker" style headline.
- **Smart Overlay Content:** Automatically searches and downloads memes/B-roll from TikTok/YouTube.
- **Advanced Subtitles:** Supports various subtitle styles (Karaoke, CapCut Bold, Word Pop) with beat-aligned animations.
- **RAG (Retrieval-Augmented Generation):** Learns from past clip performance using Supabase.
- **YouTube Integration:** Supports automatic downloading and usage of native YouTube transcripts.

---

## 💻 CLI Commands

### 1. `run` (Main Pipeline)
Processes a video from start to finish.
```bash
clipper run <URL_OR_PATH> [OPTIONS]
```
- `<URL_OR_PATH>`: YouTube URL or local video file path.
- `--max-clips <N>`: Maximum viral moments to extract (default: 3).
- `--provider <NAME>`: LLM provider: `claude`, `gemini`, `openai`, `groq`, `ollama`, `vllm`.
- `--layout <TYPE>`: Video layout: `portrait` (9:16), `square` (1:1), `landscape` (16:9).
- `--focus <KEYWORDS>`: Comma-separated keywords to prioritize during analysis.
- `--resume <JOB_ID>`: Resume a failed or partial job.

### 2. `vocab` (Knowledge Management)
Manage the vocabulary and keywords used for analysis.
```bash
clipper vocab <SUBCOMMAND>
```
- `seed defaults`: Populate the database with default viral keywords.
- `list <CATEGORY>`: List words in a category (e.g., `tone_funny`, `energy_high`).
- `add <CATEGORY> <WORD>`: Manually add a new word to the cache.
- `review`: Interactive review of auto-suggested candidate words.
- `stats`: Show database connection status and word counts.

### 3. `thumbnail`
Regenerate thumbnails for an existing job.
```bash
clipper thumbnail --job-id <ID>
```

---

## ⚙️ Configuration (`config.toml`)

The `config.toml` file controls the default behavior of the pipeline.

```toml
[analyze]
provider = "claude"        # Default LLM provider
max_clips = 3              # Default number of clips
vision_enabled = true      # Enable frame analysis for better context

[edit]
font_dir = "fonts"         # Path to TTF/OTF files
headline_dur = 4.0         # How many seconds to show the headline
bgm_volume = 0.12          # Background music volume (0.0 to 1.0)

[overlay]
enabled = true             # Enable TikTok/YouTube meme inserts
max_duration = 8.0         # Max length of an overlay clip
max_variants = 3           # How many different clips to try per query
fallback_to_youtube = true # Use YouTube Shorts if TikTok fails

[vector_db]
enabled = true             # Enable RAG (Retrieval-Augmented Generation)
min_similarity = 0.75      # Threshold for matching past successful clips
```

---

## 🔐 Environment Variables (`.env`)

Used for API keys and database credentials.

| Variable | Description |
| :--- | :--- |
| `CLIPPER_CLAUDE_API_KEY` | Anthropic API Key |
| `CLIPPER_GEMINI_API_KEY` | Google AI Studio API Key |
| `CLIPPER_OPENAI_API_KEY` | OpenAI API Key |
| `CLIPPER_GROQ_API_KEY` | Groq API Key (Fastest for Whisper/Llama) |
| `CLIPPER_SUPABASE_URL` | PostgreSQL connection string for RAG |
| `CLIPPER_EMBED_API_KEY` | (Optional) API key for embeddings if different from LLM |
| `FFMPEG_PATH` | (Optional) Custom path to FFmpeg binary |

---

## 🗄 RAG Database Schema

If you enable RAG, run this in your Supabase SQL Editor:
```sql
ALTER TABLE viral_moments 
ADD COLUMN headline TEXT,
ADD COLUMN clip_style TEXT,
ADD COLUMN sfx_vibe TEXT,
ADD COLUMN bgm_vibe TEXT,
ADD COLUMN subtitle_style TEXT,
ADD COLUMN overlay_style TEXT,
ADD COLUMN overlay_position TEXT,
ADD COLUMN sfx_at_sec DOUBLE PRECISION;
```

---
## 📄 License & Copyright

Copyright (c) 2026 CLIPPER. **All Rights Reserved.**

This software is **Proprietary**. Unauthorized copying, modification, or distribution of this software via any medium is strictly prohibited. For licensing inquiries, please contact the owner.

Built with ❤️ for content creators.
