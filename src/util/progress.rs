use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use std::time::Duration;

/// Braille spinner — for open-ended waits.
pub fn spinner(msg: &str) -> ProgressBar {
    let pb = ProgressBar::new_spinner();
    pb.set_style(
        ProgressStyle::with_template("  {spinner:.cyan} {msg} {elapsed}")
            .unwrap()
            .tick_strings(&["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]),
    );
    pb.set_message(msg.to_owned());
    pb.enable_steady_tick(Duration::from_millis(80));
    pb
}

/// Percentage bar — for yt-dlp download where we get 0-100 progress.
pub fn percent_bar(msg: &str) -> ProgressBar {
    let pb = ProgressBar::new(100);
    pb.set_style(
        ProgressStyle::with_template(
            "  {msg}\n  {spinner:.green} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {pos:>3}% ({eta})",
        )
        .unwrap()
        .tick_strings(&["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"])
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
        ProgressStyle::with_template(
            "  {msg}\n  {spinner:.yellow} [{elapsed_precise}] [{wide_bar:.yellow/white}] {pos}/{len} clips",
        )
        .unwrap()
        .tick_strings(&["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"])
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
        ProgressStyle::with_template("    {spinner:.blue} {msg} {elapsed}")
            .unwrap()
            .tick_strings(&["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]),
    );
    pb.set_message(msg.to_owned());
    pb.enable_steady_tick(Duration::from_millis(80));
    pb
}

/// Print a prominent stage header to stderr (visible regardless of RUST_LOG).
pub fn stage_header(n: u8, total: u8, label: &str) {
    let bar = "─".repeat(50);
    eprintln!("\n  ┌{bar}┐");
    eprintln!("  │  Stage {n}/{total}: {label:<44}│");
    eprintln!("  └{bar}┘");
}

/// Print a stage completion line with elapsed time.
pub fn stage_done(label: &str, elapsed: std::time::Duration) {
    let secs = elapsed.as_secs_f64();
    eprintln!("  ✓ {label} done in {secs:.1}s\n");
}
