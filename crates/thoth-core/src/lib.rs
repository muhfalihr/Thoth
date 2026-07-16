#![allow(dead_code, unused_imports)]

//! Thoth core library: pipeline orchestration + shared types.
//! Adapters (thoth CLI, thoth-server) depend on this crate.

/*
 * Thoth - AI-Powered Short-Form Video Strategist
 * Copyright (c) 2026 Thoth. All Rights Reserved.
 * This software is PROPRIETARY. Unauthorized use is strictly prohibited.
 */

pub mod analyze;
pub mod cli;
pub mod config;
pub mod edit;
pub mod execution;
pub mod gpu;
pub mod ingest;
pub mod narration;
pub mod news;
pub mod pipeline;
pub mod reaction;
pub mod rag;
pub mod transcribe;
pub mod util;
pub mod log_style;
pub mod brand;
pub mod worker;

use anyhow::{Context, Result};
use clap::Parser;
use tracing_subscriber::{EnvFilter, fmt};

use cli::{Cli, ClipStyleArg, Commands};
use config::AppConfig;
use edit::ffmpeg::ClipStyle;
use edit::layout::OutputLayout;
use execution::JobExecutionContext;
use pipeline::PipelineRunner;
use pipeline::job::JobContext;

/// Convert CLI enum → internal ClipStyle enum.
fn clip_style_from_arg(a: &ClipStyleArg) -> ClipStyle {
    match a {
        ClipStyleArg::Fade   => ClipStyle::Fade,
        ClipStyleArg::Flash  => ClipStyle::Flash,
        ClipStyleArg::Zoom   => ClipStyle::Zoom,
        ClipStyleArg::Smooth => ClipStyle::Smooth,
        ClipStyleArg::None   => ClipStyle::None,
    }
}
use futures_util::stream::StreamExt;
use std::io::Write;
use std::path::PathBuf;

/// Build an `AudioOptions` struct from raw CLI argument values.
#[allow(clippy::too_many_arguments)]
fn build_audio_opts(
    sfx_intro:             Option<PathBuf>,
    bgm:                   Option<PathBuf>,
    bgm_volume:            f32,
    clip_style:            edit::ClipStyle,
    headline_dur:          f64,
    font_dir:              &PathBuf,
    font_bold:             &str,
    font_regular:          &str,
    social_icon_path:      Option<PathBuf>,
    social_icon_size:      u32,
    social_icon_min_size:  u32,
    social_icon_max_size:  u32,
) -> edit::AudioOptions {
    let font = edit::FontConfig {
        fonts_dir:    font_dir.clone(),
        bold_font:    font_bold.to_owned(),
        regular_font: font_regular.to_owned(),
        family_name:  // derive from font name: "Poppins-Bold.ttf" → "Poppins"
            font_bold
                .split('-')
                .next()
                .unwrap_or("Poppins")
                .to_owned(),
    };

    let social_icon = social_icon_path.map(|path| edit::SocialIcon {
        path,
        size: social_icon_size,
    });

    edit::AudioOptions {
        sfx_intro,
        bgm,
        bgm_volume,
        clip_style,
        headline_dur,
        font,
        social_icon,
        social_icon_min_size,
        social_icon_max_size,
        ..Default::default()
    }
}

/// Download an image URL to `stem` (extension chosen from the response), returning
/// the saved path. Returns `None` on any failure — avatars are purely cosmetic, so
/// a miss must never abort the run (the card falls back to a drawn initial tile).
async fn download_image_to(
    client: &reqwest::Client,
    url: &str,
    stem: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    // Validate the body is a real image by its MAGIC BYTES — NOT the Content-Type header,
    // which lies: some avatar CDNs return an HTML error page or a whitespace-padded body
    // with an `image/*` type. A corrupt `-loop 1` PNG never emits a frame, so the overlay
    // that consumes it blocks the ENTIRE render forever (single- AND multi-threaded alike) —
    // this was the real cause of the "runaway render" hang. Derive the extension from the
    // actual signature and reject anything unrecognized (→ None → avatar skipped, no hang).
    let ext = match bytes.as_ref() {
        b if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) => "png",
        b if b.starts_with(&[0xFF, 0xD8, 0xFF]) => "jpg",
        b if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" => "webp",
        b if b.starts_with(b"GIF8") => "gif",
        _ => {
            tracing::warn!("downloaded image has no valid image signature — skipping: {url}");
            return None;
        }
    };
    let dest = stem.with_extension(ext);
    std::fs::write(&dest, &bytes).ok()?;
    Some(dest)
}

