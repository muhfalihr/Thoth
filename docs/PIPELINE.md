# Pipeline Architecture

Thoth turns a long-form video (or a scout content-set) into short-form clips through
five stages. Each stage writes its artifacts to the job directory and checkpoints its
progress, so a failed run can resume where it stopped.

```
URL / file / --content set.json  (scout: main + footage + comments + figures)
    │
    ▼ Stage 1 · INGEST
    yt-dlp → video.mp4 + metadata            (YouTube / TikTok / Instagram / direct .mp4)
    │
    ▼ Stage 2 · TRANSCRIBE
    Whisper (CUDA or API) → transcript.json  (word-level timestamps)
    │
    ▼ Stage 3 · ANALYZE
    LLM (multi-provider) → moments.json
    Vision LLM → visual scores + per-frame description
    RAG / pgvector → inject past viral patterns
    │
    ▼ Stage 4 · ENRICH  (opt-in)
    Narrator-driven: one LLM script → TTS voiceover (spine) + narration-structure RAG
    Cultural context (scout): references / discourse + web-grounding + Knowledge Base
    News: keyword → news search → screenshot cards
    Reaction: script + TTS + avatar (optional)
    │
    ▼ Stage 5 · EDIT
    FFmpeg encode (subtitles ALWAYS on the frontmost layer)
    ├── AI cover intro (FLUX background + subject cutout + headline) → dissolve to footage
    ├── Hook-title PNG (bold stroke + shadow, per-line colors)
    ├── Reaction-news overlays (profile card, comment cards, callout)
    ├── Reaction memes full-screen (LLM-matched to narration emotion, below subtitles)
    ├── Montage composite (paper-grid canvas + footage cards)
    ├── GPU color grading (wgpu shaders)
    └── GPU transitions (wgpu — 21 effects)
```

See **[FEATURES.md](FEATURES.md)** for what each of those edit steps does, and
**[MODELS.md](MODELS.md)** for the AI models used per stage.

---

## Two operating modes

Thoth builds a video in one of two ways, chosen automatically from the input:

- **Clip-mode** — cut the most viral moments out of a single source video. The default
  when you pass a plain `URL` or file.
- **Narrator-driven** — one LLM-written narration script becomes the audio spine, and
  b-roll + reaction/news cards are assembled around it. Triggered by `--content set.json`
  or by enabling `[narration]`. Degrades to clip-mode if narration is unavailable.

---

## Output structure

```
output/
└── .thoth/<job_id>/
    ├── state.json                 ← stage checkpoints (resume support)
    ├── source/
    │   └── video.mp4
    ├── transcribe/
    │   └── transcript.json        ← word-level timestamps
    ├── analyze/
    │   ├── moments.json               ← ViralMoment[] with color_mood, gpu_transition
    │   └── video_descriptions.json    ← per-frame description (vision)
    ├── narration/
    │   └── narration.mp3           ← TTS voiceover (narrator-driven mode)
    └── clips/
        ├── clip_000_narration.mp4  ← narrator-driven, or
        ├── clip_001_<slug>.mp4     ← clip-mode
        ├── clip_001_<slug>.jpg     ← thumbnail
        └── final_concat.mp4        ← if [gpu] concat_output = true

# Sidecars in output/ (from --content / content_search):
#   content_enrichment.json · content_context.json · content_comments.json · content_profile.json
```

---

## `ViralMoment` — LLM output schema

For each clip, the analysis LLM emits the following object (into `analyze/moments.json`):

```json
{
  "title": "Social-media hook (≤ 60 chars)",
  "headline": "Lower-third overlay text (≤ 44 chars, ALL CAPS)",
  "start_sec": 45.2,
  "end_sec": 78.1,
  "hook": "first 3 opening words",
  "viral_type": "educational_shock | transformation | controversy | actionable | relatable | blueprint | inspiration | storytelling",
  "emotional_trigger": "curiosity | surprise | validation | inspiration | fear | humor | empathy | admiration",
  "energy": "high | medium | low",
  "subtitle_style": "capcut_bold",
  "clip_style": "flash",
  "sfx_vibe": "impact",
  "sfx_at_sec": 8.0,
  "bgm_vibe": "upbeat",
  "overlay_query": "shocked reaction face",
  "overlay_style": "sticker",
  "overlay_position": "bottom_right",
  "color_mood": "vibrant",
  "gpu_transition": "blink"
}
```

The `subtitle_style`, `clip_style`, `sfx_vibe`, `bgm_vibe`, `overlay_style`,
`color_mood`, and `gpu_transition` fields can be overridden globally by a named
**style profile** (`--style-profile`, see [CONFIGURATION.md](CONFIGURATION.md#stylesprofiles--style-profiles)).
