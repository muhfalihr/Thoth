//! Deterministic FFmpeg graph construction for a verified main-footage plan.
//!
//! Everything in this module is **pure**: no filesystem access, no process spawn,
//! no network. The whole handles/transitions/ambience contract is therefore a
//! function of the plan timeline plus render settings and can be asserted in unit
//! tests without touching media. [`super::planned`] owns the I/O half.
//!
//! ## Coordinate model
//!
//! Scout materialises each cut with its handles baked in, so a cut file is laid
//! out as `[0, before) handle · [before, before+visible) visible · handle`
//! (`main_footage::verify::validate_cut_metadata` enforces exactly this length).
//! The *visible* span is the only part that occupies narration time, which is why
//! the rendered timeline length is `sum(visible)` regardless of how large the
//! handles are.
//!
//! A transition of `d` ms into cut `k` is **centred on the cut point**: cut `k-1`
//! is extended `d/2` into its after-handle and cut `k` starts `d/2` early inside
//! its before-handle, then `xfade` consumes the `d` ms overlap. The merged length
//! is unchanged (`vis[k-1] + vis[k]`), so no later cut — and no narration word —
//! moves. A plain `concat` is used when the transition is (or falls back to)
//! `match_cut`.

use std::path::PathBuf;

use thoth_types::main_footage::{CutHandlesV1, TransitionKind, TransitionV1};

use super::ffmpeg::{HeadlineImage, NORMALIZE, build_cover_overlay, build_headline_png_overlay};
use crate::main_footage::{MainFootageError, MainFootageErrorCode};

/// Approved transition window from the plan's Global Constraints. A duration
/// outside it is not rendered as a transition — it falls back to `match_cut`
/// exactly like an unusable handle does.
pub(crate) const MIN_TRANSITION_MS: u16 = 120;
pub(crate) const MAX_TRANSITION_MS: u16 = 300;

/// Fade applied to the head and tail of every ambience segment. Long enough to
/// kill the click at a concat boundary, short enough to be inaudible.
const MICRO_FADE_SEC: f64 = 0.015;

/// Output frame rate. `xfade` and `concat` both require every input to agree, and
/// cuts come from arbitrary sources, so each segment is resampled here.
const OUTPUT_FPS: u32 = 30;

/// The timeline is contiguous by construction (the durability gate rejects gaps),
/// so a millisecond of slack is all that separates rounding from a real mismatch.
const DURATION_TOLERANCE_SEC: f64 = 0.002;

fn invalid(detail: &'static str) -> MainFootageError {
    MainFootageError::new(MainFootageErrorCode::PlanVerificationFailed, detail)
}

/// One already-resolved timeline item. `cut_path` is a local job-owned file; this
/// type deliberately cannot carry a URL.
#[derive(Debug, Clone)]
pub(crate) struct PlannedGraphItem {
    pub cut_path: PathBuf,
    /// Visible seconds this cut occupies on the narration timeline. Excludes both
    /// handles.
    pub visible_duration_sec: f64,
    pub handles: CutHandlesV1,
    /// The transition *into* this cut, i.e. from its predecessor. Ignored for the
    /// first item, which has no predecessor.
    pub transition: TransitionV1,
    /// Whether the cut file carries an audio stream. Cuts without one contribute
    /// silence so the ambience concat keeps a uniform stream count.
    pub has_audio: bool,
}

/// Everything the graph needs that is not the timeline itself.
#[derive(Debug, Clone)]
pub(crate) struct PlannedGraphRequest {
    pub items: Vec<PlannedGraphItem>,
    pub narration_audio: PathBuf,
    pub narration_duration_sec: f64,
    /// Windows where the narrator is silent; ambience rises to `leak_vol` here and
    /// sits at `duck_vol` everywhere else.
    pub leak_windows: Vec<(f64, f64)>,
    pub duck_vol: f32,
    pub leak_vol: f32,
    /// `AudioOptions::mute_event`: the source stream is suppressed entirely.
    pub mute_source: bool,
    pub width: u32,
    pub height: u32,
    pub bgm: Option<(PathBuf, f32)>,
    pub sfx_intro: Option<PathBuf>,
    pub hook_title_png: Option<HeadlineImage>,
    pub cover: Option<HeadlineImage>,
    /// `(codec, extra args)` as produced by `edit::ffmpeg::build_encoder`.
    pub encoder: (String, Vec<String>),
    pub audio_bitrate: String,
    pub output: PathBuf,
}

/// The constructed command plus the facts tests assert on.
#[derive(Debug, Clone)]
pub(crate) struct PlannedGraph {
    pub args: Vec<String>,
    pub filter: String,
    /// `-i` operands in order. Cut inputs come first, in timeline order.
    pub input_paths: Vec<PathBuf>,
    /// `sum(visible)` — the rendered length.
    pub total_duration_sec: f64,
    /// Transition actually rendered into each item after fallback. Index 0 is
    /// always `MatchCut` (no predecessor).
    pub transitions: Vec<TransitionKind>,
}

