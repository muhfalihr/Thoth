# SP2 — Montage: Narration-Aligned Full-Frame Footage

**Date:** 2026-07-22
**Status:** Design approved, ready for implementation plan
**Predecessor:** SP1 (Topic Dossier + dossier-driven footage + subtitle-vision), merged `d2af01d`
**Target path:** narration-driven montage — `render_narration_video` (`crates/thoth-core/src/edit/service.rs`) and its filtergraph builders in `crates/thoth-core/src/edit/ffmpeg.rs`.

---

## 1. Problem

In the narration-driven montage, two defects hurt the result:

1. **Footage overlays (menimpa) the main card.** In the Montage vertical layout the main video is scaled to a centred card on the crumpled-**paper canvas** (`MontageRender.paper_bg`), and footage cards (`build_footage_card_overlay`) are composited **at the same centre on top of it** — footage visually covers the main card. It reads as a messy overlay, not a deliberate cut.
2. **Placement is coarse.** The narration path already embedding-matches (`narration_window_text` ↔ footage `description`, cosine, floor `placement_min_similarity`), but into **≤4 windows at fixed time offsets** (`t = hook+seg; t += 2*seg`), matched against the often-weak scraped `description`. Footage lands in a rigid slot, not at the moment the narration actually discusses its topic.

## 2. Goal

The narration is the spine (fixed duration = narration MP3). Footage should:
- own its time window **cleanly** (never partially cover the main card), and
- appear **exactly when the narration speaks its topic**, driven by the SP1 `footage.query` / dossier signal.

Main video stays (never deleted); it plays continuously underneath and simply advances while a footage window is showing (**Advance** model — the video-length invariant holds because we hide, not append).

## 3. Scope

**In scope**
- **A. Framing:** hide the main card during a footage window; render footage aspect-aware (9:16 → cover-crop full-frame; else → natural/contain on the paper canvas + drop-shadow). No overlap with the main card.
- **B. Placement:** replace the fixed 4-window scheme with **topic-anchored** placement — anchor each footage to the narration timestamp where its topic is spoken, using `footage.query` (→ dossier `for` → `description`) matched against the narration word-timeline.

**Out of scope (YAGNI / deferred)**
- Rebuilding the visual track as a concat of full-frame segments (the enable-gating overlay approach achieves the same visual with a far smaller diff).
- Blur-pad backgrounds (explicitly rejected — paper canvas is the background).
- Split-screen main+footage side-by-side.
- Beat-sync SFX, adaptive trend learning (separate BLUEPRINT items).
- The **non-narration** moment/clip montage path (`service.rs` ~1200) — different mode, untouched.

## 4. Locked decisions

| # | Decision |
|---|----------|
| Main continuity | **Advance** — main hidden during footage window (via `enable=` gating), keeps running underneath; length invariant = narration duration. |
| 9:16 footage | **Cover-crop** to full 1080×1920 (main hidden → clean cut). |
| Non-9:16 footage | **Contain** at natural aspect on the paper canvas + **drop-shadow** under the block. No blur, no overlap with main. |
| Matching signal | Priority: `footage.query` → dossier `for` (if available in edit stage) → `footage.description`. |
| Anchor granularity | **Per-sentence** — split narration `words` on punctuation into sentences with time spans; embed each; match. |
| Relevance floor | Keep `[overlay] placement_min_similarity`; below floor → footage skipped, main shows. |
| Rollout | **New default** for narration montage. No new config flag. Degrade automatically to current behavior when embed provider or word timings are unavailable. |
| Config | Reuse existing `[overlay] placement_min_similarity`, `[montage] intercut_max_cuts`, `intercut_segment_secs`. No new keys. |

## 5. Current architecture (grounding)

**Vertical Montage composition** (`build_video_filter`, `ffmpeg.rs` ~1439):
```
[paper_idx:v] scale=cover 1080x1920            → [bg]   (paper canvas = the background)
[0:v] trim + scale=cardw(=footage_scale_pct%)  → [fg]   (MAIN video as centred card)
[bg][fg] overlay=(W-w)/2:(H-h)/2                → main_vf
```
Footage cards then chain on top (`ffmpeg.rs` ~968–987) via `build_footage_card_overlay` (`ffmpeg.rs` ~548), each centred at `(W-w)/2:(H-h)/2`, scale `scale_pct` (default 88) → **covers the main card**.

**Placement** (`render_narration_video`, `service.rs` ~1894–2024):
- `words: Vec<WordTimestamp>` loaded from `job.narration_words()` (per-word narration timing).
- Windows: `t = hook_dur + seg; t += 2*seg`, capped ~4.
- Per window: `narration_window_text(&words, lo, hi)` → embed → `cosine` vs each candidate's `desc` → best above `placement_min_similarity`; else empty (main shows).
- Fallback (no embed provider): alternate video/image by rotation.

Helpers already present and reused: `narration_window_text` (`service.rs:446`), `cosine` (`service.rs:458`), embed provider (`rag/embed.rs`), `FootageCardCue`/`MontageRender` (`ffmpeg.rs` ~236, ~243).

## 6. Design — A. Framing

**A1. Aspect detection.** Footage files are already downloaded + trimmed on disk before the filtergraph is built. `ffprobe` each once for `width`/`height`; classify `cover` when `h/w ≥ ~1.2` (portrait / near-9:16), else `contain`. Cache per path (already de-duplicated by the `have` set). Probe failure → treat as `contain` (safe default).

