use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Result;
use chrono::{DateTime, Utc};
use indicatif::MultiProgress;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::analyze::schema::ViralMomentList;
use crate::analyze::provider::{build_llm_provider, LlmProvider};
use crate::config::AppConfig;
use crate::transcribe::model::WordTimestamp;
use crate::util::beat_detect;
use crate::pipeline::job::JobContext;
use crate::transcribe::model::Transcript;
use crate::util::fs::slugify;
use crate::util::progress::{stage_done, step_bar, sub_spinner};

use super::color::ColorGrading;
use super::error::EditError;
use super::ffmpeg::{concat_post_roll, encode_clip_direct, generate_thumbnail, AssetSfxCue, AudioOptions, ClipStyle, HeadlineOverlay, ImageOverlaySpec};
use super::layout::OutputLayout;
use super::enrichment;
use super::overlay::{detect_overlay_style, fetch_overlay_from_url};
use crate::news::model::EnrichResult;
use super::subtitle::{generate_ass, SubtitleStyle};
use super::transition::Transition;
use crate::gpu::processor::{ClipJob, GpuProcessor};

/// Build the hook-title overlay, preferring the high-fidelity Pillow PNG renderer
/// and falling back to the libass renderer. Returns `(png, ass)` — at most one is
/// `Some`; both `None` only if even the ASS fallback fails.
///
/// `ass_path` is the clip's subtitle path; the hook artifacts are siblings
/// (`*.hook.png` / `*.hook.ass`).
fn build_hook_overlay(
    hk: &crate::config::HookTitleConfig,
    text: &str,
    duration_sec: f64,
    layout: &OutputLayout,
    ass_path: &Path,
) -> (Option<super::ffmpeg::HeadlineImage>, Option<PathBuf>) {
    let (w, h) = match layout {
        OutputLayout::Vertical   => (1080u32, 1920u32),
        OutputLayout::Horizontal => (1920u32, 1080u32),
        OutputLayout::Square     => (1080u32, 1080u32),
    };

    // ── Preferred: Pillow PNG (thick stroke, drop-shadow, crisp AA) ───────────
    if hk.engine.eq_ignore_ascii_case("python") || hk.engine.eq_ignore_ascii_case("png") {
        let png_path = ass_path.with_extension("hook.png");
        let spec = super::headline_png::HeadlinePngSpec {
            text: text.to_owned(),
            width: w,
            height: h,
            font_path: hk.font_file.clone(),
            font_size: hk.fontsize,
            palette: hk.palette.clone(),
            stroke_width: hk.stroke_width,
            stroke_color: "#000000".into(),
            line_spacing: hk.line_spacing,
            text_align: hk.text_align.clone(),
            margin_l: hk.margin_l,
            max_lines: 5,
            margin_v: hk.margin_v,
            max_width_ratio: 0.90,
            uppercase: true,
            shadow: super::headline_png::HeadlineShadow {
                dx: 0,
                dy: hk.shadow_dy,
                blur: hk.shadow_blur,
                color: "#000000".into(),
                alpha: hk.shadow_alpha,
            },
            out: png_path.to_string_lossy().to_string(),
        };
        let script = Path::new("scripts/render_headline.py");
        match spec.render(&super::headline_png::python_cmd(), script) {
            Ok(p) => {
                info!("       💥 Hook title PNG: \"{}\" ({:.1}s, {} colours, Pillow)",
                      text, duration_sec, hk.palette.len());
                return (Some(super::ffmpeg::HeadlineImage { path: p, duration_sec }), None);
            }
            Err(e) => warn!("hook title PNG render failed ({e}) — falling back to ASS"),
        }
    }

    // ── Fallback: libass ─────────────────────────────────────────────────────
    let spec = super::hook_title::HookTitleSpec {
        text: text.to_owned(),
        duration_sec,
        palette: hk.palette.clone(),
        font: hk.font.clone(),
        fontsize: hk.fontsize,
        outline_px: hk.outline_px,
        align: hk.align,
        margin_v: hk.margin_v,
        per_line_color: hk.color_mode.eq_ignore_ascii_case("per_line"),
        animate: hk.animate,
    };
    let ass = ass_path.with_extension("hook.ass");
    match super::hook_title::generate_hook_ass(&spec, &ass) {
        Ok(()) => {
            info!("       💥 Hook title: \"{}\" ({:.1}s, {} colours, ASS)",
                  text, duration_sec, hk.palette.len());
            (None, Some(ass))
        }
        Err(e) => {
            warn!("hook title generation failed: {e}");
            (None, None)
        }
    }
}

/// Build the AI cover intro (Novita bg + rembg cutout + headline text) via the
/// Python script. Reuses the hook-title styling (palette/font/stroke/shadow) so
/// the cover text matches the rest of the brand. Returns `None` on any failure so
/// the caller falls back to the normal hook title.
#[allow(clippy::too_many_arguments)]
fn build_cover(
    cfg: &crate::config::CoverConfig,
    hk: &crate::config::HookTitleConfig,
    headline: &str,
    topic_desc: &str,
    subject_name: &str,
    subject_frame: &Path,
    duration_sec: f64,
    layout: &OutputLayout,
    out_base: &Path,
    chat_model: &str,
    chat_base_url: &str,
    vision_model: &str,
    vision_base_url: &str,
) -> Option<super::ffmpeg::HeadlineImage> {
    let (w, h) = match layout {
        OutputLayout::Vertical   => (1080u32, 1920u32),
        OutputLayout::Horizontal => (1920u32, 1080u32),
        OutputLayout::Square     => (1080u32, 1080u32),
    };
    let ai_mode = cfg.subject_mode.eq_ignore_ascii_case("ai");
    let frame_str = if subject_frame.exists() {
        subject_frame.to_string_lossy().to_string()
    } else {
        String::new()
    };
    // Cutout source only in cutout/auto modes; describe-frame always (for vision).
    let subj = if !ai_mode { frame_str.clone() } else { String::new() };
    let out = out_base.with_extension("cover.png");
    // Translation needs a chat model + an API key (Novita). Disable if missing.
    let translate = cfg.prompt_translate
        && !chat_model.trim().is_empty()
        && !chat_base_url.trim().is_empty();
    // Fallback FLUX prompt (when LLM translation is off/fails) — fold in the topic description so even
    // the fallback reflects the actual event, not just the headline.
    let topic_short: String = topic_desc.chars().take(300).collect();
    let fallback_prompt = if topic_short.trim().is_empty() {
        format!("{}. {}", headline.trim(), cfg.prompt_suffix)
    } else {
        format!("{}. {}. {}", headline.trim(), topic_short.trim(), cfg.prompt_suffix)
    };
    let spec = super::cover::CoverSpec {
        prompt: fallback_prompt,
        prompt_suffix: cfg.prompt_suffix.clone(),
        translate,
        chat_model: chat_model.to_owned(),
        chat_base_url: chat_base_url.to_owned(),
        vision_model: vision_model.to_owned(),
        vision_base_url: vision_base_url.to_owned(),
        headline_text: headline.to_owned(),
        topic_desc: topic_desc.to_owned(),
        subject_name: subject_name.to_owned(),
        face_swap: cfg.face_swap,
        image_engine: cfg.image_engine.clone(),
        image_model: cfg.image_model.clone(),
        subject_mode: cfg.subject_mode.clone(),
        subject_frame: subj,
        describe_frame: frame_str,
        width: w,
        height: h,
        font_path: hk.font_file.clone(),
        font_size: hk.fontsize,
        palette: hk.palette.clone(),
        stroke_width: hk.stroke_width,
        stroke_color: "#000000".into(),
        line_spacing: hk.line_spacing,
        text_align: hk.text_align.clone(),
        margin_l: hk.margin_l,
        max_lines: 5,
        margin_v: hk.margin_v,
        max_width_ratio: 0.92,
        uppercase: true,
        text_shadow: super::headline_png::HeadlineShadow {
            dx: 0,
            dy: hk.shadow_dy,
            blur: hk.shadow_blur,
            color: "#000000".into(),
            alpha: hk.shadow_alpha,
        },
        model_steps: cfg.steps,
        model_seed: 0,
        bg_width: cfg.bg_width,
        bg_height: cfg.bg_height,
        rembg_model: cfg.rembg_model.clone(),
        subject_scale: cfg.subject_scale,
        darken: cfg.darken,
        out: out.to_string_lossy().to_string(),
    };
    let script = Path::new("scripts/render_cover.py");
    match spec.render(&super::headline_png::python_cmd(), script) {
        Ok(p) => {
            info!("       🖼️  AI cover: \"{}\" ({:.1}s, Novita FLUX + rembg)",
                  headline, duration_sec);
            Some(super::ffmpeg::HeadlineImage { path: p, duration_sec })
        }
        Err(e) => {
            warn!("AI cover failed ({e}) — falling back to hook title");
            None
        }
    }
}

/// LLM-pick reaction memes for the narration, matched to the spoken emotion.
/// Returns `(file, at_sec)` in NARRATION time (0-based). Best-effort → empty on
/// any failure (no provider, bad JSON, etc.).
async fn select_narration_memes(
    provider: &dyn LlmProvider,
    catalog: &crate::analyze::asset_catalog::AssetCatalog,
    words: &[WordTimestamp],
    narr_dur: f64,
    max_memes: usize,
) -> Vec<(String, f64)> {
    let memes: Vec<&crate::analyze::asset_catalog::AssetEntry> =
        catalog.assets.iter().filter(|a| a.kind == "video").collect();
    if memes.is_empty() || words.is_empty() || max_memes == 0 {
        return Vec::new();
    }

    let mut catalog_txt = String::new();
    for m in &memes {
        catalog_txt.push_str(&format!(
            "  {} | triggers: {} | {}\n",
            m.file, m.triggers.join(","), m.meaning
        ));
    }

    // Narration with timestamps, chunked ~12 words per line.
    let mut narr = String::new();
    let mut chunk = String::new();
    let mut chunk_start = 0i64;
    let mut n = 0;
    for w in words {
        if chunk.is_empty() {
            chunk_start = w.start_ms;
        }
        chunk.push_str(w.word.trim());
        chunk.push(' ');
        n += 1;
        if n >= 12 {
            narr.push_str(&format!("[t={:.1}s] {}\n", chunk_start as f64 / 1000.0, chunk.trim()));
            chunk.clear();
            n = 0;
        }
    }
    if !chunk.trim().is_empty() {
        narr.push_str(&format!("[t={:.1}s] {}\n", chunk_start as f64 / 1000.0, chunk.trim()));
    }

    let system = "You place short REACTION MEMES into a narrated Indonesian video so it \
feels alive — a meme is the viewer's inner voice popping in at the exact emotional beat. \
You get the narration (with [t=..s] timestamps) and a catalog of meme video files (each \
with emotional triggers + meaning). Choose memes and place each at the SECOND where the \
narrator expresses a matching emotion (shock, sadness, facepalm, laughter, confusion, \
applause, anger, etc.). Rules: use ONLY files from the catalog; at_sec must be a real \
moment in the narration; spread them out (>=6s apart); do not overuse. Output STRICT \
JSON only, no prose: {\"memes\":[{\"file\":\"<catalog file>\",\"at_sec\":<seconds>,\"emotion\":\"<word>\"}]}";

    let user = format!(
        "MEME CATALOG:\n{catalog_txt}\nNARRATION (total {narr_dur:.0}s):\n{narr}\n\n\
         Pick up to {max_memes} memes. JSON only."
    );

    let raw = match provider.chat_completion(system, &user).await {
        Ok(r) => r,
        Err(e) => {
            warn!("meme selection LLM failed: {e}");
            return Vec::new();
        }
    };
    let json = match (raw.find('{'), raw.rfind('}')) {
        (Some(a), Some(b)) if b > a => &raw[a..=b],
        _ => {
            warn!("meme selection: no JSON in response");
            return Vec::new();
        }
    };

    #[derive(serde::Deserialize)]
    struct Pick {
        file: String,
        #[serde(default)]
        at_sec: f64,
    }
    #[derive(serde::Deserialize)]
    struct Resp {
        #[serde(default)]
        memes: Vec<Pick>,
    }
    let resp: Resp = match serde_json::from_str(json) {
        Ok(r) => r,
        Err(e) => {
            warn!("meme selection parse failed: {e}");
            return Vec::new();
        }
    };

    let valid = catalog.valid_files();
    let mut out = Vec::new();
    for p in resp.memes {
        if !valid.contains(&p.file) || !memes.iter().any(|m| m.file == p.file) {
            continue;
        }
        out.push((p.file, p.at_sec.clamp(0.0, (narr_dur - 0.3).max(0.0))));
    }
    out
}