/// Resolve the transition rendered into each item, applying the plan's
/// `transition_fallback` rule: an out-of-range duration or a handle too short on
/// either side degrades to `match_cut` rather than borrowing visible frames.
pub(crate) fn effective_transitions(items: &[PlannedGraphItem]) -> Vec<TransitionKind> {
    let mut resolved = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        if index == 0 || item.transition.kind == TransitionKind::MatchCut {
            resolved.push(TransitionKind::MatchCut);
            continue;
        }
        let duration_ms = item.transition.duration_ms;
        let previous = &items[index - 1];
        let usable = (MIN_TRANSITION_MS..=MAX_TRANSITION_MS).contains(&duration_ms)
            && previous.handles.after_ms >= duration_ms
            && item.handles.before_ms >= duration_ms;
        resolved.push(if usable {
            item.transition.kind
        } else {
            TransitionKind::MatchCut
        });
    }
    resolved
}

/// Half the overlap each side of a cut point contributes, in seconds.
fn overlap_sec(kind: TransitionKind, duration_ms: u16) -> f64 {
    if kind == TransitionKind::MatchCut {
        0.0
    } else {
        f64::from(duration_ms) / 2000.0
    }
}

fn xfade_name(kind: TransitionKind) -> &'static str {
    match kind {
        TransitionKind::CrossDissolve => "fade",
        TransitionKind::FadeThroughBlack => "fadeblack",
        // Never reached: match cuts take the concat branch.
        TransitionKind::MatchCut => "fade",
    }
}

/// Ambience gain expression: `duck_vol` while the narrator speaks, rising to
/// `leak_vol` — the ceiling — inside a narration gap. Commas inside a filtergraph
/// expression must be escaped, matching `edit::ffmpeg`'s legacy narrator chain.
fn ambience_volume(duck_vol: f32, leak_vol: f32, leak_windows: &[(f64, f64)]) -> String {
    let duck = duck_vol.clamp(0.0, 1.0);
    if leak_windows.is_empty() {
        return format!("volume={duck:.3}");
    }
    let leak = leak_vol.clamp(duck, 1.0);
    let condition = leak_windows
        .iter()
        .map(|(start, end)| format!("between(t\\,{start:.2}\\,{end:.2})"))
        .collect::<Vec<_>>()
        .join("+");
    format!("volume='if(gt({condition}\\,0)\\,{leak:.3}\\,{duck:.3})':eval=frame")
}

