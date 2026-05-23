/// Trend-aware style profile generator.
///
/// Downloads a sample of trending videos from a given URL (TikTok hashtag,
/// YouTube search, etc.), extracts frames, and asks a vision LLM to describe
/// the editing style. The results are synthesized into a `StyleProfile` that
/// can be saved to `config.toml` and used with `--style-profile`.
///
/// Usage:
///   `clipper trend-analyze "https://www.tiktok.com/tag/suratirta" --sample 5 --provider gemini --output-profile tiktok_id_health`

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;
use tracing::{info, warn};

use crate::config::{AppConfig, StyleProfile, VisionConfig};

use super::vision::{extract_frames, VisualAnalyzer};

// ── Service ───────────────────────────────────────────────────────────────────

pub struct TrendAnalyzeService<'a> {
    config: &'a AppConfig,
}

impl<'a> TrendAnalyzeService<'a> {
    pub fn new(config: &'a AppConfig) -> Self {
        Self { config }
    }

    /// Download `sample` videos from `url`, analyze their editing style, and
    /// return a `StyleProfile` synthesized from the collective analysis.
    pub async fn run(
        &self,
        url:            &str,
        sample:         usize,
        vision_provider: &str,
        output_dir:     &Path,
    ) -> Result<StyleProfile> {
        tokio::fs::create_dir_all(output_dir).await
            .context("failed to create output_dir")?;

        let ytdlp_path = &self.config.ingest.ytdlp_path;
        let ffmpeg_bin = ffmpeg_sidecar::paths::ffmpeg_path();
        let ffmpeg_dir = ffmpeg_bin.parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        // ── Download sample videos ────────────────────────────────────────────
        // Strategy:
        //   1. Try the provided URL directly (works for YouTube, single videos)
        //   2. If TikTok URL and it fails → auto-fallback to YouTube Shorts search
        //      (TikTok hashtag extraction is broken in yt-dlp without cookies)
        info!("trend-analyze: downloading {} sample videos from {}", sample, url);

        let effective_url = normalize_url(url, sample);
        info!("trend-analyze: resolved URL: {}", effective_url);

        let mut video_paths = download_sample_videos(
            ytdlp_path, &effective_url, sample, output_dir, &ffmpeg_dir,
        ).await?;

        // Auto-fallback: if TikTok page returned 0 videos (common — requires cookies),
        // try a YouTube Shorts search using the hashtag keyword instead.
        if video_paths.is_empty() && is_tiktok_url(url) {
            let keyword = extract_keyword_from_url(url);
            let yt_url  = format!("ytsearch{}:{keyword} short viral tiktok 2025", sample);
            warn!(
                "trend-analyze: TikTok hashtag download failed (no working app info — \
                 requires cookies). Falling back to YouTube search: '{yt_url}'"
            );
            video_paths = download_sample_videos(
                ytdlp_path, &yt_url, sample, output_dir, &ffmpeg_dir,
            ).await?;
        }

        if video_paths.is_empty() {
            anyhow::bail!(
                "No videos could be downloaded.\n\
                 Tip: TikTok hashtag pages require authentication cookies.\n\
                 Try these instead:\n\
                   1. YouTube search:   'ytsearch10:editor trending shorts 2025'\n\
                   2. Direct video URL: 'https://www.youtube.com/watch?v=...'\n\
                   3. YT Shorts search: 'https://www.youtube.com/shorts/...'"
            );
        }
        info!("trend-analyze: {} videos downloaded", video_paths.len());

        // ── Build vision analyzer with the specified provider ─────────────────
        // Temporarily override the vision provider for this analysis
        let mut vision_cfg = self.config.vision.clone();
        vision_cfg.provider = vision_provider.to_owned();

        let analyzer = VisualAnalyzer::new(&vision_cfg, &self.config.llm);

        // ── Analyze each video ────────────────────────────────────────────────
        let mut style_votes: Vec<StyleProfile> = Vec::new();
        let frames_dir = output_dir.join("frames");

        for (idx, video_path) in video_paths.iter().enumerate() {
            info!("trend-analyze: analyzing video {}/{} — {}", idx+1, video_paths.len(),
                  video_path.file_name().unwrap_or_default().to_string_lossy());

            let clip_frames_dir = frames_dir.join(format!("v{idx:02}"));
            // Extract 4 frames spread across the video
            let frames = extract_frames(
                video_path, 2.0, get_video_duration(video_path).await.min(60.0),
                4, 512, &clip_frames_dir, None,
            ).await;

            if frames.is_empty() {
                warn!("trend-analyze: no frames extracted for {}", video_path.display());
                continue;
            }

            if let Some(profile) = analyze_style_from_frames(&frames, &analyzer).await {  // clippy: ref is needed
                info!("  → detected style: {} (subtitle={}, clip={}, overlay={})",
                      profile.description, profile.subtitle_style,
                      profile.clip_style, profile.overlay_style);
                style_votes.push(profile);
            }

            // Cleanup frames for this video
            let _ = tokio::fs::remove_dir_all(&clip_frames_dir).await;
        }

        if style_votes.is_empty() {
            anyhow::bail!("Style analysis produced no results");
        }

        // ── Synthesize: vote-based majority across all analyzed videos ────────
        let final_profile = synthesize_profiles(&style_votes);
        info!(
            "trend-analyze: synthesized profile — subtitle={} clip={} sfx={} bgm={} overlay={}",
            final_profile.subtitle_style, final_profile.clip_style,
            final_profile.sfx_vibe, final_profile.bgm_vibe, final_profile.overlay_style
        );

        Ok(final_profile)
    }
}