**A2. `FootageCardCue` gains framing fields** (`ffmpeg.rs`, all `#[serde(default)]` where serialized): `cover: bool` (from A1) — enough to branch. Existing `scale_pct` retained for the contain branch.

**A3. `build_footage_card_overlay` branches:**
- `cover` → `scale` to fill + `crop=1080:1920` (force_original_aspect_ratio=increase then crop), overlay opaque full-frame at `0:0`. Main card is hidden underneath during this window (A4), so this is a clean cut.
- `contain` → current natural scale at `cardw` centred, **plus** a drop-shadow: a darkened, `boxblur`-ed, slightly y-offset copy of the footage rectangle drawn *behind* the footage block on the paper canvas (or a semi-transparent blurred black box sized to the footage). Paper canvas fills the rest — no blur-pad, no overlap with main.

**A4. Hide the main card during footage windows.** Gate the `[bg][fg]overlay` (main card) with `enable='not(between(t,w0s,w0e)+between(t,w1s,w1e)+…)'` over the footage windows — or equivalently gate each footage overlay's opaque cover so that during its window only footage (+ paper) is visible. Main stream still advances (Advance). Subtitles / comment / profile / hook cards continue to chain on top of whatever segment shows (unchanged).

## 7. Design — B. Topic-anchored placement

Replace the fixed-window loop with:

1. **Sentence timeline.** From `words`, build `Vec<(text, start_sec, end_sec)>` by splitting on sentence punctuation (`. ! ? …` and long gaps). Reuse `narration_window_text` semantics for the text slice.
2. **Candidate signal.** For each footage candidate build `topic = first_non_empty(query, dossier_for, description)`.
3. **Match.** Embed each sentence and each candidate `topic` (one batch). For each candidate, pick the highest-cosine sentence **above `placement_min_similarity`**; that sentence's `start_sec` (nudged by `lead_in_secs`) is the anchor. Below floor → drop the candidate (main shows there).
4. **Resolve collisions / spacing.** Sort anchors by time; enforce a min gap (`intercut_segment_secs`); if two candidates land on the same sentence, keep the higher-scoring one, push the other to its next-best sentence above floor (or drop). Cap total at `intercut_max_cuts`.
5. **Window duration.** `intercut_segment_secs` clamped to the footage clip's own length and to the gap before the next anchor.
6. Emit `FootageCardCue { path, at_sec: anchor, duration_sec, cover, scale_pct }`.

**Fallback:** if the embed provider is absent or `words` is empty → current fixed-window + rotation path, unchanged.

## 8. Data contract

- `FootageCardCue` (`ffmpeg.rs`): **+`cover: bool`** (`#[serde(default)]`). No other struct changes required for A.
- `footage.query` already on `ContentResult` (SP1). Dossier `for` is optional: if the edit stage does not already load `content_context.json`/dossier, use `query`→`description` only; wiring dossier `for` into edit is an **optional enhancement**, not a blocker.
- No SQL/JSON wire changes; no `dashboard/src/api.ts` impact.

## 9. Error handling & degradation

- `ffprobe` fail → `cover=false` (contain).
- Embed provider missing / `words` empty → fixed-window fallback (current behavior).
- No footage above floor → no cards; main plays full (already the graceful state today).
- `--url` runs without content-set / narration → path untouched.
- All new work is best-effort; a failure never aborts the render.

## 10. Testing

- **Unit (Rust, `cargo test --bin thoth` / `-p thoth-core`):**
  - Aspect classifier: portrait→cover, landscape/square→contain, probe-fail→contain.
  - `build_footage_card_overlay` cover branch emits `crop=1080:1920`; contain branch emits the shadow sub-filter and centred scale; assert on the generated filter string (mirrors existing `montage_branch_composites_on_paper` test at `ffmpeg.rs:2571`).
  - Main-card `enable=` excludes each footage window span.
  - Sentence splitter: punctuation + gap boundaries produce correct `(text,start,end)`.
  - Anchor selection: highest-cosine-above-floor wins; below-floor dropped; collision pushes to next-best; cap respected.
  - Fallback: empty `words` / no embed provider → fixed-window path.
- **Full verify (per CLAUDE.md):** `cmd /c ".\build_cuda.bat > build_log.txt 2>&1"; "EXIT=$LASTEXITCODE"` via PowerShell, EXIT=0, verify `target/release/thoth.exe` mtime advanced.

## 11. Risks

- **Cover-crop cuts subjects at frame edges** on very wide clips misclassified as portrait — mitigated by the `h/w ≥ 1.2` threshold (only genuine portraits cover).
- **Drop-shadow cost** — one extra blurred copy per contain card; footage count is capped (`intercut_max_cuts`), so bounded.
- **Sentence embedding cost** — one batch embed of narration sentences + candidate topics per render; small N, acceptable; skipped entirely in fallback.
- **Enable-gating arithmetic** — off-by-one in window spans could flash the main card mid-footage; covered by the `enable=` unit test.

## 12. Update after implementation

Mark BLUEPRINT.md items (montage / CapCut-subtitle-adjacent framing) and set the date. `.superpowers/sdd/progress.md` tracks task-level progress if executed via Subagent-Driven Development.
