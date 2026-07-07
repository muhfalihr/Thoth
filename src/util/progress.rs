use crate::brand;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

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
