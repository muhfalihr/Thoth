//! FFmpeg-backed [`PlannedMainRenderer`] over a **verified** main-footage plan.
//!
//! This is the production endpoint; it replaced the placeholder
//! `DeferredPlannedMainRenderer` that Task 12 left behind the same port.
//! Its whole input surface is job-owned local media: the verified plan's cut
//! paths, the narration audio the timeline names, and render settings. There is
//! deliberately no URL, HTTP client, ingest service, planner, or downloader
//! reachable from here — see the `no_network` tests at the bottom, which assert
//! that property against this module's own source text.
//!
//! Graph construction lives in [`super::planned_ffmpeg`] and is pure; this module
//! only resolves paths, probes for audio streams, and runs the process.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
use async_trait::async_trait;
use chrono::Utc;
use tracing::info;

use super::error::EditError;
use super::ffmpeg::{AudioOptions, build_encoder, run_ffmpeg_with_binary};
use super::layout::OutputLayout;
use super::planned_ffmpeg::{
    PlannedGraphItem, PlannedGraphRequest, build_planned_graph, leak_windows_from_words,
};
use super::service::{ClipOutput, EditResult};
use crate::config::FfmpegConfig;
use crate::execution::JobExecutionContext;
use crate::main_footage::{
    MainFootageError, MainFootageErrorCode, NarrationTimelineV1, VerifiedMainFootagePlan,
    resolve_contained,
};
use crate::pipeline::PlannedMainRenderer;
use crate::pipeline::job::JobContext;
use thoth_types::main_footage::PlannedCutV1;

/// Narration pause long enough for the source ambience to breathe through.
const LEAK_GAP_SEC: f64 = 0.5;

/// Applied when the caller supplies no narration voice settings. Matches the
/// legacy narrator defaults so a planned render sounds like the rest of Thoth.
const DEFAULT_DUCK_VOL: f32 = 0.25;
const DEFAULT_LEAK_VOL: f32 = 0.60;

/// The single rendered artifact, relative to the job root.
const OUTPUT_NAME: &str = "planned_main.mp4";

fn invalid(detail: impl Into<String>) -> MainFootageError {
    MainFootageError::new(MainFootageErrorCode::PlanVerificationFailed, detail)
}

/// Project an `EditError` from the FFmpeg run onto the renderer's own boundary.
///
/// Cancellation is the one error the pipeline seam still acts on
/// (`pipeline::planned_renderer_error` passes it through untouched, and
/// `execution::is_cancelled` matches by `downcast_ref`, not by message), so the
/// typed [`crate::execution::Cancelled`] must be the error itself rather than a
/// wrapped cause. Everything else becomes a typed plan-verification failure whose
/// `Display` still carries the FFmpeg tail for the operator log.
fn planned_edit_error(error: EditError) -> anyhow::Error {
    match error {
        EditError::Cancelled(cancelled) => anyhow::Error::new(cancelled),
        other => invalid(format!("planned_render_failed: {other}")).into(),
    }
}

/// Resolve every timeline cut to a job-contained file that exists **now**.
///
/// The plan's `cut_path` is slash-relative to the job root by contract;
/// `resolve_contained` re-checks that and refuses to leave the root. A cut that
/// has since been deleted is the whole reason this boundary exists, so a missing
/// file is an error here rather than a silent gap in the render.
pub(crate) fn resolve_planned_cuts(
    root: &Path,
    timeline: &[PlannedCutV1],
) -> Result<Vec<PathBuf>, MainFootageError> {
    let mut resolved = Vec::with_capacity(timeline.len());
    for cut in timeline {
        let path = resolve_contained(root, Path::new(&cut.cut_path))
            .map_err(|_| invalid("planned_cut_path_invalid"))?;
        if !path.is_file() {
            return Err(invalid("planned_cut_missing"));
        }
        resolved.push(path);
    }
    Ok(resolved)
}

fn ffprobe_binary(ffmpeg: &Path) -> PathBuf {
    if let Some(path) = std::env::var_os("THOTH_FFPROBE") {
        return PathBuf::from(path);
    }
    ffmpeg.with_file_name(if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    })
}

