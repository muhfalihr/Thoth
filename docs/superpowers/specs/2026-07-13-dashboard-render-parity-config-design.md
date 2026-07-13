# Dashboard Sub-project A — Render Parity + Config Editor

**Date:** 2026-07-13
**Status:** Design approved, pending spec review
**Part of:** "Full operator console" initiative (dashboard represents the whole CLI/`run_full.ps1` workflow). Decomposed into A→B→C→D; this spec covers **A** only.

## Context

The Thoth dashboard today can enqueue only a bare `thoth run` — `RunForm.tsx`
sends `{ command, url, content_set, params: {} }`, and the worker
(`crates/thoth-core/src/worker/mod.rs::execute_pipeline`) rebuilds argv with just
`url --content --output-dir --job-id`. Every other `RunArgs` flag falls to its clap
default, and `config.toml` (31 sections, 6 style profiles) has no dashboard surface
at all. This sub-project closes that gap **within the existing worker/queue model**
— no new runtime, no scout/Bun orchestration (that is sub-project B).

The worker already deliberately rebuilds the CLI argv "so every `RunArgs` default is
populated by clap"; `worker/mod.rs:70` even carries the TODO this spec implements:
`// map its keys to flags here if/when the REST API grows typed run knobs`.

## Goals

1. Expose the ~12 high-value per-run `thoth run` knobs in the dashboard, plus an
   `extra_args` escape hatch so **any** flag is reachable without UI work.
2. Read/edit `config.toml` from the dashboard (raw TOML + validation).
3. Config edits apply to the **next** job with no worker restart.

**Non-goals (later sub-projects):** scout/discovery/content-set orchestration (B/C),
end-to-end guided flow (D), structured per-section config forms, browser lifecycle.

## Approach

**Chosen: `params` → argv flags in `execute_pipeline`** (extends the existing
"rebuild argv, let clap fill defaults" pattern). Rejected: a typed `RunParams`
struct passed straight to the pipeline (breaks the clap-defaults design, adds a
mirror struct across crates); mapping params→flags in `thoth-server` (puts CLI
knowledge in the server, violating the thoth-core/adapter contract).

## Architecture & data flow

```
RunForm (params object, non-empty keys only)
  → POST /api/jobs { command, url, content_set, params }
  → thoth-jobs: params stored as-is in the JSON column (no schema change)
  → worker claim → execute_pipeline: push_params(argv, params) + extra_args
  → RunArgs::try_parse_from(argv)  (clap fills all unset defaults)
  → pipeline runs
```

`JobSpec.params` stays `serde_json::Value`. No SQL migration — the `params` column
already exists. Unknown keys are ignored (forward-compat, matching the content-set
`#[serde(default)]` discipline).

### Params shape (dashboard → worker)

```jsonc
{
  "provider": "novita",            // LlmProviderName enum
  "model": "medium",               // WhisperModelSize enum
  "max_clips": 3,                  // usize
  "layout": "9x16",                // OutputLayout enum
  "language": "id",                // Option<String>
  "keywords": ["prabowo", "AI"],   // Vec<String> → --focus, comma-joined
  "clip_style": "…",               // ClipStyleArg enum
  "style_profile": "tiktok_id_2025", // dynamic, from config
  "social": "@acct",               // String
  "bgm": "./music/lofi.mp3",       // path
  "bgm_volume": 0.12,              // f32
  "sfx_intro": "./sfx/whoosh.mp3", // path
  "headline_dur": 4.0,             // f64
  "extra_args": ["--some-flag", "v"] // appended verbatim
}
```

Every key optional. Omitted key ⇒ flag not pushed ⇒ clap default applies.

## Backend changes (Rust)

### `crates/thoth-core/src/worker/mod.rs`
- Add `fn push_params(argv: &mut Vec<String>, params: &serde_json::Value)`:
  for each known key present, push `--flag` + stringified value; arrays that map to
  a repeatable/CSV flag (`keywords` → `--focus a,b`) formatted to that flag's clap
  shape; booleans as bare `--flag` when true. Finally, `extra_args` (array of
  strings) appended verbatim.
- Call it in `execute_pipeline` after the `--job-id` push, before `try_parse_from`.
- The exact flag names/shapes are read from `RunArgs` (`cli.rs`) when implementing;
  the mapping table lives only here.

### `crates/thoth-core/src/worker/mod.rs::run_worker`
- Move `AppConfig::load()` from once-at-startup into the claim loop, re-reading
  config **per claimed job**. Rationale: `AppConfig` is parsed settings only — the
  warm CUDA/Whisper models live in the process and are untouched by reload — so
  re-reading is cheap and makes saved config edits apply to the next job with no
  restart. On reload error, log a warning and reuse the last good config (never fail
  a job because the operator saved a mid-edit config).