/// Build the complete FFmpeg argument vector for one planned timeline.
pub(crate) fn build_planned_graph(
    request: &PlannedGraphRequest,
) -> Result<PlannedGraph, MainFootageError> {
    if request.items.is_empty() {
        return Err(invalid("planned_timeline_empty"));
    }
    if request.width == 0 || request.height == 0 {
        return Err(invalid("planned_layout_invalid"));
    }
    for item in &request.items {
        if !item.visible_duration_sec.is_finite() || item.visible_duration_sec <= 0.0 {
            return Err(invalid("planned_cut_duration_invalid"));
        }
    }

    let transitions = effective_transitions(&request.items);
    let overlaps: Vec<f64> = request
        .items
        .iter()
        .zip(&transitions)
        .map(|(item, kind)| overlap_sec(*kind, item.transition.duration_ms))
        .collect();

    let total_duration_sec: f64 = request
        .items
        .iter()
        .map(|item| item.visible_duration_sec)
        .sum();
    if (total_duration_sec - request.narration_duration_sec).abs() > DURATION_TOLERANCE_SEC {
        return Err(invalid("planned_timeline_narration_mismatch"));
    }

    // ── Inputs ────────────────────────────────────────────────────────────────
    // Cut inputs first, strictly in timeline order: a recurring source appears
    // once per use because a filter pad can only be consumed once, and the render
    // order must never depend on filesystem or lexical ordering.
    let mut args: Vec<String> = vec!["-y".into()];
    let mut input_paths: Vec<PathBuf> = Vec::new();
    for item in &request.items {
        args.push("-i".into());
        args.push(item.cut_path.to_string_lossy().into_owned());
        input_paths.push(item.cut_path.clone());
    }

    let render_ambience = !request.mute_source;
    // A cut with no audio stream gets its own `anullsrc`; one lavfi input cannot
    // feed several chains without an explicit split, and silence is free.
    let mut silence_index = Vec::new();
    if render_ambience {
        for item in &request.items {
            if item.has_audio {
                silence_index.push(None);
                continue;
            }
            silence_index.push(Some(input_paths.len()));
            args.extend([
                "-f".into(),
                "lavfi".into(),
                "-t".into(),
                format!("{:.3}", item.visible_duration_sec),
                "-i".into(),
                "anullsrc=r=48000:cl=stereo".into(),
            ]);
            input_paths.push(PathBuf::from("anullsrc"));
        }
    }

    let narration_input = input_paths.len();
    args.push("-i".into());
    args.push(request.narration_audio.to_string_lossy().into_owned());
    input_paths.push(request.narration_audio.clone());

    let bgm_input = request.bgm.as_ref().map(|(path, _)| {
        let index = input_paths.len();
        // BGM is usually shorter than the timeline; loop it and bound it by atrim.
        args.extend([
            "-stream_loop".into(),
            "-1".into(),
            "-i".into(),
            path.to_string_lossy().into_owned(),
        ]);
        input_paths.push(path.clone());
        index
    });

    let sfx_input = request.sfx_intro.as_ref().map(|path| {
        let index = input_paths.len();
        args.push("-i".into());
        args.push(path.to_string_lossy().into_owned());
        input_paths.push(path.clone());
        index
    });

    let hook_input = request.hook_title_png.as_ref().map(|hook| {
        let index = input_paths.len();
        args.extend([
            "-loop".into(),
            "1".into(),
            "-i".into(),
            hook.path.to_string_lossy().into_owned(),
        ]);
        input_paths.push(hook.path.clone());
        index
    });

    let cover_input = request.cover.as_ref().map(|cover| {
        let index = input_paths.len();
        args.extend([
            "-loop".into(),
            "1".into(),
            "-i".into(),
            cover.path.to_string_lossy().into_owned(),
        ]);
        input_paths.push(cover.path.clone());
        index
    });

    // ── Video: one normalized segment per cut, then the transition chain ──────
    let (width, height) = (request.width, request.height);
    let mut filter = String::new();
    for (index, item) in request.items.iter().enumerate() {
        let handle_before = f64::from(item.handles.before_ms) / 1000.0;
        let segment_start = handle_before - overlaps[index];
        let segment_end = handle_before
            + item.visible_duration_sec
            + overlaps.get(index + 1).copied().unwrap_or(0.0);
        if !filter.is_empty() {
            filter.push(';');
        }
        filter.push_str(&format!(
            "[{index}:v]trim=start={segment_start:.4}:end={segment_end:.4},\
             setpts=PTS-STARTPTS,\
             scale={width}:{height}:force_original_aspect_ratio=decrease,\
             pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={OUTPUT_FPS},\
             format=yuv420p[v{index}]"
        ));
    }

    let mut accumulated = "v0".to_owned();
    let mut visible_before = request.items[0].visible_duration_sec;
    for index in 1..request.items.len() {
        let label = format!("m{index}");
        if overlaps[index] > 0.0 {
            let duration = overlaps[index] * 2.0;
            // The overlap straddles the cut point, so the merged stream keeps the
            // exact visible length and every later offset stays put.
            let offset = visible_before - overlaps[index];
            let name = xfade_name(transitions[index]);
            filter.push_str(&format!(
                ";[{accumulated}][v{index}]xfade=transition={name}:\
                 duration={duration:.3}:offset={offset:.3}[{label}]"
            ));
        } else {
            filter.push_str(&format!(
                ";[{accumulated}][v{index}]concat=n=2:v=1:a=0[{label}]"
            ));
        }
        accumulated = label;
        visible_before += request.items[index].visible_duration_sec;
    }

    // Overlays sit on top of the finished timeline and are time-bounded by their
    // own `enable` windows, so they can never change the rendered length.
    let mut video_label = format!("{accumulated}");
    if let (Some(index), Some(hook)) = (hook_input, request.hook_title_png.as_ref()) {
        filter.push(';');
        filter.push_str(&build_headline_png_overlay(index, hook, &video_label, "vhook"));
        video_label = "vhook".to_owned();
    }
    if let (Some(index), Some(cover)) = (cover_input, request.cover.as_ref()) {
        filter.push(';');
        filter.push_str(&build_cover_overlay(
            index,
            cover,
            width,
            height,
            &video_label,
            "vcover",
        ));
        video_label = "vcover".to_owned();
    }
    filter.push_str(&format!(";[{video_label}]setpts=PTS-STARTPTS[outv]"));

    // ── Audio: narration spine, ducked ambience, then the existing BGM/SFX ────
    filter.push_str(&format!(
        ";[{narration_input}:a]{NORMALIZE},afade=t=in:st=0:d=0.15[voice]"
    ));

    let mut mix_labels: Vec<String> = vec!["[voice]".into()];

    if render_ambience {
        for (index, item) in request.items.iter().enumerate() {
            let fade_out = (item.visible_duration_sec - MICRO_FADE_SEC).max(0.0);
            let source = match silence_index[index] {
                Some(silence) => format!("[{silence}:a]atrim=duration={:.4}", item.visible_duration_sec),
                None => {
                    let start = f64::from(item.handles.before_ms) / 1000.0;
                    let end = start + item.visible_duration_sec;
                    format!("[{index}:a]atrim=start={start:.4}:end={end:.4}")
                }
            };
            filter.push_str(&format!(
                ";{source},asetpts=PTS-STARTPTS,{NORMALIZE},\
                 afade=t=in:st=0:d={MICRO_FADE_SEC:.3},\
                 afade=t=out:st={fade_out:.4}:d={MICRO_FADE_SEC:.3}[a{index}]"
            ));
        }
        let concat_inputs: String = (0..request.items.len())
            .map(|index| format!("[a{index}]"))
            .collect();
        let count = request.items.len();
        filter.push_str(&format!(
            ";{concat_inputs}concat=n={count}:v=0:a=1[amb_raw]"
        ));
        filter.push_str(&format!(
            ";[amb_raw]loudnorm=I=-24:TP=-2.0:LRA=7,{}[amb]",
            ambience_volume(request.duck_vol, request.leak_vol, &request.leak_windows)
        ));
        mix_labels.push("[amb]".into());
    }

    if let Some(index) = sfx_input {
        let sfx_duration = 2.5_f64.min(total_duration_sec);
        let fade_out = (sfx_duration - 0.5).max(0.1);
        filter.push_str(&format!(
            ";[{index}:a]{NORMALIZE},atrim=duration={sfx_duration:.3},\
             asetpts=PTS-STARTPTS,apad=pad_dur={total_duration_sec:.3},\
             afade=t=in:st=0:d=0.200,afade=t=out:st={fade_out:.3}:d=0.500,\
             volume=0.80[sfx_out]"
        ));
        mix_labels.push("[sfx_out]".into());
    }

    if let (Some(index), Some((_, volume))) = (bgm_input, request.bgm.as_ref()) {
        filter.push_str(&format!(
            ";[{index}:a]{NORMALIZE},atrim=duration={total_duration_sec:.3},\
             asetpts=PTS-STARTPTS,volume={volume:.4}[bgm_out]"
        ));
        mix_labels.push("[bgm_out]".into());
    }

    if mix_labels.len() > 1 {
        let count = mix_labels.len();
        filter.push_str(&format!(
            ";{}amix=inputs={count}:duration=first:normalize=0:weights='{}'[outa]",
            mix_labels.concat(),
            "1 ".repeat(count).trim_end()
        ));
    } else {
        filter.push_str(";[voice]aformat=sample_fmts=fltp:channel_layouts=stereo[outa]");
    }

    let (codec, encoder_args) = &request.encoder;
    args.extend([
        "-filter_complex".into(),
        filter.clone(),
        "-map".into(),
        "[outv]".into(),
        "-map".into(),
        "[outa]".into(),
        "-t".into(),
        format!("{total_duration_sec:.3}"),
        "-c:v".into(),
        codec.clone(),
    ]);
    args.extend(encoder_args.iter().cloned());
    args.extend([
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        request.audio_bitrate.clone(),
        "-ac".into(),
        "2".into(),
        "-movflags".into(),
        "+faststart".into(),
        request.output.to_string_lossy().into_owned(),
    ]);

    Ok(PlannedGraph {
        args,
        filter,
        input_paths,
        total_duration_sec,
        transitions,
    })
}

