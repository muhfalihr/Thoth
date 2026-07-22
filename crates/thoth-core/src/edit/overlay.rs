/// TikTok / YouTube Shorts overlay download, style detection, and caching.
///
/// Downloads a short viral clip matching a search query via yt-dlp, then
/// analyses it to determine the best rendering style:
///
/// - **FullScreen** — full-frame cut-away (B-roll, shocking footage)
/// - **Sticker**    — chromakey green/blue background + corner position (reaction sticker)
/// - **Pip**        — small picture-in-picture box in corner (reaction video)
///
/// Style is determined in two passes:
///   1. LLM hint from `overlay_style` field in ViralMoment ("sticker"/"pip"/"fullscreen"/"auto")
///   2. Auto-detection via FFmpeg pixel analysis when hint = "auto"
///
/// Clips are cached by the MD5 hash of the query string.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::config::OverlayConfig;
use crate::execution::JobExecutionContext;

// ── Style types ───────────────────────────────────────────────────────────────

/// Where to anchor a sticker or PiP box on the frame.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StickerPosition {
    /// Most popular TikTok sticker position — bottom-right, above subtitle area.
    #[default]
    BottomRight,
    BottomLeft,
    TopRight,
    TopLeft,
    BottomCenter,
}

impl StickerPosition {
    /// Parse from LLM-supplied string. Falls back to BottomRight for unknown values.
    pub fn from_str(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "bottom_left"   | "bottomleft"   => StickerPosition::BottomLeft,
            "top_right"     | "topright"     => StickerPosition::TopRight,
            "top_left"      | "topleft"      => StickerPosition::TopLeft,
            "bottom_center" | "bottomcenter" => StickerPosition::BottomCenter,
            _                                => StickerPosition::BottomRight,
        }
    }
}

/// Which background colour to key out.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum KeyColor {
    #[default]
    Green,
    Blue,
}

impl KeyColor {
    /// FFmpeg chromakey colour string.
    pub fn ffmpeg_color(&self) -> &'static str {
        match self {
            KeyColor::Green => "0x00FF00",
            KeyColor::Blue  => "0x0000FF",
        }
    }
}

/// How the downloaded overlay clip should be rendered on the main clip.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum OverlayStyle {
    /// Full-frame replacement — overlay covers entire screen.
    /// Best for: shocking B-roll, proof clips, dramatic footage.
    #[default]
    FullScreen,

    /// Chromakey + corner sticker.
    /// Best for: reaction faces with greenscreen, meme stickers, TikTok templates.
    Sticker {
        position:  StickerPosition,
        /// Display width as percentage of frame width (35% default).
        scale_pct: u32,
        key_color: KeyColor,
    },

    /// Small picture-in-picture box — no chroma key.
    /// Best for: real-content reaction videos, duet-style commentary.
    Pip {
        position:  StickerPosition,
        /// Display width as percentage of frame width (28% default).
        scale_pct: u32,
    },

    /// Centred footage CARD on the paper canvas — Montage montage.
    /// The enrichment clip is shown large in the centre (same width as the main
    /// footage card) during its time window, so the video cuts main↔enrichment.
    /// Best for: reaction montage of multiple relevant clips.
    FootageCard {
        /// Display width as percentage of frame width (≈88% — matches main card).
        scale_pct: u32,
        /// Vertical placement variation: 0 = centre, negative = up, positive = down
        /// (pixels). Keeps the card clear while adding per-beat dynamism.
        y_offset: i32,
    },
}

// ── OverlaySpec ───────────────────────────────────────────────────────────────

/// Resolved overlay clip: local path + timing + rendering style for FFmpeg.
#[derive(Debug, Clone)]
pub struct OverlaySpec {
    /// Local path to the downloaded (and trimmed) overlay clip.
    pub path: PathBuf,
    /// Seconds from the clip's start where the overlay begins.
    pub at_sec: f64,
    /// How many seconds the overlay lasts.
    pub duration_sec: f64,
    /// How the overlay should be rendered (auto-detected or LLM-hinted).
    pub style: OverlayStyle,
}

// ── Public API ────────────────────────────────────────────────────────────────


