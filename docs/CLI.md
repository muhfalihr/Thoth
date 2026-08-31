# Thoth CLI Reference

Generated from `thoth --help` (and each subcommand's `--help`). Keep this in sync
with `crates/thoth-core/src/cli.rs` whenever the CLI surface changes.

## Python v1 workflow client

`thoth-control` is the thin operator client for the Python control plane. Run it from `python/`
after `uv sync --all-groups`:

```powershell
uv run thoth-control workflow start --url https://example.com/source --style news-vertical
uv run thoth-control workflow watch <workflow_id>
uv run thoth-control workflow approve <workflow_id> --approval-id <approval_id> --decision approve
uv run thoth-control workflow cancel <workflow_id>
uv run thoth-control workflow retry <workflow_id> --from-stage source
```

Set `THOTH_CONTROL_PLANE_URL` (default `http://localhost:8000`) and
`THOTH_CONTROL_PLANE_API_KEY` without printing or committing their values. Every command sends the
same typed `/api/v1/workflows` HTTP contract used by the dashboard. It has no Scout/Bun subprocess
route and does not implement alternate orchestration. Durable retry is deliberately unavailable
and returns `503` until checkpoint and artifact-fingerprint validation can prevent duplicate side
effects.

`workflow watch` opens the authorized `/events` Server-Sent Events stream and prints each typed
lifecycle event until the server closes the stream; it is not a one-time status lookup.

The Rust `thoth scout` command below remains a clearly labelled legacy operator path. It may be
used by the isolated worker-only compatibility adapter, but new v1 API/dashboard/CLI traffic never
calls `/api/scout/*` or shapes a `scout/cli.ts` command.

> On Windows the binary is `thoth.exe` (or `.\target\release\thoth.exe`); on
> Linux/macOS it is `thoth` (or `./target/release/thoth`). The examples below use
> the bare name `thoth` — assume it is on your `PATH` or prefix the release path.

```
Thoth — AI short-form video strategist: source, narrate, and edit viral clips

Usage: thoth <COMMAND>
```

| Command | Purpose |
|---|---|
| [`run`](#run) | **Full end-to-end pipeline** (ingest → transcribe → analyze → edit) |
| [`ingest`](#ingest) | Download a single video |
| [`transcribe`](#transcribe) | Transcribe a video with Whisper |
| [`analyze`](#analyze) | Find viral moments from a transcript with an LLM |
| [`edit`](#edit) | Cut, reframe, and burn subtitles into clips |
| [`worker`](#worker) | Run as a persistent warm worker against the SQLite job queue |
| [`trend-analyze`](#trend-analyze) | Analyze trending videos → generate a style profile |
| [`vocab`](#vocab) | Manage the dynamic vocabulary (Supabase) |
| [`thumbnail`](#thumbnail) | Regenerate thumbnails from a previous job |
| [`scout`](#scout) | Pass-through to `scout/cli.ts` (TypeScript content sourcing) |
| `help` | Print help (also: `thoth <command> --help`) |

Global flags: `-h, --help` · `-V, --version`

> For running the two-process server + worker deployment, see
> **[RUNNING.md](RUNNING.md)**. For installation and build, see
> **[INSTALL.md](INSTALL.md)**.

---

## `run`

**The main pipeline** — end-to-end: ingest → transcribe → analyze → edit.

```
Usage: thoth run [OPTIONS] [URL]
```

**Arguments**

| | Description |
|---|---|
| `[URL]` | Single video URL (default mode). Takes precedence over `--content`. |

**Options**

| Flag | Default | Description |
|---|---|---|
| `--content <FILE>` | — | Content-set JSON from **scout** (`{main, footage, comments, ...}`) → narrator-driven mode. Discovery is handled by scout; Thoth does not search on its own. The footage list is written to `<output_dir>/content_enrichment.json` for the edit/narration stages. |
| `-o, --output-dir <DIR>` | `./output` | Output directory for all job artifacts |
| `--provider <PROVIDER>` | `novita` | LLM provider for analysis — see the [provider table](#provider-values) |
| `--model <MODEL>` | `medium` | Whisper model size — `tiny` \| `base` \| `small` \| `medium` \| `large-v3` |
| `--max-clips <N>` | `3` | Maximum number of viral clips to produce |
| `--layout <LAYOUT>` | `vertical` | `vertical` (9:16) \| `horizontal` (16:9) \| `square` (1:1) |
| `--language <LANG>` | auto | Transcription language code (e.g. `id`, `en`). Auto-detected if empty |
| `--keywords <KEYWORDS>` | — | Focus-keyword override (comma-separated) — takes priority over automatic LLM extraction; usually unnecessary |
| `--sfx-intro <FILE>` | — | SFX at the start of each clip |
| `--bgm <FILE>` | — | Background music (looped, mixed low under the clip audio) |
| `--bgm-volume <0.0–1.0>` | `0.12` (≈ −18 dB) | BGM volume |
| `--clip-style <STYLE>` | `fade` | `fade` \| `flash` \| `zoom` \| `smooth` \| `none` |
| `--social <HANDLE>` | `""` (auto from channel) | Social handle shown on the headline panel |
| `--headline-dur <SEC>` | `4` | Headline-panel display duration |
| `--font-dir <DIR>` | `assets/fonts` | Font folder (`Poppins-Bold.ttf` / `Poppins-Regular.ttf` auto-download if missing) |
| `--font-bold <FILE>` | `Poppins-Bold.ttf` | Bold font for headline & subtitles (relative to `--font-dir`) |
| `--font-regular <FILE>` | `Poppins-Regular.ttf` | Regular font for source-credit text |
| `--social-icon <PNG>` | — | PNG icon replacing the `@handle` text on the headline panel |
| `--social-icon-size <PX>` | `48` | Displayed icon size |
| `--social-icon-min-size <PX>` | `16` | Minimum icon size |
| `--social-icon-max-size <PX>` | `128` | Maximum icon size |
| `--resume <JOB_ID>` | — | Resume a previously failed job (skips already-completed stages) |
| `--style-profile <NAME>` | `auto` | Apply a named style profile from `config.toml [styles.profiles]` — overrides the LLM's per-clip `subtitle_style`/`clip_style`/`sfx_vibe`/`bgm_vibe`/`overlay_style`. `auto` lets the LLM decide per clip |

```bash
thoth run "https://youtu.be/xxxx"
thoth run ./video.mp4 --max-clips 5 --layout vertical
thoth run "https://youtu.be/xxxx" --style-profile tiktok_id_2025
thoth run "https://youtu.be/xxxx" --provider claude --layout square
thoth run --content scout/output/thoth_content_set.json --provider novita   # narrator-driven
thoth run --resume <JOB_ID>
```

> **Narrator-driven mode**: run with `--content set.json` (or enable `[narration]`)
> to build the video around a narrator voiceover. Use `--provider novita` for the
> narration (the default `groq` is rate-limited and will fall back to clip-mode).

---

## `ingest`

Download a video for processing.

```
Usage: thoth ingest [OPTIONS] <URL>
```

| Argument | Description |
|---|---|
| `<URL>` | Video URL to download |

| Flag | Default | Description |
|---|---|---|
| `-o, --output-dir <DIR>` | `./output` | Output directory for all job artifacts |
| `--force` | — | Force re-download even if the file already exists |

```bash
thoth ingest "https://youtu.be/xxxx"
thoth ingest "https://youtu.be/xxxx" --force -o ./output
```

---

## `transcribe`

Transcribe a video file using Whisper.

```
Usage: thoth transcribe [OPTIONS] <VIDEO_PATH>
```

| Argument | Description |
|---|---|
| `<VIDEO_PATH>` | Path to the source video file |

| Flag | Default | Description |
|---|---|---|
| `-o, --output-dir <DIR>` | `./output` | Output directory for the transcript JSON |
| `--model <MODEL>` | `medium` | Whisper model size — `tiny` \| `base` \| `small` \| `medium` \| `large-v3` |
| `--language <LANGUAGE>` | auto | Language code (e.g. `id`, `en`). Auto-detects if empty |

```bash
thoth transcribe ./output/video.mp4 --model large-v3 --language id
```

---

## `analyze`

Identify viral moments using an LLM.

```
Usage: thoth analyze [OPTIONS] <TRANSCRIPT_PATH>
```

| Argument | Description |
|---|---|
| `<TRANSCRIPT_PATH>` | Path to the transcript JSON produced by `transcribe` |

| Flag | Default | Description |
|---|---|---|
| `--provider <PROVIDER>` | `novita` | LLM provider — see the [provider table](#provider-values) |
| `--max-clips <N>` | `3` | Maximum number of viral clips to find |
| `--keywords <KEYWORDS>` | — | *[Optional override]* Focus keywords, comma-separated. Takes priority over automatic LLM extraction — usually unnecessary |
| `--video-path <VIDEO_PATH>` | — | Source video path; if set **and** `[vision] enabled = true`, analyze extracts frames and scores each candidate moment visually (humor/impact/novelty/engagement) before picking the final clips |
| `--title <TITLE>` | `""` | Video title (optional — metadata for the RAG database) |
| `--channel <CHANNEL>` | `""` | Channel/creator name (optional — metadata for the RAG database) |

```bash
thoth analyze ./output/transcript.json --provider claude --max-clips 5
```

### Provider values

Used by `analyze`, `run`, and `trend-analyze`.

| Provider | Notes |
|---|---|
| `novita` **(default for `analyze`/`run`)** | Fast & cheap, OpenAI-compatible. Models: `meta-llama/llama-3.3-70b-instruct`, `deepseek/deepseek-r1-turbo`, etc. Set `THOTH_NOVITA_API_KEY` |
| `groq` | OpenAI-compatible; also provides the Whisper API for `transcribe`. Rate-limited free tier |
| `openai` | Set `THOTH_OPENAI_API_KEY` |
| `claude` | Anthropic — `claude-sonnet-4-5` \| `claude-opus-4-5` \| `claude-haiku-3-5`. Set `THOTH_CLAUDE_API_KEY` + optional `claude_model` in `config.toml` |
| `gemini` | Google — `gemini-2.0-flash` \| `gemini-1.5-pro` \| `gemini-2.5-pro`. Set `THOTH_GEMINI_API_KEY` |
| `vllm` | Self-hosted vLLM server (OpenAI-compatible). Set `vllm_base_url` + `vllm_model` in `config.toml` |
| `ollama` | Local Ollama server (OpenAI-compatible) |
| `together` | OpenAI-compatible, wide model selection. Set `THOTH_TOGETHER_API_KEY` |
| `fireworks` | OpenAI-compatible, fast open-source serving. Set `THOTH_FIREWORKS_API_KEY` |

> `trend-analyze` uses the same provider list but defaults to `gemini` (vision-capable, for visual-style analysis).

---

## `edit`

Cut, reframe, and burn subtitles into clips.

```
Usage: thoth edit [OPTIONS] <VIDEO_PATH> <MOMENTS_PATH> <TRANSCRIPT_PATH>
```

| Argument | Description |
|---|---|
| `<VIDEO_PATH>` | Path to the source video file |
| `<MOMENTS_PATH>` | Path to the viral-moments JSON produced by `analyze` |
| `<TRANSCRIPT_PATH>` | Path to the transcript JSON (for subtitle burn-in) |

| Flag | Default | Description |
|---|---|---|
| `--layout <LAYOUT>` | `vertical` | `vertical` (9:16 TikTok/Reels/Shorts) \| `horizontal` (16:9) \| `square` (1:1 IG feed) |
| `-o, --output-dir <DIR>` | `./output` | Output directory for rendered clips |
| `--sfx-intro <FILE>` | — | SFX at the start of each clip (MP3/WAV/AAC), mixed with the video audio |
| `--bgm <FILE>` | — | BGM, auto-looped, mixed low under the clip audio |
| `--bgm-volume <0.0–1.0>` | `0.12` (≈ −18 dB) | BGM volume |
| `--clip-style <STYLE>` | `fade` | IN/OUT transition — see the table below |
| `--social <HANDLE>` | `""` | Social handle in the top-left of the headline panel (e.g. `@handle`) |
| `--source-channel <NAME>` | — | Channel/creator name for source credit on the headline panel |
| `--headline-dur <SEC>` | `4` | Headline-panel display duration (seconds) |
| `--font-dir <DIR>` | `assets/fonts` | Font folder (`Poppins-Bold.ttf` / `Poppins-Regular.ttf` auto-download if missing) |
| `--font-bold <FILE>` | `Poppins-Bold.ttf` | Bold font for headline & subtitles (relative to `--font-dir`) |
| `--font-regular <FILE>` | `Poppins-Regular.ttf` | Regular font for source-credit text |
| `--social-icon <PNG>` | — | PNG icon replacing the `@handle` text on the headline panel |
| `--social-icon-size <PX>` | `48` | Displayed icon size |
| `--social-icon-min-size <PX>` | `16` | Minimum icon size |
| `--social-icon-max-size <PX>` | `128` | Maximum icon size |
| `--style-profile <NAME>` | `auto` | Apply a named style profile from `config.toml [styles.profiles]` |

### `--clip-style` values

| Value | Description |
|---|---|
| `fade` **(default)** | Fade from/to black — works for any content |
| `flash` | Flash from/to white — energetic, good for memes/reactions |
| `zoom` | Ken Burns zoom-in push at the start + fade out |
| `smooth` | Long, soft fade (0.8s) — cinematic/professional |
| `none` | No transition — instant cut |

```bash
thoth edit ./output/video.mp4 ./output/moments.json ./output/transcript.json \
  --layout vertical --clip-style zoom --bgm ./music/lofi.mp3 --style-profile tiktok_id_2025
```

---

## `worker`

Run as a persistent warm worker: pull queued jobs from the shared SQLite queue and
execute them in-process (models stay resident between jobs). This is the engine
half of the two-process server + worker deployment — see **[RUNNING.md](RUNNING.md)**
for the full launch story.

```
Usage: thoth worker [OPTIONS]
```

| Flag | Default | Env | Description |
|---|---|---|---|
| `--db <DB>` | `thoth.db` | `THOTH_DB` | Path to the shared SQLite job database (the same file `thoth-server` opens) |

```bash
thoth worker --db ./thoth.db
# or:
THOTH_DB=./thoth.db thoth worker
```

---

## `trend-analyze`

Analyze trending videos to generate a reusable style profile.

```
Usage: thoth trend-analyze [OPTIONS] --output-profile <OUTPUT_PROFILE> <URL>
```

| Argument | Description |
|---|---|
| `<URL>` | Sample-video source URL. Examples: a hashtag page, a search query (e.g. `ytsearch5:trending shorts 2025`), or a single video |

| Flag | Default | Description |
|---|---|---|
| `--sample <N>` | `5` | Number of sample videos to download & analyze |
| `--provider <PROVIDER>` | `gemini` | Vision LLM provider for style analysis: `gemini` \| `openai` \| `claude` \| `vllm` (see the [provider table](#provider-values)) |
| `--output-profile <NAME>` | **required** | Name of the generated style profile (saved to `config.toml` + `style_profiles/`) |
| `--output-dir <DIR>` | `style_profiles` | Folder for downloaded sample clips + the generated profile |

```bash
thoth trend-analyze "https://www.tiktok.com/tag/example" --sample 10 --output-profile tiktok_id_latest
```

---

## `vocab`

Manage the dynamic vocabulary (word lists stored in Supabase).

```
Usage: thoth vocab <COMMAND>
```

| Subcommand | Purpose |
|---|---|
| `add` | Add one word to a vocabulary category |
| `list` | List all words in a category |
| `review` | Review auto-discovered candidate words (approve/reject) |
| `seed` | Seed the vocabulary into Supabase from a built-in dataset or a URL |
| `refresh` | Refresh the in-memory vocabulary cache from Supabase |
| `stats` | Show vocabulary statistics |

### `vocab add`

```
Usage: thoth vocab add [OPTIONS] <CATEGORY> <WORD>
```

| | Description |
|---|---|
| `<CATEGORY>` | `tone_funny` \| `tone_serious` \| `intro` \| `name_titles` \| `stop_words` \| `energy_high` \| `energy_low` \| `vibe` |
| `<WORD>` | The word/phrase to add |
| `--subcategory <SUB>` | For `vibe`: `impact` \| `whoosh` \| `ding` \| `comedy` \| …; for `stop_words`: `id` \| `en` |
| `--language <LANG>` | `id` \| `en` \| `mixed` (default `id`) |
| `--notes <TEXT>` | Optional note on why the word matters |

```bash
thoth vocab add tone_funny "wkwkwk" --language id
```

### `vocab list`

```bash
thoth vocab list tone_funny
```

### `vocab review`

Interactive — review auto-discovered candidate words and approve/reject them one by one.

```bash
thoth vocab review
```

### `vocab seed`

```
Usage: thoth vocab seed [OPTIONS]
```

Built-in datasets: `defaults` (all hardcoded word lists — run once after SQL setup),
`kamus-alay` (Indonesian slang, ~3000 words), `openslr-stopwords` (Indonesian
stop-words, ~758 words). Or use `--url` to download from a direct file URL. Supported
formats (auto-detected from extension/content): `.txt` (one word per line),
`.csv`/`.tsv` (first column = word, optional second = label/translation), `.json`
(array of strings, or array of `{"word":…, "label":…}` objects).

| Flag | Default | Description |
|---|---|---|
| `--source <SOURCE>` | `defaults` | `defaults` \| `kamus-alay` \| `openslr-stopwords` |
| `--url <URL>` | — | Download from a URL instead of a built-in dataset |
| `--category <CATEGORY>` | — | Target category for words from `--url` (**required** when `--url` is used) |
| `--subcategory <SUB>` | — | e.g. a vibe name (`impact`) or a stop-words language (`id`/`en`) |
| `--language <LANG>` | `id` | Language code for the seeded words |
| `--column <N>` | `0` | 0-based column index to use as the word, for CSV/TSV |
| `--skip-header` | — | Skip the header row in CSV/TSV |
| `--label-filter <TEXT>` | — | Only seed rows whose column[1] contains this text (CSV/TSV) |

```bash
thoth vocab seed --source defaults
thoth vocab seed --url https://example.com/words.txt --category tone_funny
```

### `vocab refresh` / `vocab stats`

```bash
thoth vocab refresh
thoth vocab stats
```

---

## `thumbnail`

Regenerate thumbnails for previously rendered clips.

```
Usage: thoth thumbnail [OPTIONS] <JOB_ID>
```

| Argument | Description |
|---|---|
| `<JOB_ID>` | ID of the job that contains the output clips |

| Flag | Default | Description |
|---|---|---|
| `-o, --output-dir <DIR>` | `./output` | Directory where jobs are stored |

```bash
thoth thumbnail <JOB_ID>
```

---

## `scout`

Run scout content-sourcing commands (TypeScript, requires Node ≥ 24).

Delegates to `scout/cli.ts` — every scout subcommand & flag is forwarded transparently
(`trailing_var_arg`). See [scout/README.md](../scout/README.md) for full documentation.

```
Usage: thoth scout [ARGS]...
```

Available subcommands: `browser`, `discover`, `trending`, `run`, `comments`, `footage`,
`figures`, `enrich`, `images`, `validate`, `pulse`, `topics`, `news`.

```bash
thoth scout browser status
thoth scout discover --max-per 4 --hours 48 --tiktok
thoth scout run <url> --out set.json --per 2 --max 4
thoth scout validate <set.json>
```

---

*Regenerate any section manually with `thoth <command> --help`.*
