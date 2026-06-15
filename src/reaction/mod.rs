//! Reaction module — Phase 4-6 of the News+Reaction pipeline.
//!
//! Phase 4: LLM reaction script + TTS voice synthesis
//! Phase 5: Static avatar image post-roll (TODO)
//! Phase 6: D-ID / HeyGen talking avatar (TODO)

pub mod avatar;
pub mod error;
pub mod model;
pub mod script;
pub mod tts;

pub use avatar::{create_avatar_segment, AvatarSegmentSpec};
pub use error::ReactionError;
pub use model::ReactionScript;
pub use tts::{synthesize, TtsResult};
