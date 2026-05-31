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

/// Download (or serve from cache) a short overlay clip matching `query`.
///
/// Download strategy (tried in order):
///   1. **Stealth scraper** (when `cfg.scraper_enabled`): fetches TikTok / YouTube
///      search pages with Chrome-fingerprint headers, extracts direct video URLs
///      pre-ranked by view count, passes them straight to yt-dlp — 3–5× faster
///      than a blind yt-dlp search and picks the most-viral matching clip.
///   2. **yt-dlp TikTok search** (fallback): existing `ytsearch`/TikTok URL approach.
///   3. **yt-dlp YouTube Shorts** (final fallback, when `cfg.fallback_to_youtube`).
///
/// Downloads up to `cfg.max_variants` different clips per query and selects
/// one based on `variant_index % max_variants`.
///
/// Cache layout: `{cache_dir}/{md5(query)}_{0,1,2}.mp4`
///
/// Returns `None` on any error — an overlay is purely additive and should
/// never block clip rendering.
pub async fn fetch_overlay_clip(
    query:         &str,
    at_sec:        f64,
    duration:      f64,
    cfg:           &OverlayConfig,
    ytdlp_path:    &str,
    ffmpeg_dir:    &str,
    // variant_index: index of this clip in the render batch — used to rotate variants
    variant_index: usize,
) -> Option<OverlaySpec> {
    let query = query.trim();
    if query.is_empty() { return None; }

    if let Err(e) = tokio::fs::create_dir_all(&cfg.cache_dir).await {
        warn!("overlay: cannot create cache dir: {e}");
        return None;
    }

    let max_variants = cfg.max_variants.max(1) as usize;

    // ── Stage 1: stealth scraper — resolve ranked direct URLs ─────────────────
    // The scraper fetches TikTok / YouTube search pages with Chrome-matched TLS
    // and headers, parses embedded JSON for video IDs, and returns direct URLs
    // sorted by view count.  yt-dlp then downloads a specific URL instead of
    // running a search query — much faster and higher quality.
    let scraped: Vec<String> = if cfg.scraper_enabled {
        let results = crate::scraper::resolve_overlay_urls(
            query,
            max_variants,
            (cfg.max_duration * 1.5) as u32,
        ).await;
        if !results.is_empty() {
            info!(
                "overlay: scraper resolved {} URL(s) for '{query}' (top: {} views)",
                results.len(),
                results.first().map(|r| r.view_count).unwrap_or(0)
            );
        }
        results.into_iter().map(|r| r.url).collect()
    } else {
        Vec::new()
    };

    // ── Stage 2: download each variant (scraped URL → yt-dlp search fallback) ─
    let mut downloaded_count = 0usize;
    for idx in 0..max_variants {
        let dest = cache_path_variant(&cfg.cache_dir, query, idx);
        if dest.exists() {
            downloaded_count += 1;
            continue; // already cached
        }

        // Only download if we haven't already hit a failure for this query
        if downloaded_count == 0 && idx > 0 {
            break;
        }

        info!("overlay: downloading variant {}/{} for query '{query}'…", idx + 1, max_variants);
        let tmp_prefix = dest.with_extension(format!("tmp{idx}"));

        // ── 2a. Scraped direct URL (fastest, view-count ranked) ───────────────
        let downloaded = if let Some(direct_url) = scraped.get(idx) {
            info!("overlay: direct URL download ({direct_url})");
            download_clip_direct(
                ytdlp_path, direct_url, &tmp_prefix,
                cfg.max_duration, ffmpeg_dir, idx,
            ).await
        } else {
            false
        };

        // ── 2b. yt-dlp TikTok search fallback ────────────────────────────────
        let downloaded = if !downloaded {
            let tiktok_url = format!(
                "https://www.tiktok.com/search?q={}&type=video",
                urlencoded(query)
            );
            download_clip_variant(
                ytdlp_path, &tiktok_url, &tmp_prefix,
                cfg.max_duration, ffmpeg_dir, "TikTok", idx,
            ).await
        } else {
            downloaded
        };

        // ── 2c. yt-dlp YouTube Shorts final fallback ──────────────────────────
        if !downloaded && cfg.fallback_to_youtube {
            info!("overlay: TikTok failed, trying YouTube Shorts (variant {idx})…");
            download_clip_variant(
                ytdlp_path,
                &format!("ytsearch10:{query} short"),
                &tmp_prefix, cfg.max_duration, ffmpeg_dir, "YouTube", idx,
            ).await;
        }

        if let Some(raw) = find_downloaded(&tmp_prefix) {
            if trim_clip(&raw, &dest, cfg.max_duration, ffmpeg_dir).await.is_ok() {
                let _ = tokio::fs::remove_file(&raw).await;
            } else {
                let _ = tokio::fs::rename(&raw, &dest).await;
            }
            downloaded_count += 1;
        }
    }

    if downloaded_count == 0 {
        warn!("overlay: no clips downloaded for query '{query}'");
        return None;
    }

    // ── Pick variant by rotation ──────────────────────────────────────────────
    let pick = variant_index % downloaded_count;
    let chosen = cache_path_variant(&cfg.cache_dir, query, pick);

    if chosen.exists() {
        debug!("overlay: using variant {pick}/{downloaded_count} for '{query}': {}", chosen.display());
        Some(OverlaySpec {
            path: chosen,
            at_sec,
            duration_sec: duration,
            style: OverlayStyle::FullScreen, // style resolved in service.rs
        })
    } else {
        // Fallback: pick any available variant
        for idx in 0..max_variants {
            let fallback = cache_path_variant(&cfg.cache_dir, query, idx);
            if fallback.exists() {
                return Some(OverlaySpec {
                    path: fallback,
                    at_sec,
                    duration_sec: duration,
                    style: OverlayStyle::FullScreen,
                });
            }
        }
        warn!("overlay: no cached variant found for query '{query}'");
        None
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
    path:          &Path,
    style_hint:    &str,
    ffmpeg_dir:    &str,
    position_hint: &str,   // "bottom_right"|"bottom_left"|"top_right"|"top_left"|"bottom_center"
) -> OverlayStyle {
    let pos = StickerPosition::from_str(position_hint);
    match style_hint.trim().to_lowercase().as_str() {
        "sticker" => {
            // LLM says sticker — run pixel analysis to determine key color
            let key = detect_key_color(path, ffmpeg_dir).await.unwrap_or(KeyColor::Green);
            OverlayStyle::Sticker { position: pos, scale_pct: 35, key_color: key }
        }
        "pip" => {
            OverlayStyle::Pip { position: pos, scale_pct: 28 }
        }
        "fullscreen" => OverlayStyle::FullScreen,
        _ => {
            // "auto" or empty — run full auto-detection, use position hint
            auto_detect_style_at(path, ffmpeg_dir, pos).await
        }
    }
}

// ── Auto-detection ────────────────────────────────────────────────────────────

/// Analyse overlay frames to automatically pick the best `OverlayStyle`.
///
/// - Green/blue screen dominant → `Sticker`
/// - Portrait aspect ratio (face/reaction) → `Pip`
/// - Otherwise → `FullScreen`
async fn auto_detect_style_at(path: &Path, ffmpeg_dir: &str, pos: StickerPosition) -> OverlayStyle {
    // 1. Check aspect ratio via ffprobe (fast, no decoding)
    let aspect = get_video_aspect(path, ffmpeg_dir).await;

    // 2. Sample a center frame and analyse colours
    if let Some((avg_r, avg_g, avg_b)) = sample_center_frame(path, ffmpeg_dir).await {
        // Greenscreen heuristic: G significantly dominates R and B
        if avg_g as f32 > avg_r as f32 * 1.35
            && avg_g as f32 > avg_b as f32 * 1.35
            && avg_g > 70
        {
            info!("overlay: auto-detected greenscreen (R={avg_r} G={avg_g} B={avg_b})");
            return OverlayStyle::Sticker {
                position:  pos.clone(),
                scale_pct: 35,
                key_color: KeyColor::Green,
            };
        }
        // Bluescreen heuristic
        if avg_b as f32 > avg_r as f32 * 1.35
            && avg_b as f32 > avg_g as f32 * 1.35
            && avg_b > 70
        {
            info!("overlay: auto-detected bluescreen (R={avg_r} G={avg_g} B={avg_b})");
            return OverlayStyle::Sticker {
                position:  pos.clone(),
                scale_pct: 35,
                key_color: KeyColor::Blue,
            };
        }
    }

    // Portrait video (w < h) = likely a face reaction → PiP
    if let Some((w, h)) = aspect {
        if w > 0 && h > 0 && (w as f32) < (h as f32) * 0.75 {
            info!("overlay: auto-detected portrait aspect ({w}×{h}) → PiP");
            return OverlayStyle::Pip { position: pos, scale_pct: 28 };
        }
    }

    // Default: full-screen
    OverlayStyle::FullScreen
}

/// Detect whether a clip has green or blue screen as dominant background colour.
/// Returns the detected `KeyColor`, or `None` if no chroma screen detected.
async fn detect_key_color(path: &Path, ffmpeg_dir: &str) -> Option<KeyColor> {
    let (r, g, b) = sample_center_frame(path, ffmpeg_dir).await?;
    if g as f32 > r as f32 * 1.25 && g as f32 > b as f32 * 1.25 {
        Some(KeyColor::Green)
    } else if b as f32 > r as f32 * 1.25 && b as f32 > g as f32 * 1.25 {
        Some(KeyColor::Blue)
    } else {
        None
    }
}

/// Extract a single centre frame from the video and return average (R, G, B).
async fn sample_center_frame(path: &Path, ffmpeg_dir: &str) -> Option<(u8, u8, u8)> {
    let ffmpeg = resolve_ffmpeg(ffmpeg_dir);

    // Extract a 64×64 patch from the center of frame 1 as raw RGB
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(&ffmpeg)
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
            .stderr(std::process::Stdio::null())
            .output(),
    ).await;

    let bytes = match output {
        Ok(Ok(out)) if !out.stdout.is_empty() => out.stdout,
        _ => return None,
    };

    // Average RGB across all pixels (64×64×3 bytes)
    let n = bytes.len() / 3;
    if n == 0 { return None; }

    let (mut r, mut g, mut b) = (0u64, 0u64, 0u64);
    for chunk in bytes.chunks_exact(3) {
        r += chunk[0] as u64;
        g += chunk[1] as u64;
        b += chunk[2] as u64;
    }
    Some(((r / n as u64) as u8, (g / n as u64) as u8, (b / n as u64) as u8))
}