/// Narration gaps long enough for the ambience to breathe through. Derived from
/// the immutable narration words, so the ceiling windows are a property of the
/// timeline rather than of any render setting.
pub(crate) fn leak_windows_from_words(
    words: &[thoth_types::main_footage::NarrationWordV1],
    duration_sec: f64,
    minimum_gap_sec: f64,
) -> Vec<(f64, f64)> {
    let mut windows = Vec::new();
    let mut cursor = 0.0_f64;
    for word in words {
        if word.start_sec - cursor >= minimum_gap_sec {
            windows.push((cursor, word.start_sec));
        }
        cursor = cursor.max(word.end_sec);
    }
    if duration_sec - cursor >= minimum_gap_sec {
        windows.push((cursor, duration_sec));
    }
    windows
}

#[cfg(test)]
mod tests {
    use super::*;
    use thoth_types::main_footage::NarrationWordV1;

    fn handles(before_ms: u16, after_ms: u16) -> CutHandlesV1 {
        CutHandlesV1 {
            before_ms,
            after_ms,
        }
    }

    fn item(visible: f64, before_ms: u16, after_ms: u16, kind: TransitionKind, ms: u16) -> PlannedGraphItem {
        PlannedGraphItem {
            cut_path: PathBuf::from(format!("cuts/v001/cut-{visible}.mp4")),
            visible_duration_sec: visible,
            handles: handles(before_ms, after_ms),
            transition: TransitionV1 {
                kind,
                duration_ms: ms,
            },
            has_audio: true,
        }
    }

