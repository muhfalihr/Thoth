//! GPU-accelerated video processing pipeline.
//!
//! Architecture mirrors CapCut's internal pipeline:
//! - `context.rs`   — wgpu device/queue initialization (NVIDIA/AMD preferred)
//! - `effect.rs`    — ColorPipeline + TransitionPipeline (WGSL shaders)
//! - `processor.rs` — Full pipeline: FFmpeg decode → GPU → FFmpeg encode
//!
//! ## WGSL Shaders (ported from CapCut reverse engineering)
//! - `shaders/color.wgsl`      — HSL, Log Color Wheels, Curves, Sharpen, Vignette
//! - `shaders/transition.wgsl` — 21 transition effects (Fade, Blink, Wipe, Slide, ...)
//!
//! ## Usage
//!
//! ```rust
//! use thoth::gpu::{GpuProcessor, ClipJob, ColorParams};
//! use thoth::edit::transition::Transition;
//!
//! let gpu = GpuProcessor::new().await?;
//!
//! // Apply color grading to a single clip
//! let mut color = ColorParams::default();
//! color.saturation = 0.3;
//! color.vignette   = 0.4;
//! gpu.apply_color("input.mp4", "output.mp4", 0.0, 30.0, &color, true).await?;
//!
//! // Concat multiple clips with GPU transitions
//! let jobs = vec![
//!     ClipJob::new("clip1.mp4", 0.0, 15.0)
//!         .with_transition(Transition::Blink),
//!     ClipJob::new("clip2.mp4", 0.0, 12.0)
//!         .with_transition(Transition::WipeLeft),
//!     ClipJob::new("clip3.mp4", 5.0, 18.0)
//!         .with_transition(Transition::None),
//! ];
//! gpu.concat_gpu(&jobs, "final.mp4", true).await?;
//! ```

pub mod context;
pub mod effect;
pub mod processor;

pub use context::GpuContext;
pub use effect::{ColorParams, ColorPipeline, TransitionParams, TransitionPipeline};
pub use processor::{ClipJob, GpuProcessor, VideoMeta};
