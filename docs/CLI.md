# Thoth CLI Reference

Dihasilkan dari `.\target\release\thoth.exe --help` (dan `--help` tiap subcommand),
binary rilis `build_cuda.bat`. Update dokumen ini setiap kali `src/cli.rs` berubah.

```
Thoth — AI short-form video strategist: source, narrate, and edit viral clips

Usage: thoth.exe <COMMAND>
```

| Command | Fungsi singkat |
|---|---|
| [`ingest`](#ingest) | Download 1 video YouTube |
| [`transcribe`](#transcribe) | Transkrip video via Whisper (CUDA) |
| [`analyze`](#analyze) | Cari momen viral dari transkrip via LLM |
| [`edit`](#edit) | Potong, reframe, burn subtitle jadi klip |
| [`run`](#run) | **Pipeline penuh end-to-end** (ingest→transcribe→analyze→edit) |
| [`trend-analyze`](#trend-analyze) | Analisis video trending → generate style profile |
| [`vocab`](#vocab) | Kelola vocabulary dinamis (Supabase) |
| [`thumbnail`](#thumbnail) | Generate ulang thumbnail dari job lama |
| [`scout`](#scout) | Pass-through ke `scout/cli.ts` (TypeScript, sourcing konten) |
| `help` | Cetak help (juga: `thoth <command> --help`) |

Global: `-h, --help` · `-V, --version`

---

## `ingest`

Download a YouTube video for processing.

```
Usage: thoth.exe ingest [OPTIONS] <URL>
```

**Argumen**
| | Deskripsi |
|---|---|
| `<URL>` | YouTube URL to download |

**Opsi**
| Flag | Default | Deskripsi |
|---|---|---|
| `-o, --output-dir <OUTPUT_DIR>` | `./output` | Output directory for all job artifacts |
| `--force` | — | Force re-download even if the file already exists |

```bash
thoth ingest "https://youtu.be/xxxx"
thoth ingest "https://youtu.be/xxxx" --force -o ./output
```

---

## `transcribe`

Transcribe a video file using Whisper (CUDA).

```
Usage: thoth.exe transcribe [OPTIONS] <VIDEO_PATH>
```

**Argumen**
| | Deskripsi |
|---|---|
| `<VIDEO_PATH>` | Path to the source video file |

**Opsi**
| Flag | Default | Deskripsi |
|---|---|---|
| `-o, --output-dir <OUTPUT_DIR>` | `./output` | Output directory for transcript JSON |
| `--model <MODEL>` | `medium` | Whisper model size — `tiny` \| `base` \| `small` \| `medium` \| `large-v3` |
| `--language <LANGUAGE>` | auto | Language code (e.g. `id`, `en`). Auto-detects if empty |

```bash
thoth transcribe ./output/video.mp4 --model large-v3 --language id
```

---

## `analyze`

Identify viral moments using an LLM.

```
Usage: thoth.exe analyze [OPTIONS] <TRANSCRIPT_PATH>
```

**Argumen**
| | Deskripsi |
|---|---|
| `<TRANSCRIPT_PATH>` | Path to the transcript JSON file produced by `transcribe` |

**Opsi**
| Flag | Default | Deskripsi |
|---|---|---|
| `--provider <PROVIDER>` | `novita` | LLM provider — lihat [tabel provider](#provider-values-analyze--run--trend-analyze) |
| `--max-clips <N>` | `3` | Maximum number of viral clips to find |
| `--keywords <KEYWORDS>` | — | **[Override opsional]** Focus keywords, comma-separated (mis. `"prabowo,dollar,AI"`). Prioritas di atas ekstraksi otomatis LLM — biasanya TIDAK perlu diisi |
| `--video-path <VIDEO_PATH>` | — | Path video sumber; jika di-set DAN `[vision] enabled = true`, analyze mengekstrak frame dan menilai tiap kandidat momen secara visual (humor/impact/novelty/engagement) sebelum memilih klip final |
| `--title <TITLE>` | `""` | Judul video (opsional — metadata untuk RAG database) |
| `--channel <CHANNEL>` | `""` | Nama channel/creator (opsional — metadata untuk RAG database) |

```bash
thoth analyze ./output/transcript.json --provider claude --max-clips 5
```

### Provider values (`analyze` / `run` / `trend-analyze`)
| Provider | Catatan |
|---|---|
| `groq` | — |
| `openai` | — |
| `claude` | Anthropic — `claude-sonnet-4-5` \| `claude-opus-4-5` \| `claude-haiku-3-5`. Set `THOTH_CLAUDE_API_KEY` + opsional `claude_model` di `config.toml` |
| `gemini` | Google — `gemini-2.0-flash` \| `gemini-1.5-pro` \| `gemini-2.5-pro`. Set `THOTH_GEMINI_API_KEY` (free key: aistudio.google.com/apikey) |
| `vllm` | Self-hosted vLLM server (OpenAI-compatible). Set `vllm_base_url` + `vllm_model` di `config.toml` |
| `ollama` | — |
| `novita` **(default `analyze`/`run`)** | Cepat & murah, OpenAI-compatible. Model: `meta-llama/llama-3.3-70b-instruct`, `deepseek/deepseek-r1-turbo`, dll. Set `THOTH_NOVITA_API_KEY` |
| `together` | OpenAI-compatible, pilihan model luas. Set `THOTH_TOGETHER_API_KEY` |
| `fireworks` | OpenAI-compatible, open-source serving cepat. Set `THOTH_FIREWORKS_API_KEY` |

> `trend-analyze` memakai daftar provider yang sama tapi default-nya `gemini` (vision-capable untuk analisis gaya visual).

---

## `edit`

Cut, reframe, and burn subtitles into clips.

```
Usage: thoth.exe edit [OPTIONS] <VIDEO_PATH> <MOMENTS_PATH> <TRANSCRIPT_PATH>
```

**Argumen**
| | Deskripsi |
|---|---|
| `<VIDEO_PATH>` | Path to the source video file |
| `<MOMENTS_PATH>` | Path to the viral moments JSON produced by `analyze` |
| `<TRANSCRIPT_PATH>` | Path to the transcript JSON (untuk burn subtitle) |

**Opsi**
| Flag | Default | Deskripsi |
|---|---|---|
| `--layout <LAYOUT>` | `vertical` | `vertical` (9:16 TikTok/Reels/Shorts) \| `horizontal` (16:9) \| `square` (1:1 IG feed) |
| `-o, --output-dir <OUTPUT_DIR>` | `./output` | Output directory for rendered clips |
| `--sfx-intro <FILE>` | — | SFX di awal tiap klip (MP3/WAV/AAC), di-mix dengan audio video |
| `--bgm <FILE>` | — | BGM di-loop otomatis, mixed di volume rendah di bawah suara klip |
| `--bgm-volume <0.0–1.0>` | `0.12` (≈ −18 dB) | Volume BGM |
| `--clip-style <STYLE>` | `fade` | Transisi IN/OUT — lihat tabel di bawah |
| `--social <HANDLE>` | `""` | Handle sosial media di kiri-atas panel headline (mis. `@namaakun`) |
| `--source-channel <NAME>` | — | Nama channel/creator untuk source credit di panel headline |
| `--headline-dur <SEC>` | `4` | Durasi tampil panel headline (detik) |
| `--font-dir <DIR>` | `assets/fonts` | Folder font (`Poppins-Bold.ttf`/`Poppins-Regular.ttf` auto-download jika hilang) |
| `--font-bold <FILE>` | `Poppins-Bold.ttf` | Font bold untuk headline & subtitle (relatif ke `--font-dir`) |
| `--font-regular <FILE>` | `Poppins-Regular.ttf` | Font regular untuk teks source credit |
| `--social-icon <PNG>` | — | Icon PNG menggantikan teks `@social_handle` di panel headline |
| `--social-icon-size <PX>` | `48` | Ukuran tampil icon sosial |
| `--social-icon-min-size <PX>` | `16` | Batas minimum ukuran icon |
| `--social-icon-max-size <PX>` | `128` | Batas maksimum ukuran icon |
| `--style-profile <NAME>` | `auto` | Terapkan style profile bernama dari `config.toml [styles.profiles]` — override `subtitle_style`/`clip_style`/`sfx_vibe`/`bgm_vibe`/`overlay_style` pilihan LLM. `auto` = biarkan LLM memutuskan per-klip |

### `--clip-style` values
| Value | Deskripsi |
|---|---|
| `fade` **(default)** | Fade from/to black — cocok untuk semua konten |
| `flash` | Flash from/to white — energik, cocok untuk meme/reaction |
| `zoom` | Ken Burns zoom-in push di awal + fade out |
| `smooth` | Fade panjang lembut (0.8s) — sinematik/profesional |
| `none` | Tanpa transisi — instant cut |

```bash
thoth edit ./output/video.mp4 ./output/moments.json ./output/transcript.json \
  --layout vertical --clip-style zoom --bgm ./music/lofi.mp3 --style-profile tiktok_id_2025
```

---

## `run`

**Pipeline utama** — end-to-end: ingest → transcribe → analyze → edit.

```
Usage: thoth.exe run [OPTIONS] [URL]
```

**Argumen**
| | Deskripsi |
|---|---|
| `[URL]` | Single video URL (mode default). Punya prioritas di atas `--content`. Contoh: `thoth run --url https://youtu.be/abc` |

**Opsi**
| Flag | Default | Deskripsi |
|---|---|---|
| `--content <FILE>` | — | Content-set JSON dari **scout** (`{main, footage, comments, ...}`) → mode narrator-driven. Discovery ditangani scout, Thoth tidak lagi search sendiri. Footage list ditulis ke `<output_dir>/content_enrichment.json` untuk stage edit/narration |
| `-o, --output-dir <DIR>` | `./output` | Output directory untuk semua artifact job |
| `--provider <PROVIDER>` | `novita` | LLM provider untuk analisis — lihat [tabel provider](#provider-values-analyze--run--trend-analyze) |
| `--model <MODEL>` | `medium` | Whisper model size — `tiny`\|`base`\|`small`\|`medium`\|`large-v3` |
| `--max-clips <N>` | `3` | Jumlah maksimum klip viral yang dihasilkan |
| `--layout <LAYOUT>` | `vertical` | `vertical`\|`horizontal`\|`square` |
| `--language <LANG>` | auto | Kode bahasa transkripsi (mis. `id`, `en`) |
| `--keywords <KEYWORDS>` | — | Override focus keyword (comma-separated) — prioritas di atas ekstraksi otomatis LLM |
| `--sfx-intro <FILE>` | — | SFX di awal tiap klip |
| `--bgm <FILE>` | — | BGM (looped, mixed rendah) |
| `--bgm-volume <0.0–1.0>` | `0.12` | Volume BGM |
| `--clip-style <STYLE>` | `fade` | `fade`\|`flash`\|`zoom`\|`smooth`\|`none` |
| `--social <HANDLE>` | `""` (auto dari channel) | Handle sosial di panel headline |
| `--headline-dur <SEC>` | `4` | Durasi panel headline |
| `--font-dir <DIR>` | `assets/fonts` | Folder font |
| `--font-bold <FILE>` | `Poppins-Bold.ttf` | Font bold |
| `--font-regular <FILE>` | `Poppins-Regular.ttf` | Font regular |
| `--social-icon <PNG>` | — | Icon PNG pengganti teks `@social_handle` |
| `--social-icon-size <PX>` | `48` | Ukuran tampil icon |
| `--social-icon-min-size <PX>` | `16` | Batas minimum |
| `--social-icon-max-size <PX>` | `128` | Batas maksimum |
| `--resume <JOB_ID>` | — | Lanjutkan job gagal sebelumnya (skip stage yang sudah selesai) |
| `--style-profile <NAME>` | `auto` | Style profile bernama dari `config.toml [styles.profiles]` |

```bash
thoth run "https://youtu.be/xxxx"
thoth run ./video.mp4 --max-clips 5 --layout vertical
thoth run "https://youtu.be/xxxx" --style-profile tiktok_id_2025
thoth run "https://youtu.be/xxxx" --provider claude --layout square
thoth run --content scout/output/thoth_content_set.json --provider novita   # narrator-driven, dari scout
thoth run --resume <JOB_ID>
```

> **Narrator-driven**: jalankan dengan `--content set.json` (atau aktifkan `[narration]`) untuk membangun video di sekitar voiceover narator. Gunakan `--provider novita` untuk narasi (default `groq` kena rate-limit → fallback clip-mode).

---

## `trend-analyze`

Analyze trending videos to generate a reusable style profile.

```
Usage: thoth.exe trend-analyze [OPTIONS] --output-profile <OUTPUT_PROFILE> <URL>
```

**Argumen**
| | Deskripsi |
|---|---|
| `<URL>` | URL sumber sample video. Contoh: TikTok hashtag `https://www.tiktok.com/tag/suratirta`, YouTube search `ytsearch5:trending shorts indonesia 2025`, atau video tunggal |

**Opsi**
| Flag | Default | Deskripsi |
|---|---|---|
| `--sample <N>` | `5` | Jumlah video sample yang di-download & dianalisis |
| `--provider <PROVIDER>` | `gemini` | Vision LLM provider untuk analisis gaya: `gemini`\|`openai`\|`claude`\|`vllm` (lihat [tabel provider](#provider-values-analyze--run--trend-analyze)) |
| `--output-profile <NAME>` | **wajib** | Nama style profile hasil generate (disimpan ke `config.toml` + `style_profiles/`) |
| `--output-dir <DIR>` | `style_profiles` | Folder simpan sample clip yang di-download + profile hasil generate |

```bash
thoth trend-analyze "https://www.tiktok.com/tag/suratirta" --sample 10 --output-profile tiktok_id_latest
```

---

## `vocab`

Manage dynamic vocabulary (word lists stored in Supabase).

```
Usage: thoth.exe vocab <COMMAND>
```

| Subcommand | Fungsi |
|---|---|
| `add` | Tambah 1 kata ke kategori vocabulary |
| `list` | List semua kata dalam 1 kategori |
| `review` | Review kandidat kata auto-discovered (approve/reject) |
| `seed` | Seed vocabulary ke Supabase dari dataset built-in atau URL |
| `refresh` | Refresh cache vocabulary in-memory dari Supabase |
| `stats` | Tampilkan statistik vocabulary |

### `vocab add`
```
Usage: thoth.exe vocab add [OPTIONS] <CATEGORY> <WORD>
```
| | Deskripsi |
|---|---|
| `<CATEGORY>` | `tone_funny`\|`tone_serious`\|`intro`\|`name_titles`\|`stop_words`\|`energy_high`\|`energy_low`\|`vibe` |
| `<WORD>` | Kata/frasa yang ditambahkan |
| `--subcategory <SUB>` | Untuk `vibe`: `impact`\|`whoosh`\|`ding`\|`comedy`\|...; untuk `stop_words`: `id`\|`en` |
| `--language <LANG>` | `id`\|`en`\|`mixed` (default `id`) |
| `--notes <TEXT>` | Catatan opsional kenapa kata ini penting |

```bash
thoth vocab add tone_funny "wkwkwk" --language id
```

### `vocab list`
```
Usage: thoth.exe vocab list <CATEGORY>
```
```bash
thoth vocab list tone_funny
```

### `vocab review`
```
Usage: thoth.exe vocab review
```
Interaktif — review kandidat kata yang ditemukan otomatis, approve/reject satu per satu.

### `vocab seed`
```
Usage: thoth.exe vocab seed [OPTIONS]
```
Dataset built-in: `defaults` (semua word list hardcoded — jalankan sekali setelah SQL setup),
`kamus-alay` (slang Indonesia, ~3000 kata), `openslr-stopwords` (stop word Indonesia, ~758 kata).
Atau `--url` untuk download dari URL file langsung — format didukung (auto-detect dari
ekstensi/konten): `.txt` (1 kata/baris), `.csv`/`.tsv` (kolom pertama = kata, kedua opsional =
label/terjemahan), `.json` (array string, atau array objek `{"word":..., "label":...}`).

| Flag | Default | Deskripsi |
|---|---|---|
| `--source <SOURCE>` | `defaults` | `defaults`\|`kamus-alay`\|`openslr-stopwords` |
| `--url <URL>` | — | Download dari URL alih-alih dataset built-in |
| `--category <CATEGORY>` | — | Kategori target untuk kata dari `--url` (**wajib** jika `--url` dipakai) |
| `--subcategory <SUB>` | — | Mis. nama vibe (`impact`) atau bahasa stop_words (`id`/`en`) |
| `--language <LANG>` | `id` | Kode bahasa untuk kata yang di-seed |
| `--column <N>` | `0` | Index kolom (0-based) yang dipakai sebagai kata, untuk CSV/TSV |
| `--skip-header` | — | Skip baris header di CSV/TSV |
| `--label-filter <TEXT>` | — | Filter: hanya seed baris yang kolom[1]-nya mengandung teks ini (CSV/TSV) |

```bash
thoth vocab seed --source defaults
thoth vocab seed --url https://example.com/words.txt --category tone_funny
```

### `vocab refresh`
```bash
thoth vocab refresh
```

### `vocab stats`
```bash
thoth vocab stats
```

---

## `thumbnail`

Generate thumbnails for previously rendered clips.

```
Usage: thoth.exe thumbnail [OPTIONS] <JOB_ID>
```

**Argumen**
| | Deskripsi |
|---|---|
| `<JOB_ID>` | ID job yang berisi output clips |

**Opsi**
| Flag | Default | Deskripsi |
|---|---|---|
| `-o, --output-dir <DIR>` | `./output` | Direktori tempat job disimpan |

```bash
thoth thumbnail <JOB_ID>
```

---

## `scout`

Run scout content-sourcing commands (TypeScript, requires Node ≥24).

Delegates to `scout/cli.ts` — semua sub-command & flag scout diteruskan transparan
(`trailing_var_arg`). Lihat dokumentasi lengkap di [README.md § `scout`](../README.md#scout--content-sourcing-typescript-pass-through)
dan [scout/README.md](../scout/README.md).

```
Usage: thoth.exe scout [ARGS]...
```

Available: `browser`, `discover`, `trending`, `run`, `comments`, `footage`, `figures`,
`enrich`, `images`, `validate`, `pulse`, `topics`, `news`.

```bash
thoth scout browser status
thoth scout discover --max-per 4 --hours 48 --tiktok
thoth scout run <url> --out set.json --per 2 --max 4
thoth scout validate <set.json>
```

---

*Dihasilkan 2026-07-07 dari binary rilis (`build_cuda.bat`, EXIT 0). Regenerasi manual:
`.\target\release\thoth.exe <command> --help` untuk tiap subcommand di atas.*
