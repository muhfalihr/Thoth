pub mod color;
pub mod error;
pub mod ffmpeg;
pub mod fonts;
pub mod intro;
pub mod layout;
pub mod overlay;
pub mod service;
pub mod sfx;
pub mod subtitle;
pub mod transition;

pub use color::ColorGrading;
pub use ffmpeg::{AudioOptions, ClipStyle, HeadlineOverlay, SocialIcon};
pub use fonts::FontConfig;
pub use layout::OutputLayout;
pub use service::{EditResult, EditService};
pub use transition::{ClipSpec, Transition, concat_with_transitions, transition_sequence_from_vibes};