// ── URL helpers ───────────────────────────────────────────────────────────────

fn is_tiktok_url(url: &str) -> bool {
    url.contains("tiktok.com")
}

/// Convert any URL or keyword into a form yt-dlp can download from.
///
/// Handles:
///   - Plain keyword         → `ytsearch{N}:keyword short viral 2025`
///   - YouTube search page   → `ytsearch{N}:keyword` (extracted from query param)
///   - YouTube hashtag page  → `ytsearch{N}:#hashtag shorts`
///   - TikTok hashtag page   → downloaded directly (fallback to YT if it fails)
///   - Direct video URL      → passed through unchanged
fn normalize_url(url: &str, sample: usize) -> String {
    // Already a yt-dlp search expression — pass through unchanged
    if url.starts_with("ytsearch") || url.starts_with("ytdl") {
        return url.to_owned();
    }
    // Plain keyword (no protocol) → YouTube search
    if !url.starts_with("http") {
        return format!("ytsearch{sample}:{url} short viral 2025");
    }

    // YouTube search results page: /results?search_query=...
    if url.contains("youtube.com/results") {
        if let Some(q) = url.split("search_query=").nth(1) {
            let keyword = q.split('&').next().unwrap_or(q)
                .replace('+', " ")
                .replace("%20", " ");
            return format!("ytsearch{sample}:{keyword} shorts viral 2025");
        }
    }

    // YouTube hashtag page: /hashtag/...
    if url.contains("youtube.com/hashtag/") {
        if let Some(tag) = url.split("/hashtag/").nth(1) {
            let keyword = tag.split('?').next().unwrap_or(tag);
            return format!("ytsearch{sample}:#{keyword} shorts 2025");
        }
    }

    url.to_owned()
}

/// Extract the keyword from a TikTok hashtag or challenge URL.
/// `https://www.tiktok.com/tag/editor` → `"editor"`
fn extract_keyword_from_url(url: &str) -> String {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("trending")
        .to_owned()
}

// ── Video download ────────────────────────────────────────────────────────────

async fn download_sample_videos(
    ytdlp_path: &str,
    url:        &str,
    sample:     usize,
    output_dir: &Path,
    ffmpeg_dir: &str,
) -> Result<Vec<PathBuf>> {
    let template = output_dir.join("%(id)s.%(ext)s").to_string_lossy().to_string();

    let mut args = vec![
        "--no-playlist".to_owned(),
        "--max-downloads".to_owned(), sample.to_string(),
        "--format".to_owned(), "mp4/bestvideo[height<=720]+bestaudio/best".to_owned(),
        "--merge-output-format".to_owned(), "mp4".to_owned(),
        "--match-filter".to_owned(), "duration < 180".to_owned(),  // trend videos can be up to 3 min
        "--output".to_owned(), template,
        "--ignore-errors".to_owned(),
        "--js-runtimes".to_owned(), "deno".to_owned(),
        // Not quiet — show errors so user knows what's happening
        "--no-warnings".to_owned(),
    ];
    if !ffmpeg_dir.is_empty() {
        args.push("--ffmpeg-location".to_owned());
        args.push(ffmpeg_dir.to_owned());
    }
    args.push(url.to_owned());

    let status = tokio::time::timeout(
        Duration::from_secs(300),
        tokio::process::Command::new(ytdlp_path)
            .args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
    ).await;

    match status {
        Ok(Ok(s)) if s.success() => {}
        Ok(Ok(s)) => {
            let code = s.code().unwrap_or(-1);
            // Codes 1 and 101 = partial success (some items failed, others may have succeeded)
            if code == 1 || code == 101 {
                warn!("trend-analyze: yt-dlp exited with code {code} (partial — checking for any downloaded files)");
            } else {
                anyhow::bail!("yt-dlp exited with code {code}");
            }
        }
        Ok(Err(e)) => anyhow::bail!("yt-dlp spawn error: {e}"),
        Err(_) => anyhow::bail!("yt-dlp timed out"),
    }

    // Collect downloaded video files (any format yt-dlp produced)
    const VIDEO_EXTS: &[&str] = &["mp4", "webm", "mkv", "mov", "avi"];
    let mut videos = Vec::new();
    let mut entries = tokio::fs::read_dir(output_dir).await?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let p = entry.path();
        if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            if VIDEO_EXTS.contains(&ext.to_lowercase().as_str()) {
                videos.push(p);
            }
        }
    }
    videos.sort();
    Ok(videos)
}