/// LLM-pick reaction SFX (impact / whoosh / riser / notification) for the
/// narration, matched to the spoken emotion or a scene transition. The SFX
/// analogue of [`select_narration_memes`]. Returns `(file, at_sec)` in NARRATION
/// time (0-based). Best-effort → empty on any failure.
async fn select_narration_sfx(
    provider: &dyn LlmProvider,
    catalog: &crate::analyze::asset_catalog::AssetCatalog,
    words: &[WordTimestamp],
    narr_dur: f64,
    max_sfx: usize,
) -> Vec<(String, f64)> {
    let sfx: Vec<&crate::analyze::asset_catalog::AssetEntry> =
        catalog.assets.iter().filter(|a| a.kind == "audio").collect();
    if sfx.is_empty() || words.is_empty() || max_sfx == 0 {
        return Vec::new();
    }

    let mut catalog_txt = String::new();
    for s in &sfx {
        catalog_txt.push_str(&format!(
            "  {} | {} | energy: {} | triggers: {} | {}\n",
            s.file, s.category, s.energy, s.triggers.join(","), s.meaning
        ));
    }

    // Narration with timestamps, chunked ~12 words per line.
    let mut narr = String::new();
    let mut chunk = String::new();
    let mut chunk_start = 0i64;
    let mut n = 0;
    for w in words {
        if chunk.is_empty() {
            chunk_start = w.start_ms;
        }
        chunk.push_str(w.word.trim());
        chunk.push(' ');
        n += 1;
        if n >= 12 {
            narr.push_str(&format!("[t={:.1}s] {}\n", chunk_start as f64 / 1000.0, chunk.trim()));
            chunk.clear();
            n = 0;
        }
    }
    if !chunk.trim().is_empty() {
        narr.push_str(&format!("[t={:.1}s] {}\n", chunk_start as f64 / 1000.0, chunk.trim()));
    }

    let system = "You are a sound designer placing short SOUND EFFECTS into a narrated \
Indonesian video so each beat lands harder. You get the narration (with [t=..s] timestamps) \
and a catalog of SFX files (each with a category, energy and emotional/transition triggers). \
Place each SFX at the SECOND that calls for it: an IMPACT/stinger on a shock, punchline or \
number reveal; a WHOOSH on a scene change/transition; a RISER just BEFORE a big reveal; a \
NOTIFICATION on a 'comment/netizen' mention. Rules: use ONLY files from the catalog; at_sec \
must be a real moment in the narration; spread them out (>=3s apart); do not carpet-bomb — \
silence has value. Output STRICT JSON only, no prose: \
{\"sfx\":[{\"file\":\"<catalog file>\",\"at_sec\":<seconds>,\"reason\":\"<word>\"}]}";

    let user = format!(
        "SFX CATALOG:\n{catalog_txt}\nNARRATION (total {narr_dur:.0}s):\n{narr}\n\n\
         Pick up to {max_sfx} SFX. JSON only."
    );

    let raw = match provider.chat_completion(system, &user).await {
        Ok(r) => r,
        Err(e) => {
            warn!("sfx selection LLM failed: {e}");
            return Vec::new();
        }
    };
    let json = match (raw.find('{'), raw.rfind('}')) {
        (Some(a), Some(b)) if b > a => &raw[a..=b],
        _ => {
            warn!("sfx selection: no JSON in response");
            return Vec::new();
        }
    };

    #[derive(serde::Deserialize)]
    struct Pick {
        file: String,
        #[serde(default)]
        at_sec: f64,
    }
    #[derive(serde::Deserialize)]
    struct Resp {
        #[serde(default)]
        sfx: Vec<Pick>,
    }
    let resp: Resp = match serde_json::from_str(json) {
        Ok(r) => r,
        Err(e) => {
            warn!("sfx selection parse failed: {e}");
            return Vec::new();
        }
    };

    let valid = catalog.valid_files();
    let mut out = Vec::new();
    for p in resp.sfx {
        if !valid.contains(&p.file) || !sfx.iter().any(|s| s.file == p.file) {
            continue;
        }
        out.push((p.file, p.at_sec.clamp(0.0, (narr_dur - 0.3).max(0.0))));
    }
    out
}

