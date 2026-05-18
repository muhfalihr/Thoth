#![allow(dead_code, unused_imports)]

mod analyze;
mod cli;
mod config;
mod edit;
mod ingest;
mod pipeline;
mod transcribe;
mod util;

use anyhow::{Context, Result};
use clap::Parser;
use tracing_subscriber::{EnvFilter, fmt};

use cli::{Cli, Commands};
use config::AppConfig;
use edit::layout::OutputLayout;
use pipeline::PipelineRunner;
use pipeline::job::JobContext;
use futures_util::stream::StreamExt;
use std::io::Write;
use std::path::PathBuf;

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

#[tokio::main]
async fn main() -> Result<()> {
    // Immediate feedback to verify if the process even starts
    println!("[BOOT] Clipper process started. Initializing...");

    // Load .env file if present
    dotenvy::dotenv().ok();

    // Structured logging — level from RUST_LOG, default info
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("clipper=info")),
        )
        .with_target(false)
        .compact()
        .init();

    tracing::info!("Clipper starting...");

    let cli = Cli::parse();
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

    // Check for yt-dlp
    if which::which(&config.ingest.ytdlp_path).is_err() {
        anyhow::bail!(
            "yt-dlp not found! Please install it via 'winget install yt-dlp' or download it from https://github.com/yt-dlp/yt-dlp"
        );
    }

    match cli.command {
        Commands::Ingest(args) => {
            let job_id = uuid::Uuid::new_v4().to_string();
            let job = JobContext::new(job_id, args.output_dir.clone())
                .context("failed to create job directories")?;
            let svc = ingest::IngestService::new(&config, &job);
            let result = svc.run(&args.url, args.force).await?;
            println!("Ingest complete.");
            println!("  Video : {}", result.video_path.display());
            println!("  Title : {}", result.title);
            println!("  Job ID: {}", job.job_id);
        }

        Commands::Transcribe(args) => {
            // When run standalone the job dir is derived from the video file's parent
            let output_dir = args.output_dir.clone();
            let job_id = uuid::Uuid::new_v4().to_string();
            let job = JobContext::new(job_id, output_dir).context("failed to create job directories")?;
            
            let mut config = config;
            if let Some(lang) = args.language {
                config.whisper.language = lang;
            }

            let svc = transcribe::TranscribeService::new(&config, &job);
            let result = svc.run(&args.video_path, &args.model.to_string()).await?;
            println!("Transcription complete.");
            println!("  Transcript : {}", result.transcript_path.display());
            println!("  Words      : {}", result.word_count);
            println!("  Duration   : {:.1}s", result.duration_secs);
        }

        Commands::Analyze(args) => {
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
            let svc = analyze::AnalyzeService::new(&config, &job);
            let result = svc
                .run(&args.transcript_path, &args.provider.to_string(), args.max_clips)
                .await?;
            println!("Analysis complete.");
            println!("  Moments : {}", result.moment_count);
            println!("  Provider: {} ({})", result.provider_used, result.model_used);
            println!("  Output  : {}", result.moments_path.display());
        }

        Commands::Edit(args) => {
            let job_id = uuid::Uuid::new_v4().to_string();
            let job = JobContext::new(job_id, args.output_dir.clone())
                .context("failed to create job directories")?;
            let svc = edit::EditService::new(&config, &job);
            let layout = OutputLayout::from(&args.layout);
            let result = svc
                .run(
                    &args.video_path,
                    &args.moments_path,
                    &args.transcript_path,
                    &layout,
                )
                .await?;
            println!("Edit complete. {} clip(s) rendered:", result.output_clips.len());
            for clip in &result.output_clips {
                println!("  [{}] {} → {}", clip.clip_index, clip.title, clip.path.display());
            }
        }

        Commands::Run(args) => {
            let mut config = config;
            if let Some(lang) = args.language {
                config.whisper.language = lang;
            }

            let runner = PipelineRunner::new(&config);
            let clips = runner
                .run(
                    &args.url,
                    &args.output_dir,
                    &args.provider,
                    &args.model,
                    args.max_clips,
                    &args.layout,
                    args.resume.as_deref(),
                )
                .await?;
            println!("\nPipeline complete. {} clip(s):", clips.len());
            for p in &clips {
                println!("  {}", p.display());
            }
        }
    }

    Ok(())
}