### `crates/thoth-server` — config + style-profile endpoints
Path resolution: `std::env::var("THOTH_CONFIG").unwrap_or_else(|| "config.toml")`,
matching `AppConfig::load()`'s cwd-relative `File::with_name("config")`.

- `GET /api/config` → `200 { "text": "<raw config.toml>" }`; missing file → `{ "text": "" }`.
- `PUT /api/config { "text" }` → parse `toml::from_str::<toml::Value>(&text)`;
  `Err` → `400 { "error": "<parse msg>" }` (no write); `Ok` → write file, `200`.
- `GET /api/style-profiles` → `200 ["tiktok_id_2025", …]`: read config, collect the
  `[styles.profiles.*]` table keys; parse error or absent → `[]`.
- All three mounted inside the existing bearer `require_api_key` layer.
- Add `toml` dependency to `thoth-server` (already transitively available via the
  `config` crate; add as a direct dep).

## Frontend changes (dashboard)

### `dashboard/src/api.ts` (hand-synced contract)
- `export type RunParams` mirroring the params shape above (all optional).
- Extend `JobSpec.params` usage — `createJob` accepts `params: RunParams`.
- `getStyleProfiles(): Promise<string[]>` → `GET /api/style-profiles` (`[]` on fail).
- `getConfig(): Promise<string>` → text; `putConfig(text): Promise<{ ok: boolean; error?: string }>`.
- Static enum value lists (`PROVIDERS`, `WHISPER_MODELS`, `LAYOUTS`, `CLIP_STYLES`)
  hardcoded here, mirroring the Rust enums — same hand-sync discipline as the rest
  of `api.ts`, noted with a comment pointing at the Rust source.

### `dashboard/src/components/RunForm.tsx`
- Collapsible **"Options"** panel under the existing url/content-set row.
- Dropdowns: provider, model, layout, clip_style (static); style_profile (from
  `getStyleProfiles()`, free-text fallback).
- Inputs: max_clips (number), language, social, bgm, bgm_volume (number),
  sfx_intro, headline_dur (number), keywords (comma-separated → string[]).
- `extra_args` textarea (whitespace-split → string[]).
- `handleSubmit` assembles `params` from **only non-empty** fields.

### `dashboard/src/components/ConfigEditor.tsx` (new)
- On mount, `getConfig()` → `<textarea>` (monospace).
- Save → `putConfig(text)`; `400` → inline parse error (red), no navigation; success
  → small "saved — applies to next run" note.
- Mounted as a second view/tab in `App.tsx` (simple in-app toggle; no router).

## Error handling

- Invalid TOML on save → `400` + inline message; file untouched.
- Invalid per-run value: dropdowns constrain the enum knobs, so only `extra_args`
  can carry a bad flag. If it does, `RunArgs::try_parse_from` fails in the worker →
  job fails with that error → surfaced via the existing SSE `error` event +
  JobMonitor (no new error channel).
- `getStyleProfiles()` / `getConfig()` network failure → empty/last value + the
  existing fetch-error patterns; never blocks the form.

## Testing

- **Rust unit** (`worker/mod.rs`): feed a representative `params` JSON through
  `push_params`, assert the resulting argv, then `RunArgs::try_parse_from(argv)`
  succeeds — guards the mapping against clap drift. (ponytail: the one runnable
  check the mapping logic requires.)
- **Server integration** (`tests/routes_http.rs`, in-process `oneshot`): config
  round-trip — `GET` returns seeded text; `PUT` invalid TOML → `400` and file
  unchanged; `PUT` valid → `200` and file updated; `GET /api/style-profiles` on a
  config with two profiles returns both names.
- **Frontend**: `bun run build` clean (consistent with the existing dashboard; no
  component-test harness introduced).
- **Full build gate** (per CLAUDE.md): `build_cuda.bat` EXIT 0, both binaries
  rebuilt; `cargo test --workspace` green.

## Interface-sync checklist (compiler-unenforced couplings)

- `RunParams` (TS) ↔ `push_params` key handling (Rust): a new knob = add to both.
- Static enum lists in `api.ts` ↔ Rust enums (`LlmProviderName`, `WhisperModelSize`,
  `OutputLayout`, `ClipStyleArg`): a new variant = update `api.ts`.
- `config.toml` path: server (`THOTH_CONFIG`/cwd) ↔ worker (`File::with_name`).
