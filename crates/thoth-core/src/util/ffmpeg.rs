use ffmpeg_sidecar::command::FfmpegCommand;

/// Creates a new `FfmpegCommand`.
/// If the `FFMPEG_PATH` environment variable is set, it uses that path.
/// Otherwise, it falls back to the default `ffmpeg_sidecar` discovery.
pub fn command() -> FfmpegCommand {
    if let Ok(path) = std::env::var("FFMPEG_PATH") {
        FfmpegCommand::new_with_path(path)
    } else {
        FfmpegCommand::new()
    }
}