/// Get video duration in seconds using ffprobe.
async fn get_video_duration(path: &Path) -> f64 {
    let ffprobe = std::env::var("FFMPEG_PATH")
        .ok()
        .and_then(|p| std::path::Path::new(&p).parent().map(|d| d.join("ffprobe").to_string_lossy().to_string()))
        .unwrap_or_else(|| "ffprobe".to_owned());

    let out = tokio::process::Command::new(&ffprobe)
        .args(["-v","error","-show_entries","format=duration","-of","csv=p=0",
               &path.to_string_lossy()])
        .output().await;

    out.ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(30.0)
}

// ── Style analysis ────────────────────────────────────────────────────────────

async fn analyze_style_from_frames(
    frames:   &[super::vision::FrameData],
    analyzer: &VisualAnalyzer<'_>,
) -> Option<StyleProfile> {
    let system = "You are a video editing style analyst. Analyze these frames from a trending \
                  short-form social media video and identify the editing style.";

    let user = "Analyze the editing style of these video frames. Look at:\
                \n- Subtitle/caption style (bold/animated/CapCut-style/minimal/word-pop/karaoke)\
                \n- Visual transition feel (flash/fade/zoom/smooth/cut)\
                \n- Any overlay usage (sticker/PiP/fullscreen reaction/none)\
                \n- Audio energy impression (upbeat/cinematic/lofi/inspirational)\
                \n- Overall energy (high/medium/low)\
                \n\nRespond ONLY with JSON:\
                \n{\"subtitle_style\":\"karaoke|capcut_bold|word_pop|minimal_white\",\
                \"clip_style\":\"fade|flash|zoom|smooth|none\",\
                \"overlay_style\":\"none|sticker|pip|fullscreen\",\
                \"sfx_vibe\":\"impact|whoosh|ding|comedy|none\",\
                \"bgm_vibe\":\"lofi|upbeat|cinematic|inspirational|none\",\
                \"description\":\"one sentence\"}";

    let raw = call_vision_for_style(analyzer, system, user, frames).await?;
    parse_style_profile(&raw)
}

async fn call_vision_for_style(
    analyzer: &VisualAnalyzer<'_>,
    system:   &str,
    user:     &str,
    frames:   &[super::vision::FrameData],
) -> Option<String> {
    // Use raw_vision_call which sends our custom style-analysis prompts directly
    // to the vision API without being overridden by describe_batch's frame prompts.
    analyzer.raw_vision_call(system, user, frames).await
}

fn parse_style_profile(raw: &str) -> Option<StyleProfile> {
    // Strip markdown fences
    let cleaned = raw.trim()
        .trim_start_matches("```json").trim_start_matches("```")
        .trim_end_matches("```").trim();

    let start = cleaned.find('{')?;
    let end   = cleaned.rfind('}')?;
    let json: Value = serde_json::from_str(&cleaned[start..=end]).ok()?;

    let get = |k: &str| json[k].as_str().unwrap_or("").to_owned();

    Some(StyleProfile {
        description:    get("description"),
        subtitle_style: get("subtitle_style"),
        clip_style:     get("clip_style"),
        sfx_vibe:       get("sfx_vibe"),
        bgm_vibe:       get("bgm_vibe"),
        overlay_style:  get("overlay_style"),
    })
}

// ── Profile synthesis ─────────────────────────────────────────────────────────

/// Take the majority vote for each field across all analyzed videos.
fn synthesize_profiles(votes: &[StyleProfile]) -> StyleProfile {
    fn majority(values: impl Iterator<Item = String>) -> String {
        let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for v in values {
            if !v.is_empty() { *counts.entry(v).or_default() += 1; }
        }
        counts.into_iter().max_by_key(|(_, c)| *c).map(|(v, _)| v).unwrap_or_default()
    }

    let subtitle = majority(votes.iter().map(|p| p.subtitle_style.clone()));
    let clip     = majority(votes.iter().map(|p| p.clip_style.clone()));
    let sfx      = majority(votes.iter().map(|p| p.sfx_vibe.clone()));
    let bgm      = majority(votes.iter().map(|p| p.bgm_vibe.clone()));
    let overlay  = majority(votes.iter().map(|p| p.overlay_style.clone()));

    let desc = format!(
        "Auto-generated from {} videos: {}/{}/{}/{}/{}",
        votes.len(), subtitle, clip, sfx, bgm, overlay
    );

    StyleProfile { description: desc, subtitle_style: subtitle, clip_style: clip,
                   sfx_vibe: sfx, bgm_vibe: bgm, overlay_style: overlay }
}

// ── Profile serialization ─────────────────────────────────────────────────────

/// Write a style profile as a TOML snippet that can be pasted into config.toml.
pub fn profile_to_toml(name: &str, profile: &StyleProfile) -> String {
    format!(
        "[styles.profiles.{name}]\n\
         description    = \"{}\"\n\
         subtitle_style = \"{}\"\n\
         clip_style     = \"{}\"\n\
         sfx_vibe       = \"{}\"\n\
         bgm_vibe       = \"{}\"\n\
         overlay_style  = \"{}\"\n",
        profile.description, profile.subtitle_style, profile.clip_style,
        profile.sfx_vibe, profile.bgm_vibe, profile.overlay_style
    )
}
