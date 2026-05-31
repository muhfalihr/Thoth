pub mod error;
pub mod service;
pub mod ytdlp;

pub use service::{IngestResult, IngestService};
pub use ytdlp::{CookieSource, KillOnDrop, YtDlpArgs};