/// Download (or serve from cache) an overlay clip from a SPECIFIC, pre-curated URL.
///
/// Takes a URL already picked from the cross-platform enrichment pool
/// (`content_enrichment.json`) — relevance-filtered YouTube/Instagram videos — and
/// downloads it directly via yt-dlp. This is what powers the Montage
/// "multiple relevant clips" cutaway style.
///
/// Cache key is `md5(url)` (variant slot 0). Returns `None` on any failure — an
/// overlay is purely additive and must never block clip rendering.
pub async fn fetch_overlay_from_url(
    execution:  &JobExecutionContext,
    url:        &str,
    at_sec:     f64,
    duration:   f64,
    cfg:        &OverlayConfig,
    ytdlp_path: &str,
    ffmpeg_dir: &str,
    cookie:     Option<&crate::ingest::CookieSource>,
) -> Result<Option<OverlaySpec>> {
    let url = url.trim();
    if url.is_empty() { return Ok(None); }

    if let Err(e) = tokio::fs::create_dir_all(&cfg.cache_dir).await {
        warn!("overlay: cannot create cache dir: {e}");
        return Ok(None);
    }

    // Cache by URL hash so the same enrichment clip is downloaded only once.
    let dest = cache_path_variant(&cfg.cache_dir, url, 0);
    if !dest.exists() {
        info!("overlay: downloading enrichment clip {url}");
        let tmp_prefix = dest.with_extension("tmpurl");
        // Grab only the opening slice — enrichment clips are full-length videos,
        // so a max-duration *filter* (download_clip_direct) would reject them.
        let ok = download_clip_section(
            execution, ytdlp_path, url, &tmp_prefix, cfg.max_duration, ffmpeg_dir, cookie,
        ).await?;
        if !ok {
            warn!("overlay: enrichment download failed for {url}");
            return Ok(None);
        }
        if let Some(raw) = find_downloaded(&tmp_prefix) {
            match trim_clip(execution, &raw, &dest, cfg.max_duration, ffmpeg_dir).await {
                Ok(()) => {
                    let _ = tokio::fs::remove_file(&raw).await;
                }
                Err(error) if crate::execution::is_cancelled(&error) => return Err(error),
                Err(_) => {
                    let _ = tokio::fs::rename(&raw, &dest).await;
                }
            }
        } else {
            warn!("overlay: enrichment clip not found on disk after download ({url})");
            return Ok(None);
        }
    }

    if dest.exists() {
        debug!("overlay: using enrichment clip for {url}: {}", dest.display());
        Ok(Some(OverlaySpec {
            path: dest,
            at_sec,
            duration_sec: duration,
            style: OverlayStyle::FullScreen, // style resolved in service.rs
        }))
    } else {
        Ok(None)
    }
}

/// Determine the best `OverlayStyle` for an already-downloaded clip.
///
/// Priority:
///   1. `style_hint` from LLM ("sticker" | "pip" | "fullscreen") — trusted when not "auto"
///   2. Auto-detection via FFmpeg pixel analysis (green/blue screen → Sticker, else FullScreen)
///
/// Never fails — returns `OverlayStyle::FullScreen` on any error.
pub async fn detect_overlay_style(
    execution:     &JobExecutionContext,
    path:          &Path,
    style_hint:    &str,
    ffmpeg_dir:    &str,
    position_hint: &str,   // "bottom_right"|"bottom_left"|"top_right"|"top_left"|"bottom_center"
) -> Result<OverlayStyle> {
    let pos = StickerPosition::from_str(position_hint);
    match style_hint.trim().to_lowercase().as_str() {
        "sticker" => {
            // LLM says sticker — run pixel analysis to determine key color
            let key = detect_key_color(execution, path, ffmpeg_dir).await?.unwrap_or(KeyColor::Green);
            Ok(OverlayStyle::Sticker { position: pos, scale_pct: 35, key_color: key })
        }
        "pip" => {
            Ok(OverlayStyle::Pip { position: pos, scale_pct: 28 })
        }
        "fullscreen" => Ok(OverlayStyle::FullScreen),
        _ => {
            // "auto" or empty — run full auto-detection, use position hint
            auto_detect_style_at(execution, path, ffmpeg_dir, pos).await
        }
    }
}