/// Get video width × height using ffprobe.
async fn get_video_aspect(path: &Path, ffmpeg_dir: &str) -> Option<(u32, u32)> {
    let ffprobe = {
        let dir = Path::new(ffmpeg_dir);
        let bin = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
        if ffmpeg_dir.is_empty() {
            "ffprobe".to_owned()
        } else {
            dir.join(bin).to_string_lossy().to_string()
        }
    };

    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(&ffprobe)
            .args([
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "csv=p=0",
                &path.to_string_lossy(),
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output(),
    ).await.ok()?.ok()?;

    let text = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = text.trim().split(',').collect();
    if parts.len() >= 2 {
        let w = parts[0].trim().parse::<u32>().ok()?;
        let h = parts[1].trim().parse::<u32>().ok()?;
        Some((w, h))
    } else {
        None
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

/// Download a clip from a DIRECT URL (resolved by the stealth scraper).
///
/// Unlike `download_clip_variant` which runs a search query inside yt-dlp,
/// this function passes a specific video URL so yt-dlp downloads immediately
/// without an extra search round-trip.
async fn download_clip_direct(
    ytdlp:       &str,
    url:         &str,
    out_prefix:  &Path,
    max_dur:     f64,
    ffmpeg_dir:  &str,
    variant_idx: usize,
) -> bool {
    let template = format!("{}.%(ext)s", out_prefix.to_string_lossy());

    let (bin, args) = crate::ingest::YtDlpArgs::new(ytdlp)
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
        .url(url)
        .build();

    debug!("overlay: yt-dlp direct[v{variant_idx}] {url}");

    let result = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new(&bin)
            .args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
    ).await;

    matches!(result, Ok(Ok(s)) if s.success())
}

/// Download a single overlay clip via yt-dlp search query.
///
/// Uses `max_downloads(1)` so yt-dlp picks the first result matching the
/// duration filter — successive variants rotate at the call site.
async fn download_clip_variant(
    ytdlp:       &str,
    url:         &str,
    out_prefix:  &Path,
    max_dur:     f64,
    ffmpeg_dir:  &str,
    label:       &str,
    variant_idx: usize,
) -> bool {
    let template = format!("{}.%(ext)s", out_prefix.to_string_lossy());

    let (bin, args) = crate::ingest::YtDlpArgs::new(ytdlp)
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
        .url(url)
        .build();

    debug!("overlay: yt-dlp {label}[v{variant_idx}] args: {:?}", args);

    let result = tokio::time::timeout(
        Duration::from_secs(60),
        tokio::process::Command::new(&bin)
            .args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
    ).await;

    matches!(result, Ok(Ok(s)) if s.success())
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

async fn trim_clip(src: &Path, dest: &Path, max_dur: f64, ffmpeg_dir: &str) -> Result<()> {
    let ffmpeg = resolve_ffmpeg(ffmpeg_dir);
    let status = tokio::process::Command::new(&ffmpeg)
        .args(["-y", "-i", &src.to_string_lossy(), "-t", &format!("{max_dur:.3}"),
               "-c", "copy", "-movflags", "+faststart", &dest.to_string_lossy()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .context("ffmpeg trim spawn")?;
    if status.success() { Ok(()) } else { Err(anyhow::anyhow!("ffmpeg trim exited {status}")) }
}