/// FFmpeg-backed renderer for verified plans.
///
/// The resolved binary path is per-instance state, never a process global: a
/// `static` cache here would be a fourth source of cross-test interference in a
/// suite that already has three (Ruling AI).
pub struct PlannedFfmpegRenderer {
    ffmpeg: FfmpegConfig,
    binary: PathBuf,
}

impl PlannedFfmpegRenderer {
    #[must_use]
    pub fn new(ffmpeg: &FfmpegConfig) -> Self {
        let binary = if let Ok(path) = std::env::var("FFMPEG_PATH") {
            PathBuf::from(path)
        } else if let Some(path) = ffmpeg.ffmpeg_path.as_deref().filter(|p| !p.is_empty()) {
            PathBuf::from(path)
        } else {
            ffmpeg_sidecar::paths::ffmpeg_path()
        };
        Self {
            ffmpeg: ffmpeg.clone(),
            binary,
        }
    }

    /// Whether `path` carries an audio stream. Results are memoized in the
    /// caller-owned map so a reused cut is probed once per render.
    async fn has_audio(
        &self,
        path: &Path,
        cache: &mut HashMap<PathBuf, bool>,
        execution: &JobExecutionContext,
    ) -> Result<bool> {
        if let Some(known) = cache.get(path) {
            return Ok(*known);
        }
        let mut command = tokio::process::Command::new(ffprobe_binary(&self.binary));
        command.args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "csv=p=0",
        ]);
        command.arg(path);
        let output = execution.output(&mut command).await.map_err(|error| {
            if crate::execution::is_cancelled(&error) {
                error
            } else {
                invalid("planned_cut_probe_failed").into()
            }
        })?;
        if !output.status.success() {
            return Err(invalid("planned_cut_probe_failed").into());
        }
        let present = String::from_utf8_lossy(&output.stdout).contains("audio");
        cache.insert(path.to_owned(), present);
        Ok(present)
    }

    /// The whole render, expressed over the plan's *contents* rather than the
    /// opaque [`VerifiedMainFootagePlan`].
    ///
    /// `VerifiedMainFootagePlan` has private fields and only `verify_plan` can
    /// build one, so this seam is what makes the render path reachable from a
    /// test without a two-hundred-line package fixture. It is `pub(crate)` and
    /// takes `&[PlannedCutV1]` — a caller still cannot invent a verified plan,
    /// only pass one's timeline through.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn render_timeline(
        &self,
        job: &JobContext,
        timeline: &[PlannedCutV1],
        narration_duration_sec: f64,
        narration: &NarrationTimelineV1,
        layout: &OutputLayout,
        audio: &AudioOptions,
        social_name: &str,
        style_profile_name: &str,
        execution: &JobExecutionContext,
    ) -> Result<EditResult> {
        execution.check_cancelled()?;

        let root = job.root();
        let cut_paths = resolve_planned_cuts(&root, timeline)?;
        let narration_audio = resolve_contained(&root, Path::new(&narration.audio_path))
            .map_err(|_| invalid("planned_narration_audio_invalid"))?;
        if !narration_audio.is_file() {
            return Err(invalid("planned_narration_audio_missing").into());
        }

        let mut probe_cache = HashMap::new();
        let mut items = Vec::with_capacity(cut_paths.len());
        for (cut, cut_path) in timeline.iter().zip(cut_paths) {
            let has_audio = if audio.mute_event {
                // The source stream is dropped anyway; skip the probe entirely.
                false
            } else {
                self.has_audio(&cut_path, &mut probe_cache, execution).await?
            };
            items.push(PlannedGraphItem {
                cut_path,
                visible_duration_sec: cut.source_end_sec - cut.source_start_sec,
                handles: cut.handles.clone(),
                transition: cut.transition.clone(),
                has_audio,
            });
        }

        // The plan is authored directly in narration coordinates, so `lead_in_secs`
        // is deliberately NOT applied: delaying the voice here would slide every
        // word off the cut it was planned against.
        let (duck_vol, leak_vol, leak_windows) = match audio.narration.as_ref() {
            Some(voice) if !voice.leak_windows.is_empty() => (
                voice.duck_event_vol,
                voice.leak_vol,
                voice.leak_windows.clone(),
            ),
            Some(voice) => (
                voice.duck_event_vol,
                voice.leak_vol,
                leak_windows_from_words(&narration.words, narration.duration_sec, LEAK_GAP_SEC),
            ),
            None => (
                DEFAULT_DUCK_VOL,
                DEFAULT_LEAK_VOL,
                leak_windows_from_words(&narration.words, narration.duration_sec, LEAK_GAP_SEC),
            ),
        };

        let output = job.clips_dir().join(OUTPUT_NAME);
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|_| invalid("planned_output_dir_unwritable"))?;
        }

        let request = PlannedGraphRequest {
            items,
            narration_audio,
            narration_duration_sec,
            leak_windows,
            duck_vol,
            leak_vol,
            mute_source: audio.mute_event,
            width: layout.width(),
            height: layout.height(),
            bgm: audio
                .bgm
                .as_ref()
                .map(|path| (path.clone(), audio.bgm_volume)),
            sfx_intro: audio.sfx_intro.clone(),
            hook_title_png: audio.hook_title_png.clone(),
            cover: audio.cover.clone(),
            encoder: build_encoder(&self.ffmpeg),
            audio_bitrate: self.ffmpeg.audio_bitrate.clone(),
            output: output.clone(),
        };
        let graph = build_planned_graph(&request)?;

        info!(
            "🎬 Rendering {} planned cuts ({:.2}s) for @{social_name} [{style_profile_name}]",
            graph.transitions.len(),
            graph.total_duration_sec
        );
        run_ffmpeg_with_binary(execution, &self.binary, &graph.args)
            .await
            .map_err(planned_edit_error)?;

        Ok(EditResult {
            output_clips: vec![ClipOutput {
                clip_index: 0,
                title: social_name.to_owned(),
                path: output,
                thumb_path: None,
                duration_secs: graph.total_duration_sec,
                layout: layout.to_string(),
            }],
            completed_at: Utc::now(),
        })
    }
}