// ── Auto-detection ────────────────────────────────────────────────────────────

/// Analyse overlay frames to automatically pick the best `OverlayStyle`.
///
/// - Green/blue screen dominant → `Sticker`
/// - Portrait aspect ratio (face/reaction) → `Pip`
/// - Otherwise → `FullScreen`
async fn auto_detect_style_at(execution: &JobExecutionContext, path: &Path, ffmpeg_dir: &str, pos: StickerPosition) -> Result<OverlayStyle> {
    // 1. Check aspect ratio via ffprobe (fast, no decoding)
    let aspect = get_video_aspect(execution, path, ffmpeg_dir).await?;

    // 2. Sample a center frame and analyse colours
    if let Some((avg_r, avg_g, avg_b)) = sample_center_frame(execution, path, ffmpeg_dir).await? {
        // Greenscreen heuristic: G significantly dominates R and B
        if avg_g as f32 > avg_r as f32 * 1.35
            && avg_g as f32 > avg_b as f32 * 1.35
            && avg_g > 70
        {
            info!("overlay: auto-detected greenscreen (R={avg_r} G={avg_g} B={avg_b})");
            return Ok(OverlayStyle::Sticker {
                position:  pos.clone(),
                scale_pct: 35,
                key_color: KeyColor::Green,
            });
        }
        // Bluescreen heuristic
        if avg_b as f32 > avg_r as f32 * 1.35
            && avg_b as f32 > avg_g as f32 * 1.35
            && avg_b > 70
        {
            info!("overlay: auto-detected bluescreen (R={avg_r} G={avg_g} B={avg_b})");
            return Ok(OverlayStyle::Sticker {
                position:  pos.clone(),
                scale_pct: 35,
                key_color: KeyColor::Blue,
            });
        }
    }

    // Portrait video (w < h) = likely a face reaction → PiP
    if let Some((w, h)) = aspect {
        if w > 0 && h > 0 && (w as f32) < (h as f32) * 0.75 {
            info!("overlay: auto-detected portrait aspect ({w}×{h}) → PiP");
            return Ok(OverlayStyle::Pip { position: pos, scale_pct: 28 });
        }
    }

    // Default: full-screen
    Ok(OverlayStyle::FullScreen)
}

/// Detect whether a clip has green or blue screen as dominant background colour.
/// Returns the detected `KeyColor`, or `None` if no chroma screen detected.
async fn detect_key_color(execution: &JobExecutionContext, path: &Path, ffmpeg_dir: &str) -> Result<Option<KeyColor>> {
    let Some((r, g, b)) = sample_center_frame(execution, path, ffmpeg_dir).await? else { return Ok(None); };
    if g as f32 > r as f32 * 1.25 && g as f32 > b as f32 * 1.25 {
        Ok(Some(KeyColor::Green))
    } else if b as f32 > r as f32 * 1.25 && b as f32 > g as f32 * 1.25 {
        Ok(Some(KeyColor::Blue))
    } else {
        Ok(None)
    }
}