async fn download_ffmpeg_with_progress() -> Result<()> {
    let url = ffmpeg_sidecar::download::ffmpeg_download_url()?;
    tracing::info!("Downloading FFmpeg from {}...", url);

    let client = reqwest::Client::new();
    let res = client.get(url).send().await?;
    let total_size = res.content_length().ok_or_else(|| anyhow::anyhow!("Failed to get content length"))?;

    let pb = indicatif::ProgressBar::new(total_size);
    pb.set_style(indicatif::ProgressStyle::default_bar()
        .template("{msg}\n{spinner:.green} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {bytes}/{total_bytes} ({eta})")?
        .progress_chars("#>-"));
    pb.set_message("Downloading FFmpeg...");

    let archive_name = "ffmpeg-release-essentials.zip";
    let mut file = std::fs::File::create(archive_name)?;
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();

    while let Some(item) = stream.next().await {
        let chunk = item?;
        file.write_all(&chunk)?;
        downloaded = std::cmp::min(downloaded + (chunk.len() as u64), total_size);
        pb.set_position(downloaded);
    }

    pb.finish_with_message("Download complete.");

    tracing::info!("Unpacking FFmpeg...");
    extract_zip(archive_name, ".")?;

    if std::path::Path::new(archive_name).exists() {
        std::fs::remove_file(archive_name)?;
    }
    tracing::info!("FFmpeg installed successfully.");

    Ok(())
}

fn extract_zip(archive_path: &str, dest_dir: &str) -> Result<()> {
    let file = std::fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let outpath = match file.enclosed_name() {
            Some(path) => std::path::Path::new(dest_dir).join(path),
            None => continue,
        };

        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath)?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    std::fs::create_dir_all(p)?;
                }
            }

            // If it's ffmpeg.exe, we can flatten it to the root if desired,
            // but let's just extract everything as-is first.
            let mut outfile = std::fs::File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
        }

        // On Unix, set permissions if needed
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = file.unix_mode() {
                std::fs::set_permissions(&outpath, std::fs::Permissions::from_mode(mode))?;
            }
        }
    }

    // Move ffmpeg.exe to root if it's nested (Gyan.dev zips usually have a subfolder)
    move_ffmpeg_to_root(dest_dir)?;

    Ok(())
}

fn move_ffmpeg_to_root(dest_dir: &str) -> Result<()> {
    let walker = walkdir::WalkDir::new(dest_dir);
    for entry in walker.into_iter().filter_map(|e| e.ok()) {
        if entry.file_name() == "ffmpeg.exe" || entry.file_name() == "ffmpeg" {
            let target = std::path::Path::new(dest_dir).join(entry.file_name());
            if entry.path() != target {
                std::fs::rename(entry.path(), &target)?;
            }
        }
    }
    Ok(())
}

/// Synthesize a still-image MAIN into a short video so a NON-VIDEO post (IG photo/slide, tweet image)
/// can drive the normal pipeline. The cropped post image is fit+padded to the layout and held for
/// `secs`; a sibling `.info.json` carries the real title/description/uploader so the ingest stage
/// reports correct metadata (and the analyze whole-clip fallback + narration grounding take over).
/// Returns the mp4 path, or `None` on an ordinary ffmpeg failure (caller falls back to the post
/// URL); cancellation is returned as an error so the job stops promptly.
async fn synthesize_still_video(
    execution: &JobExecutionContext,
    img: &str, out_dir: &std::path::Path, title: &str, description: &str, uploader: &str,
    w: u32, h: u32,
) -> Result<Option<PathBuf>> {
    execution.check_cancelled()?;
    let secs = 45.0_f64;
    let out = out_dir.join("main_still.mp4");
    let ffmpeg = ffmpeg_sidecar::paths::ffmpeg_path();
    let vf = format!(
        "scale={w}:{h}:force_original_aspect_ratio=decrease,\
         pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p"
    );
    // Include a SILENT audio track (anullsrc) — the transcribe stage extracts audio.wav, which fails
    // on a video with no audio stream. Silence → empty transcript → narration grounds on context.
    let args = vec![
        "-y".into(), "-loop".into(), "1".into(), "-framerate".into(), "30".into(),
        "-t".into(), secs.to_string(), "-i".into(), img.into(),
        "-f".into(), "lavfi".into(), "-t".into(), secs.to_string(), "-i".into(),
        "anullsrc=channel_layout=stereo:sample_rate=44100".into(),
        "-vf".into(), vf, "-c:v".into(), "libx264".into(), "-preset".into(),
        "veryfast".into(), "-pix_fmt".into(), "yuv420p".into(), "-c:a".into(),
        "aac".into(), "-shortest".into(), out.to_string_lossy().to_string(),
    ];
    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let status = match execution.status(&mut command).await {
        Ok(status) => status,
        Err(error) if execution::is_cancelled(&error) => return Err(error),
        Err(_) => return Ok(None),
    };
    if !status.success() || !out.exists() {
        return Ok(None);
    }
    // Sidecar info.json → IngestService::load_info_json reads title/duration/uploader/description.
    let info = serde_json::json!({
        "title": if title.trim().is_empty() { "Postingan" } else { title.trim() },
        "duration": secs, "id": "main_still",
        "uploader": uploader, "description": description.trim(),
    });
    let _ = std::fs::write(out.with_extension("info.json"), info.to_string());
    Ok(Some(out))
}