    fn request(items: Vec<PlannedGraphItem>) -> PlannedGraphRequest {
        let narration_duration_sec = items.iter().map(|i| i.visible_duration_sec).sum();
        PlannedGraphRequest {
            items,
            narration_audio: PathBuf::from("narration/narration.mp3"),
            narration_duration_sec,
            leak_windows: Vec::new(),
            duck_vol: 0.25,
            leak_vol: 0.60,
            mute_source: false,
            width: 1080,
            height: 1920,
            bgm: None,
            sfx_intro: None,
            hook_title_png: None,
            cover: None,
            encoder: ("libx264".into(), vec!["-crf".into(), "20".into()]),
            audio_bitrate: "192k".into(),
            output: PathBuf::from("clips/planned.mp4"),
        }
    }

    fn input_operands(graph: &PlannedGraph) -> Vec<String> {
        graph
            .args
            .windows(2)
            .filter(|pair| pair[0] == "-i")
            .map(|pair| pair[1].clone())
            .collect()
    }

    fn output_duration_arg(graph: &PlannedGraph) -> String {
        let position = graph
            .args
            .iter()
            .position(|arg| arg == "-t")
            .expect("graph always bounds the output with -t");
        graph.args[position + 1].clone()
    }

    /// The renderer must follow the plan, not the directory listing. Cut files are
    /// named so that lexical order is the exact reverse of timeline order.
    #[test]
    fn input_order_follows_the_plan_timeline_not_the_filesystem() {
        let mut items = vec![
            item(2.0, 200, 200, TransitionKind::MatchCut, 0),
            item(3.0, 200, 200, TransitionKind::MatchCut, 0),
            item(4.0, 200, 200, TransitionKind::MatchCut, 0),
        ];
        items[0].cut_path = PathBuf::from("cuts/v001/zzz-first.mp4");
        items[1].cut_path = PathBuf::from("cuts/v001/mmm-second.mp4");
        items[2].cut_path = PathBuf::from("cuts/v001/aaa-third.mp4");
        let graph = build_planned_graph(&request(items)).unwrap();
        let operands = input_operands(&graph);
        assert_eq!(
            &operands[..3],
            &[
                "cuts/v001/zzz-first.mp4".to_owned(),
                "cuts/v001/mmm-second.mp4".to_owned(),
                "cuts/v001/aaa-third.mp4".to_owned(),
            ],
            "cut inputs must be emitted in timeline order"
        );
    }

    /// A source may recur; each use is its own input because a filter pad cannot
    /// be consumed twice.
    #[test]
    fn a_reused_cut_gets_one_input_per_use() {
        let mut items = vec![
            item(2.0, 200, 200, TransitionKind::MatchCut, 0),
            item(3.0, 200, 200, TransitionKind::MatchCut, 0),
        ];
        items[1].cut_path = items[0].cut_path.clone();
        let graph = build_planned_graph(&request(items)).unwrap();
        let operands = input_operands(&graph);
        assert_eq!(operands[0], operands[1], "same file used twice");
        assert!(
            graph.filter.contains("[0:v]") && graph.filter.contains("[1:v]"),
            "each use needs its own input pad: {}",
            graph.filter
        );
    }

    /// Handles are transition material, never screen time. Doubling them must not
    /// change the rendered length by a single millisecond.
    #[test]
    fn visible_duration_excludes_handles() {
        let small = build_planned_graph(&request(vec![
            item(2.0, 100, 100, TransitionKind::MatchCut, 0),
            item(3.0, 100, 100, TransitionKind::MatchCut, 0),
        ]))
        .unwrap();
        let large = build_planned_graph(&request(vec![
            item(2.0, 500, 500, TransitionKind::MatchCut, 0),
            item(3.0, 500, 500, TransitionKind::MatchCut, 0),
        ]))
        .unwrap();
        assert_eq!(small.total_duration_sec, 5.0);
        assert_eq!(large.total_duration_sec, 5.0);
        assert_eq!(output_duration_arg(&small), output_duration_arg(&large));
        // The first cut's visible span starts after its own before-handle.
        assert!(
            small.filter.contains("[0:v]trim=start=0.1000:end=2.1000"),
            "{}",
            small.filter
        );
        assert!(
            large.filter.contains("[0:v]trim=start=0.5000:end=2.5000"),
            "{}",
            large.filter
        );
    }

    /// `match_cut` uses no handle material at all — a straight concat.
    #[test]
    fn match_cut_concatenates_without_overlap() {
        let graph = build_planned_graph(&request(vec![
            item(2.0, 300, 300, TransitionKind::MatchCut, 0),
            item(3.0, 300, 300, TransitionKind::MatchCut, 200),
        ]))
        .unwrap();
        assert_eq!(
            graph.transitions,
            vec![TransitionKind::MatchCut, TransitionKind::MatchCut]
        );
        assert!(
            graph.filter.contains("concat=n=2:v=1:a=0"),
            "{}",
            graph.filter
        );
        assert!(!graph.filter.contains("xfade"), "{}", graph.filter);
        assert_eq!(output_duration_arg(&graph), "5.000");
    }

