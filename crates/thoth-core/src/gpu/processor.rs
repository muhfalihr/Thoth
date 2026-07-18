use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tracing::{debug, info, warn};

use super::context::GpuContext;
use super::effect::{ColorParams, ColorPipeline, TransitionParams, TransitionPipeline};
use crate::edit::transition::Transition;
use crate::execution::{JobExecutionContext, SupervisedChild};

// ── Video metadata ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct VideoMeta {
    pub width:  u32,
    pub height: u32,
    pub fps:    f64,
    pub frames: u64,
}

impl VideoMeta {
    /// Probe video with ffprobe.
    pub async fn probe(execution: &JobExecutionContext, path: &Path) -> Result<Self> {
        let mut command = Command::new(ffmpeg_bin("ffprobe"));
        command
            .args([
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
                "-of", "csv=p=0",
                path.to_str().unwrap_or_default(),
            ]);
        let out = execution
            .output(&mut command)
            .await
            .context("failed to spawn ffprobe")?;

        let s = String::from_utf8_lossy(&out.stdout);
        let parts: Vec<&str> = s.trim().split(',').collect();
        if parts.len() < 4 {
            bail!("ffprobe output unexpected: {s}");
        }

        let width  = parts[0].parse::<u32>().unwrap_or(1920);
        let height = parts[1].parse::<u32>().unwrap_or(1080);

        // fps = num/den
        let fps = if let Some((n, d)) = parts[2].split_once('/') {
            let n = n.parse::<f64>().unwrap_or(30.0);
            let d = d.parse::<f64>().unwrap_or(1.0);
            n / d.max(1.0)
        } else {
            parts[2].parse::<f64>().unwrap_or(30.0)
        };

        let frames = parts[3].trim().parse::<u64>().unwrap_or(0);

        Ok(VideoMeta { width, height, fps, frames })
    }

    pub fn frame_bytes(&self) -> usize {
        (self.width * self.height * 4) as usize
    }
}

// ── Frame pipe helpers ────────────────────────────────────────────────────────

