pub mod error;
pub mod prompt;
pub mod provider;
pub mod schema;
pub mod service;
pub mod trend_analyzer;
pub mod trending;
pub mod vision;

pub use schema::{ViralMoment, ViralMomentList, VisualScore};
pub use vision::{VideoDescription, build_enriched_transcript, describe_video_frames};
pub use service::{AnalyzeResult, AnalyzeService};