/// Extract a single centre frame from the video and return average (R, G, B).
async fn sample_center_frame(execution: &JobExecutionContext, path: &Path, ffmpeg_dir: &str) -> Result<Option<(u8, u8, u8)>> {
    let ffmpeg = resolve_ffmpeg(ffmpeg_dir);

    // Extract a 64×64 patch from the center of frame 1 as raw RGB
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
            .args([
                "-y",
                "-i", &path.to_string_lossy(),
                "-vf", "select=eq(n\\,1),crop=64:64:(iw-64)/2:(ih-64)/2,scale=64:64",
                "-frames:v", "1",
                "-f", "rawvideo",
                "-pix_fmt", "rgb24",
                "pipe:1",
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
    let output = execution.output_with_timeout(&mut command, Duration::from_secs(15)).await;

    let bytes = match output {
        Ok(out) if !out.stdout.is_empty() => out.stdout,
        Err(error) if crate::execution::is_cancelled(&error) => return Err(error),
        _ => return Ok(None),
    };

    // Average RGB across all pixels (64×64×3 bytes)
    let n = bytes.len() / 3;
    if n == 0 { return Ok(None); }

    let (mut r, mut g, mut b) = (0u64, 0u64, 0u64);
    for chunk in bytes.chunks_exact(3) {
        r += chunk[0] as u64;
        g += chunk[1] as u64;
        b += chunk[2] as u64;
    }
    Ok(Some(((r / n as u64) as u8, (g / n as u64) as u8, (b / n as u64) as u8)))
}

/// Get video width × height using ffprobe.
pub(crate) async fn get_video_aspect(execution: &JobExecutionContext, path: &Path, ffmpeg_dir: &str) -> Result<Option<(u32, u32)>> {
    let ffprobe = {
        let dir = Path::new(ffmpeg_dir);
        let bin = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
        if ffmpeg_dir.is_empty() {
            "ffprobe".to_owned()
        } else {
            dir.join(bin).to_string_lossy().to_string()
        }
    };

    let mut command = tokio::process::Command::new(&ffprobe);
    command
            .args([
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "csv=p=0",
                &path.to_string_lossy(),
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
    let output = match execution.output_with_timeout(&mut command, Duration::from_secs(5)).await {
        Ok(output) => output,
        Err(error) if crate::execution::is_cancelled(&error) => return Err(error),
        Err(_) => return Ok(None),
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = text.trim().split(',').collect();
    if parts.len() >= 2 {
        let Ok(w) = parts[0].trim().parse::<u32>() else { return Ok(None); };
        let Ok(h) = parts[1].trim().parse::<u32>() else { return Ok(None); };
        Ok(Some((w, h)))
    } else {
        Ok(None)
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn resolve_ffmpeg(ffmpeg_dir: &str) -> String {
    if ffmpeg_dir.is_empty() {
        std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".to_owned())
    } else {
        let dir = Path::new(ffmpeg_dir);
        let bin = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        dir.join(bin).to_string_lossy().to_string()
    }
}

/// Cache path for variant `idx` of a query.
/// Layout: `{cache_dir}/{md5}_{idx}.mp4`
fn cache_path_variant(cache_dir: &Path, query: &str, idx: usize) -> PathBuf {
    let hash = format!("{:x}", md5::compute(query.to_lowercase().trim().as_bytes()));
    cache_dir.join(format!("{hash}_{idx}.mp4"))
}

fn urlencoded(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "+".to_owned(),
            c   => format!("%{:02X}", c as u32),
        })
        .collect()
}

/// Apply cookie authentication to a yt-dlp arg builder, mirroring the ingest path.
/// `None` leaves the builder unchanged. Any temp cookie DB copy it creates is
/// recorded in `builder.temp_cookie_path` — capture it before `.build()` and pass
/// to [`cleanup_temp_cookie`] afterwards.
async fn apply_cookie(
    builder: crate::ingest::YtDlpArgs,
    cookie:  Option<&crate::ingest::CookieSource>,
) -> crate::ingest::YtDlpArgs {
    match cookie {
        Some(src) => builder.with_cookie(src).await,
        None => builder,
    }
}

/// Delete the temp cookie DB copy created by `with_cookie` (Windows Chromium),
/// if any. Best-effort — a leftover temp file must never fail a footage download.
async fn cleanup_temp_cookie(path: Option<std::path::PathBuf>) {
    if let Some(p) = path {
        let _ = tokio::fs::remove_file(p).await;
    }
}

/// Download a clip from a DIRECT URL (resolved by the stealth scraper).
///
/// Unlike `download_clip_variant` which runs a search query inside yt-dlp,
/// this function passes a specific video URL so yt-dlp downloads immediately
/// without an extra search round-trip.
async fn download_clip_direct(
    execution:   &JobExecutionContext,
    ytdlp:       &str,
    url:         &str,
    out_prefix:  &Path,
    max_dur:     f64,
    ffmpeg_dir:  &str,
    variant_idx: usize,
    cookie:      Option<&crate::ingest::CookieSource>,
) -> Result<bool> {
    let template = format!("{}.%(ext)s", out_prefix.to_string_lossy());

    let builder = crate::ingest::YtDlpArgs::new(ytdlp)
        .quiet()
        .no_playlist()
        .format("mp4/bestvideo[height<=1920]+bestaudio/best")
        .merge_mp4()
        .max_duration(((max_dur * 1.5) as u64).min(300))
        // SKILL.md §1A — lighter retry count for overlay (non-critical path)
        .resilience(3, 3, 1, 20)
        // SKILL.md §1B — YouTube client fallback for YouTube URLs
        .youtube_client_fallback(url)
        // SKILL.md §2A — filename safety on Windows
        .windows_safe()
        .ffmpeg_dir(ffmpeg_dir)
        .output(&template)
        .url(url);
    // SKILL.md §3A — cookie auth (TikTok/IG/age-gated footage needs login cookies).
    let builder = apply_cookie(builder, cookie).await;
    let temp_cookie = builder.temp_cookie_path.clone();
    let (bin, args) = builder.build();

    debug!("overlay: yt-dlp direct[v{variant_idx}] {url}");

    let mut command = tokio::process::Command::new(&bin);
    command.args(&args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let result = execution.status_with_timeout(&mut command, Duration::from_secs(60)).await;

    cleanup_temp_cookie(temp_cookie).await;
    supervised_overlay_status(result)
}

/// Download only the OPENING `max_dur` seconds of a specific video URL.
///
/// Used for enrichment cutaways: the source is a full-length video, so we slice
/// the first few seconds via `--download-sections` instead of applying a
/// max-duration *filter* (which would reject the whole video). Fast — only the
/// requested slice is fetched.
async fn download_clip_section(
    execution:  &JobExecutionContext,
    ytdlp:      &str,
    url:        &str,
    out_prefix: &Path,
    max_dur:    f64,
    ffmpeg_dir: &str,
    cookie:     Option<&crate::ingest::CookieSource>,
) -> Result<bool> {
    let template = format!("{}.%(ext)s", out_prefix.to_string_lossy());
    // Grab a little extra so trim_clip has headroom to land on a clean keyframe.
    let secs = ((max_dur + 2.0) as u64).max(2);

    let builder = crate::ingest::YtDlpArgs::new(ytdlp)
        .quiet()
        .no_playlist()
        .format("mp4/bestvideo[height<=1920]+bestaudio/best")
        .merge_mp4()
        .download_first_secs(secs)
        .resilience(3, 3, 1, 20)
        .youtube_client_fallback(url)
        .windows_safe()
        .ffmpeg_dir(ffmpeg_dir)
        .output(&template)
        .url(url);
    // SKILL.md §3A — cookie auth so footage from TikTok/IG (login-gated) downloads.
    let builder = apply_cookie(builder, cookie).await;
    let temp_cookie = builder.temp_cookie_path.clone();
    let (bin, args) = builder.build();

    debug!("overlay: yt-dlp section[0-{secs}s] {url}");

    let mut command = tokio::process::Command::new(&bin);
    command.args(&args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let result = execution.status_with_timeout(&mut command, Duration::from_secs(90)).await;

    cleanup_temp_cookie(temp_cookie).await;
    supervised_overlay_status(result)
}

/// Download a single overlay clip via yt-dlp search query.
///
/// Uses `max_downloads(1)` so yt-dlp picks the first result matching the
/// duration filter — successive variants rotate at the call site.
async fn download_clip_variant(
    execution:   &JobExecutionContext,
    ytdlp:       &str,
    url:         &str,
    out_prefix:  &Path,
    max_dur:     f64,
    ffmpeg_dir:  &str,
    label:       &str,
    variant_idx: usize,
    cookie:      Option<&crate::ingest::CookieSource>,
) -> Result<bool> {
    let template = format!("{}.%(ext)s", out_prefix.to_string_lossy());

    let builder = crate::ingest::YtDlpArgs::new(ytdlp)
        // Allow search results; max_downloads(1) picks first matching clip
        .max_downloads(1)
        .quiet()
        .format("mp4/bestvideo[height<=1920]+bestaudio/best")
        .merge_mp4()
        // Allow videos up to 1.5× max_duration (safety margin) but cap at 300s
        .max_duration(((max_dur * 1.5) as u64).min(300))
        // SKILL.md §1A — lighter retry count for overlay (non-critical path)
        .resilience(3, 3, 1, 20)
        // SKILL.md §1B — YouTube client fallback for YouTube URLs
        .youtube_client_fallback(url)
        // SKILL.md §2A — filename safety on Windows
        .windows_safe()
        .js_runtimes()
        .ffmpeg_dir(ffmpeg_dir)
        .output(&template)
        .url(url);
    // SKILL.md §3A — cookie auth (TikTok search/download needs login cookies).
    let builder = apply_cookie(builder, cookie).await;
    let temp_cookie = builder.temp_cookie_path.clone();
    let (bin, args) = builder.build();

    debug!("overlay: yt-dlp {label}[v{variant_idx}] args: {:?}", args);

    let mut command = tokio::process::Command::new(&bin);
    command.args(&args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let result = execution.status_with_timeout(&mut command, Duration::from_secs(60)).await;

    cleanup_temp_cookie(temp_cookie).await;
    supervised_overlay_status(result)
}

fn supervised_overlay_status(result: Result<std::process::ExitStatus>) -> Result<bool> {
    match result {
        Ok(status) => Ok(status.success()),
        Err(error) if crate::execution::is_cancelled(&error) => Err(error),
        Err(_) => Ok(false),
    }
}

fn find_downloaded(prefix: &Path) -> Option<PathBuf> {
    let dir  = prefix.parent()?;
    let stem = prefix.file_name()?.to_string_lossy();
    let Ok(entries) = std::fs::read_dir(dir) else { return None; };
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with(stem.as_ref()) && entry.path().is_file() {
            return Some(entry.path());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervised_overlay_cancellation_is_not_soft_failed() {
        let error = supervised_overlay_status(Err(anyhow::Error::new(
            crate::execution::Cancelled,
        )))
        .expect_err("cancelled overlay must not be converted to false");

        assert!(crate::execution::is_cancelled(&error));
    }
}

async fn trim_clip(execution: &JobExecutionContext, src: &Path, dest: &Path, max_dur: f64, ffmpeg_dir: &str) -> Result<()> {
    let ffmpeg = resolve_ffmpeg(ffmpeg_dir);
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .args(["-y", "-i", &src.to_string_lossy(), "-t", &format!("{max_dur:.3}"),
               "-c", "copy", "-movflags", "+faststart", &dest.to_string_lossy()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let status = execution.status(&mut command).await.context("ffmpeg trim spawn")?;
    if status.success() { Ok(()) } else { Err(anyhow::anyhow!("ffmpeg trim exited {status}")) }
}

/// Classify a video aspect ratio as cover (true) or contain (false).
///
/// Portrait and near-9:16 aspect ratios (h/w ≥ 1.2) are "cover" — they fill
/// the entire frame in vertical orientation. Landscape or square are "contain".
///
/// Uses integer math to avoid floating-point errors: `(h as u64)*100 >= (w as u64)*120`
pub(crate) fn cover_from_dims(w: u32, h: u32) -> bool {
    if w == 0 || h == 0 {
        return false;
    }
    (h as u64) * 100 >= (w as u64) * 120
}

/// Probe a video's aspect ratio and classify as cover or contain.
///
/// Returns `true` if the video is portrait/near-9:16 (cover), `false` for landscape/square.
/// Returns `false` on any probe failure (ffprobe error, missing dimensions, etc.).
pub(crate) async fn footage_is_cover(
    execution:  &JobExecutionContext,
    path:       &Path,
    ffmpeg_dir: &str,
) -> bool {
    match get_video_aspect(execution, path, ffmpeg_dir).await {
        Ok(Some((w, h))) => cover_from_dims(w, h),
        _ => false,
    }
}

#[cfg(test)]
mod sp2_aspect_tests {
    use super::cover_from_dims;

    #[test]
    fn classifies_cover_vs_contain() {
        assert!(cover_from_dims(1080, 1920));   // 9:16 portrait → cover
        assert!(cover_from_dims(720, 1280));    // portrait → cover
        assert!(cover_from_dims(1000, 1200));   // h/w = 1.2 exactly → cover
        assert!(!cover_from_dims(1920, 1080));  // landscape → contain
        assert!(!cover_from_dims(1080, 1080));  // square → contain
        assert!(!cover_from_dims(0, 0));        // degenerate → contain
        assert!(!cover_from_dims(1080, 1180));  // h/w < 1.2 → contain
    }
}