    /// A cross dissolve overlaps `d` centred on the cut point: the predecessor
    /// runs `d/2` into its after-handle, the successor starts `d/2` early, and the
    /// total is unchanged.
    #[test]
    fn cross_dissolve_overlaps_within_handles_without_shifting_the_timeline() {
        let graph = build_planned_graph(&request(vec![
            item(2.0, 300, 300, TransitionKind::MatchCut, 0),
            item(3.0, 300, 300, TransitionKind::CrossDissolve, 200),
        ]))
        .unwrap();
        assert_eq!(
            graph.transitions,
            vec![TransitionKind::MatchCut, TransitionKind::CrossDissolve]
        );
        // predecessor: 0.300 .. 0.300 + 2.0 + 0.100
        assert!(
            graph.filter.contains("[0:v]trim=start=0.3000:end=2.4000"),
            "{}",
            graph.filter
        );
        // successor: 0.300 - 0.100 .. 0.200 + 3.0
        assert!(
            graph.filter.contains("[1:v]trim=start=0.2000:end=3.3000"),
            "{}",
            graph.filter
        );
        assert!(
            graph
                .filter
                .contains("xfade=transition=fade:duration=0.200:offset=1.900"),
            "{}",
            graph.filter
        );
        assert_eq!(output_duration_arg(&graph), "5.000");
    }

    /// Fade through black uses the same bounded overlap with `fadeblack`.
    #[test]
    fn fade_through_black_uses_the_same_bounded_overlap() {
        let graph = build_planned_graph(&request(vec![
            item(2.0, 300, 300, TransitionKind::MatchCut, 0),
            item(3.0, 300, 300, TransitionKind::FadeThroughBlack, 300),
        ]))
        .unwrap();
        assert!(
            graph
                .filter
                .contains("xfade=transition=fadeblack:duration=0.300:offset=1.850"),
            "{}",
            graph.filter
        );
        assert_eq!(output_duration_arg(&graph), "5.000");
    }

    /// Three cuts with transitions: every later offset is the running visible sum
    /// minus that transition's half-overlap, so narration coordinates never drift.
    #[test]
    fn transition_offsets_track_cumulative_visible_time() {
        let graph = build_planned_graph(&request(vec![
            item(2.0, 300, 300, TransitionKind::MatchCut, 0),
            item(3.0, 300, 300, TransitionKind::CrossDissolve, 200),
            item(4.0, 300, 300, TransitionKind::FadeThroughBlack, 300),
        ]))
        .unwrap();
        assert!(
            graph
                .filter
                .contains("xfade=transition=fade:duration=0.200:offset=1.900"),
            "{}",
            graph.filter
        );
        // 2.0 + 3.0 visible so far, minus 0.150 half-overlap.
        assert!(
            graph
                .filter
                .contains("xfade=transition=fadeblack:duration=0.300:offset=4.850"),
            "{}",
            graph.filter
        );
        assert_eq!(output_duration_arg(&graph), "9.000");
    }

    /// Absent handles take the recorded fallback: `match_cut`.
    #[test]
    fn insufficient_handles_fall_back_to_match_cut() {
        let missing_before = build_planned_graph(&request(vec![
            item(2.0, 300, 300, TransitionKind::MatchCut, 0),
            item(3.0, 100, 300, TransitionKind::CrossDissolve, 200),
        ]))
        .unwrap();
        assert_eq!(missing_before.transitions[1], TransitionKind::MatchCut);
        assert!(!missing_before.filter.contains("xfade"));

        let missing_after = build_planned_graph(&request(vec![
            item(2.0, 300, 100, TransitionKind::MatchCut, 0),
            item(3.0, 300, 300, TransitionKind::CrossDissolve, 200),
        ]))
        .unwrap();
        assert_eq!(missing_after.transitions[1], TransitionKind::MatchCut);
        assert!(!missing_after.filter.contains("xfade"));
    }

    /// Durations outside the approved 120..=300 ms window are not rendered.
    #[test]
    fn out_of_range_transition_durations_fall_back_to_match_cut() {
        for duration_ms in [0_u16, 119, 301, 5_000] {
            let graph = build_planned_graph(&request(vec![
                item(2.0, 6_000, 6_000, TransitionKind::MatchCut, 0),
                item(3.0, 6_000, 6_000, TransitionKind::CrossDissolve, duration_ms),
            ]))
            .unwrap();
            assert_eq!(
                graph.transitions[1],
                TransitionKind::MatchCut,
                "{duration_ms}ms is outside the approved window"
            );
        }
        let inside = build_planned_graph(&request(vec![
            item(2.0, 6_000, 6_000, TransitionKind::MatchCut, 0),
            item(3.0, 6_000, 6_000, TransitionKind::CrossDissolve, 120),
        ]))
        .unwrap();
        assert_eq!(inside.transitions[1], TransitionKind::CrossDissolve);
    }