#[async_trait]
impl PlannedMainRenderer for PlannedFfmpegRenderer {
    async fn render(
        &self,
        job: &JobContext,
        plan: &VerifiedMainFootagePlan,
        narration: &NarrationTimelineV1,
        layout: &OutputLayout,
        audio: &AudioOptions,
        social_name: &str,
        style_profile_name: &str,
        execution: &JobExecutionContext,
    ) -> Result<EditResult> {
        self.render_timeline(
            job,
            plan.timeline(),
            plan.narration_duration_sec(),
            narration,
            layout,
            audio,
            social_name,
            style_profile_name,
            execution,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::Cancelled;
    use thoth_types::main_footage::{CutHandlesV1, MatchLevel, TransitionKind, TransitionV1};

    /// Every identifier that would mean this renderer can reach the network or
    /// re-acquire a source. Assembled from fragments so the check does not trip
    /// over its own needles — the assertion below proves the fragments still
    /// spell the real thing.
    fn forbidden_needles() -> Vec<String> {
        [
            ("req", "west"),
            ("fetch_overlay", "_from_url"),
            ("yt-", "dlp"),
            ("ingest::", "service"),
            // Scheme-agnostic on purpose: `"https://…".contains("http://")` is
            // false, so a needle spelling one scheme misses the commonest form.
            (":", "//"),
            ("Ingest", "Service"),
            ("down", "load_"),
        ]
        .iter()
        .map(|(head, tail)| format!("{head}{tail}"))
        .collect()
    }

    fn source_without_test_module(source: &str) -> &str {
        source
            .split_once("#[cfg(test)]")
            .map_or(source, |(body, _)| body)
    }

    /// Ruling F: a runnable, *discriminating* source-level check. Adding
    /// `reqwest::get` to either renderer module turns this red.
    #[test]
    fn the_renderer_source_cannot_reach_the_network() {
        let modules = [
            ("planned.rs", include_str!("planned.rs")),
            ("planned_ffmpeg.rs", include_str!("planned_ffmpeg.rs")),
        ];
        let needles = forbidden_needles();
        assert!(
            needles.contains(&"reqwest".to_owned()),
            "the needle list must actually spell the forbidden crate"
        );
        assert!(
            needles.contains(&"://".to_owned()),
            "the needle list must catch every URL scheme, not one spelling of it"
        );
        for (name, source) in modules {
            let body = source_without_test_module(source);
            for needle in &needles {
                assert!(
                    !body.contains(needle.as_str()),
                    "{name} must not reference `{needle}` — the planned renderer \
                     renders job-owned local media only"
                );
            }
        }
    }

    /// Type-level half of Ruling F: the graph request is constructible from local
    /// paths alone, and every path it carries is a `PathBuf` — there is no field
    /// that could hold a URL or a client handle. The *construction* is the real
    /// (compile-time) guarantee; the one runtime assertion worth making is that
    /// the graph opens nothing the request did not name, which is what would
    /// change if a remote fallback input were ever introduced.
    #[test]
    fn a_render_request_is_constructible_from_local_paths_only() {
        let request = PlannedGraphRequest {
            items: vec![PlannedGraphItem {
                cut_path: PathBuf::from("cuts/v001/cut-000.mp4"),
                visible_duration_sec: 2.0,
                handles: CutHandlesV1 {
                    before_ms: 300,
                    after_ms: 300,
                },
                transition: TransitionV1 {
                    kind: TransitionKind::MatchCut,
                    duration_ms: 0,
                },
                has_audio: true,
            }],
            narration_audio: PathBuf::from("narration/narration.mp3"),
            narration_duration_sec: 2.0,
            leak_windows: Vec::new(),
            duck_vol: 0.25,
            leak_vol: 0.6,
            mute_source: false,
            width: 1080,
            height: 1920,
            bgm: None,
            sfx_intro: None,
            hook_title_png: None,
            cover: None,
            encoder: ("libx264".into(), Vec::new()),
            audio_bitrate: "192k".into(),
            output: PathBuf::from("clips/planned_main.mp4"),
        };
        let graph = build_planned_graph(&request).unwrap();
        assert_eq!(
            graph.input_paths,
            vec![
                PathBuf::from("cuts/v001/cut-000.mp4"),
                PathBuf::from("narration/narration.mp3"),
            ],
            "the graph may open only the local files the request named"
        );
    }

    /// Ruling AH item 2: cancellation is the one error with observable behaviour
    /// at the pipeline seam, and `is_cancelled` matches by type. If the wrap loses
    /// the typed `Cancelled`, a cancelled render is reported as a hard failure.
    #[test]
    fn typed_cancellation_survives_the_renderer_boundary() {
        let error = planned_edit_error(EditError::Cancelled(Cancelled));
        assert!(
            crate::execution::is_cancelled(&error),
            "cancellation must stay downcastable, got: {error:#}"
        );
    }

    /// Every other FFmpeg failure becomes the renderer's own typed boundary error
    /// — and keeps the diagnostic in its `Display`.
    #[test]
    fn an_ffmpeg_failure_becomes_a_typed_plan_verification_failure() {
        let error = planned_edit_error(EditError::FfmpegFailed("exit 1: bad filter".into()));
        assert!(!crate::execution::is_cancelled(&error));
        let typed = error
            .downcast_ref::<MainFootageError>()
            .expect("the renderer reports its own typed boundary error");
        assert_eq!(typed.code, MainFootageErrorCode::PlanVerificationFailed);
        assert!(
            typed.detail.contains("bad filter"),
            "the operator needs the FFmpeg tail: {}",
            typed.detail
        );
    }

    fn planned_cut(cut_path: &str) -> PlannedCutV1 {
        PlannedCutV1 {
            id: "cut-000".into(),
            source_id: "src-000".into(),
            source_path: "sources/main.mp4".into(),
            cut_path: cut_path.into(),
            checksum: "0".repeat(64),
            source_start_sec: 0.0,
            source_end_sec: 2.0,
            output_start_sec: 0.0,
            output_end_sec: 2.0,
            match_level: MatchLevel::Exact,
            reuse_count: 0,
            transition: TransitionV1 {
                kind: TransitionKind::MatchCut,
                duration_ms: 0,
            },
            handles: CutHandlesV1 {
                before_ms: 300,
                after_ms: 300,
            },
        }
    }

    /// The renderer must never render around a cut that has gone missing — that
    /// would silently drop planned screen time.
    /// Per-test scratch root, mirroring `main_footage`'s existing test idiom
    /// (a fresh uuid dir under the system temp) rather than a shared fixture.
    fn scratch_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("planned-render-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_missing_cut_is_a_plan_verification_failure() {
        let root = scratch_root();
        std::fs::create_dir_all(root.join("cuts/v001")).unwrap();
        std::fs::write(root.join("cuts/v001/cut-000.mp4"), b"present").unwrap();

        let present = resolve_planned_cuts(&root, &[planned_cut("cuts/v001/cut-000.mp4")]);
        assert!(present.is_ok(), "{present:?}");

        let error = resolve_planned_cuts(&root, &[planned_cut("cuts/v001/cut-404.mp4")])
            .expect_err("a deleted cut must not be rendered around");
        assert_eq!(error.code, MainFootageErrorCode::PlanVerificationFailed);
        assert_eq!(error.detail, "planned_cut_missing");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A cut path that escapes the job root is refused before it reaches FFmpeg.
    #[test]
    fn a_cut_path_outside_the_job_root_is_refused() {
        let root = scratch_root();
        for escape in ["../outside.mp4", "/etc/passwd", "https://cdn.test/a.mp4"] {
            let error = resolve_planned_cuts(&root, &[planned_cut(escape)])
                .expect_err("an escaping cut path must not resolve");
            assert_eq!(error.detail, "planned_cut_path_invalid", "for `{escape}`");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── Step 5: generated-media render ────────────────────────────────────────

    fn test_ffmpeg() -> Option<PathBuf> {
        if let Ok(path) = std::env::var("FFMPEG_PATH") {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Some(path);
            }
        }
        let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        // Walk out of `crates/thoth-core` to the repo root, where the project
        // keeps its own binary (see CLAUDE.md "FFmpeg: Local ffmpeg.exe").
        let mut dir = Some(Path::new(env!("CARGO_MANIFEST_DIR")));
        while let Some(current) = dir {
            let candidate = current.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
            dir = current.parent();
        }
        let bundled = ffmpeg_sidecar::paths::ffmpeg_path();
        bundled.is_file().then_some(bundled)
    }

    fn run_tool(binary: &Path, args: &[&str]) {
        let output = std::process::Command::new(binary)
            .args(args)
            .output()
            .unwrap_or_else(|error| panic!("{} {args:?}: {error}", binary.display()));
        assert!(
            output.status.success(),
            "{} {args:?} failed:\n{}",
            binary.display(),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn probe_json(ffmpeg: &Path, media: &Path) -> String {
        let output = std::process::Command::new(ffprobe_binary(ffmpeg))
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_entries",
                "format=duration:stream=codec_type,width,height",
            ])
            .arg(media)
            .output()
            .expect("ffprobe must run");
        assert!(output.status.success(), "ffprobe failed on {media:?}");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn probed_duration(report: &str) -> f64 {
        let marker = "\"duration\":";
        let start = report.find(marker).expect("ffprobe reports a duration") + marker.len();
        let rest = &report[start..];
        let text = rest.trim_start().trim_start_matches('"');
        let end = text
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(text.len());
        text[..end].parse().expect("a numeric duration")
    }

    fn cut(index: usize, kind: TransitionKind, duration_ms: u16) -> PlannedCutV1 {
        PlannedCutV1 {
            id: format!("cut-{index:03}"),
            source_id: format!("src-{index:03}"),
            source_path: format!("sources/source-{index}.mp4"),
            cut_path: format!("cuts/v001/cut-{index:03}.mp4"),
            checksum: "0".repeat(64),
            source_start_sec: 1.0,
            source_end_sec: 3.0,
            output_start_sec: 2.0 * index as f64,
            output_end_sec: 2.0 * index as f64 + 2.0,
            match_level: MatchLevel::Exact,
            reuse_count: 0,
            transition: TransitionV1 { kind, duration_ms },
            handles: CutHandlesV1 {
                before_ms: 300,
                after_ms: 300,
            },
        }
    }

    /// End-to-end proof on real media that the renderer works **only** from the
    /// immutable cuts: the generated sources are deleted after materialization,
    /// so any reach back to `sources/` would make this fail rather than pass
    /// quietly. Also pins the two facts a mis-built graph would break — the
    /// rendered length equals the visible sum (handles are not screen time) and
    /// both streams survive the mix.
    #[tokio::test]
    async fn renders_from_immutable_cuts_after_the_sources_are_deleted() {
        let Some(ffmpeg) = test_ffmpeg() else {
            eprintln!("SKIP: no ffmpeg binary found — generated-media render not exercised");
            return;
        };

        let root = scratch_root();
        let sources = root.join("sources");
        let cuts = root.join("cuts/v001");
        let narration_dir = root.join("narration");
        for dir in [&sources, &cuts, &narration_dir] {
            std::fs::create_dir_all(dir).unwrap();
        }

        // Two distinct generated sources; the third timeline item reuses the first.
        for (index, colour) in ["red", "blue"].iter().enumerate() {
            let source = sources.join(format!("source-{index}.mp4"));
            run_tool(
                &ffmpeg,
                &[
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    &format!("color=c={colour}:size=320x240:rate=30:duration=6"),
                    "-f",
                    "lavfi",
                    "-i",
                    &format!("sine=frequency={}:duration=6", 220 * (index + 1)),
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-shortest",
                    source.to_str().unwrap(),
                ],
            );
        }

        // Materialize the cuts with their handles baked in: 0.3 + 2.0 + 0.3.
        let timeline = vec![
            cut(0, TransitionKind::MatchCut, 0),
            cut(1, TransitionKind::CrossDissolve, 200),
            cut(2, TransitionKind::FadeThroughBlack, 300),
        ];
        for (index, planned) in timeline.iter().enumerate() {
            let source = sources.join(format!("source-{}.mp4", index.min(1)));
            run_tool(
                &ffmpeg,
                &[
                    "-y",
                    "-ss",
                    "0.7",
                    "-t",
                    "2.6",
                    "-i",
                    source.to_str().unwrap(),
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    root.join(&planned.cut_path).to_str().unwrap(),
                ],
            );
        }

        let narration_audio = narration_dir.join("narration.mp3");
        run_tool(
            &ffmpeg,
            &[
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=330:duration=6",
                narration_audio.to_str().unwrap(),
            ],
        );

        // The teeth: after materialization the sources are gone. Task 10's whole
        // point is that the renderer never reaches back to them.
        std::fs::remove_dir_all(&sources).unwrap();
        assert!(!sources.exists());

        let job = JobContext::new_flat("planned-render".to_owned(), root.clone()).unwrap();
        let narration = NarrationTimelineV1 {
            schema_version: 1,
            audio_path: "narration/narration.mp3".to_owned(),
            audio_checksum: "0".repeat(64),
            duration_sec: 6.0,
            words: vec![thoth_types::main_footage::NarrationWordV1 {
                text: "halo".to_owned(),
                start_sec: 1.0,
                end_sec: 1.4,
            }],
            beats: Vec::new(),
            created_at: None,
            fingerprint: None,
        };
        let renderer = PlannedFfmpegRenderer::new(&FfmpegConfig {
            ffmpeg_path: Some(ffmpeg.to_string_lossy().into_owned()),
            nvenc: false,
            cq_value: 28,
            preset: "ultrafast".to_owned(),
            audio_bitrate: "128k".to_owned(),
        });
        let execution = JobExecutionContext::new();
        let result = renderer
            .render_timeline(
                &job,
                &timeline,
                6.0,
                &narration,
                &OutputLayout::Vertical,
                &AudioOptions::default(),
                "thoth",
                "default",
                &execution,
            )
            .await
            .expect("the planned render must succeed from the cuts alone");

        let clip = &result.output_clips[0];
        assert!(clip.path.is_file(), "{}", clip.path.display());
        assert!((clip.duration_secs - 6.0).abs() < 1e-9);

        let report = probe_json(&ffmpeg, &clip.path);
        let rendered = probed_duration(&report);
        assert!(
            (rendered - 6.0).abs() < 0.25,
            "rendered {rendered:.3}s must equal the visible sum (6.0s), not the \
             cut lengths (7.8s): {report}"
        );
        assert!(report.contains("\"video\""), "{report}");
        assert!(report.contains("\"audio\""), "{report}");
        assert!(report.contains("1080"), "{report}");
        assert!(report.contains("1920"), "{report}");

        let _ = std::fs::remove_dir_all(&root);
    }
}