/// Narration text spoken within `[lo_sec, hi_sec]` of NARRATION time (from the word
/// timings). Used to semantically match a footage cutaway to what the narrator is
/// saying at the moment the card appears.
fn narration_window_text(words: &[crate::transcribe::model::WordTimestamp], lo_sec: f64, hi_sec: f64) -> String {
    let lo = (lo_sec * 1000.0) as i64;
    let hi = (hi_sec * 1000.0) as i64;
    words.iter()
        .filter(|w| w.start_ms >= lo && w.start_ms < hi)
        .map(|w| w.word.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Cosine similarity of two equal-length vectors. `-1.0` on degenerate input.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() { return -1.0; }
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for i in 0..a.len() { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if na == 0.0 || nb == 0.0 { return -1.0; }
    dot / (na.sqrt() * nb.sqrt())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipOutput {
    pub clip_index: usize,
    pub title: String,
    pub path: PathBuf,
    #[serde(default)]
    pub thumb_path: Option<PathBuf>,
    pub duration_secs: f64,
    pub layout: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditResult {
    pub output_clips: Vec<ClipOutput>,
    pub completed_at: DateTime<Utc>,
}

pub struct EditService<'a> {
    config: &'a AppConfig,
    job: &'a JobContext,
}

impl<'a> EditService<'a> {
    pub fn new(config: &'a AppConfig, job: &'a JobContext) -> Self {
        Self { config, job }
    }

    /// Resolve the cookie source for footage (overlay) downloads, mirroring the
    /// ingest path (priority: file > browser). Login-gated platforms like TikTok/IG
    /// refuse downloads without cookies, so footage cutaways need the same auth the
    /// main video gets. `None` = no cookies configured.
    fn overlay_cookie(&self) -> Option<crate::ingest::CookieSource> {
        let ing = &self.config.ingest;
        if !ing.cookie_file.trim().is_empty() {
            Some(crate::ingest::CookieSource::File(
                std::path::PathBuf::from(&ing.cookie_file),
            ))
        } else if !ing.cookie_browser.trim().is_empty() {
            Some(crate::ingest::CookieSource::Browser(ing.cookie_browser.clone()))
        } else {
            None
        }
    }

    pub async fn run(
        &self,
        video_path:        &Path,
        moments_path:      &Path,
        transcript_path:   &Path,
        layout:            &OutputLayout,
        audio_opts:        &AudioOptions,
        source_channel:     &str,
        social_name:        &str,
        style_profile_name: &str,   // "auto" or "" = LLM per-clip, named = apply profile
    ) -> Result<EditResult, EditError> {
        let t0 = Instant::now();

        // ── Validate social icon (if provided) ───────────────────────────────
        if let Some(icon) = &audio_opts.social_icon {
            if !icon.path.exists() {
                return Err(EditError::FfmpegFailed(format!(
                    "social icon not found: {}", icon.path.display()
                )));
            }
            let ext = icon.path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !ext.eq_ignore_ascii_case("png") {
                return Err(EditError::FfmpegFailed(
                    "social icon must be a PNG file (extension .png)".to_owned()
                ));
            }
            if icon.size < audio_opts.social_icon_min_size {
                return Err(EditError::FfmpegFailed(format!(
                    "social icon size {} px is below the minimum {} px",
                    icon.size, audio_opts.social_icon_min_size
                )));
            }
            if icon.size > audio_opts.social_icon_max_size {
                return Err(EditError::FfmpegFailed(format!(
                    "social icon size {} px exceeds the maximum {} px",
                    icon.size, audio_opts.social_icon_max_size
                )));
            }
        }

        // Load inputs
        let moments_raw = tokio::fs::read_to_string(moments_path)
            .await
            .map_err(EditError::Io)?;
        let moments: ViralMomentList =
            serde_json::from_str(&moments_raw).map_err(|e| EditError::FfmpegFailed(e.to_string()))?;

        let transcript_raw = tokio::fs::read_to_string(transcript_path)
            .await
            .map_err(EditError::Io)?;
        let mut transcript: Transcript =
            serde_json::from_str(&transcript_raw).map_err(|e| EditError::FfmpegFailed(e.to_string()))?;
        // Fix BPE subword splits (e.g. "bers"+"ama" → "bersama") on load.
        // This is idempotent — safe to call even if already fixed.
        transcript.fix_subwords();

        // ── Load enrich data (optional — present only after Stage 4) ─────────
        // Load enrich.json if it exists and news.enabled. The data provides
        // formatted_screenshot_path for each moment's best news article.
        let enrich_data: Option<EnrichResult> = if self.config.news.enabled {
            let enrich_path = self.job.enrich_path();
            if enrich_path.exists() {
                match tokio::fs::read_to_string(&enrich_path).await {
                    Ok(raw) => match serde_json::from_str::<EnrichResult>(&raw) {
                        Ok(e) => {
                            info!("loaded enrich.json: {} moments, {} news articles",
                                  e.enrichments.len(), e.news_found);
                            Some(e)
                        }
                        Err(e) => { warn!("failed to parse enrich.json: {e}"); None }
                    }
                    Err(e) => { warn!("failed to read enrich.json: {e}"); None }
                }
            } else {
                None
            }
        } else {
            None
        };

        // ── Load cross-platform enrichment cutaway pool (optional) ───────────
        // `content_enrichment.json` (written by Stage 0.5 multi-platform search)
        // lives in the pipeline base dir. When present + overlay enabled, its
        // relevance-verified videos drive the cutaways — preferred over a fresh
        // per-moment yt-dlp search. Empty when absent → graceful fallback.
        let enrich_pool = if self.config.overlay.enabled {
            enrichment::load_pool(&self.job.base_dir)
        } else {
            Vec::new()
        };
        // Static image-card pool: non-video posts (tweet/IG photo/article) that
        // OpenClaw screenshotted + vision-cropped. Independent of `overlay.enabled`
        // (these are not downloaded — just composited as stills). Empty when none.
        let image_pool = enrichment::load_image_pool(&self.job.base_dir);

        // ── OpenClaw real-data sidecars (optional) ───────────────────────────
        // `content_profile.json` / `content_comments.json` are written by `main.rs`
        // from the `--content` set: the subject's FACTUAL profile (overrides the
        // LLM's guessed character_* fields) and scraped viral comments. Absent for
        // plain `--url` runs → cards fall back to LLM data / no comment card.
        let profile_override = super::profile_card::load_profile_override(&self.job.base_dir);
        let comment_pool = super::comment_card::load_comment_pool(&self.job.base_dir);
        if profile_override.is_some() {
            info!("🪪 using OpenClaw real profile for the character card");
        }
        if !comment_pool.is_empty() {
            info!("💬 OpenClaw comment pool: {} viral comment(s)", comment_pool.len());
        }

        let encoder = if self.config.ffmpeg.nvenc { "NVENC (GPU)" } else { "libx264 (CPU)" };
        info!(
            "rendering {} clip(s) — layout: {}, encoder: {}",
            moments.moments.len(),
            layout,
            encoder
        );

        // Build SFX/BGM catalogs by scanning the configured folders.
        // The catalog knows ALL audio files in each folder and picks the best
        // match per clip based on vibe + energy + viral_type.
        let sfx_catalog = super::sfx::SfxCatalog::new(
            &self.config.assets.sfx_dir,
            &self.config.assets.sfx,
        );
        let bgm_catalog = super::sfx::SfxCatalog::new(
            &self.config.assets.bgm_dir,
            &self.config.assets.bgm,
        );
        super::sfx::log_catalogs(&sfx_catalog, &bgm_catalog);

        // Annotated asset catalog — used to know which meme cue carries its own
        // audio (so the edit stage can mix it + duck the narration). Optional.
        let asset_catalog = crate::analyze::asset_catalog::AssetCatalog::load(
            &self.config.assets.catalog_path,
        );

        // Resolve effective yt-dlp path for overlay downloads
        let overlay_ytdlp = if self.config.overlay.ytdlp_path.is_empty() {
            self.config.ingest.ytdlp_path.clone()
        } else {
            self.config.overlay.ytdlp_path.clone()
        };

        // FFmpeg directory for overlay trim step
        let ffmpeg_bin = std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".to_owned());
        let ffmpeg_dir = std::path::Path::new(&ffmpeg_bin)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        // Cookies for footage downloads (TikTok/IG need login cookies, like ingest).
        let overlay_cookie = self.overlay_cookie();

        // Top-level clip counter bar
        let mp = MultiProgress::new();
        let pb_clips = mp.add(step_bar(moments.moments.len() as u64, "Rendering clips"));

        let mut output_clips = Vec::new();

        // ── Narrator-driven mode ─────────────────────────────────────────────
        // When a narration voiceover exists, build ONE video AROUND it: the
        // narration is the audio spine (event ducked), footage is B-roll on the
        // paper canvas, and subtitles come from the narration word timings.
        if self.config.narration.enabled && self.job.narration_mp3().exists() {
            let video_dur = transcript.duration_ms as f64 / 1000.0;
            match self.render_narration_video(
                video_path, &moments, layout, audio_opts, &enrich_pool, &image_pool,
                &overlay_ytdlp, &ffmpeg_dir, video_dur,
                profile_override.as_ref(), &comment_pool, source_channel,
            ).await {
                Ok(clip) => {
                    output_clips.push(clip);
                    pb_clips.finish_with_message("narrator-driven video rendered".to_owned());
                    return Ok(EditResult { output_clips, completed_at: Utc::now() });
                }
                Err(e) => warn!("narration render failed ({e}) — falling back to per-clip edit"),
            }
        }

        for (i, moment) in moments.moments.iter().enumerate() {
            let slug     = slugify(&moment.title);
            let ass_path = self.job.ass_path(i, &slug);
            let out_path = self.job.clip_path(i, &slug);
            let clip_t0  = Instant::now();

            let video_duration = transcript.duration_ms as f64 / 1000.0;
            
            // ── Step 0: Align boundaries to sentence boundaries ──────────────
            //
            // Strategy:
            //   1. Use words_starting_in() (looser filter) to find first/last word
            //   2. Snap START backward to the nearest sentence boundary ≤2s back
            //   3. Snap END forward to the nearest sentence boundary ≤2s ahead
            //
            // This ensures clips always begin/end at a natural phrase break, not
            // mid-word or mid-sentence.  The sentence boundary helpers look for
            // Whisper segment breaks where the previous segment ends with .!? or
            // there is a >500ms gap (natural pause).
            let clip_words = transcript.words_starting_in(moment.start_sec, moment.end_sec);
            let (start, end) = if let (Some(first), Some(last)) = (clip_words.first(), clip_words.last()) {
                let word_s = first.start_ms as f64 / 1000.0;
                let word_e = last.end_ms   as f64 / 1000.0;
                // Snap to sentence boundaries (look up to 2.0s in each direction)
                let s = transcript.find_sentence_start_before(word_s, 2.0).max(0.0);
                let e = transcript.find_sentence_end_after(word_e, 2.0).min(video_duration);
                (s, e)
            } else {
                // No words found — use sentence-boundary snapping on the LLM timestamps
                // (better than falling back to potentially mid-sentence timestamps)
                let s = transcript.find_sentence_start_before(moment.start_sec, 3.0).max(0.0);
                let e = transcript.find_sentence_end_after(moment.end_sec,   3.0).min(video_duration);
                (s, e)
            };
            let duration = end - start;

            if start >= end || end > video_duration + 1.0 {
                return Err(EditError::InvalidBounds {
                    start,
                    end,
                    duration: video_duration,
                });
            }

            info!(
                "\n  ┄ Clip {}/{}: [{}·{}] \"{}\"  [{:.1}s – {:.1}s | {:.0}s | {} | {}]",
                i + 1, moments.moments.len(),
                moment.viral_type, moment.content_category, moment.title,
                start, end, duration, moment.energy, moment.emotional_trigger
            );
            // Show which headline text will appear on-screen
            let hl_display = if !moment.headline.is_empty() {
                format!("\"{}\" (AI-crafted)", moment.headline.to_uppercase())
            } else {
                format!("\"{}\" (from title)", moment.title.to_uppercase())
            };
            info!("       📺 Headline: {}", hl_display);
            if !moment.hook.is_empty() {
                info!("       🪝 Hook: \"{}\"", moment.hook);
            }
            if !moment.transcript_segment.is_empty() {
                let preview: String = moment.transcript_segment.chars().take(80).collect();
                info!("       📝 Segment: \"{}{}\"",
                    preview,
                    if moment.transcript_segment.len() > 80 { "…" } else { "" }
                );
            }
            if !moment.target_audience.is_empty() {
                info!("       👥 For: \"{}\"", moment.target_audience);
            }

            // Resolve subtitle style early (needed before Step 1)
            let effective_subtitle_style: String =
                if !style_profile_name.is_empty() && style_profile_name != "auto" {
                    self.config.styles.profiles.get(style_profile_name)
                        .and_then(|p| if p.subtitle_style.is_empty() { None } else { Some(p.subtitle_style.clone()) })
                        .unwrap_or_else(|| moment.subtitle_style.clone())
                } else {
                    moment.subtitle_style.clone()
                };

            // ── Beat role (Animelorian narrative) ────────────────────────────
            // The video is ONE arc: clip 0 = HOOK (giant headline only, no running
            // subtitle while it shows), clips 1+ = CONTENT (subtitle + callouts, no
            // giant headline). Drives per-beat layer gating below.
            let is_hook    = i == 0;
            let anim_on_clip = self.config.animelorian.enabled;
            // Hook headline window — used to suppress the running subtitle while the
            // giant hook title is on screen (reference: hook = headline only).
            let hook_window = if is_hook && self.config.hook_title.enabled {
                self.config.hook_title.duration_sec.min(duration - 0.2).max(0.0)
            } else { 0.0 };

            // ── Step 1: Generate ASS subtitles ───────────────────────────
            let sp_sub = sub_spinner(&mp, "Generating subtitles (ASS)…");
            let word_count_in_clip = {
                let mut words = transcript.words_in_window(start, end);
                // On the hook clip, drop words that fall inside the hook-title window
                // so the giant headline reads alone (no competing running subtitle).
                if hook_window > 0.0 {
                    let cutoff_ms = ((start + hook_window) * 1000.0) as i64;
                    words.retain(|w| w.start_ms >= cutoff_ms);
                }
                let n = words.len();
                let sub_style = SubtitleStyle::from_str(&effective_subtitle_style);
                generate_ass(&words, start, &ass_path, &audio_opts.font, &sub_style)?;
                n
            };
            sp_sub.finish_with_message(format!("  ✓ subtitles: {word_count_in_clip} words"));

            // ── Step 2: Single-pass trim + reframe + subtitle + encode ──────
            let sp_enc = sub_spinner(
                &mp,
                &format!(
                    "Encoding {:.1}s–{:.1}s  (reframe + subtitles + {encoder})…",
                    start, end
                ),
            );

            // ── Build headline overlay for this moment ───────────────────────
            // Priority:
            //   1. moment.headline  — LLM-crafted news-ticker text (≤44 chars, ALL CAPS friendly)
            //   2. moment.title     — social-media hook title (fallback for old moments.json)
            // The panel appears for the first headline_dur seconds of the clip.
            let headline_dur = if audio_opts.headline_dur > 0.0 {
                audio_opts.headline_dur
            } else {
                4.0 // default 4 seconds
            };
            let headline = if audio_opts.headline.is_none() {
                // Choose best available headline text
                let hl_text = if !moment.headline.is_empty() {
                    moment.headline.clone()   // LLM-crafted visual overlay ✓
                } else {
                    moment.title.clone()      // fallback: social-media title
                };

                if !hl_text.is_empty() {
                    Some(HeadlineOverlay {
                        headline:      hl_text,
                        source:        source_channel.to_owned(),
                        social:        social_name.to_owned(),
                        duration_secs: headline_dur,
                    })
                } else {
                    None
                }
            } else {
                audio_opts.headline.clone()
            };

            let mut audio_clone  = audio_opts.clone();
            let has_headline     = headline.is_some();
            audio_clone.headline = headline;

            // ── Hook title (giant multi-colour scroll-stopper, first N seconds) ──
            // Animelorian: the giant headline appears ONLY on the hook (clip 0) —
            // content clips must NOT carry it. Non-Animelorian keeps legacy behaviour.
            if self.config.hook_title.enabled && (is_hook || !anim_on_clip) {
                let hk = &self.config.hook_title;
                let text = if !moment.headline.is_empty() {
                    moment.headline.clone()
                } else {
                    moment.title.clone()
                };
                if !text.trim().is_empty() {
                    let clip_dur = end - start;
                    let duration_sec = hk.duration_sec.min(clip_dur - 0.2).max(0.5);
                    let (png, ass) = build_hook_overlay(hk, &text, duration_sec, layout, &ass_path);
                    if png.is_some() || ass.is_some() {
                        audio_clone.hook_title_png = png;
                        audio_clone.hook_title_ass = ass;
                        // Avoid duplicate text: the giant hook title replaces the
                        // lower-third headline panel (same words, top vs bottom).
                        audio_clone.headline = None;
                    }
                }
            }

            // Animelorian has NO lower-third headline panel at all (the giant hook
            // title carries the message). Drop it on every clip in this mode.
            if anim_on_clip {
                audio_clone.headline = None;
            }

            // ── Beat-2 profile card = CREATOR of the main video (NOT the story subject) ──
            // Skip on the hook clip — this is a CONTENT beat (3–6s). Identity priority:
            // (1) real OpenClaw profile crop/handle, (2) the main video's uploader
            // (`source_channel` from info.json), (3) none → skip the card. The LLM
            // `character_*` fields describe the SUBJECT of the story, not the uploader, so
            // they are NEVER used as the card identity (that mislabels the creator).
            let has_real_profile = profile_override.as_ref()
                .map(|p| !p.name.trim().is_empty() || !p.handle.trim().is_empty())
                .unwrap_or(false);
            let uploader = source_channel.trim();
            let has_uploader = !uploader.is_empty();
            if self.config.profile_card.enabled && !is_hook && (has_real_profile || has_uploader) {
                let pc = &self.config.profile_card;
                let clip_dur = end - start;
                let at = pc.at_sec.clamp(0.0, (clip_dur - 0.5).max(0.0));
                let dur = pc.duration_sec.min(clip_dur - at).max(0.5);

                // Seed from the uploader; real OpenClaw profile (if any) overrides field-by-field.
                let mut name   = uploader.to_string();
                let mut handle = uploader.to_string();
                let mut stats  = String::new();
                let mut avatar_path = String::new();
                let mut image_path = String::new();
                if let Some(p) = &profile_override {
                    if !p.name.trim().is_empty()   { name   = p.name.trim().to_string(); }
                    if !p.handle.trim().is_empty() { handle = p.handle.trim().to_string(); }
                    if !p.stats.trim().is_empty()  { stats  = p.stats.trim().to_string(); }
                    avatar_path = p.avatar_path.trim().to_string();
                    image_path  = p.image_path.trim().to_string();
                }

                let card = super::profile_card::ProfileCard {
                    name:            name.clone(),
                    handle:          handle.clone(),
                    stats:           stats.clone(),
                    accent:          pc.accent.clone(),
                    font:            pc.font.clone(),
                    at_sec:          at,
                    duration_sec:    dur,
                    position:        pc.position.clone(),
                    name_above_head: pc.name_above_head,
                    show_card:       pc.show_card,
                    avatar_path:     avatar_path.clone(),
                    image_path:      image_path.clone(),
                };

                // Composite the real avatar photo onto the card's avatar tile — but NOT
                // when a full profile-card crop is pasted (the crop already has the avatar).
                if !avatar_path.is_empty() && !card.has_crop() {
                    if let Some((bx, by, bsz)) = card.avatar_rect(1080, 1920) {
                        audio_clone.image_badges.push(super::ffmpeg::ImageBadgeCue {
                            path: std::path::PathBuf::from(&avatar_path),
                            x: bx, y: by, size: bsz,
                            at_sec: at, duration_sec: dur,
                        });
                    }
                }

                audio_clone.profile_card = Some(card);
                info!("       🪪 Profile card: \"{}\"{}{} at t={:.1}s",
                      name,
                      if handle.is_empty() { String::new() } else { format!(" @{handle}") },
                      if avatar_path.is_empty() { "" } else { " +photo" },
                      at);
            }

            // ── Beat-3 number callouts (figure + arrow) ──────────────────────
            // Skip on the hook clip — callouts belong to the CHRONOLOGY beat.
            if self.config.callout.enabled && !is_hook && !moment.callouts.is_empty() {
                let cc = &self.config.callout;
                let clip_dur = end - start;
                let mut rendered: Vec<super::callout::Callout> = Vec::new();
                for c in &moment.callouts {
                    if c.text.trim().is_empty() { continue; }
                    let raw = if c.at_sec > clip_dur { (c.at_sec - start).max(0.0) } else { c.at_sec };
                    let at = raw.clamp(0.0, (clip_dur - 0.3).max(0.0));
                    let dur = if c.duration_sec > 0.0 { c.duration_sec } else { 2.0 };
                    rendered.push(super::callout::Callout {
                        text:         c.text.trim().to_string(),
                        at_sec:       at,
                        duration_sec: dur.min(clip_dur - at).max(0.3),
                        position:     c.position.clone(),
                        direction:    c.direction.clone(),
                        accent:       cc.accent.clone(),
                        font:         cc.font.clone(),
                    });
                    if rendered.len() >= cc.max_per_clip { break; }
                }
                if !rendered.is_empty() {
                    info!("       🔢 Callouts: {} placed", rendered.len());
                    audio_clone.callouts = rendered;
                }
            }

            // ── Reaction beat: real viral comment card (OpenClaw) ────────────
            // Distribute scraped comments across the CONTENT clips (rotate by clip
            // index), landing one in the reaction zone of each. Skips the hook clip.
            // A notification SFX punctuates the comment's entrance when available.
            if !is_hook && !comment_pool.is_empty() {
                let clip_dur = end - start;
                // content clips are i>=1 → rotate from index 0.
                let c = &comment_pool[(i - 1) % comment_pool.len()];
                let at  = (clip_dur * 0.45).clamp(0.0, (clip_dur - 1.0).max(0.0));
                let dur = 3.5_f64.min(clip_dur - at).max(1.0);
                let pc = &self.config.profile_card;
                let card = super::comment_card::CommentCard {
                    author:       c.author.clone(),
                    text:         c.text.clone(),
                    likes:        c.likes,
                    avatar_path:  c.avatar_path.clone(),
                    image_path:   c.image_path.clone(),
                    accent:       pc.accent.clone(),
                    font:         pc.font.clone(),
                    at_sec:       at,
                    duration_sec: dur,
                };

                // Composite the commenter's real avatar onto its tile — only for the
                // drawn card. When a real crop is pasted, the avatar is already in it.
                if !card.has_crop() && !c.avatar_path.trim().is_empty() {
                    let (bx, by, bsz) = card.avatar_rect(1080, 1920);
                    audio_clone.image_badges.push(super::ffmpeg::ImageBadgeCue {
                        path: std::path::PathBuf::from(c.avatar_path.trim()),
                        x: bx, y: by, size: bsz,
                        at_sec: at, duration_sec: dur,
                    });
                }

                // Notification SFX on the comment's entrance (graceful if missing).
                let notif = std::path::Path::new(&self.config.assets.sfx_dir).join("notification.mp3");
                if notif.exists() {
                    audio_clone.asset_sfx_cues.push(super::ffmpeg::AssetSfxCue {
                        path: notif,
                        at_sec: at,
                        duration_sec: 1.2,
                        volume: 0.8,
                    });
                }

                audio_clone.comment_cards.push(card);
                let preview: String = c.text.chars().take(40).collect();
                info!("       💬 Comment card: {} — \"{}{}\" at t={:.1}s",
                      c.author,
                      preview,
                      if c.text.chars().count() > 40 { "…" } else { "" },
                      at);
            }

            // ── Apply style profile (if specified) ───────────────────────────
            // A style profile overrides the LLM's per-clip field picks with a
            // consistent preset (e.g. "tiktok_id_2025" forces capcut_bold subtitles,
            // flash transitions, etc.).  Fields left empty ("") in the profile defer
            // to the LLM's suggestion.
            // Style profile overrides — owned Strings to avoid borrow lifetime issues
            let (
                effective_moment_clip_style,
                effective_moment_sfx_vibe,
                effective_moment_bgm_vibe,
                effective_moment_overlay_style,
            ): (String, String, String, String) =
            if !style_profile_name.is_empty() && style_profile_name != "auto" {
                if let Some(p) = self.config.styles.profiles.get(style_profile_name) {
                    (
                        if p.clip_style.is_empty()    { moment.clip_style.clone() }    else { p.clip_style.clone() },
                        if p.sfx_vibe.is_empty()      { moment.sfx_vibe.clone() }      else { p.sfx_vibe.clone() },
                        if p.bgm_vibe.is_empty()      { moment.bgm_vibe.clone() }      else { p.bgm_vibe.clone() },
                        if p.overlay_style.is_empty() { moment.overlay_style.clone() } else { p.overlay_style.clone() },
                    )
                } else {
                    warn!("style profile '{}' not found in config.toml — using LLM picks", style_profile_name);
                    (moment.clip_style.clone(), moment.sfx_vibe.clone(),
                     moment.bgm_vibe.clone(), moment.overlay_style.clone())
                }
            } else {
                (moment.clip_style.clone(), moment.sfx_vibe.clone(),
                 moment.bgm_vibe.clone(), moment.overlay_style.clone())
            };

            // ── Resolve per-clip production style ─────────────────────────────
            // CLI flags (--clip-style / --sfx / --bgm) act as global overrides.
            // Then style profile overrides. Then LLM per-clip suggestion.

            // clip_style
            if !effective_moment_clip_style.is_empty() && effective_moment_clip_style != "fade" {
                if audio_opts.clip_style == ClipStyle::Fade {
                    audio_clone.clip_style = ClipStyle::from_vibe(&effective_moment_clip_style);
                }
            }

            // sfx via catalog (considers vibe + energy + viral_type + rotation)
            if audio_opts.sfx_intro.is_none() {
                audio_clone.sfx_intro = sfx_catalog.pick(
                    &effective_moment_sfx_vibe,
                    &moment.energy,
                    &moment.viral_type,
                    i,
                );
            }

            // bgm via catalog
            if audio_opts.bgm.is_none() {
                audio_clone.bgm = bgm_catalog.pick(
                    &effective_moment_bgm_vibe,
                    &moment.energy,
                    &moment.viral_type,
                    i,
                );
            }

            // Store effective overlay style back for overlay download step
            let _ = effective_moment_overlay_style; // used in overlay detection below

            let sfx_label = audio_clone.sfx_intro.as_ref()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .map(|s| format!("{} (vibe={})", s, moment.sfx_vibe))
                .unwrap_or_else(|| "none".to_owned());
            let bgm_label = audio_clone.bgm.as_ref()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .map(|s| format!("{} (vibe={})", s, moment.bgm_vibe))
                .unwrap_or_else(|| "none".to_owned());

            // ── Download overlay clip + detect style (opt-in) ────────────────
            // Cutaway source priority:
            //   1. cross-platform enrichment pool (content_enrichment.json) — a
            //      curated, relevance-verified clip rotated per moment by index;
            //   2. per-moment `overlay_query` yt-dlp search (legacy fallback).
            // ── Animelorian composite (paper canvas + footage card) ──────────
            // Active for CONTENT clips; the hook clip (i==0) stays full-frame
            // immersive when hook_fullscreen.
            let anim_cfg = &self.config.animelorian;
            let anim_on  = anim_cfg.enabled && !(is_hook && anim_cfg.hook_fullscreen);
            // Placement is FIXED & CONSISTENT (comfortable for viewers): the footage
            // card sits in the same centred band on every content clip — no random
            // per-clip jumping. `card_y_off = 0` = vertical centre. (Subtle motion
            // like ken-burns is a future option; position must stay stable.)
            let card_y_off = 0i32;
            if anim_on {
                audio_clone.animelorian = Some(super::ffmpeg::AnimelorianRender {
                    paper_bg: anim_cfg.paper_bg.clone(),
                    footage_scale_pct: anim_cfg.footage_scale_pct,
                    card_y_offset: card_y_off,
                });
            }

            let has_enrich_pool = !enrich_pool.is_empty();
            if self.config.overlay.enabled
                && (!moment.overlay_query.is_empty() || has_enrich_pool)
            {
                let clip_duration = end - start;
                let at  = if moment.overlay_at_sec  > 0.0 { moment.overlay_at_sec  } else { 5.0 };
                let dur = if moment.overlay_duration > 0.0 { moment.overlay_duration } else { 4.0 };
                let at_clamped  = at.min(clip_duration - 1.0).max(0.0);
                // Cap show duration to both clip bounds AND max_duration (downloaded file length)
                let dur_clamped = dur
                    .min(clip_duration - at_clamped)
                    .min(self.config.overlay.max_duration)  // never show more than downloaded
                    .max(1.0);

                // 1) Enrichment pool — rotate by clip index so each clip gets a
                //    different relevant cutaway.
                let mut overlay_source = String::new();
                let mut spec = if has_enrich_pool {
                    let cand = &enrich_pool[i % enrich_pool.len()];
                    overlay_source = format!("{} [{}]", cand.url, cand.platform);
                    fetch_overlay_from_url(
                        &cand.url,
                        at_clamped,
                        dur_clamped,
                        &self.config.overlay,
                        &overlay_ytdlp,
                        &ffmpeg_dir,
                        overlay_cookie.as_ref(),
                    ).await
                } else {
                    None
                };

                // (Footage comes ONLY from the OpenClaw enrichment pool above. The old
                // query-based auto-search overlay was removed — Thoth no longer invents
                // footage; if the pool is empty/undownloadable the overlay is simply skipped.)

                // Set overlay style.
                if let Some(ref mut ov) = spec {
                    if anim_on && anim_cfg.montage {
                        // Animelorian montage: enrichment shown as a centred footage
                        // CARD (cuts main↔enrichment), not a corner Pip. Window =
                        // [seg, seg+seg] so the video changes footage mid-clip.
                        let clip_duration = end - start;
                        let seg   = anim_cfg.montage_segment_secs.max(1.0);
                        let m_at  = seg.min((clip_duration - 1.0).max(0.0));
                        let m_dur = seg
                            .min(clip_duration - m_at)
                            .min(self.config.overlay.max_duration)
                            .max(1.0);
                        ov.at_sec = m_at;
                        ov.duration_sec = m_dur;
                        // Same position + scale as the main card → the enrichment
                        // cleanly REPLACES it during [seg, 2·seg] (a montage cut).
                        ov.style = super::overlay::OverlayStyle::FootageCard {
                            scale_pct: anim_cfg.footage_scale_pct,
                            y_offset:  card_y_off,
                        };
                    } else {
                        // Legacy: greenscreen → sticker, LLM hint respected.
                        ov.style = detect_overlay_style(
                            &ov.path,
                            &moment.overlay_style,    // LLM hint: "sticker"|"pip"|"fullscreen"|"auto"
                            &ffmpeg_dir,
                            &moment.overlay_position, // LLM position: "bottom_right"|"bottom_left"|...
                        ).await;
                    }

                    info!(
                        "       🎬 Overlay: {} | style={:?} | t={:.1}s for {:.1}s | src={}",
                        ov.path.file_name().unwrap_or_default().to_string_lossy(),
                        ov.style,
                        ov.at_sec, ov.duration_sec,
                        overlay_source
                    );
                } else {
                    info!("       🎬 Overlay: skipped (src={})", overlay_source);
                }

                audio_clone.overlay = spec;

                // ── Densify montage (Item 1): extra tiled footage cards ──────
                // Beyond the single primary card (above, window [seg, 2·seg]), pull
                // up to `montage_max_cuts − 1` MORE distinct clips from the footage
                // pool and tile them at later windows so the footage keeps changing.
                // Each is rendered as a centred FootageCard (cuts main↔footage).
                if anim_on && anim_cfg.montage && !enrich_pool.is_empty() {
                    let extra = anim_cfg.montage_max_cuts.saturating_sub(1) as usize;
                    if extra > 0 {
                        let clip_duration = end - start;
                        let seg = anim_cfg.montage_segment_secs.max(1.0);
                        let gap = (seg * 0.6).max(1.0); // base B-roll breathes between cuts
                        let mut win_start = seg * 2.0 + gap; // start after the primary card
                        let mut placed = 0usize;
                        for k in 0..extra {
                            if win_start + 1.0 >= clip_duration { break; }
                            let dur = seg
                                .min(clip_duration - win_start)
                                .min(self.config.overlay.max_duration)
                                .max(1.0);
                            // Rotate to clips DIFFERENT from the primary (i % len).
                            let cand = &enrich_pool[(i + 1 + k) % enrich_pool.len()];
                            if let Some(fspec) = fetch_overlay_from_url(
                                &cand.url, win_start, dur,
                                &self.config.overlay, &overlay_ytdlp, &ffmpeg_dir,
                                overlay_cookie.as_ref(),
                            ).await {
                                audio_clone.footage_cards.push(super::ffmpeg::FootageCardCue {
                                    path:         fspec.path,
                                    at_sec:       win_start,
                                    duration_sec: dur,
                                    scale_pct:    anim_cfg.footage_scale_pct,
                                });
                                placed += 1;
                                info!("       🎞️ Montage cut {}: {} [{}] at t={:.1}s",
                                      placed + 1, cand.url, cand.platform, win_start);
                            }
                            win_start += dur + gap;
                        }
                    }
                }
            }

            // ── Image cards (Item: non-video posts) ──────────────────────────
            // Tile cropped post screenshots (tweets/IG photos/articles supplied by
            // OpenClaw as stills) as centred cards on CONTENT clips. Independent of
            // the video-overlay gate above — image cards need no download. Rotate by
            // clip index so each content clip shows a different post.
            if anim_on && anim_cfg.montage && !is_hook && !image_pool.is_empty() {
                let clip_duration = end - start;
                let at = (clip_duration * 0.5).min(clip_duration - 1.2).max(0.5);
                if at + 1.0 < clip_duration {
                    let seg = anim_cfg.montage_segment_secs.max(1.0);
                    let dur = seg.min(clip_duration - at).max(1.0);
                    let cand = &image_pool[i % image_pool.len()];
                    audio_clone.image_cards.push(super::ffmpeg::ImageCardCue {
                        path:         std::path::PathBuf::from(&cand.image_path),
                        at_sec:       at,
                        duration_sec: dur,
                        scale_pct:    anim_cfg.footage_scale_pct,
                    });
                    info!("       🖼️ Image card: {} [{}] at t={:.1}s",
                          cand.url, cand.platform, at);
                }
            }

            // ── Beat-sync: align transitions + SFX to BGM downbeats ─────────
            if self.config.assets.beat_sync {
                if let Some(ref bgm_path) = audio_clone.bgm {
                    let bpm      = beat_detect::detect_bpm(bgm_path, &effective_moment_bgm_vibe).await;
                    let interval = beat_detect::beat_interval_ms(bpm);

                    // Snap SFX beat offset (additive to sfx_at_sec)
                    audio_clone.sfx_beat_offset_ms = beat_detect::nearest_beat_after_ms(bpm, 0);
                    audio_clone.clip_bpm           = bpm;
                    audio_clone.bgm_duck           = true;

                    info!(
                        "       🎵 Beat sync: {:.0} BPM  interval={}ms  \
                         sfx_offset={}ms  transition=beat-aligned  ducking=on",
                        bpm, interval, audio_clone.sfx_beat_offset_ms
                    );
                }
            }

            // ── News screenshot overlay (Phase 3) ────────────────────────────
            // Attach the formatted news image (if available) to be shown over the
            // video at config.news.display_start_sec for display_duration_secs.
            if let Some(ref enrich) = enrich_data {
                if let Some(enrichment) = enrich.enrichments.get(i) {
                    if let Some(fmt_path) = enrichment.best_news()
                        .and_then(|n| n.formatted_screenshot_path.as_ref())
                    {
                        if fmt_path.exists() {
                            let clip_dur = end - start;
                            let at  = self.config.news.display_start_sec;
                            let dur = self.config.news.display_duration_secs;
                            // Only insert if clip is long enough to show it
                            if clip_dur > at + dur + 1.0 {
                                audio_clone.news_overlay = Some(ImageOverlaySpec {
                                    path:         fmt_path.clone(),
                                    at_sec:       at,
                                    duration_sec: dur,
                                    ken_burns:    true,
                                });
                                info!("       📰 News overlay: {} at t={:.1}s for {:.1}s",
                                      fmt_path.file_name().unwrap_or_default().to_string_lossy(),
                                      at, dur);
                            }
                        }
                    }
                }
            }

            // ── Dynamic SFX timing from LLM ──────────────────────────────────
            // LLM sets sfx_at_sec to the peak moment (e.g. stat reveal at 8s).
            // 0.0 = play at clip start (default); >0 = delay to peak moment.
            if moment.sfx_at_sec > 0.0 {
                let at_clamped = moment.sfx_at_sec.min((end - start) - 0.5).max(0.0);
                audio_clone.sfx_at_sec = at_clamped;
                info!("       🔊 SFX peak moment: t={:.1}s from clip start", at_clamped);
            }
            if moment.sfx_duration_sec > 0.0 {
                audio_clone.sfx_duration_sec = moment.sfx_duration_sec.clamp(0.5, 5.0);
            }

            // ── Asset cues (timestamped, from moment.asset_cues) ─────────────
            // Audio catalog entries → mixed SFX punch-ins; video entries → meme PiP
            // cutaways overlaid in rotating corners.
            if !moment.asset_cues.is_empty() {
                let clip_dur = end - start;
                // Consistent reaction-zone corner (NOT rotating) — a meme jumping
                // corners between pops feels random/uncomfortable. Top-right sits on
                // the paper margin, clear of the bottom subtitle.
                let meme_pos = "top_right";
                let mut cues: Vec<AssetSfxCue> = Vec::new();
                let mut memes: Vec<super::ffmpeg::MemeCue> = Vec::new();
                for c in &moment.asset_cues {
                    let ext = std::path::Path::new(&c.file)
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.to_lowercase())
                        .unwrap_or_default();
                    let path = std::path::PathBuf::from(&c.file);
                    if !path.exists() { continue; }
                    // Some LLMs emit ABSOLUTE video time instead of clip-relative;
                    // if it overshoots the clip length, treat it as absolute.
                    let raw = if c.at_sec > clip_dur { (c.at_sec - start).max(0.0) } else { c.at_sec };
                    let mut at = raw.clamp(0.0, (clip_dur - 0.3).max(0.0));
                    // Beat-snap: when BGM beat-sync is on, land the cue on the nearest beat.
                    if audio_clone.clip_bpm > 0.0 {
                        let beat = 60.0 / audio_clone.clip_bpm as f64;
                        if beat > 0.05 {
                            let snapped = (at / beat).round() * beat;
                            if snapped > 0.0 && snapped < clip_dur - 0.2 { at = snapped; }
                        }
                    }
                    match ext.as_str() {
                        "mp3" | "wav" | "aac" | "m4a" | "ogg" | "flac" => {
                            if cues.len() >= 4 { continue; }
                            let dur = if c.duration_sec > 0.0 { c.duration_sec } else { 2.0 };
                            cues.push(AssetSfxCue { path, at_sec: at, duration_sec: dur, volume: 0.80 });
                        }
                        "mp4" | "mov" | "webm" | "mkv" | "gif" => {
                            if memes.len() >= 3 { continue; }
                            // Reaction memes are SHORT pops (0.8–2s) for punch, not lingering PiP.
                            let dur = if c.duration_sec > 0.0 { c.duration_sec.clamp(0.8, 2.0) } else { 1.6 };
                            let pos = meme_pos.to_string();
                            // Mix the meme's own audio only when the catalog says it has one.
                            let with_audio = asset_catalog
                                .as_ref()
                                .map(|cat| cat.file_has_audio(&c.file))
                                .unwrap_or(false);
                            memes.push(super::ffmpeg::MemeCue {
                                path, at_sec: at, duration_sec: dur, position: pos,
                                with_audio, audio_volume: 0.90,
                                fullscreen: self.config.assets.meme_fullscreen,
                            });
                        }
                        _ => {}
                    }
                }
                if !cues.is_empty() {
                    info!("       🎚️  Asset SFX cues: {} placed", cues.len());
                    audio_clone.asset_sfx_cues = cues;
                }
                if !memes.is_empty() {
                    let with_snd = memes.iter().filter(|m| m.with_audio).count();
                    info!("       🎭 Meme PiP cues: {} placed ({} with audio → narration ducked)",
                          memes.len(), with_snd);
                    audio_clone.meme_cues = memes;
                }
            }

            info!(
                "       🎬 Style: {} | 🔊 SFX: {} | 🎵 BGM: {}",
                format!("{:?}", audio_clone.clip_style).to_lowercase(),
                sfx_label,
                bgm_label,
            );

            let video_path_clone = video_path.to_owned();
            let ass_path_clone   = ass_path.clone();
            let out_path_clone   = out_path.clone();
            let layout_clone     = layout.clone();
            let cfg_clone        = self.config.ffmpeg.clone();

            tokio::task::spawn_blocking(move || {
                encode_clip_direct(
                    &video_path_clone,
                    start, end,
                    &ass_path_clone,
                    &layout_clone,
                    &out_path_clone,
                    &cfg_clone,
                    None,       // no intro card
                    &audio_clone,
                )
            })
            .await
            .map_err(|e| EditError::FfmpegFailed(e.to_string()))??;

            let out_mb = std::fs::metadata(&out_path)
                .map(|m| m.len() as f64 / 1_048_576.0)
                .unwrap_or(0.0);
            sp_enc.finish_with_message(format!(
                "  ✓ encoded  {:.1} MB  ({:.1}s)",
                out_mb, clip_t0.elapsed().as_secs_f64()
            ));

            // ── Step 2b: Post-roll avatar concat (Phase 5) ──────────────────
            // Append the avatar reaction segment (if available) after the main clip.
            if self.config.reaction.enabled {
                if let Some(ref enrich) = enrich_data {
                    if let Some(enrichment) = enrich.enrichments.get(i) {
                        if let Some(ref seg_path) = enrichment.avatar_video_path {
                            if seg_path.exists() && self.config.reaction.position == "post_roll" {
                                let concat_tmp = out_path.with_extension("concat_tmp.mp4");
                                let concat_result = tokio::task::spawn_blocking({
                                    let main  = out_path.clone();
                                    let seg   = seg_path.clone();
                                    let tmp   = concat_tmp.clone();
                                    let cfg   = self.config.ffmpeg.clone();
                                    move || concat_post_roll(&main, &seg, &tmp, &cfg)
                                }).await
                                .map_err(|e| EditError::FfmpegFailed(e.to_string()))?;

                                match concat_result {
                                    Ok(()) => {
                                        // Replace main clip with concatenated version
                                        std::fs::rename(&concat_tmp, &out_path)
                                            .map_err(EditError::Io)?;
                                        info!("       📎 Post-roll appended → {}", out_path.display());
                                    }
                                    Err(e) => {
                                        warn!("post-roll concat failed (clip kept as-is): {e}");
                                        let _ = std::fs::remove_file(&concat_tmp);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // ── Step 3: Generate Thumbnail ───────────────────────────────────
            let thumb_path = out_path.with_extension("jpg");
            let optimal_time = if moment.overlay_at_sec > 0.0 {
                moment.overlay_at_sec + 0.5
            } else if moment.sfx_at_sec > 0.0 {
                moment.sfx_at_sec
            } else if has_headline {
                // If there's a headline, pick an early frame so the text is fully visible
                (duration / 2.0).min(1.0)
            } else {
                duration / 2.0
            };
            
            // Ensure optimal_time is within bounds
            let thumb_time = optimal_time.clamp(0.0, duration.max(0.1));
            
            let sp_thumb = sub_spinner(&mp, &format!("Generating thumbnail at {:.1}s…", thumb_time));
            let mut final_thumb_path = None;
            if let Err(e) = generate_thumbnail(&out_path, &thumb_path, thumb_time) {
                warn!("failed to generate thumbnail: {}", e);
                sp_thumb.finish_with_message("  ✗ thumbnail failed");
            } else {
                sp_thumb.finish_with_message("  ✓ thumbnail saved");
                final_thumb_path = Some(thumb_path);
            }

            output_clips.push(ClipOutput {
                clip_index: i,
                title: moment.title.clone(),
                path: out_path,
                thumb_path: final_thumb_path,
                duration_secs: duration,
                layout: layout.to_string(),
            });

            pb_clips.inc(1);
        }

        pb_clips.finish_with_message(format!(
            "All {} clips rendered in {:.1}s",
            output_clips.len(),
            t0.elapsed().as_secs_f64()
        ));

        // ── GPU post-processing (color grading + GPU transitions) ─────────────
        //
        // Runs AFTER all FFmpeg clips are encoded.
        // Two modes based on config:
        //   1. gpu.color_grading=true, gpu.concat_output=false
        //      → Apply color grading to each clip independently (in-place)
        //   2. gpu.concat_output=true
        //      → Concat all clips into one final video with GPU transitions
        let gpu_cfg = &self.config.gpu;
        if gpu_cfg.enabled && (!output_clips.is_empty()) {
            let gpu_sp = sub_spinner(&mp, "Initializing GPU pipeline…");
            match GpuProcessor::new().await {
                Err(e) => {
                    warn!("GPU init failed (falling back to FFmpeg-only): {e}");
                    gpu_sp.finish_with_message("  ✗ GPU unavailable — FFmpeg-only output");
                }
                Ok(gpu) => {
                    gpu_sp.finish_with_message("  ✓ GPU ready");

                    if gpu_cfg.concat_output && output_clips.len() > 1 {
                        // ── Mode 2: concat all clips into one video ───────────
                        let sp = sub_spinner(&mp, &format!(
                            "GPU concat {} clips with transitions…", output_clips.len()
                        ));

                        let jobs: Vec<ClipJob> = output_clips.iter().enumerate()
                            .map(|(i, clip)| {
                                // Resolve color mood for this clip
                                let mood = if !gpu_cfg.default_color_mood.is_empty() {
                                    gpu_cfg.default_color_mood.clone()
                                } else {
                                    moments.moments.get(i)
                                        .map(|m| m.color_mood.clone())
                                        .unwrap_or_default()
                                };
                                let color = ColorGrading::from_mood(&mood).to_gpu_params();

                                // Resolve GPU transition for this clip
                                let tr_name = moments.moments.get(i)
                                    .map(|m| {
                                        let profile_tr = if !style_profile_name.is_empty()
                                            && style_profile_name != "auto"
                                        {
                                            self.config.styles.profiles
                                                .get(style_profile_name)
                                                .map(|p| p.gpu_transition.as_str())
                                                .unwrap_or("")
                                        } else { "" };
                                        if !profile_tr.is_empty() { profile_tr.to_owned() }
                                        else if !m.gpu_transition.is_empty() { m.gpu_transition.clone() }
                                        else { m.clip_style.clone() }
                                    })
                                    .unwrap_or_default();
                                let transition = Transition::from_name(&tr_name);

                                ClipJob::new(&clip.path, 0.0, clip.duration_secs)
                                    .with_color(color)
                                    .with_transition(transition)
                            })
                            .collect();

                        let concat_path = output_clips[0].path
                            .parent().unwrap_or(std::path::Path::new("."))
                            .join("final_concat.mp4");

                        match gpu.concat_gpu(&jobs, &concat_path, self.config.ffmpeg.nvenc).await {
                            Ok(()) => {
                                sp.finish_with_message(format!(
                                    "  ✓ GPU concat → {}", concat_path.display()
                                ));
                                info!("GPU concat complete: {}", concat_path.display());
                            }
                            Err(e) => {
                                warn!("GPU concat failed: {e}");
                                sp.finish_with_message("  ✗ GPU concat failed");
                            }
                        }

                    } else if gpu_cfg.color_grading {
                        // ── Mode 1: apply color grading to each clip ──────────
                        let sp_gpu = sub_spinner(&mp, &format!(
                            "GPU color grading {} clips…", output_clips.len()
                        ));

                        let mut graded = 0usize;
                        for (i, clip) in output_clips.iter_mut().enumerate() {
                            let mood = if !gpu_cfg.default_color_mood.is_empty() {
                                gpu_cfg.default_color_mood.clone()
                            } else {
                                moments.moments.get(i)
                                    .map(|m| m.color_mood.clone())
                                    .unwrap_or_default()
                            };

                            if mood.is_empty() { continue; }

                            let grading = ColorGrading::from_mood(&mood);
                            if grading.is_identity() { continue; }

                            let gpu_out = clip.path.with_extension("gpu.mp4");
                            match gpu.apply_color(
                                &clip.path, &gpu_out,
                                0.0, clip.duration_secs,
                                &grading.to_gpu_params(),
                                self.config.ffmpeg.nvenc,
                            ).await {
                                Ok(()) => {
                                    // Replace original with GPU-graded version
                                    if let Err(e) = std::fs::rename(&gpu_out, &clip.path) {
                                        warn!("rename GPU output failed: {e}");
                                    } else {
                                        graded += 1;
                                    }
                                }
                                Err(e) => warn!("GPU color grading clip {i}: {e}"),
                            }
                        }

                        sp_gpu.finish_with_message(format!(
                            "  ✓ GPU color graded {graded}/{} clips", output_clips.len()
                        ));
                    }
                }
            }
        }

        info!("edit complete: {} clips", output_clips.len());
        stage_done("Edit", t0.elapsed());

        Ok(EditResult {
            output_clips,
            completed_at: Utc::now(),
        })
    }

    /// Render ONE narrator-driven video: narration = audio spine, footage = B-roll
    /// on the paper canvas, subtitles from the narration word timings, hook headline
    /// at the start. The video length equals the narration length.
    #[allow(clippy::too_many_arguments)]
    async fn render_narration_video(
        &self,
        video_path:    &Path,
        moments:       &ViralMomentList,
        layout:        &OutputLayout,
        audio_opts:    &AudioOptions,
        enrich_pool:   &[crate::ingest::content_search::ContentResult],
        image_pool:    &[crate::ingest::content_search::ContentResult],
        overlay_ytdlp: &str,
        ffmpeg_dir:    &str,
        video_dur:     f64,
        profile_override: Option<&super::profile_card::ProfileCardData>,
        comment_pool:     &[super::comment_card::CommentData],
        source_channel:   &str,
    ) -> Result<ClipOutput, EditError> {
        // 1) Narration words + duration + hook line.
        let words_raw = std::fs::read_to_string(self.job.narration_words())
            .map_err(EditError::Io)?;
        let words: Vec<WordTimestamp> = serde_json::from_str(&words_raw)
            .map_err(|e| EditError::FfmpegFailed(format!("narration words: {e}")))?;
        if words.is_empty() {
            return Err(EditError::FfmpegFailed("narration has no word timings".into()));
        }
        let narr_dur = (words.last().unwrap().end_ms as f64 / 1000.0).max(2.0);
        let hook = std::fs::read_to_string(self.job.narration_dir().join("hook.txt"))
            .unwrap_or_default().trim().to_string();

        // 2) Lead-in + B-roll window. The event audio plays LOUD for `lead` secs
        // (establishes the vibe), then the narrator comes in. The narration is the
        // audio SPINE, so the video length = lead-in + narration — NOT capped to the
        // source length. When the narration outlasts the source B-roll, loop the
        // source to fill the timeline (Bug 6: a ~48s narration was being truncated to
        // a ~10s source clip because `dur` was `.min(video_dur)`).
        let lead = self.config.narration.lead_in_secs.clamp(0.0, 3.0);
        let dur  = narr_dur + lead;
        let loop_source = dur > video_dur - 0.2;
        let (start, end) = if loop_source {
            (0.0, dur) // play B-roll from the top, looped (-stream_loop) to cover the narration
        } else {
            let prefer = moments.moments.first().map(|m| m.start_sec).unwrap_or(0.0);
            let start = if prefer + dur <= video_dur { prefer } else { (video_dur - dur).max(0.0) };
            (start, start + dur)
        };

        // Hook window — the giant headline reads ALONE (no running subtitle). It
        // spans the lead-in plus the first narration beat.
        let hook_win = if self.config.hook_title.enabled && !hook.is_empty() {
            self.config.hook_title.duration_sec.min((narr_dur - 0.2).max(0.0))
        } else { 0.0 };
        let hook_dur = if hook_win > 0.0 { (lead + hook_win).min(dur - 0.2) } else { 0.0 };

        // 3) Subtitles from the narration word timings, SHIFTED later by `lead`
        // (clip_start = -lead). Drop words inside the hook window. The DISPLAYED captions are
        // stripped of punctuation (the spoken narration audio keeps it) — same per-word timings,
        // tokens that become empty (e.g. a standalone "—") are dropped.
        let ass_path = self.job.ass_path(0, "narration");
        let out_path = self.job.clip_path(0, "narration");
        {
            let cutoff = (hook_win * 1000.0) as i64;
            let sub_words: Vec<WordTimestamp> = words.iter()
                .filter(|w| w.start_ms >= cutoff)
                .filter_map(|w| {
                    let t = crate::narration::strip_punctuation(&w.word);
                    if t.is_empty() { None } else { Some(WordTimestamp { word: t, ..w.clone() }) }
                })
                .collect();
            let refs: Vec<&WordTimestamp> = sub_words.iter().collect();
            let style = SubtitleStyle::from_str("word_pop");
            generate_ass(&refs, -lead, &ass_path, &audio_opts.font, &style)?;
        }

        // Dynamic ducking: the event swells during the lead-in, then ducks under
        // the narrator (continuous TTS has no usable mid-speech pauses).
        let leak_windows = if lead > 0.1 {
            vec![(0.0, (lead - 0.05).max(0.1))]
        } else { Vec::new() };

        // 4) Build audio/video directives.
        let mut audio = audio_opts.clone();
        audio.loop_source = loop_source; // loop short B-roll to fill the narration (Bug 6)
        audio.headline = None;
        audio.narration = Some(super::ffmpeg::NarrationVoice {
            mp3: self.job.narration_mp3(),
            duck_event_vol: self.config.narration.duck_event_vol,
            leak_vol: self.config.narration.leak_event_vol,
            leak_windows,
            lead_in_secs: lead,
        });
        if lead > 0.1 {
            info!("       🔊 Lead-in: event plays loud {:.1}s before narrator", lead);
        }

        // Hook headline (giant, hook window) from the narration hook line.
        if hook_dur > 0.0 && !hook.trim().is_empty() {
            // Preferred: full-screen AI cover intro (bg + subject cutout + text)
            // shown for the cover window, then dissolves to footage. When it
            // succeeds the cover carries the text, so the hook title is suppressed.
            let cover_cfg = &self.config.cover;
            let mut cover_done = false;
            if cover_cfg.enabled {
                let subject_frame = ass_path.with_extension("cover_subject.jpg");
                // Always grab a representative frame: used for the cutout (cutout/
                // auto modes) AND for the vision description that drives the AI
                // event recreation (all modes).
                if cover_cfg.subject {
                    let at = (start + cover_cfg.subject_at_sec).clamp(start, (end - 0.1).max(start));
                    // Dodge mirror/kaleidoscope TRANSITION frames (subject appears doubled on the cover)
                    // by picking the least-symmetric frame in a small window around the chosen moment.
                    let at = super::ffmpeg::pick_cover_frame_time(video_path, at, start, end);
                    let _ = generate_thumbnail(video_path, &subject_frame, at);
                }
                let cover_dur = cover_cfg.duration_sec.min(dur - 0.2).max(0.5);
                // Detailed topic description (beyond the short hook) → grounds the AI scene in what the
                // content is actually about. First moment's title + reason describe the event.
                let topic_desc = moments.moments.first().map(|m| {
                    let mut s = m.title.trim().to_string();
                    if !m.reason.trim().is_empty() {
                        if !s.is_empty() { s.push_str(". "); }
                        s.push_str(m.reason.trim());
                    }
                    s
                }).unwrap_or_default();
                // Subject name → internet reference-photo lookup for a faithful face-swap.
                let subject_name = moments.moments.first()
                    .map(|m| m.character_name.trim().to_string()).unwrap_or_default();
                if let Some(cov) = build_cover(
                    cover_cfg, &self.config.hook_title, &hook, &topic_desc, &subject_name, &subject_frame,
                    cover_dur, layout, &ass_path,
                    &self.config.llm.novita_model, &self.config.llm.novita_base_url,
                    &self.config.vision.novita_model, &self.config.vision.novita_base_url,
                ) {
                    audio.cover = Some(cov);
                    cover_done = true;
                }
            }
            // Fallback: the giant hook title (PNG or ASS) over the footage.
            if !cover_done {
                let hk = &self.config.hook_title;
                let (png, ass) = build_hook_overlay(hk, &hook, hook_dur, layout, &ass_path);
                audio.hook_title_png = png;
                audio.hook_title_ass = ass;
            }
        }

        // Paper canvas + MONTAGE: cut to relevant enrichment footage cards at
        // intervals so the video keeps changing (Animelorian). Between cards the
        // main event B-roll shows on the paper.
        let anim = &self.config.animelorian;
        if anim.enabled {
            audio.animelorian = Some(super::ffmpeg::AnimelorianRender {
                paper_bg: anim.paper_bg.clone(),
                footage_scale_pct: anim.footage_scale_pct,
                card_y_offset: 0,
            });
            let has_vid = !enrich_pool.is_empty();
            let has_img = !image_pool.is_empty();
            let overlay_cookie = self.overlay_cookie();
            if has_vid || has_img {
                let seg = anim.montage_segment_secs.clamp(2.5, 6.0);
                let mut fcards = Vec::new();
                let mut icards = Vec::new();

                // (a) Card WINDOWS (clip-time start + duration). One card per "card beat";
                // between them the main event B-roll shows on the paper canvas.
                let mut windows: Vec<(f64, f64)> = Vec::new();
                {
                    let mut t = hook_dur.max(0.3) + seg;
                    while t + 1.0 < dur && windows.len() < 4 {
                        let card_dur = seg.min(dur - t - 0.2);
                        if card_dur >= 1.0 { windows.push((t, card_dur)); }
                        t += 2.0 * seg; // main beat + card beat
                    }
                }

                // (b) Combined candidate pool (video + image), each with its `description`.
                enum Kind { Video, Image }
                struct Cand { kind: Kind, idx: usize, desc: String }
                let footage_desc = |c: &crate::ingest::content_search::ContentResult| -> String {
                    if !c.description.trim().is_empty() { c.description.trim().to_string() }
                    else if !c.title.trim().is_empty() { c.title.trim().to_string() }
                    else if !c.snippet.trim().is_empty() { c.snippet.trim().to_string() }
                    else { c.query.trim().to_string() }
                };
                let mut cands: Vec<Cand> = Vec::new();
                for (i, c) in enrich_pool.iter().enumerate() { cands.push(Cand { kind: Kind::Video, idx: i, desc: footage_desc(c) }); }
                for (i, c) in image_pool.iter().enumerate()  { cands.push(Cand { kind: Kind::Image, idx: i, desc: footage_desc(c) }); }

                // (c) Assign a candidate to each window. PREFERRED: embedding-match the
                // window's narration text to the footage `description` (cosine). FALLBACK
                // (no embed provider / no descriptions): round-robin alternating video/image.
                let cfg = crate::rag::embed::EmbedConfig::from_app_config(self.config);
                let any_desc = cands.iter().any(|c| !c.desc.trim().is_empty());
                let mut assignment: Vec<Option<usize>> = vec![None; windows.len()];
                if cfg.is_valid() && any_desc && !cands.is_empty() {
                    let client = reqwest::Client::new();
                    let mut cand_emb: Vec<Option<Vec<f32>>> = Vec::with_capacity(cands.len());
                    for c in &cands {
                        cand_emb.push(if c.desc.trim().is_empty() { None }
                            else { crate::rag::embed::embed_text_with_config(&c.desc, &cfg, &client).await });
                    }
                    let floor = self.config.overlay.placement_min_similarity;
                    let mut used = vec![false; cands.len()];
                    let mut skipped = 0usize;
                    for (wi, &(wt, wdur)) in windows.iter().enumerate() {
                        let wtext = narration_window_text(&words, wt - lead, wt + wdur - lead);
                        let wemb = if wtext.trim().is_empty() { None }
                            else { crate::rag::embed::embed_text_with_config(&wtext, &cfg, &client).await };
                        let mut best: Option<(usize, f32)> = None;
                        for (ci, ce) in cand_emb.iter().enumerate() {
                            if used[ci] { continue; }
                            let score = match (&wemb, ce) { (Some(a), Some(b)) => cosine(a, b), _ => -1.0 };
                            if best.map(|(_, s)| score > s).unwrap_or(true) { best = Some((ci, score)); }
                        }
                        // RELEVANCE FLOOR: only place footage when the best match clears the floor.
                        // Below it, leave the slot empty → the main clip shows instead of forcing a
                        // weakly-related cutaway (the "out-of-context b-roll" problem).
                        if let Some((ci, score)) = best {
                            if score >= floor { used[ci] = true; assignment[wi] = Some(ci); }
                            else { skipped += 1; }
                        }
                    }
                    info!(
                        "       🧠 Footage placement: embedding-matched ke narasi ({} window{})",
                        windows.len(),
                        if skipped > 0 { format!(", {skipped} di-skip <floor {floor:.2} → main clip") } else { String::new() }
                    );
                } else {
                    let vids: Vec<usize> = cands.iter().enumerate().filter(|(_, c)| matches!(c.kind, Kind::Video)).map(|(i, _)| i).collect();
                    let imgs: Vec<usize> = cands.iter().enumerate().filter(|(_, c)| matches!(c.kind, Kind::Image)).map(|(i, _)| i).collect();
                    let (mut vi, mut ii) = (0usize, 0usize);
                    for (beat, slot) in assignment.iter_mut().enumerate() {
                        let use_image = if has_vid && has_img { beat % 2 == 1 } else { has_img };
                        let ci = if use_image && !imgs.is_empty() { let x = imgs[ii % imgs.len()]; ii += 1; x }
                            else if !vids.is_empty() { let x = vids[vi % vids.len()]; vi += 1; x }
                            else if !imgs.is_empty() { let x = imgs[ii % imgs.len()]; ii += 1; x }
                            else { break; };
                        *slot = Some(ci);
                    }
                }

                // (d) Render the assignment → cues.
                for (wi, &(wt, wdur)) in windows.iter().enumerate() {
                    let Some(ci) = assignment[wi] else { continue; };
                    match cands[ci].kind {
                        Kind::Image => {
                            let cand = &image_pool[cands[ci].idx];
                            icards.push(super::ffmpeg::ImageCardCue {
                                path: std::path::PathBuf::from(&cand.image_path),
                                at_sec: wt, duration_sec: wdur, scale_pct: anim.footage_scale_pct,
                            });
                        }
                        Kind::Video => {
                            let cand = &enrich_pool[cands[ci].idx];
                            if let Some(spec) = super::overlay::fetch_overlay_from_url(
                                &cand.url, wt, wdur, &self.config.overlay, overlay_ytdlp, ffmpeg_dir,
                                overlay_cookie.as_ref(),
                            ).await {
                                fcards.push(super::ffmpeg::FootageCardCue {
                                    path: spec.path, at_sec: wt, duration_sec: wdur, scale_pct: anim.footage_scale_pct,
                                });
                            }
                        }
                    }
                }
                info!(
                    "       🎬 Montage: {} footage + {} image card(s) over {:.0}s",
                    fcards.len(), icards.len(), dur
                );
                audio.footage_cards = fcards;
                audio.image_cards = icards;
            }
        }

        // ── Beat-2 profile card = CREATOR of the main video (NOT the story subject) ─────
        // Card appears once, just after the hook. Identity priority: (1) real OpenClaw
        // profile crop/handle, (2) the main video's uploader (`source_channel` from
        // info.json), (3) none → skip. The LLM `character_*` fields describe the SUBJECT
        // of the story, not the uploader, so they are NEVER used as the card identity.
        let has_real_profile = profile_override
            .map(|p| !p.name.trim().is_empty() || !p.handle.trim().is_empty())
            .unwrap_or(false);
        let uploader = source_channel.trim();
        let has_uploader = !uploader.is_empty();
        if self.config.profile_card.enabled && (has_real_profile || has_uploader) {
            let pc = &self.config.profile_card;
            let at  = (hook_dur + 0.3).clamp(0.0, (dur - 0.5).max(0.0));
            let pdur = pc.duration_sec.min(dur - at).max(0.5);
            let mut name   = uploader.to_string();
            let mut handle = uploader.to_string();
            let mut stats  = String::new();
            let mut avatar_path = String::new();
            let mut image_path = String::new();
            if let Some(p) = profile_override {
                if !p.name.trim().is_empty()   { name   = p.name.trim().to_string(); }
                if !p.handle.trim().is_empty() { handle = p.handle.trim().to_string(); }
                if !p.stats.trim().is_empty()  { stats  = p.stats.trim().to_string(); }
                avatar_path = p.avatar_path.trim().to_string();
                image_path  = p.image_path.trim().to_string();
            }
            let card = super::profile_card::ProfileCard {
                name: name.clone(), handle: handle.clone(), stats,
                accent: pc.accent.clone(), font: pc.font.clone(),
                at_sec: at, duration_sec: pdur, position: pc.position.clone(),
                name_above_head: pc.name_above_head, show_card: pc.show_card,
                avatar_path: avatar_path.clone(),
                image_path: image_path.clone(),
            };
            if !avatar_path.is_empty() && !card.has_crop() {
                if let Some((bx, by, bsz)) = card.avatar_rect(1080, 1920) {
                    audio.image_badges.push(super::ffmpeg::ImageBadgeCue {
                        path: std::path::PathBuf::from(&avatar_path),
                        x: bx, y: by, size: bsz, at_sec: at, duration_sec: pdur,
                    });
                }
            }
            audio.profile_card = Some(card);
            info!("       🪪 Profile card: \"{}\"{}{} at t={:.1}s", name,
                  if handle.is_empty() { String::new() } else { format!(" @{handle}") },
                  if avatar_path.is_empty() { "" } else { " +photo" }, at);
        }

        // ── Reaction beat: real viral comment cards (OpenClaw) ───────────────
        // Show the top comments (by likes) spaced across the reaction portion of
        // the arc, each in its own time window + a notification SFX on entrance.
        if !comment_pool.is_empty() {
            let mut ranked: Vec<&super::comment_card::CommentData> = comment_pool.iter().collect();
            ranked.sort_by(|a, b| b.likes.cmp(&a.likes));
            let n = ranked.len().min(3);
            let reaction_start = (dur * 0.40).max(hook_dur + 0.5);
            let avail = (dur - reaction_start - 0.3).max(0.0);
            if avail >= 1.0 && n > 0 {
                let span = avail / n as f64;
                let pc = &self.config.profile_card;
                let notif = std::path::Path::new(&self.config.assets.sfx_dir).join("notification.mp3");
                for (k, c) in ranked.iter().take(n).enumerate() {
                    let at  = reaction_start + k as f64 * span;
                    let cdur = 3.5_f64.min(span - 0.4).max(1.0).min(dur - at);
                    if cdur < 1.0 { continue; }
                    let card = super::comment_card::CommentCard {
                        author: c.author.clone(), text: c.text.clone(), likes: c.likes,
                        avatar_path: c.avatar_path.clone(),
                        image_path: c.image_path.clone(),
                        accent: pc.accent.clone(), font: pc.font.clone(),
                        at_sec: at, duration_sec: cdur,
                    };
                    // Skip the avatar badge when a real crop is pasted (avatar is in it).
                    if !card.has_crop() && !c.avatar_path.trim().is_empty() {
                        let (bx, by, bsz) = card.avatar_rect(1080, 1920);
                        audio.image_badges.push(super::ffmpeg::ImageBadgeCue {
                            path: std::path::PathBuf::from(c.avatar_path.trim()),
                            x: bx, y: by, size: bsz, at_sec: at, duration_sec: cdur,
                        });
                    }
                    if notif.exists() {
                        audio.asset_sfx_cues.push(super::ffmpeg::AssetSfxCue {
                            path: notif.clone(), at_sec: at, duration_sec: 1.2, volume: 0.8,
                        });
                    }
                    audio.comment_cards.push(card);
                }
                info!("       💬 Comment cards: {} placed in reaction beat", audio.comment_cards.len());
            }
        }

        // ── Reaction memes matched to narration emotion (LLM-picked) ─────────
        // A meme is the viewer's inner voice popping in at the exact emotional
        // beat. The legacy per-clip path wired this from moment.asset_cues; the
        // narration path picks them here so memes also appear in narrator mode.
        if self.config.assets.memes_in_narration && audio.meme_cues.is_empty() {
            if let Some(cat) =
                crate::analyze::asset_catalog::AssetCatalog::load(&self.config.assets.catalog_path)
            {
                match build_llm_provider(self.config, &self.config.llm.default_provider) {
                    Ok(provider) => {
                        let picks = select_narration_memes(
                            provider.as_ref(), &cat, &words, narr_dur,
                            self.config.assets.narration_max_memes as usize,
                        ).await;
                        // narration-time → clip-time (+lead); enforce min gap + max.
                        let mut cand: Vec<(f64, String)> = picks.into_iter()
                            .filter_map(|(file, narr_at)| {
                                let at = (narr_at + lead).clamp(hook_dur + 0.3, (dur - 0.6).max(0.0));
                                if at <= hook_dur + 0.2 || at >= dur - 0.5 { None }
                                else { Some((at, file)) }
                            })
                            .collect();
                        cand.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                        let max = self.config.assets.narration_max_memes as usize;
                        let mut cues: Vec<super::ffmpeg::MemeCue> = Vec::new();
                        let mut last = -100.0_f64;
                        for (at, file) in cand {
                            if cues.len() >= max { break; }
                            if at - last < 5.0 { continue; }
                            let path = std::path::PathBuf::from(&file);
                            if !path.exists() { continue; }
                            let cdur = cat.assets.iter().find(|a| a.file == file)
                                .and_then(|a| a.duration_sec).unwrap_or(1.6)
                                .clamp(0.8, 2.2).min(dur - at - 0.1);
                            if cdur < 0.5 { continue; }
                            cues.push(super::ffmpeg::MemeCue {
                                path, at_sec: at, duration_sec: cdur,
                                position: "top_right".into(),
                                with_audio: cat.file_has_audio(&file), audio_volume: 0.9,
                                fullscreen: self.config.assets.meme_fullscreen,
                            });
                            last = at;
                        }
                        if !cues.is_empty() {
                            let snd = cues.iter().filter(|m| m.with_audio).count();
                            info!("       🎭 Reaction memes: {} placed (LLM-matched, {} with audio → narration ducked)",
                                  cues.len(), snd);
                            audio.meme_cues = cues;
                        } else {
                            info!("       🎭 Reaction memes: none placed");
                        }
                    }
                    Err(e) => warn!("meme selection: no LLM provider ({e})"),
                }
            }
        }

        // ── Reaction SFX matched to narration beats (LLM-picked) ─────────────
        // SFX analogue of the meme block above: the LLM drops impact/whoosh/riser/
        // notification hits on the narration's emotional & transition beats, so SFX
        // is DYNAMIC in narrator mode too (not just the static comment-card cue).
        // Independent + best-effort; appends to any SFX already queued (the comment
        // notifications added earlier survive).
        if self.config.assets.sfx_in_narration {
            if let Some(cat) =
                crate::analyze::asset_catalog::AssetCatalog::load(&self.config.assets.catalog_path)
            {
                match build_llm_provider(self.config, &self.config.llm.default_provider) {
                    Ok(provider) => {
                        let picks = select_narration_sfx(
                            provider.as_ref(), &cat, &words, narr_dur,
                            self.config.assets.narration_max_sfx as usize,
                        ).await;
                        // narration-time → clip-time (+lead); keep clear of the hook and
                        // of the clip tail; sort so the min-gap pass is deterministic.
                        let meme_ats: Vec<f64> = audio.meme_cues.iter().map(|m| m.at_sec).collect();
                        let mut cand: Vec<(f64, String)> = picks.into_iter()
                            .filter_map(|(file, narr_at)| {
                                let at = (narr_at + lead).clamp(hook_dur + 0.3, (dur - 0.4).max(0.0));
                                if at <= hook_dur + 0.2 || at >= dur - 0.3 { None } else { Some((at, file)) }
                            })
                            .collect();
                        cand.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                        let max = self.config.assets.narration_max_sfx as usize;
                        let mut cues: Vec<super::ffmpeg::AssetSfxCue> = Vec::new();
                        let mut last = -100.0_f64;
                        for (at, file) in cand {
                            if cues.len() >= max { break; }
                            if at - last < 3.0 { continue; }                          // min gap between SFX
                            if meme_ats.iter().any(|m| (m - at).abs() < 0.6) { continue; } // don't stack on a meme
                            let path = std::path::PathBuf::from(&file);
                            if !path.exists() { continue; }
                            // Play the SFX's own length, bounded so a long sting doesn't run on.
                            let cdur = cat.assets.iter().find(|a| a.file == file)
                                .and_then(|a| a.duration_sec).unwrap_or(1.2)
                                .clamp(0.3, 3.0).min(dur - at - 0.05);
                            if cdur < 0.2 { continue; }
                            cues.push(super::ffmpeg::AssetSfxCue {
                                path, at_sec: at, duration_sec: cdur, volume: 0.85,
                            });
                            last = at;
                        }
                        if !cues.is_empty() {
                            info!("       🎚️  Reaction SFX: {} placed (LLM-matched to narration beats)", cues.len());
                            audio.asset_sfx_cues.extend(cues); // append → keep comment-card notifications
                        } else {
                            info!("       🎚️  Reaction SFX: none placed");
                        }
                    }
                    Err(e) => warn!("sfx selection: no LLM provider ({e})"),
                }
            }
        }

        info!("🎬 Narrator-driven video: {:.1}s | B-roll [{:.1}–{:.1}s]{} | hook \"{}\"",
              dur, start, end,
              if loop_source { format!(" (looped from {video_dur:.0}s source)") } else { String::new() },
              hook);

        // 5) Encode (blocking ffmpeg).
        super::ffmpeg::encode_clip_direct(
            video_path, start, end, &ass_path, layout, &out_path,
            &self.config.ffmpeg, None, &audio,
        )?;

        let thumb = out_path.with_extension("jpg");
        let _ = super::ffmpeg::generate_thumbnail(&out_path, &thumb, 1.0);

        Ok(ClipOutput {
            clip_index: 0,
            title: if hook.is_empty() { "Narrated".into() } else { hook },
            path: out_path,
            thumb_path: thumb.exists().then_some(thumb),
            duration_secs: dur,
            layout: layout.to_string(),
        })
    }
}