/// CLI entry point. Parses args, bootstraps logging/ffmpeg/env, dispatches.
/// (Body = the old `main.rs::run()` with `Cli::parse()` folded in.)
pub async fn run_cli() -> Result<()> {
    // Load .env file if present
    dotenvy::dotenv().ok();

    // Backward-compat for the CLIPPER → Thoth rename: mirror any legacy `THOTH_*`
    // env var onto `THOTH_*` (so an existing .env keeps working unchanged). New keys
    // use `THOTH_*`. Runs once at startup before any config/env reads or task spawns.
    for (k, v) in std::env::vars().collect::<Vec<_>>() {
        if let Some(rest) = k.strip_prefix("THOTH_") {
            let nk = format!("THOTH_{rest}");
            if std::env::var(&nk).is_err() {
                unsafe { std::env::set_var(&nk, &v); }
            }
        }
    }

    // Structured logging — level from RUST_LOG, default info
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("thoth=info")),
        )
        .event_format(log_style::ThothFormatter)
        .init();

    brand::banner();
    tracing::debug!("Thoth starting...");

    let cli = Cli::parse();
    util::progress::set_json_mode(cli.progress_json);
    tracing::debug!("CLI arguments parsed: {:?}", cli);

    let config = AppConfig::load().context("failed to load configuration")?;
    tracing::info!("Configuration loaded.");

    // Ensure ffmpeg-sidecar binary is available on first run
    let local_ffmpeg = if std::path::Path::new("ffmpeg.exe").exists() {
        Some("ffmpeg.exe")
    } else if std::path::Path::new("ffmpeg").exists() {
        Some("ffmpeg")
    } else {
        None
    };

    let ffmpeg_path = if let Some(p) = local_ffmpeg {
        tracing::info!("Using local FFmpeg: {}", p);
        Some(p.to_owned())
    } else if let Ok(p) = which::which("ffmpeg") {
        tracing::info!("Using system FFmpeg: {}", p.display());
        Some(p.to_string_lossy().to_string())
    } else {
        None
    };

    if let Some(ref p) = ffmpeg_path {
        let abs_path = std::fs::canonicalize(p)
            .unwrap_or_else(|_| std::path::PathBuf::from(p))
            .to_string_lossy()
            .to_string();
        unsafe { std::env::set_var("FFMPEG_PATH", abs_path) };
    } else {
        download_ffmpeg_with_progress().await.context("failed to download FFmpeg")?;
        // After download, it should be in the root
        let path = if std::path::Path::new("ffmpeg.exe").exists() {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        let abs_path = std::fs::canonicalize(path)
            .unwrap_or_else(|_| std::path::PathBuf::from(path))
            .to_string_lossy()
            .to_string();
        unsafe { std::env::set_var("FFMPEG_PATH", abs_path) };
    }

    // Ensure fontconfig has a config so FFmpeg drawtext `font=` works on Windows.
    // The bundled/local ffmpeg.exe ships no default fonts.conf; without one, any
    // drawtext using a font family (headline panel, hook/profile/callout overlays)
    // fails to initialise fontconfig and aborts the encode. We write a minimal
    // config pointing at the system + project fonts, only when the user hasn't set
    // their own. Gated to Windows so we never override a working Linux/macOS setup.
    #[cfg(windows)]
    {
        if std::env::var_os("FONTCONFIG_FILE").is_none()
            && std::env::var_os("FONTCONFIG_PATH").is_none()
        {
            let conf = std::path::Path::new("assets/fonts/fonts.conf");
            let body = "<?xml version=\"1.0\"?>\n\
                        <!DOCTYPE fontconfig SYSTEM \"fonts.dtd\">\n\
                        <fontconfig>\n\
                        \x20 <dir>C:/Windows/Fonts</dir>\n\
                        \x20 <dir>assets/fonts</dir>\n\
                        \x20 <cachedir>assets/fonts/.fc-cache</cachedir>\n\
                        </fontconfig>\n";
            match std::fs::write(conf, body).and_then(|_| std::fs::canonicalize(conf)) {
                Ok(abs) => {
                    unsafe { std::env::set_var("FONTCONFIG_FILE", abs.to_string_lossy().to_string()) };
                    tracing::info!("fontconfig: {}", conf.display());
                }
                Err(e) => tracing::warn!("could not set up fontconfig ({e}); drawtext fonts may fail"),
            }
        }
    }

    // Check for yt-dlp
    if which::which(&config.ingest.ytdlp_path).is_err() {
        anyhow::bail!(
            "yt-dlp not found! Please install it via 'winget install yt-dlp' or download it from https://github.com/yt-dlp/yt-dlp"
        );
    }

    match cli.command {
        Commands::Ingest(args) => {
            let execution = JobExecutionContext::new();
            let job_id = uuid::Uuid::new_v4().to_string();
            let job = JobContext::new(job_id, args.output_dir.clone())
                .context("failed to create job directories")?;
            let svc = ingest::IngestService::new(&config, &job, &execution);
            let result = svc.run(&args.url, args.force).await?;
            println!("{}", brand::ok("Ingest complete."));
            println!("{}", brand::field("Video", result.video_path.display()));
            println!("{}", brand::field("Title", result.title));
            println!("{}", brand::field("Job ID", job.job_id));
        }

        Commands::Transcribe(args) => {
            let execution = JobExecutionContext::new();
            // When run standalone the job dir is derived from the video file's parent
            let output_dir = args.output_dir.clone();
            let job_id = uuid::Uuid::new_v4().to_string();
            let job = JobContext::new(job_id, output_dir).context("failed to create job directories")?;

            let mut config = config;
            if let Some(lang) = args.language {
                config.whisper.language = lang;
            }

            let svc = transcribe::TranscribeService::new(&config, &job, &execution);
            let result = svc.run(&args.video_path, &args.model.to_string()).await?;
            println!("{}", brand::ok("Transcription complete."));
            println!("{}", brand::field("Transcript", result.transcript_path.display()));
            println!("{}", brand::field("Words", result.word_count));
            println!("{}", brand::field("Duration", format!("{:.1}s", result.duration_secs)));
        }

        Commands::Analyze(args) => {
            let execution = JobExecutionContext::new();
            let job_id = uuid::Uuid::new_v4().to_string();
            // Derive output dir from transcript file's grandparent or use cwd
            let output_dir = args
                .transcript_path
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .unwrap_or(std::path::Path::new("."))
                .to_owned();
            let job = JobContext::new(job_id, output_dir).context("failed to create job directories")?;
            let svc = analyze::AnalyzeService::new(&config, &job, &execution);
            let result = svc
                .run(
                    &args.transcript_path,
                    &args.provider.to_string(),
                    args.max_clips,
                    &args.keywords,
                    args.video_path.as_deref(),  // enables visual analysis when [vision] enabled
                    &args.title,
                    &args.channel,
                )
                .await?;
            println!("{}", brand::ok("Analysis complete."));
            println!("{}", brand::field("Moments", result.moment_count));
            println!("{}", brand::field("Provider", format!("{} ({})", result.provider_used, result.model_used)));
            println!("{}", brand::field("Output", result.moments_path.display()));
        }

        Commands::Edit(args) => {
            let execution = JobExecutionContext::new();
            let job_id = uuid::Uuid::new_v4().to_string();
            let job = JobContext::new(job_id, args.output_dir.clone())
                .context("failed to create job directories")?;
            let svc = edit::EditService::new(&config, &job, &execution);
            let layout = OutputLayout::from(&args.layout);
            let result = svc
                .run(
                    &args.video_path,
                    &args.moments_path,
                    &args.transcript_path,
                    &layout,
                    &build_audio_opts(
                        args.sfx_intro.clone(),
                        args.bgm.clone(),
                        args.bgm_volume,
                        clip_style_from_arg(&args.clip_style),
                        args.headline_dur,
                        &args.font_dir,
                        &args.font_bold,
                        &args.font_regular,
                        args.social_icon.clone(),
                        args.social_icon_size,
                        args.social_icon_min_size,
                        args.social_icon_max_size,
                    ),
                    &args.source_channel,
                    &args.social,
                    &args.style_profile,
                )
                .await?;
            println!("{}", brand::ok(format!("Edit complete — {} clip(s) rendered", result.output_clips.len())));
            for clip in &result.output_clips {
                println!("{}", brand::field(&format!("[{}]", clip.clip_index), format!("{} → {}", clip.title, clip.path.display())));
            }
        }

        Commands::Run(args) => {
            // Pipeline body extracted to `run_once` so the persistent `thoth
            // worker` runs the exact same path with warm models already resident.
            let execution = JobExecutionContext::new();
            run_once(args, config, &execution).await?;
        }

        Commands::TrendAnalyze(args) => {
            use analyze::trend_analyzer::{profile_to_toml, TrendAnalyzeService};

            let execution = JobExecutionContext::new();
            let svc = TrendAnalyzeService::new(&config, &execution);
            let profile = svc.run(
                &args.url,
                args.sample,
                &args.provider.to_string(),
                &args.output_dir,
            ).await?;

            // Save profile as TOML snippet
            let toml_snippet = profile_to_toml(&args.output_profile, &profile);
            let profile_file = args.output_dir.join(format!("{}.toml", args.output_profile));
            tokio::fs::write(&profile_file, &toml_snippet).await
                .context("failed to write profile file")?;

            println!("\n{}", brand::ok("Trend analysis complete!"));
            println!("{}", brand::field("Profile name", &args.output_profile));
            println!("{}", brand::field("Description", &profile.description));
            println!("{}", brand::field("subtitle_style", &profile.subtitle_style));
            println!("{}", brand::field("clip_style", &profile.clip_style));
            println!("{}", brand::field("sfx_vibe", &profile.sfx_vibe));
            println!("{}", brand::field("bgm_vibe", &profile.bgm_vibe));
            println!("{}", brand::field("overlay_style", &profile.overlay_style));
            println!("{}", brand::field("Profile saved to", profile_file.display()));
            println!("\nAdd to your config.toml:");
            print!("{toml_snippet}");
            println!("\nThen use with: --style-profile {}", args.output_profile);
        }

        Commands::Vocab(args) => {
            use cli::VocabCommand;
            use rag::vocab::{seed_defaults, seed_from_url, seed_kamus_alay, seed_openslr_stopwords, VocabCache};

            // Build DB pool if configured
            let pool = if config.vector_db.enabled && !config.vector_db.supabase_url.is_empty() {
                match sqlx::PgPool::connect(&config.vector_db.supabase_url).await {
                    Ok(p) => { println!("{}", brand::ok("Connected to Supabase")); Some(p) }
                    Err(e) => { eprintln!("{}", brand::err(format!("Cannot connect to Supabase: {e}"))); None }
                }
            } else {
                eprintln!("{}", brand::warn("vector_db.enabled = false or THOTH_SUPABASE_URL not set"));
                None
            };

            match args.command {
                VocabCommand::Seed { source, url, category, subcategory, language,
                                     column, skip_header, label_filter } => {
                    let pool = pool.context("Supabase connection required for seed")?;

                    // ── URL mode: download from any URL ──────────────────────
                    if let Some(ref u) = url {
                        let cat = category.as_deref().unwrap_or_else(|| {
                            eprintln!("{}", brand::warn("--category is required when using --url"));
                            "tone_funny"
                        });
                        println!("{}", brand::field("Downloading from", u));
                        println!("{}", brand::field("params", format!("category={cat}, language={language}, column={column}")));
                        if let Some(ref f) = label_filter {
                            println!("{}", brand::field("label_filter", f));
                        }
                        let n = seed_from_url(
                            &pool, u, cat,
                            subcategory.as_deref(),
                            &language, column, skip_header,
                            label_filter.as_deref(),
                        ).await?;
                        println!("{}", brand::ok(format!("Seeded {n} words from URL → category={cat}")));
                        return Ok(());
                    }

                    // ── Named dataset mode ───────────────────────────────────
                    match source.as_str() {
                        "defaults" | "default" => {
                            let n = seed_defaults(&pool).await?;
                            println!("{}", brand::ok(format!("Seeded {n} default words to Supabase")));
                        }
                        "kamus-alay" => {
                            let n = seed_kamus_alay(&pool, &language).await?;
                            println!("{}", brand::ok(format!("Seeded {n} kamus-alay words (language={language})")));
                        }
                        "openslr-stopwords" => {
                            let n = seed_openslr_stopwords(&pool, &language).await?;
                            println!("{}", brand::ok(format!("Seeded {n} OpenSLR stop words (language={language})")));
                        }
                        other => {
                            eprintln!("{}", brand::err(format!("Unknown source '{other}'.")));
                            eprintln!("{}", brand::field("Available", "defaults, kamus-alay, openslr-stopwords"));
                            eprintln!("{}", brand::field("Or use", "--url https://... --category tone_funny"));
                        }
                    }
                }
                VocabCommand::Add { category, word, subcategory, language, notes } => {
                    let pool = pool.context("Supabase connection required")?;
                    VocabCache::add_word(&pool, &category, subcategory.as_deref(), &word, &language, "manual", notes.as_deref()).await?;
                    println!("{}", brand::ok(format!("Added '{word}' to category '{category}'")));
                }
                VocabCommand::List { category } => {
                    let pool = pool.context("Supabase connection required")?;
                    let words = VocabCache::list_category(&pool, &category).await?;
                    if words.is_empty() {
                        println!("(empty — run 'thoth vocab seed' first)");
                    } else {
                        println!("{}", brand::field("Category", format!("{category} ({} words)", words.len())));
                        for (word, sub, lang, weight) in &words {
                            let sub_str = sub.as_deref().map(|s| format!("[{s}]")).unwrap_or_default();
                            println!("  {word}{sub_str} ({lang}, weight={weight:.1})");
                        }
                    }
                }
                VocabCommand::Review => {
                    let pool = pool.context("Supabase connection required")?;
                    let candidates = VocabCache::pending_candidates(&pool).await?;
                    if candidates.is_empty() {
                        println!("No pending word candidates to review.");
                        return Ok(());
                    }
                    println!("{}", brand::field("Unreviewed word candidates", candidates.len()));
                    for (word, cat, occ, ctx) in &candidates {
                        let cat_str = cat.as_deref().unwrap_or("?");
                        let ctx_str = ctx.as_deref().unwrap_or("").chars().take(60).collect::<String>();
                        println!("\n  '{}' (appeared {}×, suggested: {})", word, occ, cat_str);
                        if !ctx_str.is_empty() { println!("  context: \"{}...\"", ctx_str); }
                        print!("  [a]pprove / [r]eject / [s]kip: ");
                        use std::io::{Write, BufRead};
                        std::io::stdout().flush()?;
                        let mut input = String::new();
                        std::io::stdin().lock().read_line(&mut input)?;
                        match input.trim() {
                            "a" | "approve" => {
                                VocabCache::approve_candidate(&pool, word, cat_str, "id").await?;
                                println!("  {}", brand::ok(format!("Approved → {cat_str}")));
                            }
                            "r" | "reject" => {
                                VocabCache::reject_candidate(&pool, word).await?;
                                eprintln!("  {}", brand::err("Rejected"));
                            }
                            _ => println!("  → Skipped"),
                        }
                    }
                }
                VocabCommand::Stats => {
                    let pool = pool.context("Supabase connection required")?;
                    let cache = VocabCache::load(Some(&pool), config.vector_db.vocab_cache_ttl_secs).await;
                    println!("Vocabulary Cache Statistics:");
                    println!("{}", brand::field("Source", if cache.from_db { "Supabase" } else { "Hardcoded defaults" }));
                    println!("{}", brand::field("tone_funny", format!("{} words", cache.tone_funny.len())));
                    println!("{}", brand::field("tone_serious", format!("{} words", cache.tone_serious.len())));
                    println!("{}", brand::field("intro", format!("{} phrases", cache.intro.len())));
                    println!("{}", brand::field("name_titles", format!("{} patterns", cache.name_titles.len())));
                    println!("{}", brand::field("stop_words", format!("{} (id) + {} (en)", cache.stop_words_id.len(), cache.stop_words_en.len())));
                    println!("{}", brand::field("energy_high", format!("{} words", cache.energy_high.len())));
                    println!("{}", brand::field("energy_low", format!("{} words", cache.energy_low.len())));
                    println!("{}", brand::field("vibes", format!("{} categories", cache.vibes.len())));
                    for (vibe, words) in &cache.vibes {
                        println!("    {vibe}: {} keywords", words.len());
                    }
                }
                VocabCommand::Refresh => {
                    println!("Cache will refresh automatically on next pipeline run.");
                    println!("(TTL: {}s = {:.1} minutes)", config.vector_db.vocab_cache_ttl_secs, config.vector_db.vocab_cache_ttl_secs as f64 / 60.0);
                }
            }
        }

        Commands::Thumbnail(args) => {
            let execution = JobExecutionContext::new();
            let job = JobContext::new(args.job_id.clone(), args.output_dir.clone())
                .context("failed to access job directory")?;

            let moments_path = job.moments_path();
            if !moments_path.exists() {
                anyhow::bail!("Moments file not found: {}", moments_path.display());
            }

            let moments_raw = tokio::fs::read_to_string(&moments_path).await?;
            let moments: crate::analyze::schema::ViralMomentList = serde_json::from_str(&moments_raw)
                .context("failed to parse moments.json")?;

            println!("{}", brand::field("Generating thumbnails", format!("{} clips in job '{}'", moments.moments.len(), args.job_id)));

            let mut count = 0;
            for (i, moment) in moments.moments.iter().enumerate() {
                let slug = crate::util::fs::slugify(&moment.title);
                let out_path = job.clip_path(i, &slug);
                if !out_path.exists() {
                    eprintln!("  {}", brand::warn(format!("clip missing, skipping: {}", out_path.display())));
                    continue;
                }

                let thumb_path = out_path.with_extension("jpg");
                let duration = moment.duration();

                let optimal_time = if moment.overlay_at_sec > 0.0 {
                    moment.overlay_at_sec + 0.5
                } else if moment.sfx_at_sec > 0.0 {
                    moment.sfx_at_sec
                } else {
                    duration / 2.0
                };

                let thumb_time = optimal_time.clamp(0.0, duration.max(0.1));

                println!("  Generating thumbnail for clip {} at {:.1}s...", i + 1, thumb_time);

                if let Err(e) = edit::ffmpeg::generate_thumbnail(
                    &execution,
                    &out_path,
                    &thumb_path,
                    thumb_time,
                )
                .await
                {
                    eprintln!("  {}", brand::err(format!("failed: {}", e)));
                } else {
                    println!("  {}", brand::ok(format!("saved: {}", thumb_path.display())));
                    count += 1;
                }
            }
            println!("{}", brand::ok(format!("Done — generated {count} thumbnails")));
        }

        Commands::Scout(args) => {
            // ── Resolve scout/ directory ──────────────────────────────────
            // The binary lives at <repo>/target/release/thoth.exe — the repo
            // root is 2 levels up.  Fallback: try cwd/scout/ (when running
            // from the repo root directly during development).
            let scout_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent()?.parent()?.parent().map(|r| r.join("scout")))
                .filter(|d| d.join("cli.ts").exists())
                .or_else(|| {
                    let cwd = std::env::current_dir().ok()?.join("scout");
                    if cwd.join("cli.ts").exists() { Some(cwd) } else { None }
                })
                .ok_or_else(|| anyhow::anyhow!(
                    "scout/cli.ts not found — run from the repo root or ensure \
                     the thoth binary is in <repo>/target/release/"
                ))?;

            let cli_ts = scout_dir.join("cli.ts");

            // ── Find Bun ─────────────────────────────────────────────────
            let bun = which::which("bun").map_err(|_| anyhow::anyhow!(
                "bun not found in PATH — scout requires Bun ≥1.2 \
                 (https://bun.sh)"
            ))?;

            // ── Spawn: bun scout/cli.ts <args...> ────────────────────────
            // non-job process: Scout has its own supervisor.
            let status = std::process::Command::new(&bun)
                .arg(&cli_ts)
                .args(&args.args)
                .current_dir(&scout_dir)
                .stdin(std::process::Stdio::inherit())
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit())
                .status()
                .with_context(|| format!(
                    "failed to spawn bun {} {}",
                    cli_ts.display(),
                    args.args.join(" ")
                ))?;

            std::process::exit(status.code().unwrap_or(1));
        }

        Commands::Worker(args) => {
            worker::run_worker(&args.db).await?;
        }
    }

    Ok(())
}

