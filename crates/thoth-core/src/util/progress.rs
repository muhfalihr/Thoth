use crate::brand;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use std::sync::OnceLock;
use std::sync::RwLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// The NDJSON progress wire type now lives in the leaf `thoth-types` crate so
/// `thoth-server` can consume it without linking any of thoth-core's heavy deps.
/// Re-exported here to keep the `util::progress::ProgressEvent` path stable.
pub use thoth_types::ProgressEvent;

static JSON_MODE: AtomicBool = AtomicBool::new(false);

/// A progress sink — where each stage event goes. The `thoth worker` installs
/// one that writes to the SQLite job DB; the CLI leaves it unset and falls back
/// to stdout NDJSON under `--progress-json`.
type Sink = Box<dyn Fn(ProgressEvent) + Send + Sync>;
static SINK: RwLock<Option<Sink>> = RwLock::new(None);

/// Redirect all `emit_stage` events to `sink` (worker → DB). Replaces any prior
/// sink. Install `Box::new(|_| {})` to swallow events between jobs.
pub fn set_sink(sink: Sink) {
    *SINK.write().unwrap() = Some(sink);
}

/// Enable NDJSON progress on stdout (set by `--progress-json`).
pub fn set_json_mode(on: bool) {
    JSON_MODE.store(on, Ordering::Relaxed);
}

/// Emit one progress event: to the installed sink if any, else stdout NDJSON in
/// JSON mode, else nothing. (Live indicatif bars are separate — see below.)
pub fn emit_stage(stage: &str, pct: f32, message: &str) {
    let ev = ProgressEvent {
        stage: stage.to_owned(),
        pct,
        message: message.to_owned(),
        ts: chrono::Utc::now().to_rfc3339(),
    };
    if let Some(sink) = SINK.read().unwrap().as_ref() {
        sink(ev); // worker installs a DB sink
    } else if JSON_MODE.load(Ordering::Relaxed) {
        if let Ok(line) = serde_json::to_string(&ev) {
            println!("{line}"); // stdout = machine channel; logs go to stderr
        }
    }
}

const TICKS: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Violet spine prefix for live bars. Hardcoded ANSI is fine here: indicatif
// suppresses its own draw target when stderr is not a terminal, so these never
// reach a pipe/file.
const SPINE: &str = "\x1b[38;5;141m▏\x1b[0m";

/// Process start, for the elapsed column on stage headers.
fn start() -> Instant {
    static S: OnceLock<Instant> = OnceLock::new();
    *S.get_or_init(Instant::now)
}

/// Seconds since the first progress call (for the run footer).
pub fn elapsed_secs() -> f64 {
    start().elapsed().as_secs_f64()
}

/// Braille spinner — for open-ended waits.
pub fn spinner(msg: &str) -> ProgressBar {
    let pb = ProgressBar::new_spinner();
    pb.set_style(
        ProgressStyle::with_template(&format!("  {SPINE} {{spinner:.cyan}} {{msg}} {{elapsed}}"))
            .unwrap()
            .tick_strings(TICKS),
    );
    pb.set_message(msg.to_owned());
    pb.enable_steady_tick(Duration::from_millis(80));
    pb
}

/// Percentage bar — for yt-dlp download where we get 0-100 progress.
pub fn percent_bar(msg: &str) -> ProgressBar {
    let pb = ProgressBar::new(100);
    pb.set_style(
        ProgressStyle::with_template(&format!(
            "  {SPINE} {{msg}}\n  {SPINE} {{spinner:.cyan}} [{{elapsed_precise}}] [{{wide_bar:.cyan/blue}}] {{pos:>3}}% ({{eta}})",
        ))
        .unwrap()
        .tick_strings(TICKS)
        .progress_chars("█▉▊▋▌▍▎▏ "),
    );
    pb.set_message(msg.to_owned());
    pb.enable_steady_tick(Duration::from_millis(100));
    pb
}