/// Spawn an FFmpeg process that decodes `path` to raw RGBA on stdout.
pub fn decode_pipe(
    execution: &JobExecutionContext,
    path: &Path,
    start_sec: f64,
    end_sec: f64,
) -> Result<SupervisedChild> {
    let duration = (end_sec - start_sec).max(0.01);
    let mut command = Command::new(ffmpeg_bin("ffmpeg"));
    command
        .args([
            "-y",
            "-ss", &format!("{start_sec:.3}"),
            "-t",  &format!("{duration:.3}"),
            "-i",  path.to_str().unwrap_or_default(),
            "-f",  "rawvideo",
            "-pix_fmt", "rgba",
            "-vf", "scale=iw:ih",   // keep original size
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    spawn_piped_command(execution, &mut command).context("failed to spawn ffmpeg decode")
}

/// Spawn an FFmpeg process that encodes raw RGBA from stdin to `output`.
pub fn encode_pipe(
    execution: &JobExecutionContext,
    output: &Path,
    width: u32,
    height: u32,
    fps: f64,
    audio_source: Option<&Path>,
    nvenc: bool,
) -> Result<SupervisedChild> {
    let mut args = vec![
        "-y".to_owned(),
        "-f".into(), "rawvideo".into(),
        "-pix_fmt".into(), "rgba".into(),
        "-s".into(), format!("{width}x{height}"),
        "-r".into(), format!("{fps:.3}"),
        "-i".into(), "pipe:0".into(),
    ];

    // Add audio from original source if provided
    if let Some(audio) = audio_source {
        args.extend(["-i".to_owned(), audio.to_string_lossy().to_string()]);
    }

    let vcodec = if nvenc { "h264_nvenc" } else { "libx264" };
    args.extend(["-c:v".to_owned(), vcodec.into()]);
    if nvenc {
        args.extend(["-preset".to_owned(), "p4".into(), "-cq".into(), "23".into()]);
    } else {
        args.extend(["-preset".to_owned(), "medium".into(), "-crf".into(), "23".into()]);
    }

    if audio_source.is_some() {
        args.extend([
            "-c:a".to_owned(), "aac".into(),
            "-b:a".into(), "192k".into(),
            "-shortest".into(),
        ]);
    }

    args.extend([
        "-movflags".to_owned(), "+faststart".into(),
        output.to_string_lossy().to_string(),
    ]);

    let mut command = Command::new(ffmpeg_bin("ffmpeg"));
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stderr(Stdio::null());
    spawn_piped_command(execution, &mut command).context("failed to spawn ffmpeg encode")
}

fn spawn_piped_command(
    execution: &JobExecutionContext,
    command: &mut Command,
) -> Result<SupervisedChild> {
    execution.spawn(command).context("failed to spawn supervised GPU media command")
}

async fn run_frame_operation<T, F, Fut>(
    execution: &JobExecutionContext,
    operation: F,
) -> Result<T>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    execution.check_cancelled()?;
    Ok(operation().await)
}

async fn write_frame(
    execution: &JobExecutionContext,
    encode_in: &mut ChildStdin,
    frame: &[u8],
) -> Result<()> {
    execution.check_cancelled()?;
    match encode_in.write_all(frame).await {
        Ok(()) => Ok(()),
        Err(error) => {
            execution.check_cancelled()?;
            Err(error).context("encode write error")
        }
    }
}

async fn drain_decoder_output(
    execution: &JobExecutionContext,
    decoder_out: &mut ChildStdout,
) -> Result<u64> {
    let mut buffer = [0_u8; 8 * 1024];
    let mut drained = 0_u64;

    loop {
        execution.check_cancelled()?;
        match decoder_out.read(&mut buffer).await {
            Ok(0) => return Ok(drained),
            Ok(read) => drained += read as u64,
            Err(error) => {
                execution.check_cancelled()?;
                return Err(error).context("next decoder drain error");
            }
        }
    }
}

async fn drain_and_wait_decoder(
    execution: &JobExecutionContext,
    decoder_out: &mut ChildStdout,
    decoder: SupervisedChild,
) -> Result<std::process::ExitStatus> {
    let _ = drain_decoder_output(execution, decoder_out).await?;
    decoder.wait().await.context("next decode wait")
}

// ── GpuProcessor — full pipeline ──────────────────────────────────────────────

/// GPU-accelerated video processor.
///
/// Architecture (mirrors CapCut's pipeline):
/// ```
/// FFmpeg decode → raw RGBA frames
///     → wgpu ColorPipeline   (HSL, Curves, Wheels, Sharpen, Vignette)
///     → wgpu TransitionPipeline  (at clip boundaries)
///     → raw RGBA frames → FFmpeg encode
/// ```
pub struct GpuProcessor {
    ctx:        GpuContext,
    color_pipe: ColorPipeline,
    tr_pipe:    TransitionPipeline,
}

impl GpuProcessor {
    pub async fn new() -> Result<Self> {
        let ctx = GpuContext::new().await?;
        let color_pipe = ColorPipeline::new(&ctx);
        let tr_pipe    = TransitionPipeline::new(&ctx);
        Ok(Self { ctx, color_pipe, tr_pipe })
    }

    /// Process a single video clip with color grading.
    ///
    /// Reads frames from `input`, applies `color_params` on GPU, writes to `output`.
    /// Audio is copied directly from `input` (no re-encode).
    pub async fn apply_color(
        &self,
        execution:   &JobExecutionContext,
        input:       &Path,
        output:      &Path,
        start_sec:   f64,
        end_sec:     f64,
        color:       &ColorParams,
        nvenc:       bool,
    ) -> Result<()> {
        if color.is_identity() {
            info!("apply_color: identity params — skipping GPU pass");
            return self.copy_segment(execution, input, output, start_sec, end_sec, nvenc).await;
        }

        let meta = VideoMeta::probe(execution, input).await?;
        let frame_bytes = meta.frame_bytes();

        info!(
            "apply_color: {}x{} @ {:.1}fps  [{:.1}s–{:.1}s]  GPU={:?}",
            meta.width, meta.height, meta.fps, start_sec, end_sec,
            self.ctx.adapter.get_info().name
        );

        let mut decode = decode_pipe(execution, input, start_sec, end_sec)?;
        let mut encode = encode_pipe(execution, output, meta.width, meta.height, meta.fps,
                                      Some(input), nvenc)?;

        let mut decode_out = decode.take_stdout().context("no decode stdout")?;
        let mut encode_in  = encode.take_stdin().context("no encode stdin")?;

        let mut frame_buf = vec![0u8; frame_bytes];
        let mut processed = 0u64;

        loop {
            execution.check_cancelled()?;
            match decode_out.read_exact(&mut frame_buf).await {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => {
                    execution.check_cancelled()?;
                    bail!("decode read error: {e}");
                }
            }

            let out_frame = run_frame_operation(execution, || {
                self.color_pipe.apply(
                    &self.ctx, &frame_buf,
                    meta.width, meta.height, color, None,
                )
            })
            .await?;

            write_frame(execution, &mut encode_in, &out_frame).await?;
            processed += 1;
        }

        drop(encode_in);
        let _ = decode.wait().await.context("decode wait")?;
        let enc_status = encode.wait().await.context("encode wait")?;
        if !enc_status.success() {
            bail!("ffmpeg encode exited with: {:?}", enc_status.code());
        }

        info!("apply_color: processed {processed} frames → {}", output.display());
        Ok(())
    }

    /// Concatenate clips with GPU-native transitions.
    ///
    /// Each `ClipJob` specifies the clip file, its color grading, and the
    /// transition to use going INTO the next clip.
    pub async fn concat_gpu(
        &self,
        execution:   &JobExecutionContext,
        jobs:        &[ClipJob],
        output:      &Path,
        nvenc:       bool,
    ) -> Result<()> {
        if jobs.is_empty() {
            bail!("no clips to concat");
        }
        if jobs.len() == 1 {
            return self.apply_color(
                execution,
                &jobs[0].path, output,
                jobs[0].start_sec, jobs[0].end_sec,
                &jobs[0].color, nvenc,
            ).await;
        }

        // Step 1: apply color grading to each clip → temp files
        let tmp_dir = output.parent().unwrap_or(Path::new("."));
        let mut colored: Vec<PathBuf> = Vec::new();

        for (i, job) in jobs.iter().enumerate() {
            execution.check_cancelled()?;
            let tmp = tmp_dir.join(format!("__gpu_clip_{i}.mp4"));
            self.apply_color(execution, &job.path, &tmp, job.start_sec, job.end_sec,
                             &job.color, nvenc).await?;
            colored.push(tmp);
        }

        // Step 2: probe all colored clips
        let mut metas = Vec::with_capacity(colored.len());
        for path in &colored {
            execution.check_cancelled()?;
            metas.push(VideoMeta::probe(execution, path).await?);
        }

        let first = &metas[0];
        let w = first.width;
        let h = first.height;
        let fps = first.fps;

        // Step 3: build final output with GPU transitions
        let mut encode = encode_pipe(execution, output, w, h, fps, None, nvenc)?;
        let mut encode_in = encode.take_stdin().context("no encode stdin")?;

        // Buffer of "tail frames" from previous clip (for transition blending)
        let tr_dur_frames = |dur: f64| (dur * fps).ceil() as usize;

        for i in 0..colored.len() {
            execution.check_cancelled()?;
            let clip    = &colored[i];
            let meta    = &metas[i];
            let tr      = if i + 1 < jobs.len() { &jobs[i].transition_out } else { &Transition::None };
            let tr_dur  = jobs[i].transition_dur_override
                .unwrap_or_else(|| tr.default_duration(0.0));
            let n_tr    = tr_dur_frames(tr_dur);

            let frame_bytes = meta.frame_bytes();
            let total_frames = meta.frames as usize;
            let body_frames = total_frames.saturating_sub(n_tr);

            info!("  clip {}/{}: {} frames  transition={:?} ({} tr-frames)",
                i + 1, colored.len(), total_frames, tr, n_tr);

            let mut decode = decode_pipe(execution, clip, 0.0, f64::MAX)?;
            let mut decode_out = decode.take_stdout().context("no decode stdout")?;

            let mut frame_buf   = vec![0u8; frame_bytes];
            let mut tail_frames: Vec<Vec<u8>> = Vec::with_capacity(n_tr);
            let mut frame_idx   = 0usize;

            loop {
                execution.check_cancelled()?;
                match decode_out.read_exact(&mut frame_buf).await {
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                    Err(e) => {
                        execution.check_cancelled()?;
                        bail!("decode error on clip {i}: {e}");
                    }
                }

                if frame_idx < body_frames {
                    // Body: write directly
                    write_frame(execution, &mut encode_in, &frame_buf).await?;
                } else {
                    // Tail: buffer for transition blending
                    execution.check_cancelled()?;
                    tail_frames.push(frame_buf.clone());
                }
                frame_idx += 1;
            }
            let _ = decode.wait().await.context("decode wait")?;

            // Blend tail of this clip with head of next clip
            if i + 1 < colored.len() && *tr != Transition::None && !tail_frames.is_empty() {
                execution.check_cancelled()?;
                let next_clip  = &colored[i + 1];
                let next_meta  = &metas[i + 1];
                let nf_bytes   = next_meta.frame_bytes();
                let mut next_decode = decode_pipe(execution, next_clip, 0.0, tr_dur)?;
                let mut next_out    = next_decode.take_stdout().context("no next decode stdout")?;
                let mut next_buf    = vec![0u8; nf_bytes];
                let n_blend = tail_frames.len();

                for (bi, tail_frame) in tail_frames.iter().enumerate() {
                    execution.check_cancelled()?;
                    let progress = (bi + 1) as f32 / n_blend as f32;
                    let tr_params = TransitionParams::new(progress, tr.wgsl_id());

                    // Read corresponding frame from next clip
                    match next_out.read_exact(&mut next_buf).await {
                        Ok(_) => {}
                        Err(_) => {
                            execution.check_cancelled()?;
                            // Next clip ran out — write tail frame as-is
                            write_frame(execution, &mut encode_in, tail_frame).await?;
                            continue;
                        }
                    }

                    let blended = run_frame_operation(execution, || {
                        self.tr_pipe.blend(
                            &self.ctx,
                            tail_frame, &next_buf,
                            w, h, tr_params,
                        )
                    })
                    .await?;
                    write_frame(execution, &mut encode_in, &blended).await?;
                }
                let _ = drain_and_wait_decoder(execution, &mut next_out, next_decode).await?;
            } else {
                // No transition — flush tail as-is
                for frame in &tail_frames {
                    write_frame(execution, &mut encode_in, frame).await?;
                }
            }
        }

        drop(encode_in);
        let enc_status = encode.wait().await.context("encode wait")?;
        if !enc_status.success() {
            bail!("ffmpeg encode exited: {:?}", enc_status.code());
        }

        // Cleanup temp files
        for tmp in &colored {
            let _ = std::fs::remove_file(tmp);
        }

        info!("concat_gpu: {} clips → {}", jobs.len(), output.display());
        Ok(())
    }

    /// Fast path: copy a time segment without GPU processing.
    async fn copy_segment(&self, execution: &JobExecutionContext, input: &Path, output: &Path,
                           start: f64, end: f64, nvenc: bool) -> Result<()> {
        let duration = end - start;
        let vcodec = if nvenc { "h264_nvenc" } else { "libx264" };
        let mut command = Command::new(ffmpeg_bin("ffmpeg"));
        command
            .args([
                "-y",
                "-ss", &format!("{start:.3}"),
                "-t",  &format!("{duration:.3}"),
                "-i",  input.to_str().unwrap_or_default(),
                "-c:v", vcodec, "-crf", "23",
                "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart",
                output.to_str().unwrap_or_default(),
            ]);
        let status = execution
            .status(&mut command)
            .await
            .context("copy_segment ffmpeg")?;
        if !status.success() {
            bail!("copy_segment failed: {:?}", status.code());
        }
        Ok(())
    }
}

// ── ClipJob ───────────────────────────────────────────────────────────────────

/// One clip in a GPU concat job.
pub struct ClipJob {
    /// Path to the source video.
    pub path: PathBuf,
    pub start_sec: f64,
    pub end_sec:   f64,
    /// Color grading applied to this clip.
    pub color: ColorParams,
    /// Transition going INTO the next clip.
    pub transition_out: Transition,
    /// Override transition duration (None = use default).
    pub transition_dur_override: Option<f64>,
}

impl ClipJob {
    pub fn new(path: impl Into<PathBuf>, start: f64, end: f64) -> Self {
        Self {
            path: path.into(),
            start_sec: start,
            end_sec: end,
            color: ColorParams::default(),
            transition_out: Transition::Fade,
            transition_dur_override: None,
        }
    }

    pub fn with_color(mut self, color: ColorParams) -> Self {
        self.color = color;
        self
    }

    pub fn with_transition(mut self, t: Transition) -> Self {
        self.transition_out = t;
        self
    }

    pub fn with_transition_dur(mut self, dur: f64) -> Self {
        self.transition_dur_override = Some(dur);
        self
    }
}

// ── Utility ───────────────────────────────────────────────────────────────────

fn ffmpeg_bin(name: &str) -> String {
    if let Ok(p) = std::env::var("FFMPEG_PATH") {
        // If FFMPEG_PATH points to ffmpeg binary directly, replace the filename
        let path = std::path::Path::new(&p);
        if let Some(dir) = path.parent() {
            return dir.join(name).to_string_lossy().to_string();
        }
    }
    name.to_owned()
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
    use tokio::process::Command;

    use super::*;
    use crate::execution::{is_cancelled, JobExecutionContext};

    #[tokio::test]
    async fn gpu_pipe_honors_job_cancellation() {
        let execution = JobExecutionContext::new();
        let mut command = long_running_command();
        command.stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = spawn_piped_command(&execution, &mut command).unwrap();
        let stdout = child.take_stdout().expect("GPU pipe must expose stdout");
        let mut stdout = BufReader::new(stdout).lines();

        assert_eq!(stdout.next_line().await.unwrap().as_deref(), Some("ready"));

        let started = Instant::now();
        execution.cancel();
        let error = child.wait().await.expect_err("cancelled GPU pipe must not succeed");

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(is_cancelled(&error));
    }

    #[tokio::test]
    async fn next_decode_drain_consumes_excess_stdout_before_wait() {
        let execution = JobExecutionContext::new();
        let mut command = excess_output_command();
        command.stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = spawn_piped_command(&execution, &mut command).unwrap();
        let mut stdout = child.take_stdout().expect("next decoder must expose stdout");
        let mut head = [0_u8; 4];

        stdout.read_exact(&mut head).await.unwrap();
        assert_eq!(head, [0; 4]);
        let status = tokio::time::timeout(
            Duration::from_secs(2),
            drain_and_wait_decoder(&execution, &mut stdout, child),
        )
        .await
        .expect("draining must let a pipe-capacity-exceeding decoder exit")
        .unwrap();
        assert!(status.success());
    }

    #[tokio::test]
    async fn cancellation_prevents_next_gpu_frame_operation() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let execution = JobExecutionContext::new();
        let operations = AtomicUsize::new(0);

        run_frame_operation(&execution, || {
            operations.fetch_add(1, Ordering::SeqCst);
            execution.cancel();
            async {}
        })
        .await
        .expect("first frame operation must complete");

        let error = run_frame_operation(&execution, || {
            operations.fetch_add(1, Ordering::SeqCst);
            async {}
        })
        .await
        .expect_err("cancelled context must not start the next frame operation");

        assert!(is_cancelled(&error));
        assert_eq!(operations.load(Ordering::SeqCst), 1);
    }

    #[cfg(windows)]
    fn long_running_command() -> Command {
        let mut command = Command::new("powershell");
        command.args([
            "-NoProfile",
            "-Command",
            "Write-Output ready; Start-Sleep -Seconds 30",
        ]);
        command
    }

    #[cfg(unix)]
    fn long_running_command() -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", "printf 'ready\\n'; sleep 30"]);
        command
    }

    #[cfg(windows)]
    fn excess_output_command() -> Command {
        let mut command = Command::new("powershell");
        command.args([
            "-NoProfile",
            "-Command",
            "$out = [Console]::OpenStandardOutput(); $chunk = New-Object byte[] 4096; for ($i = 0; $i -lt 64; $i++) { $out.Write($chunk, 0, $chunk.Length) }",
        ]);
        command
    }

    #[cfg(unix)]
    fn excess_output_command() -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", "dd if=/dev/zero bs=4096 count=64 2>/dev/null"]);
        command
    }
}