/// Execute one full `run` pipeline with whatever models are already resident.
/// Shared verbatim by the CLI `run` command and the `thoth worker` claim loop —
/// the only difference is the installed progress sink (stdout vs the SQLite job
/// DB) and who supplies `args` and its execution context.
pub async fn run_once(
    args: cli::RunArgs,
    config: AppConfig,
    execution: &JobExecutionContext,
) -> Result<()> {
    execution.check_cancelled()?;
            let mut config = config;
            if let Some(lang) = args.language {
                config.whisper.language = lang;
            }

            if !args.keywords.is_empty() {
                println!("{}", brand::field("Focus keywords", args.keywords.join(", ")));
            }

            // ── Resolve the main video URL ────────────────────────────────────
            // Content discovery is handled upstream by scout. Thoth accepts
            // either a direct --url (single-video default) or an scout content
            // set via --content (main video + footage pool). It does not search.
            let resolved_url: String = if let Some(ref u) = args.url {
                u.clone()
            } else if let Some(ref content_path) = args.content {
                let set = ingest::content_search::load_content_set(content_path)?;

                // A non-video MAIN still needs a downloadable URL for Stage 1 ingest;
                // its cropped screenshot can't drive transcription. Surface it so the
                // operator knows the image won't be used as the main (footage images
                // ARE rendered as cards — see edit::enrichment::load_image_pool).
                if !set.main_image_path.trim().is_empty() {
                    tracing::warn!(
                        "main.image_path set ({}) but the main is ingested from main.url — \
                         the main screenshot is not used as a clip source (footage images are)",
                        set.main_image_path
                    );
                }

                // Count non-video footage posts that carry a usable crop screenshot —
                // these become static image cards in the edit stage.
                let image_posts = set.footage.iter()
                    .filter(|f| !f.is_video && !f.image_path.trim().is_empty())
                    .count();
                if image_posts > 0 {
                    tracing::info!("🖼️  {image_posts} non-video footage post(s) with cropped screenshots → image cards");
                }

                // Write the footage pool where the edit/narration stages read it
                // (mirrors the old enrichment-pool location, base dir == output_dir).
                let _ = std::fs::create_dir_all(&args.output_dir);
                let enrich_path = args
                    .output_dir
                    .join(edit::enrichment::ENRICHMENT_FILE);
                match serde_json::to_string_pretty(&set.footage) {
                    Ok(j) => {
                        if let Err(e) = std::fs::write(&enrich_path, j) {
                            tracing::warn!("could not write footage pool {}: {e}", enrich_path.display());
                        }
                    }
                    Err(e) => tracing::warn!("could not serialize footage pool: {e}"),
                }

                // ── Main video textual context (narration grounding) ─────────
                // Title + platform caption of the MAIN video. The narration stage
                // reads this so the script is grounded in the real topic even when
                // the spoken transcript is empty (raw b-roll with no voiceover) —
                // see PipelineRunner::generate_narration. Comments are added below.
                if !set.figures.is_empty() {
                    let names = set.figures.iter().map(|f| f.name.as_str()).collect::<Vec<_>>().join(", ");
                    tracing::info!("👤 scout figures: {names} → narration grounding");
                }
                if !set.main_title.trim().is_empty() || !set.main_description.trim().is_empty() || !set.figures.is_empty() {
                    let ctx = ingest::content_search::MainContext {
                        title: set.main_title.trim().to_string(),
                        description: set.main_description.trim().to_string(),
                        figures: set.figures.clone(),
                        references: set.references.clone(),
                        discourse: set.discourse.clone(),
                    };
                    let dest = args.output_dir.join(ingest::content_search::MAIN_CONTEXT_FILE);
                    match serde_json::to_string_pretty(&ctx) {
                        Ok(j) => {
                            if let Err(e) = std::fs::write(&dest, j) {
                                tracing::warn!("could not write main-context sidecar {}: {e}", dest.display());
                            } else {
                                tracing::info!("📝 scout main context: title+description → narration grounding");
                            }
                        }
                        Err(e) => tracing::warn!("could not serialize main-context sidecar: {e}"),
                    }
                }

                // ── Real subject profile (Beat-2 card) ────────────────────────
                // scout supplies the factual handle/follower count + avatar URL.
                // Download the avatar locally and persist a sidecar the edit stage
                // reads to OVERRIDE the LLM's guessed character_* fields.
                let img_client = reqwest::Client::new();
                // Clear any sidecar left over from a previous run first — otherwise a
                // content-set without `profile` would silently reuse the PREVIOUS run's
                // profile card (wrong subject).
                let _ = std::fs::remove_file(args.output_dir.join(edit::profile_card::PROFILE_FILE));
                if let Some(p) = &set.profile {
                    let avatar_path = download_image_to(
                        &img_client,
                        &p.avatar_url,
                        &args.output_dir.join("profile_avatar"),
                    )
                    .await
                    .map(|pb| pb.to_string_lossy().to_string())
                    .unwrap_or_default();
                    let data = edit::profile_card::ProfileCardData {
                        name: p.name.trim().to_string(),
                        handle: p.handle.trim().trim_start_matches('@').to_string(),
                        stats: p.followers.trim().to_string(),
                        avatar_path,
                        image_path: p.image_path.trim().to_string(),
                    };
                    let dest = args.output_dir.join(edit::profile_card::PROFILE_FILE);
                    match serde_json::to_string_pretty(&data) {
                        Ok(j) => {
                            if let Err(e) = std::fs::write(&dest, j) {
                                tracing::warn!("could not write profile sidecar {}: {e}", dest.display());
                            } else {
                                tracing::info!("🪪 scout profile: @{} ({})", data.handle, data.stats);
                            }
                        }
                        Err(e) => tracing::warn!("could not serialize profile sidecar: {e}"),
                    }
                }

                // ── Real viral comments (reaction beat) ───────────────────────
                // Always clear any sidecar left over from a previous run first — otherwise
                // a content-set with an empty `comments[]` would silently reuse the PREVIOUS
                // run's comment cards (wrong topic) since the edit stage just reads whatever
                // file is on disk.
                let comments_dest = args.output_dir.join(edit::comment_card::COMMENTS_FILE);
                let _ = std::fs::remove_file(&comments_dest);
                if !set.comments.is_empty() {
                    let mut pool: Vec<edit::comment_card::CommentData> = Vec::new();
                    for c in &set.comments {
                        if c.author.trim().is_empty() || c.text.trim().is_empty() {
                            continue;
                        }
                        // Comment avatars are obsolete: comment cards now render from the
                        // scout crop (`image_path` / has_crop). We no longer download the
                        // per-comment avatar — a garbage avatar response (whitespace body with
                        // an image/* type) produced a corrupt `-loop 1` PNG whose overlay
                        // never got a frame and HUNG the whole render. Empty = crop or drawn card.
                        pool.push(edit::comment_card::CommentData {
                            author: c.author.trim().to_string(),
                            text: c.text.trim().to_string(),
                            likes: c.likes,
                            avatar_path: String::new(),
                            // Crop is a local PNG already produced by scout — pass the
                            // path straight through (no download). Empty = drawn card.
                            image_path: c.image_path.trim().to_string(),
                            context: c.context.trim().to_string(),
                        });
                    }
                    if !pool.is_empty() {
                        match serde_json::to_string_pretty(&pool) {
                            Ok(j) => {
                                if let Err(e) = std::fs::write(&comments_dest, j) {
                                    tracing::warn!("could not write comments sidecar {}: {e}", comments_dest.display());
                                } else {
                                    tracing::info!("💬 scout comments: {} card(s)", pool.len());
                                }
                            }
                            Err(e) => tracing::warn!("could not serialize comments sidecar: {e}"),
                        }
                    }
                }

                tracing::info!(
                    "📦 scout content set: main={} — {} footage item(s) → {}",
                    set.main_url,
                    set.footage.len(),
                    enrich_path.display()
                );
                // NON-VIDEO MAIN (IG photo/slide, tweet image): no yt-dlp video exists. Render the
                // cropped post image into a short still→video so the pipeline runs (ingest local-file
                // branch → silent transcript → analyze whole-clip → narration grounding → edit). Guard
                // on image_path presence (scout only crops non-video) so a video main never misfires.
                let main_img = set.main_image_path.trim().to_string();
                if !set.main_is_video && !main_img.is_empty() && std::path::Path::new(&main_img).exists() {
                    let (sw, sh) = match args.layout {
                        cli::OutputLayout::Horizontal => (1920u32, 1080u32),
                        cli::OutputLayout::Square => (1080u32, 1080u32),
                        cli::OutputLayout::Vertical => (1080u32, 1920u32),
                    };
                    let uploader = set.profile.as_ref().map(|p| p.handle.trim()).unwrap_or("");
                    match synthesize_still_video(
                        execution,
                        &main_img,
                        &args.output_dir,
                        &set.main_title,
                        &set.main_description,
                        uploader,
                        sw,
                        sh,
                    )
                    .await?
                    {
                        Some(p) => { tracing::info!("🖼️  MAIN non-video → still video: {}", p.display()); p.to_string_lossy().to_string() }
                        None => { tracing::warn!("still-video synth failed → using main_url (may not be downloadable)"); set.main_url }
                    }
                } else {
                    set.main_url
                }
            } else {
                anyhow::bail!(
                    "no input supplied — provide a single video with --url <URL>, \
                     or an scout content set with --content <set.json>"
                );
            };

            let runner = PipelineRunner::new(&config, execution);
            let _clips = runner
                .run(
                    &resolved_url,
                    &args.output_dir,
                    &args.provider,
                    &args.model,
                    args.max_clips,
                    &args.layout,
                    &args.keywords,
                    &build_audio_opts(
                        args.sfx_intro.clone(),
                        args.bgm.clone(),
                        args.bgm_volume,
                        clip_style_from_arg(&args.clip_style),
                        args.headline_dur,
                        &args.font_dir,
                        &args.font_bold,
                        &args.font_regular,
                        args.social_icon.clone(),
                        args.social_icon_size,
                        args.social_icon_min_size,
                        args.social_icon_max_size,
                    ),
                    &args.social,
                    args.resume.as_deref(),
                    &args.style_profile,
                    args.job_id.as_deref(),
                )
                .await?; // footer already printed by PipelineRunner::run (brand::FEATHER summary)
    Ok(())
}