    /// The first cut has no predecessor, so whatever transition it records is not
    /// rendered — there is nothing to dissolve from.
    #[test]
    fn the_first_cut_never_renders_a_transition() {
        let graph = build_planned_graph(&request(vec![
            item(2.0, 300, 300, TransitionKind::CrossDissolve, 200),
            item(3.0, 300, 300, TransitionKind::MatchCut, 0),
        ]))
        .unwrap();
        assert_eq!(graph.transitions[0], TransitionKind::MatchCut);
        assert!(!graph.filter.contains("xfade"), "{}", graph.filter);
        assert!(
            graph.filter.contains("[0:v]trim=start=0.3000:end=2.3000"),
            "{}",
            graph.filter
        );
    }

    /// Source audio is normalized, micro-faded at both seams, and ducked under the
    /// narration spine — which is itself the first, length-defining mix input.
    #[test]
    fn source_audio_is_normalized_micro_faded_and_ducked_under_narration() {
        let graph = build_planned_graph(&request(vec![
            item(2.0, 300, 300, TransitionKind::MatchCut, 0),
            item(3.0, 300, 300, TransitionKind::MatchCut, 0),
        ]))
        .unwrap();
        assert!(
            graph.filter.contains("[0:a]atrim=start=0.3000:end=2.3000"),
            "{}",
            graph.filter
        );
        assert!(graph.filter.contains(NORMALIZE), "{}", graph.filter);
        assert!(
            graph.filter.contains("afade=t=in:st=0:d=0.015"),
            "{}",
            graph.filter
        );
        assert!(
            graph.filter.contains("afade=t=out:st=1.9850:d=0.015"),
            "{}",
            graph.filter
        );
        assert!(graph.filter.contains("loudnorm="), "{}", graph.filter);
        assert!(graph.filter.contains("[amb_raw]"), "{}", graph.filter);
        assert!(graph.filter.contains("volume=0.250[amb]"), "{}", graph.filter);
        assert!(
            graph.filter.contains("[voice][amb]amix=inputs=2"),
            "{}",
            graph.filter
        );
    }

    /// In a narration gap the ambience rises — but only to the configured ceiling,
    /// never back to unity.
    #[test]
    fn narration_gaps_rise_only_to_the_ambience_ceiling() {
        let mut plan = request(vec![
            item(2.0, 300, 300, TransitionKind::MatchCut, 0),
            item(3.0, 300, 300, TransitionKind::MatchCut, 0),
        ]);
        plan.leak_windows = vec![(1.0, 1.8)];
        plan.duck_vol = 0.20;
        plan.leak_vol = 0.55;
        let graph = build_planned_graph(&plan).unwrap();
        assert!(
            graph.filter.contains(
                "volume='if(gt(between(t\\,1.00\\,1.80)\\,0)\\,0.550\\,0.200)':eval=frame"
            ),
            "{}",
            graph.filter
        );
    }

    /// A ceiling below the duck floor would make gaps quieter than speech; it is
    /// clamped up to the floor instead.
    #[test]
    fn the_ambience_ceiling_never_drops_below_the_duck_floor() {
        let mut plan = request(vec![item(2.0, 300, 300, TransitionKind::MatchCut, 0)]);
        plan.leak_windows = vec![(0.5, 1.0)];
        plan.duck_vol = 0.40;
        plan.leak_vol = 0.10;
        let graph = build_planned_graph(&plan).unwrap();
        assert!(
            graph.filter.contains("\\,0.400\\,0.400)"),
            "{}",
            graph.filter
        );
    }

    /// A cut whose file carries no audio stream contributes silence, so the
    /// ambience concat keeps one stream per timeline item.
    #[test]
    fn silent_cuts_contribute_generated_silence() {
        let mut items = vec![
            item(2.0, 300, 300, TransitionKind::MatchCut, 0),
            item(3.0, 300, 300, TransitionKind::MatchCut, 0),
        ];
        items[1].has_audio = false;
        let graph = build_planned_graph(&request(items)).unwrap();
        assert!(
            graph.args.iter().any(|arg| arg == "anullsrc=r=48000:cl=stereo"),
            "{:?}",
            graph.args
        );
        assert!(
            graph.filter.contains("[2:a]atrim=duration=3.0000"),
            "{}",
            graph.filter
        );
        assert!(
            graph.filter.contains("[a0][a1]concat=n=2:v=0:a=1[amb_raw]"),
            "{}",
            graph.filter
        );
    }

