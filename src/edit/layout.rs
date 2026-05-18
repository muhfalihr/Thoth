use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OutputLayout {
    /// 9:16 vertical (TikTok / Reels / Shorts) — 1080×1920
    Vertical,
    /// 16:9 horizontal (YouTube / standard) — 1920×1080
    Horizontal,
    /// 1:1 square (Instagram feed) — 1080×1080
    Square,
}

impl OutputLayout {
    pub fn width(&self) -> u32 {
        match self {
            OutputLayout::Vertical => 1080,
            OutputLayout::Horizontal => 1920,
            OutputLayout::Square => 1080,
        }
    }

    pub fn height(&self) -> u32 {
        match self {
            OutputLayout::Vertical => 1920,
            OutputLayout::Horizontal => 1080,
            OutputLayout::Square => 1080,
        }
    }
}

impl From<&crate::cli::OutputLayout> for OutputLayout {
    fn from(l: &crate::cli::OutputLayout) -> Self {
        match l {
            crate::cli::OutputLayout::Vertical => OutputLayout::Vertical,
            crate::cli::OutputLayout::Horizontal => OutputLayout::Horizontal,
            crate::cli::OutputLayout::Square => OutputLayout::Square,
        }
    }
}

impl std::fmt::Display for OutputLayout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OutputLayout::Vertical => write!(f, "vertical"),
            OutputLayout::Horizontal => write!(f, "horizontal"),
            OutputLayout::Square => write!(f, "square"),
        }
    }
}