/// N-step bar — for a known number of items (clips, segments).
pub fn step_bar(steps: u64, msg: &str) -> ProgressBar {
    let pb = ProgressBar::new(steps);
    pb.set_style(
        ProgressStyle::with_template(&format!(
            "  {SPINE} {{msg}}\n  {SPINE} {{spinner:.cyan}} [{{elapsed_precise}}] [{{wide_bar:.magenta/blue}}] {{pos}}/{{len}} clips",
        ))
        .unwrap()
        .tick_strings(TICKS)
        .progress_chars("█▉▊▋▌▍▎▏ "),
    );
    pb.set_message(msg.to_owned());
    pb.enable_steady_tick(Duration::from_millis(100));
    pb
}

/// A sub-spinner that is attached to a MultiProgress group.
pub fn sub_spinner(mp: &MultiProgress, msg: &str) -> ProgressBar {
    let pb = mp.add(ProgressBar::new_spinner());
    pb.set_style(
        ProgressStyle::with_template(&format!("    {SPINE} {{spinner:.cyan}} {{msg}} {{elapsed}}"))
            .unwrap()
            .tick_strings(TICKS),
    );
    pb.set_message(msg.to_owned());
    pb.enable_steady_tick(Duration::from_millis(80));
    pb
}

/// Print a prominent stage header to stderr (visible regardless of RUST_LOG):
///
///   █ INGEST                      2/6 · 1.2s
pub fn stage_header(n: u8, total: u8, label: &str) {
    // Machine channel: coarse pct = stage index / total. All 5 stages route here.
    emit_stage(label, f32::from(n) / f32::from(total), label);
    let p = brand::p();
    let label_up = label.to_uppercase();
    let meta = format!("{n}/{total} {} {:.1}s", brand::DOT, start().elapsed().as_secs_f64());
    // pad so meta right-aligns to ~40 cols of visible content
    let visible = brand::BLOCK.chars().count() + 1 + label_up.chars().count();
    let pad = 40usize.saturating_sub(visible + meta.chars().count()).max(2);
    eprintln!(
        "\n  {}{}{} {}{}{}{}{}{}{}",
        p.gold,
        brand::BLOCK,
        p.reset,
        p.violet,
        label_up,
        p.reset,
        " ".repeat(pad),
        p.dim,
        meta,
        p.reset,
    );
}

/// Print a stage completion line with elapsed time:
///
///   ▏ ✓ ingest · 1.2s
pub fn stage_done(label: &str, elapsed: Duration) {
    let p = brand::p();
    eprintln!(
        "  {}{}{} {}{}{} {label} {}{}{} {}{:.1}s{}",
        p.violet,
        brand::SPINE,
        p.reset,
        p.gold,
        brand::OK,
        p.reset,
        p.dim,
        brand::DOT,
        p.reset,
        p.gold,
        elapsed.as_secs_f64(),
        p.reset,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_event_round_trips_as_ndjson() {
        let ev = ProgressEvent {
            stage: "transcribe".to_owned(),
            pct: 0.3,
            message: "whisper".to_owned(),
            ts: "2026-07-11T00:00:00Z".to_owned(),
        };
        let line = serde_json::to_string(&ev).unwrap();
        assert!(!line.contains('\n'), "NDJSON line must be single-line");
        let back: ProgressEvent = serde_json::from_str(&line).unwrap();
        assert_eq!(back.stage, "transcribe");
        assert!((back.pct - 0.3).abs() < 1e-6);
    }

    #[test]
    fn emit_stage_routes_to_installed_sink() {
        // A sink (what the `thoth worker` installs) captures events regardless
        // of JSON mode — this is the whole point of set_sink.
        set_json_mode(false);
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        set_sink(Box::new(move |ev| seen2.lock().unwrap().push(ev)));

        emit_stage("ingest", 0.2, "a");

        let got = seen.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].stage, "ingest");
        assert!((got[0].pct - 0.2).abs() < 1e-6);
        drop(got);

        // Restore global sink so other tests aren't affected.
        *SINK.write().unwrap() = None;
    }
}