    /// The muted-safety flag suppresses the source stream entirely: no ambience
    /// chain, no silence inputs, narration alone.
    #[test]
    fn muted_safety_metadata_suppresses_the_source_stream() {
        let mut plan = request(vec![
            item(2.0, 300, 300, TransitionKind::MatchCut, 0),
            item(3.0, 300, 300, TransitionKind::MatchCut, 0),
        ]);
        plan.mute_source = true;
        let graph = build_planned_graph(&plan).unwrap();
        assert!(!graph.filter.contains("[amb]"), "{}", graph.filter);
        assert!(!graph.filter.contains("loudnorm"), "{}", graph.filter);
        assert!(!graph.filter.contains("[0:a]"), "{}", graph.filter);
        assert!(
            graph
                .filter
                .contains("[voice]aformat=sample_fmts=fltp:channel_layouts=stereo[outa]"),
            "{}",
            graph.filter
        );
        assert_eq!(output_duration_arg(&graph), "5.000");
    }

    /// Muting the source must not silence the music bed or the stinger.
    #[test]
    fn bgm_and_sfx_remain_in_the_final_mix() {
        let mut plan = request(vec![
            item(2.0, 300, 300, TransitionKind::MatchCut, 0),
            item(3.0, 300, 300, TransitionKind::MatchCut, 0),
        ]);
        plan.bgm = Some((PathBuf::from("assets/bed.mp3"), 0.12));
        plan.sfx_intro = Some(PathBuf::from("assets/whoosh.wav"));
        let graph = build_planned_graph(&plan).unwrap();
        assert!(graph.filter.contains("[bgm_out]"), "{}", graph.filter);
        assert!(graph.filter.contains("volume=0.1200[bgm_out]"), "{}", graph.filter);
        assert!(graph.filter.contains("[sfx_out]"), "{}", graph.filter);
        assert!(
            graph
                .filter
                .contains("[voice][amb][sfx_out][bgm_out]amix=inputs=4"),
            "{}",
            graph.filter
        );

        plan.mute_source = true;
        let muted = build_planned_graph(&plan).unwrap();
        assert!(
            muted.filter.contains("[voice][sfx_out][bgm_out]amix=inputs=3"),
            "{}",
            muted.filter
        );
        assert_eq!(output_duration_arg(&muted), "5.000");
    }

    /// Overlays are additive layers with their own enable windows; adding them
    /// changes the input list and the video chain, never the coverage duration.
    #[test]
    fn overlays_do_not_change_coverage_duration() {
        let base = request(vec![
            item(2.0, 300, 300, TransitionKind::MatchCut, 0),
            item(3.0, 300, 300, TransitionKind::MatchCut, 0),
        ]);
        let plain = build_planned_graph(&base).unwrap();

        let mut decorated = base.clone();
        decorated.hook_title_png = Some(HeadlineImage {
            path: PathBuf::from("overlays/hook.png"),
            duration_sec: 1.5,
        });
        decorated.cover = Some(HeadlineImage {
            path: PathBuf::from("overlays/cover.png"),
            duration_sec: 2.0,
        });
        let overlaid = build_planned_graph(&decorated).unwrap();

        assert_eq!(plain.total_duration_sec, overlaid.total_duration_sec);
        assert_eq!(output_duration_arg(&plain), output_duration_arg(&overlaid));
        assert!(overlaid.filter.contains("[vhook]"), "{}", overlaid.filter);
        assert!(overlaid.filter.contains("[vcover]"), "{}", overlaid.filter);
        assert!(
            overlaid.filter.contains("[vcover]setpts=PTS-STARTPTS[outv]"),
            "{}",
            overlaid.filter
        );
        assert!(
            overlaid.input_paths.len() == plain.input_paths.len() + 2,
            "overlays add exactly their own inputs"
        );
    }

    /// A timeline whose visible sum disagrees with the narration length would move
    /// every downstream word; the graph refuses to build it.
    #[test]
    fn a_timeline_that_disagrees_with_narration_is_rejected() {
        let mut plan = request(vec![item(2.0, 300, 300, TransitionKind::MatchCut, 0)]);
        plan.narration_duration_sec = 2.5;
        let error = build_planned_graph(&plan).unwrap_err();
        assert_eq!(error.detail, "planned_timeline_narration_mismatch");
    }

    #[test]
    fn an_empty_timeline_is_rejected() {
        let error = build_planned_graph(&request(Vec::new())).unwrap_err();
        assert_eq!(error.detail, "planned_timeline_empty");
        assert_eq!(
            error.code,
            MainFootageErrorCode::PlanVerificationFailed
        );
    }

    #[test]
    fn leak_windows_are_derived_from_narration_pauses() {
        let words = vec![
            NarrationWordV1 {
                text: "satu".into(),
                start_sec: 1.2,
                end_sec: 1.6,
            },
            NarrationWordV1 {
                text: "dua".into(),
                start_sec: 3.0,
                end_sec: 3.4,
            },
        ];
        let windows = leak_windows_from_words(&words, 5.0, 0.6);
        assert_eq!(windows, vec![(0.0, 1.2), (1.6, 3.0), (3.4, 5.0)]);
        // A tighter gap threshold than the pause leaves no window at all.
        assert!(leak_windows_from_words(&words, 3.4, 2.0).is_empty());
    }
}
