//! Thoth terminal visual identity — "Feather Spine" + "Ink & Gold".
//!
//! Single source of the palette, glyphs, and the startup banner. Every colored
//! byte in the log formatter and progress helpers routes through [`p()`] so that
//! piped output / `NO_COLOR` degrade to clean plain text (only ANSI color is
//! gated — the unicode glyphs are UTF-8 safe in a file and stay).

use std::io::IsTerminal;
use std::sync::OnceLock;

// --- Glyphs (always emitted; not color) -------------------------------------
pub const FEATHER: &str = "🪶";
pub const SPINE: &str = "▏"; // thin spine down every sub-line
pub const BLOCK: &str = "█"; // heavy block = stage header
pub const OK: &str = "✓";
pub const WARN: &str = "⚠";
pub const ERR: &str = "✗";
pub const DOT: &str = "·";

/// Ink & Gold palette. Fields are raw ANSI codes, or empty strings when color
/// is disabled — so the same format strings work in both modes.
pub struct Palette {
    pub gold: &'static str,   // brand + success
    pub violet: &'static str, // accent / spine
    pub cyan: &'static str,   // info
    pub amber: &'static str,  // warn
    pub red: &'static str,    // error
    pub dim: &'static str,    // chrome
    pub reset: &'static str,
}

fn no_color_env() -> bool {
    std::env::var_os("NO_COLOR").is_some()
        || std::env::var("TERM").map(|t| t == "dumb").unwrap_or(false)
}

fn build_palette(enabled: bool) -> Palette {
    if enabled {
        Palette {
            gold: "\x1b[38;5;179m",
            violet: "\x1b[38;5;141m",
            cyan: "\x1b[36m",
            amber: "\x1b[33m",
            red: "\x1b[31m",
            dim: "\x1b[90m",
            reset: "\x1b[0m",
        }
    } else {
        Palette { gold: "", violet: "", cyan: "", amber: "", red: "", dim: "", reset: "" }
    }
}

/// Whether ANSI color should be emitted on stderr: interactive, no `NO_COLOR`,
/// `TERM` not `dumb`. Cached — computed once. Governs banner/log lines/progress.
pub fn color_enabled() -> bool {
    static E: OnceLock<bool> = OnceLock::new();
    *E.get_or_init(|| !no_color_env() && std::io::stderr().is_terminal())
}

/// Same gate as [`color_enabled`] but for stdout — governs command RESULT
/// lines (data-plane output), which must stay plain when stdout is redirected
/// even if stderr (chrome) is still an interactive terminal.
pub fn stdout_color_enabled() -> bool {
    static E: OnceLock<bool> = OnceLock::new();
    *E.get_or_init(|| !no_color_env() && std::io::stdout().is_terminal())
}

/// The active palette for stderr (all-empty when color is disabled).
pub fn p() -> &'static Palette {
    static P: OnceLock<Palette> = OnceLock::new();
    P.get_or_init(|| build_palette(color_enabled()))
}

/// The active palette for stdout (all-empty when color is disabled).
pub fn p_out() -> &'static Palette {
    static P: OnceLock<Palette> = OnceLock::new();
    P.get_or_init(|| build_palette(stdout_color_enabled()))
}

/// A stdout result line: `✓ msg` in gold. For command-completion summaries.
pub fn ok(msg: impl std::fmt::Display) -> String {
    let p = p_out();
    format!("{}{}{} {}", p.gold, OK, p.reset, msg)
}

/// A stdout indented field line: `  ▏ key : val` (violet spine, dim key).
pub fn field(key: &str, val: impl std::fmt::Display) -> String {
    let p = p_out();
    format!("  {}{}{} {}{}:{} {}", p.violet, SPINE, p.reset, p.dim, key, p.reset, val)
}

/// A stderr warning line: `⚠ msg` in amber.
pub fn warn(msg: impl std::fmt::Display) -> String {
    let p = p();
    format!("{}{}{} {}", p.amber, WARN, p.reset, msg)
}

/// A stderr error line: `✗ msg` in red.
pub fn err(msg: impl std::fmt::Display) -> String {
    let p = p();
    format!("{}{}{} {}", p.red, ERR, p.reset, msg)
}

/// Short tagline derived from `Cargo.toml` `description`
/// ("Thoth — AI short-form video strategist: …" → "AI short-form video strategist").
fn tagline() -> &'static str {
    static T: OnceLock<String> = OnceLock::new();
    T.get_or_init(|| {
        let d = env!("CARGO_PKG_DESCRIPTION");
        let after = d.rsplit('—').next().unwrap_or(d).trim();
        after.split(':').next().unwrap_or(after).trim().to_string()
    })
}

/// Print the head banner to stderr, once. Interactive-only (suppressed when
/// piped / `NO_COLOR`) so log files stay clean.
pub fn banner() {
    if !color_enabled() {
        return;
    }
    let p = p();
    eprintln!();
    eprintln!("  {}{}{}  {}T H O T H{}", p.gold, FEATHER, p.reset, p.gold, p.reset);
    eprintln!(
        "  {}{}{} {}{} · v{}{}",
        p.violet,
        SPINE,
        p.reset,
        p.dim,
        tagline(),
        env!("CARGO_PKG_VERSION"),
        p.reset
    );
    eprintln!("  {}{}{}", p.violet, SPINE, p.reset);
}
