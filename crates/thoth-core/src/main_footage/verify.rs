//! Durability validation for Scout-published narration-aligned footage plans.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use anyhow::Result;
use async_trait::async_trait;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::execution::JobExecutionContext;
use thoth_types::main_footage::{
    MainFootageErrorCode, MainFootagePlanV1, MainFootageWarningCode, NarrationTimelineV1,
    PlannedCutV1, PlanningMode, SourcePackageV1, fingerprint_canonical,
};

use crate::main_footage::{ImportedSourcePackage, MainFootageError};
use crate::pipeline::job::JobContext;

#[derive(Debug, Clone)]
pub(crate) struct MediaMetadata {
    duration_sec: f64,
    container: String,
    video_codec: String,
    width: u32,
    height: u32,
    has_audio: bool,
    frame_rate: f64,
}

#[async_trait]
pub(crate) trait MediaProbe: Sync {
    async fn probe(&self, path: &Path) -> Result<MediaMetadata>;
}

pub(crate) struct SupervisedFfprobe<'a> {
    execution: &'a JobExecutionContext,
}

impl<'a> SupervisedFfprobe<'a> {
    pub(crate) fn new(execution: &'a JobExecutionContext) -> Self {
        Self { execution }
    }
}

#[derive(Deserialize)]
struct FfprobeEnvelope {
    format: FfprobeFormat,
    #[serde(default)]
    streams: Vec<FfprobeStream>,
}

#[derive(Deserialize)]
struct FfprobeFormat {
    duration: String,
    format_name: String,
}

#[derive(Deserialize)]
struct FfprobeStream {
    codec_type: String,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
}

fn ffprobe_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("THOTH_FFPROBE") {
        return PathBuf::from(path);
    }
    if let Some(ffmpeg) = std::env::var_os("FFMPEG_PATH") {
        return PathBuf::from(ffmpeg).with_file_name(if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        });
    }
    ffmpeg_sidecar::paths::ffmpeg_path().with_file_name(if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    })
}

fn parse_frame_rate(value: Option<&str>) -> Option<f64> {
    let value = value?;
    let parsed = if let Some((numerator, denominator)) = value.split_once('/') {
        numerator.parse::<f64>().ok()? / denominator.parse::<f64>().ok()?
    } else {
        value.parse::<f64>().ok()?
    };
    (parsed.is_finite() && parsed > 0.0).then_some(parsed)
}

fn decode_ffprobe_metadata(stdout: &[u8]) -> Result<MediaMetadata> {
    let decoded: FfprobeEnvelope = serde_json::from_slice(stdout)?;
    let video = decoded
        .streams
        .iter()
        .find(|stream| stream.codec_type == "video")
        .ok_or_else(|| anyhow::anyhow!("ffprobe_video_stream_missing"))?;
    let frame_rate = parse_frame_rate(video.r_frame_rate.as_deref())
        .ok_or_else(|| anyhow::anyhow!("ffprobe_frame_rate_invalid"))?;
    Ok(MediaMetadata {
        duration_sec: decoded.format.duration.parse()?,
        container: decoded.format.format_name,
        video_codec: video.codec_name.clone().unwrap_or_default(),
        width: video.width.unwrap_or_default(),
        height: video.height.unwrap_or_default(),
        has_audio: decoded
            .streams
            .iter()
            .any(|stream| stream.codec_type == "audio"),
        frame_rate,
    })
}

#[async_trait]
impl MediaProbe for SupervisedFfprobe<'_> {
    async fn probe(&self, path: &Path) -> Result<MediaMetadata> {
        let mut command = Command::new(ffprobe_binary());
        command.args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_entries",
            "format=duration,format_name:stream=codec_type,codec_name,width,height,r_frame_rate",
        ]);
        command.arg(path);
        let output = self.execution.output(&mut command).await?;
        if !output.status.success() {
            anyhow::bail!("ffprobe_failed");
        }
        decode_ffprobe_metadata(&output.stdout)
    }
}

/// Deterministically recomputed plan metrics retained beside the opaque plan.
#[derive(Debug, Clone)]
pub struct MainFootagePlanMetrics {
    pub planning_mode: PlanningMode,
    pub coverage_target: f64,
    pub main_coverage_sec: f64,
    pub main_coverage_ratio: f64,
    pub total_duration_sec: f64,
    pub selected_cut_count: u32,
    pub candidate_count: u32,
    pub transition_distribution: BTreeMap<String, u32>,
}

/// A plan that has passed the Rust durability boundary. All fields are private:
/// callers can inspect it, but only this module can construct it.
#[derive(Debug, Clone)]
pub struct VerifiedMainFootagePlan {
    plan: MainFootagePlanV1,
    narration_duration_sec: f64,
    metrics: MainFootagePlanMetrics,
    version: String,
    plan_path: PathBuf,
    retained_bytes: u64,
}

impl VerifiedMainFootagePlan {
    pub fn timeline(&self) -> &[PlannedCutV1] {
        &self.plan.timeline
    }

    pub fn narration_duration_sec(&self) -> f64 {
        self.narration_duration_sec
    }

    pub fn warnings(&self) -> &[MainFootageWarningCode] {
        &self.plan.warnings
    }

    pub fn metrics(&self) -> &MainFootagePlanMetrics {
        &self.metrics
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn plan_path(&self) -> &Path {
        &self.plan_path
    }

    pub fn retained_bytes(&self) -> u64 {
        self.retained_bytes
    }

    pub fn source_package_fingerprint(&self) -> &str {
        &self.plan.source_package_fingerprint
    }

    pub fn narration_fingerprint(&self) -> &str {
        &self.plan.narration_fingerprint
    }

    pub fn plan_fingerprint(&self) -> &str {
        self.plan
            .fingerprint
            .as_deref()
            .expect("verified plans always retain their checked fingerprint")
    }
}

fn invalid(detail: &'static str) -> anyhow::Error {
    MainFootageError::new(MainFootageErrorCode::PlanVerificationFailed, detail).into()
}

fn probe_failed(error: anyhow::Error) -> anyhow::Error {
    if crate::execution::is_cancelled(&error) {
        error
    } else {
        invalid("ffprobe_failed")
    }
}

fn canonical_job_root(job: &JobContext) -> Result<PathBuf> {
    fs::canonicalize(job.root()).map_err(|_| invalid("job_root_unreadable"))
}

fn canonical_file(root: &Path, path: &Path) -> Result<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(|_| invalid("declared_artifact_missing"))?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err(invalid("declared_artifact_outside_job_root"));
    }
    Ok(canonical)
}

fn relative_artifact(root: &Path, path: &Path) -> Result<String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| invalid("declared_artifact_outside_job_root"))?;
    let rendered = relative.to_string_lossy().replace('\\', "/");
    if rendered.is_empty() {
        return Err(invalid("artifact_path_must_be_relative"));
    }
    Ok(rendered)
}

fn file_bytes(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|_| invalid("declared_artifact_unreadable"))
}

fn checksum(bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(bytes);
    format!("sha256:{:x}", hash.finalize())
}

const HASH_BUFFER_BYTES: usize = 64 * 1024;

fn checksum_reader<R: Read>(reader: R) -> std::io::Result<(String, u64)> {
    let mut reader = BufReader::with_capacity(HASH_BUFFER_BYTES, reader);
    let mut buffer = [0_u8; HASH_BUFFER_BYTES];
    let mut hash = Sha256::new();
    let mut bytes_read = 0_u64;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        bytes_read += count as u64;
    }
    Ok((format!("sha256:{:x}", hash.finalize()), bytes_read))
}

fn checksum_file(path: &Path) -> Result<(String, u64)> {
    let file = fs::File::open(path).map_err(|_| invalid("declared_artifact_unreadable"))?;
    let retained_bytes = file
        .metadata()
        .map_err(|_| invalid("declared_artifact_unreadable"))?
        .len();
    let (checksum, bytes_read) =
        checksum_reader(file).map_err(|_| invalid("declared_artifact_unreadable"))?;
    if bytes_read != retained_bytes {
        return Err(invalid("declared_artifact_changed_during_verification"));
    }
    Ok((checksum, retained_bytes))
}

fn retained_file_bytes(path: &Path) -> Result<u64> {
    fs::File::open(path)
        .and_then(|file| file.metadata())
        .map(|metadata| metadata.len())
        .map_err(|_| invalid("declared_artifact_unreadable"))
}

fn milliseconds(seconds: f64) -> Result<i64> {
    if !seconds.is_finite() || seconds < 0.0 || seconds > i64::MAX as f64 / 1000.0 {
        return Err(invalid("timeline_value_invalid"));
    }
    Ok((seconds * 1000.0).round() as i64)
}

const MIN_VISIBLE_CUT_MS: i64 = 1_500;
const MAX_VISIBLE_CUT_MS: i64 = 6_000;

fn validate_timeline_coverage(
    plan: &MainFootagePlanV1,
    narration: &NarrationTimelineV1,
) -> Result<()> {
    if plan.timeline.is_empty() {
        return Err(invalid("timeline_empty"));
    }
    if narration.beats.is_empty()
        || milliseconds(narration.beats[0].start_sec)? != 0
        || milliseconds(narration.beats.last().unwrap().end_sec)?
            != milliseconds(narration.duration_sec)?
    {
        return Err(invalid("narration_beats_incomplete"));
    }
    let mut cursor_ms = 0_i64;
    for cut in &plan.timeline {
        let start_ms = milliseconds(cut.output_start_sec)?;
        let end_ms = milliseconds(cut.output_end_sec)?;
        if start_ms != cursor_ms || end_ms <= start_ms {
            return Err(invalid("timeline_not_contiguous"));
        }
        let within_one_beat = narration.beats.iter().any(|beat| {
            let Ok(beat_start_ms) = milliseconds(beat.start_sec) else {
                return false;
            };
            let Ok(beat_end_ms) = milliseconds(beat.end_sec) else {
                return false;
            };
            start_ms >= beat_start_ms && end_ms <= beat_end_ms
        });
        if !within_one_beat {
            return Err(invalid("timeline_beat_mismatch"));
        }
        cursor_ms = end_ms;
    }
    if cursor_ms != milliseconds(narration.duration_sec)? {
        return Err(invalid("timeline_duration_mismatch"));
    }
    Ok(())
}

fn validate_source_bindings(plan: &MainFootagePlanV1, package: &SourcePackageV1) -> Result<()> {
    let package_parent = Path::new(&plan.source_package_path)
        .parent()
        .ok_or_else(|| invalid("source_package_path_invalid"))?;
    for cut in &plan.timeline {
        let source = package
            .sources
            .iter()
            .find(|source| source.id == cut.source_id)
            .ok_or_else(|| invalid("cut_source_unknown"))?;
        if Path::new(&cut.source_path) != package_parent.join(&source.path) {
            return Err(invalid("cut_source_path_mismatch"));
        }
        let source_start_ms = milliseconds(cut.source_start_sec)?;
        let source_end_ms = milliseconds(cut.source_end_sec)?;
        let output_duration_ms =
            milliseconds(cut.output_end_sec)? - milliseconds(cut.output_start_sec)?;
        if source_end_ms <= source_start_ms
            || source_end_ms > milliseconds(source.technical.duration_sec)?
            || source_end_ms - source_start_ms != output_duration_ms
            || !(MIN_VISIBLE_CUT_MS..=MAX_VISIBLE_CUT_MS).contains(&output_duration_ms)
        {
            return Err(invalid("cut_source_range_invalid"));
        }
        let index = package
            .scene_indexes
            .iter()
            .find(|index| index.source_id == cut.source_id)
            .ok_or_else(|| invalid("cut_scene_index_unknown"))?;
        let declared_scene = index.scenes.iter().find(|scene| {
            let Ok(scene_start_ms) = milliseconds(scene.start_sec) else {
                return false;
            };
            let Ok(scene_end_ms) = milliseconds(scene.end_sec) else {
                return false;
            };
            source_start_ms >= scene_start_ms && source_end_ms <= scene_end_ms
        });
        declared_scene.ok_or_else(|| invalid("cut_scene_unknown"))?;
        // Handles are extra decoded media either side of the visible cut, so what
        // bounds them is the source file, not the scene: a scene boundary is an
        // analysis artifact and the transition frames legitimately come from across
        // it. Scout computes them exactly this way (`cuts.ts::publishCut`), so
        // measuring them against the scene rejected the planner's own legal output
        // whenever a cut began at a scene start — which is the common case.
        let available_before_ms = source_start_ms;
        let available_after_ms = milliseconds(source.technical.duration_sec)? - source_end_ms;
        if i64::from(cut.handles.before_ms) > available_before_ms
            || i64::from(cut.handles.after_ms) > available_after_ms
        {
            return Err(invalid("cut_handles_out_of_bounds"));
        }
    }
    for pair in plan.timeline.windows(2) {
        let previous = &pair[0];
        let current = &pair[1];
        if current.transition.kind != thoth_types::main_footage::TransitionKind::MatchCut
            && (previous.handles.after_ms < current.transition.duration_ms
                || current.handles.before_ms < current.transition.duration_ms)
        {
            return Err(invalid("transition_handles_insufficient"));
        }
    }
    Ok(())
}

fn validate_summary(plan: &MainFootagePlanV1, narration: &NarrationTimelineV1) -> Result<()> {
    let total_ms = milliseconds(narration.duration_sec)?;
    let main_ms = plan.timeline.iter().try_fold(0_i64, |sum, cut| {
        Ok::<_, anyhow::Error>(
            sum + milliseconds(cut.output_end_sec)? - milliseconds(cut.output_start_sec)?,
        )
    })?;
    let actual = if total_ms == 0 {
        0.0
    } else {
        main_ms as f64 / total_ms as f64
    };
    if plan.main_coverage_target < 0.60
        || plan.main_coverage_target > 1.0
        || actual + f64::EPSILON < plan.main_coverage_target
        || milliseconds(plan.summary.main_coverage_sec)? != main_ms
        || milliseconds(plan.summary.total_duration_sec)? != total_ms
        || (plan.summary.main_coverage_ratio - actual).abs() > 1e-9
        || plan.summary.selected_cut_count as usize != plan.timeline.len()
    {
        return Err(invalid("plan_summary_mismatch"));
    }
    Ok(())
}

fn validate_reuse_spacing(plan: &MainFootagePlanV1) -> Result<()> {
    let mut uses: HashMap<(String, i64, i64), (i64, u32)> = HashMap::new();
    for cut in &plan.timeline {
        let key = (
            cut.source_id.clone(),
            milliseconds(cut.source_start_sec)?,
            milliseconds(cut.source_end_sec)?,
        );
        let output_start_ms = milliseconds(cut.output_start_sec)?;
        match uses.get_mut(&key) {
            Some((last_start_ms, count)) => {
                if output_start_ms - *last_start_ms < 8_000 || cut.reuse_count != *count {
                    return Err(invalid("identical_range_reuse_too_soon"));
                }
                *last_start_ms = output_start_ms;
                *count += 1;
            }
            None => {
                if cut.reuse_count != 0 {
                    return Err(invalid("reuse_count_mismatch"));
                }
                uses.insert(key, (output_start_ms, 1));
            }
        }
    }
    Ok(())
}

fn transition_name(kind: thoth_types::main_footage::TransitionKind) -> &'static str {
    match kind {
        thoth_types::main_footage::TransitionKind::MatchCut => "match_cut",
        thoth_types::main_footage::TransitionKind::CrossDissolve => "cross_dissolve",
        thoth_types::main_footage::TransitionKind::FadeThroughBlack => "fade_through_black",
    }
}

fn duration_matches(actual: f64, expected: f64, frame_rate: f64) -> bool {
    if !actual.is_finite() || !expected.is_finite() || !frame_rate.is_finite() || frame_rate <= 0.0
    {
        return false;
    }
    let tolerance = 0.08_f64.max(1.0 / frame_rate);
    (actual - expected).abs() <= tolerance
}

/// ffprobe reports `format_name` as a comma-separated demuxer family
/// (`mov,mp4,m4a,3gp,3g2,mj2`), and Scout stores that whole string as the source's
/// declared `container` (`source_package.ts::probeSourceVideo`). Splitting only the
/// probed side therefore compared each family member against the entire list and
/// never matched, so every real mp4 source failed `source_metadata_mismatch`. Both
/// sides are lists; sharing a member means the same container.
fn container_contains(actual: &str, expected: &str) -> bool {
    expected.split(',').any(|expected| {
        actual
            .split(',')
            .any(|container| container.eq_ignore_ascii_case(expected))
    })
}

fn validate_source_metadata(
    metadata: &MediaMetadata,
    source: &thoth_types::main_footage::SourceVideoV1,
) -> Result<()> {
    if !duration_matches(
        metadata.duration_sec,
        source.technical.duration_sec,
        metadata.frame_rate,
    ) || !container_contains(&metadata.container, &source.technical.container)
        || metadata.video_codec != source.technical.video_codec
        || metadata.width != source.technical.width
        || metadata.height != source.technical.height
        || metadata.has_audio != source.technical.has_audio
    {
        return Err(invalid("source_metadata_mismatch"));
    }
    Ok(())
}

fn validate_cut_metadata(
    metadata: &MediaMetadata,
    cut: &PlannedCutV1,
    source: &thoth_types::main_footage::SourceVideoV1,
) -> Result<()> {
    let visible_duration = cut.source_end_sec - cut.source_start_sec;
    let handle_ms = u32::from(cut.handles.before_ms) + u32::from(cut.handles.after_ms);
    let expected_duration = visible_duration + f64::from(handle_ms) / 1000.0;
    if !duration_matches(
        metadata.duration_sec,
        expected_duration,
        metadata.frame_rate,
    ) || !container_contains(&metadata.container, "mp4")
        || metadata.video_codec != "h264"
        || metadata.width != source.technical.width
        || metadata.height != source.technical.height
        || metadata.has_audio != source.technical.has_audio
    {
        return Err(invalid("cut_metadata_mismatch"));
    }
    Ok(())
}

pub(crate) async fn verify_plan_with_probe<P: MediaProbe>(
    job: &JobContext,
    imported: &ImportedSourcePackage,
    narration: &NarrationTimelineV1,
    plan_path: &Path,
    probe: &P,
) -> Result<VerifiedMainFootagePlan> {
    let root = canonical_job_root(job)?;
    let plan_path = canonical_file(&root, plan_path)?;
    let plan_bytes = file_bytes(&plan_path)?;
    let plan_value: serde_json::Value =
        serde_json::from_slice(&plan_bytes).map_err(|_| invalid("plan_manifest_rejected"))?;
    let plan: MainFootagePlanV1 = serde_json::from_value(plan_value.clone())
        .map_err(|_| invalid("plan_manifest_rejected"))?;

    let active_path = canonical_file(&root, &job.plans_dir().join("active.json"))?;
    let active_bytes = file_bytes(&active_path)?;
    let active: thoth_types::main_footage::MainFootageActiveV1 =
        serde_json::from_slice(&active_bytes).map_err(|_| invalid("active_pointer_rejected"))?;

    let plan_fingerprint =
        fingerprint_canonical(&plan_value).map_err(|_| invalid("plan_fingerprint_failed"))?;
    if plan.fingerprint.as_deref() != Some(plan_fingerprint.as_str())
        || active.plan_fingerprint != plan_fingerprint
        || relative_artifact(&root, &plan_path)? != active.plan_path
    {
        return Err(invalid("active_plan_fingerprint_mismatch"));
    }
    let cut_prefix = format!("cuts/{}/", active.version);
    if plan
        .timeline
        .iter()
        .any(|cut| !cut.cut_path.starts_with(&cut_prefix) || cut.cut_path == cut_prefix)
    {
        return Err(invalid("cut_version_mismatch"));
    }

    let manifest_path = canonical_file(&root, &imported.manifest_path)?;
    let manifest_bytes = file_bytes(&manifest_path)?;
    let published_package: SourcePackageV1 =
        serde_json::from_slice(&manifest_bytes).map_err(|_| invalid("source_package_rejected"))?;
    let published_value =
        serde_json::to_value(&published_package).map_err(|_| invalid("source_package_rejected"))?;
    let source_fingerprint = fingerprint_canonical(&published_value)
        .map_err(|_| invalid("source_fingerprint_failed"))?;
    let imported_value =
        serde_json::to_value(&imported.package).map_err(|_| invalid("source_package_rejected"))?;
    let imported_fingerprint =
        fingerprint_canonical(&imported_value).map_err(|_| invalid("source_fingerprint_failed"))?;
    if source_fingerprint != imported_fingerprint
        || source_fingerprint != imported.fingerprint
        || published_package.fingerprint.as_deref() != Some(source_fingerprint.as_str())
        || imported.package.fingerprint.as_deref() != Some(source_fingerprint.as_str())
        || plan.source_package_fingerprint != source_fingerprint
        || active.source_package_fingerprint != source_fingerprint
    {
        return Err(invalid("source_fingerprint_mismatch"));
    }
    if relative_artifact(&root, &manifest_path)? != plan.source_package_path {
        return Err(invalid("source_package_path_mismatch"));
    }

    let (selected_narration_path, _) = crate::narration::timeline::read_narration_timeline(job)
        .map_err(|_| invalid("narration_timeline_rejected"))?
        .ok_or_else(|| invalid("narration_timeline_missing"))?;
    let selected_narration_path = canonical_file(&root, &selected_narration_path)?;
    let narration_path = canonical_file(&root, &root.join(&plan.narration_timeline_path))?;
    if narration_path != selected_narration_path {
        return Err(invalid("narration_timeline_path_mismatch"));
    }
    let narration_bytes = file_bytes(&narration_path)?;
    let published_narration: NarrationTimelineV1 = serde_json::from_slice(&narration_bytes)
        .map_err(|_| invalid("narration_timeline_rejected"))?;
    let published_narration_value = serde_json::to_value(&published_narration)
        .map_err(|_| invalid("narration_timeline_rejected"))?;
    let narration_fingerprint = fingerprint_canonical(&published_narration_value)
        .map_err(|_| invalid("narration_fingerprint_failed"))?;
    let supplied_narration_value =
        serde_json::to_value(narration).map_err(|_| invalid("narration_timeline_rejected"))?;
    let supplied_narration_fingerprint = fingerprint_canonical(&supplied_narration_value)
        .map_err(|_| invalid("narration_fingerprint_failed"))?;
    if narration_fingerprint != supplied_narration_fingerprint
        || published_narration.fingerprint.as_deref() != Some(narration_fingerprint.as_str())
        || narration.fingerprint.as_deref() != Some(narration_fingerprint.as_str())
        || plan.narration_fingerprint != narration_fingerprint
        || active.narration_fingerprint != narration_fingerprint
    {
        return Err(invalid("narration_fingerprint_mismatch"));
    }
    if relative_artifact(&root, &narration_path)? != plan.narration_timeline_path {
        return Err(invalid("narration_timeline_path_mismatch"));
    }
    validate_timeline_coverage(&plan, narration)?;
    validate_source_bindings(&plan, &published_package)?;
    validate_summary(&plan, narration)?;
    validate_reuse_spacing(&plan)?;

    let mut retained_bytes = plan_bytes.len() as u64
        + active_bytes.len() as u64
        + manifest_bytes.len() as u64
        + narration_bytes.len() as u64;
    let mut source_paths = Vec::with_capacity(published_package.sources.len());
    for source in &published_package.sources {
        let source_path = canonical_file(&root, &imported.root.join(&source.path))?;
        let (actual_checksum, source_bytes) = checksum_file(&source_path)?;
        if actual_checksum != source.checksum {
            return Err(invalid("source_checksum_mismatch"));
        }
        retained_bytes += source_bytes;
        source_paths.push((source, source_path));
    }
    for index in &published_package.scene_indexes {
        let index_path = canonical_file(&root, &imported.root.join(&index.path))?;
        let bytes = file_bytes(&index_path)?;
        // NOT `checksum(&bytes) == index.checksum`. `SceneIndexV1.checksum` is Scout's
        // content fingerprint over the source digest, planning mode, projected scene
        // evidence and artifact *bytes* — it can never equal the digest of `index.json`,
        // so demanding that fixed point rejected every genuine Scout package. What
        // verification has to establish is that the file this job owns still describes
        // the scenes the manifest declares, which is what import checks on the way in.
        crate::main_footage::import::verify_index_contents(&bytes, index)
            .map_err(|_| invalid("scene_index_contents_mismatch"))?;
        retained_bytes += bytes.len() as u64;
        for scene in &index.scenes {
            let frame = canonical_file(&root, &imported.root.join(&scene.representative_frame))?;
            retained_bytes += retained_file_bytes(&frame)?;
            if let Some(embedding) = scene.embedding_path.as_deref() {
                let embedding = canonical_file(&root, &imported.root.join(embedding))?;
                retained_bytes += retained_file_bytes(&embedding)?;
            }
        }
    }
    let audio_path = canonical_file(&root, &root.join(&narration.audio_path))?;
    let (audio_checksum, audio_bytes) = checksum_file(&audio_path)?;
    if audio_checksum != narration.audio_checksum {
        return Err(invalid("narration_audio_checksum_mismatch"));
    }
    retained_bytes += audio_bytes;

    let mut cut_paths = Vec::with_capacity(plan.timeline.len());
    for cut in &plan.timeline {
        let path = canonical_file(&root, &root.join(&cut.cut_path))?;
        let (actual_checksum, cut_bytes) = checksum_file(&path)?;
        if actual_checksum != cut.checksum {
            return Err(invalid("cut_checksum_mismatch"));
        }
        retained_bytes += cut_bytes;
        cut_paths.push((cut, path));
    }

    for (source, source_path) in &source_paths {
        let metadata = probe.probe(source_path).await.map_err(probe_failed)?;
        validate_source_metadata(&metadata, source)?;
    }
    for (cut, path) in &cut_paths {
        let metadata = probe.probe(path).await.map_err(probe_failed)?;
        let source = published_package
            .sources
            .iter()
            .find(|source| source.id == cut.source_id)
            .ok_or_else(|| invalid("cut_source_unknown"))?;
        validate_cut_metadata(&metadata, cut, source)?;
    }

    let mut transition_distribution = BTreeMap::new();
    for cut in &plan.timeline {
        *transition_distribution
            .entry(transition_name(cut.transition.kind).to_owned())
            .or_insert(0) += 1;
    }
    let metrics = MainFootagePlanMetrics {
        planning_mode: plan.diagnostics.planning_mode,
        coverage_target: plan.main_coverage_target,
        main_coverage_sec: plan.summary.main_coverage_sec,
        main_coverage_ratio: plan.summary.main_coverage_ratio,
        total_duration_sec: plan.summary.total_duration_sec,
        selected_cut_count: plan.summary.selected_cut_count,
        candidate_count: plan.diagnostics.candidate_count,
        transition_distribution,
    };

    Ok(VerifiedMainFootagePlan {
        plan,
        narration_duration_sec: narration.duration_sec,
        metrics,
        version: active.version,
        plan_path,
        retained_bytes,
    })
}

pub(crate) async fn verify_plan_with_execution(
    job: &JobContext,
    imported: &ImportedSourcePackage,
    narration: &NarrationTimelineV1,
    plan_path: &Path,
    execution: &JobExecutionContext,
) -> Result<VerifiedMainFootagePlan> {
    execution.check_cancelled()?;
    let result = verify_plan_with_probe(
        job,
        imported,
        narration,
        plan_path,
        &SupervisedFfprobe { execution },
    )
    .await?;
    execution.check_cancelled()?;
    Ok(result)
}

/// Verifies a published plan using a fresh supervised execution context.
/// Coordinator callers use the same gate with their job context so cancellation
/// can interrupt FFprobe.
pub async fn verify_plan(
    job: &JobContext,
    imported: &ImportedSourcePackage,
    narration: &NarrationTimelineV1,
    plan_path: &Path,
) -> Result<VerifiedMainFootagePlan> {
    let execution = JobExecutionContext::new();
    verify_plan_with_execution(job, imported, narration, plan_path, &execution).await
}

#[cfg(test)]
pub(crate) mod tests {
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::fs;
    use std::io::Read;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};

    use super::{
        HASH_BUFFER_BYTES, MediaMetadata, MediaProbe, checksum, checksum_reader,
        decode_ffprobe_metadata, duration_matches, validate_source_bindings,
        validate_timeline_coverage, verify_plan_with_probe,
    };
    use crate::main_footage::{ImportedSourcePackage, fingerprint_canonical};
    use crate::pipeline::job::JobContext;

    fn digest(bytes: &[u8]) -> String {
        let mut hash = Sha256::new();
        hash.update(bytes);
        format!("sha256:{:x}", hash.finalize())
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    struct BoundedReadProbe {
        remaining: usize,
        calls: Rc<Cell<usize>>,
        largest_request: Rc<Cell<usize>>,
    }

    impl Read for BoundedReadProbe {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.calls.set(self.calls.get() + 1);
            self.largest_request
                .set(self.largest_request.get().max(buffer.len()));
            let count = self.remaining.min(buffer.len());
            buffer[..count].fill(b'x');
            self.remaining -= count;
            Ok(count)
        }
    }

    pub(crate) struct Fixture {
        pub(crate) root: PathBuf,
        pub(crate) job: JobContext,
        pub(crate) imported: ImportedSourcePackage,
        pub(crate) narration: thoth_types::main_footage::NarrationTimelineV1,
        pub(crate) plan_path: PathBuf,
        pub(crate) probe: FakeProbe,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    pub(crate) struct FakeProbe {
        pub(crate) results: HashMap<String, MediaMetadata>,
        pub(crate) opened: Mutex<Vec<PathBuf>>,
    }

    struct CancellingProbe;

    #[async_trait]
    impl MediaProbe for FakeProbe {
        async fn probe(&self, path: &Path) -> anyhow::Result<MediaMetadata> {
            self.opened.lock().unwrap().push(path.to_path_buf());
            self.results
                .get(path.file_name().unwrap().to_str().unwrap())
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("probe fixture missing"))
        }
    }

    #[async_trait]
    impl MediaProbe for CancellingProbe {
        async fn probe(&self, _path: &Path) -> anyhow::Result<MediaMetadata> {
            Err(crate::execution::Cancelled.into())
        }
    }

    pub(crate) fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("mf-verify-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let job = JobContext::new_flat("verify".into(), root.clone()).unwrap();

        let source_bytes = b"immutable source bytes";
        let source_path = job.main_footage_dir().join("sources/source-0.mp4");
        write(&source_path, source_bytes);
        // The published index file and the manifest's `scenes` are the same evidence,
        // written once. Verification compares them (see `import::verify_index_contents`),
        // so a fixture that hand-wrote a stub here would be a fixture built to pass.
        let scenes = json!([{
            "id": "scene-0",
            "start_sec": 0.0,
            "end_sec": 10.0,
            "representative_frame": "frames/source-0-000.jpg",
            "transcript_evidence": "first scene",
            "vision_description": "first scene",
            "visual_metrics": {
                "motion_score": 0.2,
                "brightness": 0.5,
                "scene_change_score": 0.1
            }
        }, {
            "id": "scene-1",
            "start_sec": 10.0,
            "end_sec": 20.0,
            "representative_frame": "frames/source-0-001.jpg",
            "transcript_evidence": "second scene",
            "vision_description": "second scene",
            "visual_metrics": {
                "motion_score": 0.3,
                "brightness": 0.6,
                "scene_change_score": 0.2
            }
        }]);
        let index_bytes = serde_json::to_vec(&json!({
            "schema_version": 1,
            "source_id": "source-0",
            "planning_mode": "vision",
            "scenes": scenes.clone(),
        }))
        .unwrap();
        let index_path = job
            .main_footage_dir()
            .join("scene-index/source-0/v001/index.json");
        write(&index_path, &index_bytes);
        write(
            &job.main_footage_dir().join("frames/source-0-000.jpg"),
            b"frame-0",
        );
        write(
            &job.main_footage_dir().join("frames/source-0-001.jpg"),
            b"frame-1",
        );

        let mut package_value = json!({
            "schema_version": 1,
            "post": {
                "id": "post-123",
                "canonical_url": "https://example.test/post-123",
                "platform": "test"
            },
            "analysis_identity": "analysis-v1",
            "sources": [{
                "id": "source-0",
                "media_index": 0,
                "path": "sources/source-0.mp4",
                "checksum": digest(source_bytes),
                "technical": {
                    "container": "mp4",
                    "video_codec": "h264",
                    "duration_sec": 20.0,
                    "width": 1080,
                    "height": 1920,
                    "has_audio": true
                }
            }],
            "ignored": [],
            "unavailable": [],
            "scene_indexes": [{
                "source_id": "source-0",
                "path": "scene-index/source-0/v001/index.json",
                "checksum": digest(&index_bytes),
                "planning_mode": "vision",
                "scenes": scenes
            }]
        });
        let package_fingerprint = fingerprint_canonical(&package_value).unwrap();
        package_value["fingerprint"] = Value::String(package_fingerprint.clone());
        let package = serde_json::from_value(package_value.clone()).unwrap();
        let manifest_path = job.source_package_manifest();
        write(
            &manifest_path,
            &serde_json::to_vec_pretty(&package_value).unwrap(),
        );
        let imported = ImportedSourcePackage {
            root: fs::canonicalize(job.main_footage_dir()).unwrap(),
            manifest_path,
            package,
            fingerprint: package_fingerprint.clone(),
            external_sources: None,
        };

        let audio_bytes = b"narration audio";
        write(&job.narration_dir().join("narration.mp3"), audio_bytes);
        let mut narration_value = json!({
            "schema_version": 1,
            "audio_path": "narration/narration.mp3",
            "audio_checksum": digest(audio_bytes),
            "duration_sec": 10.0,
            "words": [
                {"text": "one", "start_sec": 0.0, "end_sec": 1.0},
                {"text": "two", "start_sec": 5.0, "end_sec": 6.0}
            ],
            "beats": [
                {"id": "beat-001", "start_sec": 0.0, "end_sec": 5.0, "text": "one"},
                {"id": "beat-002", "start_sec": 5.0, "end_sec": 10.0, "text": "two"}
            ]
        });
        let narration_fingerprint = fingerprint_canonical(&narration_value).unwrap();
        narration_value["fingerprint"] = Value::String(narration_fingerprint.clone());
        let narration = serde_json::from_value(narration_value.clone()).unwrap();
        write(
            &job.narration_timeline(),
            &serde_json::to_vec_pretty(&narration_value).unwrap(),
        );

        let cut_1 = b"cut one bytes";
        let cut_2 = b"cut two bytes";
        write(&root.join("cuts/v001/cut-001.mp4"), cut_1);
        write(&root.join("cuts/v001/cut-002.mp4"), cut_2);
        let mut plan_value = json!({
            "schema_version": 1,
            "status": "verified",
            "source_package_path": "main-footage/source-package.json",
            "narration_timeline_path": "narration/timeline.json",
            "source_package_fingerprint": package_fingerprint,
            "narration_fingerprint": narration_fingerprint,
            "main_coverage_target": 0.6,
            "timeline": [{
                "id": "cut-001",
                "source_id": "source-0",
                "source_path": "main-footage/sources/source-0.mp4",
                "cut_path": "cuts/v001/cut-001.mp4",
                "checksum": digest(cut_1),
                "source_start_sec": 0.0,
                "source_end_sec": 5.0,
                "output_start_sec": 0.0,
                "output_end_sec": 5.0,
                "match_level": "exact",
                "reuse_count": 0,
                "transition": {"kind": "match_cut", "duration_ms": 120},
                "handles": {"before_ms": 0, "after_ms": 180}
            }, {
                "id": "cut-002",
                "source_id": "source-0",
                "source_path": "main-footage/sources/source-0.mp4",
                "cut_path": "cuts/v001/cut-002.mp4",
                "checksum": digest(cut_2),
                "source_start_sec": 10.18,
                "source_end_sec": 15.18,
                "output_start_sec": 5.0,
                "output_end_sec": 10.0,
                "match_level": "exact",
                "reuse_count": 0,
                "transition": {"kind": "cross_dissolve", "duration_ms": 180},
                "handles": {"before_ms": 180, "after_ms": 0}
            }],
            "diagnostics": {
                "planning_mode": "vision",
                "candidate_count": 2,
                "warnings": []
            },
            "summary": {
                "main_coverage_sec": 10.0,
                "main_coverage_ratio": 1.0,
                "total_duration_sec": 10.0,
                "selected_cut_count": 2
            },
            "warnings": []
        });
        let plan_fingerprint = fingerprint_canonical(&plan_value).unwrap();
        plan_value["fingerprint"] = Value::String(plan_fingerprint.clone());
        let plan_path = root.join("plans/v001/main-footage-plan.json");
        write(&plan_path, &serde_json::to_vec_pretty(&plan_value).unwrap());
        write(
            &root.join("plans/active.json"),
            &serde_json::to_vec_pretty(&json!({
                "schema_version": 1,
                "status": "verified",
                "version": "v001",
                "plan_path": "plans/v001/main-footage-plan.json",
                "source_package_fingerprint": plan_value["source_package_fingerprint"],
                "narration_fingerprint": plan_value["narration_fingerprint"],
                "plan_fingerprint": plan_fingerprint
            }))
            .unwrap(),
        );

        let source_metadata = MediaMetadata {
            duration_sec: 20.0,
            container: "mp4".into(),
            video_codec: "h264".into(),
            width: 1080,
            height: 1920,
            has_audio: true,
            frame_rate: 30.0,
        };
        let cut_metadata = |duration_sec| MediaMetadata {
            duration_sec,
            container: "mov,mp4,m4a,3gp,3g2,mj2".into(),
            video_codec: "h264".into(),
            width: 1080,
            height: 1920,
            has_audio: true,
            frame_rate: 30.0,
        };
        let probe = FakeProbe {
            results: HashMap::from([
                ("source-0.mp4".into(), source_metadata),
                ("cut-001.mp4".into(), cut_metadata(5.18)),
                ("cut-002.mp4".into(), cut_metadata(5.18)),
            ]),
            opened: Mutex::new(Vec::new()),
        };

        Fixture {
            root,
            job,
            imported,
            narration,
            plan_path,
            probe,
        }
    }

    fn rewrite_plan(fixture: &Fixture, mutate: impl FnOnce(&mut Value)) {
        let mut plan: Value =
            serde_json::from_slice(&fs::read(&fixture.plan_path).unwrap()).unwrap();
        mutate(&mut plan);
        let fingerprint = fingerprint_canonical(&plan).unwrap();
        plan["fingerprint"] = Value::String(fingerprint.clone());
        fs::write(
            &fixture.plan_path,
            serde_json::to_vec_pretty(&plan).unwrap(),
        )
        .unwrap();

        let active_path = fixture.root.join("plans/active.json");
        let mut active: Value = serde_json::from_slice(&fs::read(&active_path).unwrap()).unwrap();
        active["source_package_fingerprint"] = plan["source_package_fingerprint"].clone();
        active["narration_fingerprint"] = plan["narration_fingerprint"].clone();
        active["plan_fingerprint"] = Value::String(fingerprint);
        fs::write(active_path, serde_json::to_vec_pretty(&active).unwrap()).unwrap();
    }

    fn error_code(error: &anyhow::Error) -> thoth_types::main_footage::MainFootageErrorCode {
        error
            .downcast_ref::<crate::main_footage::MainFootageError>()
            .unwrap_or_else(|| panic!("expected MainFootageError, got {error:#}"))
            .code
    }

    /// Production mutation caught: constructing the opaque verified value before
    /// the complete gate would make this happy-path contract impossible to pin.
    #[tokio::test]
    async fn complete_durability_gate_constructs_the_opaque_verified_plan() {
        let fixture = fixture();

        let verified = verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .unwrap();

        assert_eq!(verified.version(), "v001");
        assert_eq!(verified.timeline().len(), 2);
        assert_eq!(verified.narration_duration_sec(), 10.0);
        assert!(verified.retained_bytes() > 0);
    }

    /// Production mutation caught: resolving only the legacy narration path
    /// rejects a plan that Scout correctly bound to the active immutable version.
    #[tokio::test]
    async fn durability_gate_verifies_the_active_versioned_narration_timeline() {
        let mut fixture = fixture();
        fs::remove_file(fixture.job.narration_timeline()).unwrap();
        crate::narration::timeline::write_narration_timeline(&fixture.job, &fixture.narration)
            .unwrap();
        fixture.narration = crate::narration::timeline::read_narration_timeline(&fixture.job)
            .unwrap()
            .unwrap()
            .1;
        rewrite_plan(&fixture, |plan| {
            plan["narration_timeline_path"] = json!("narration/v001/timeline.json");
        });

        let verified = verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .unwrap();

        assert_eq!(verified.version(), "v001");
    }

    /// Production mutation caught: replacing the streaming loop with
    /// `read_to_end`/`fs::read` would request the complete media payload instead
    /// of bounded chunks and defeat the durability gate on large source pools.
    #[test]
    fn checksum_reader_hashes_large_inputs_in_bounded_chunks() {
        let total_bytes = HASH_BUFFER_BYTES * 3 + 17;
        let calls = Rc::new(Cell::new(0));
        let largest_request = Rc::new(Cell::new(0));
        let reader = BoundedReadProbe {
            remaining: total_bytes,
            calls: Rc::clone(&calls),
            largest_request: Rc::clone(&largest_request),
        };

        let (actual, bytes_read) = checksum_reader(reader).unwrap();

        assert_eq!(bytes_read, total_bytes as u64);
        assert_eq!(actual, checksum(&vec![b'x'; total_bytes]));
        assert!(calls.get() >= 4, "the payload must require multiple reads");
        assert!(largest_request.get() <= HASH_BUFFER_BYTES);
    }

    /// The duration tolerance is derived from probed media truth. Missing or
    /// unusable rates must fail closed; a real low rate keeps its one-frame
    /// tolerance instead of being silently rewritten to 30 fps.
    #[test]
    fn ffprobe_requires_a_usable_frame_rate_and_preserves_low_fps() {
        let payload = |frame_rate: Option<&str>| {
            let mut stream = json!({
                "codec_type": "video",
                "codec_name": "h264",
                "width": 1080,
                "height": 1920
            });
            if let Some(frame_rate) = frame_rate {
                stream["r_frame_rate"] = json!(frame_rate);
            }
            serde_json::to_vec(&json!({
                "format": {"duration": "10.0", "format_name": "mp4"},
                "streams": [stream]
            }))
            .unwrap()
        };

        for rejected in [None, Some("0/0"), Some("0/1"), Some("not-a-rate")] {
            assert!(
                decode_ffprobe_metadata(&payload(rejected)).is_err(),
                "{rejected:?} must fail closed"
            );
        }

        let metadata = decode_ffprobe_metadata(&payload(Some("1/2"))).unwrap();
        assert_eq!(metadata.frame_rate, 0.5);
        assert!(duration_matches(11.9, 10.0, metadata.frame_rate));
        assert!(!duration_matches(12.01, 10.0, metadata.frame_rate));
    }

    /// Production mutation caught: deleting the explicit millisecond range
    /// check would let a self-consistent 200 ms or eight-second visible cut pass.
    #[test]
    fn visible_cut_duration_accepts_only_the_inclusive_1500_to_6000_ms_range() {
        let fixture = fixture();
        let original: thoth_types::main_footage::MainFootagePlanV1 =
            serde_json::from_slice(&fs::read(&fixture.plan_path).unwrap()).unwrap();

        for rejected_ms in [200, 1_499, 6_001, 8_000] {
            let mut plan = original.clone();
            let duration_sec = f64::from(rejected_ms) / 1_000.0;
            plan.timeline[0].source_end_sec = duration_sec;
            plan.timeline[0].output_end_sec = duration_sec;
            assert!(
                validate_source_bindings(&plan, &fixture.imported.package).is_err(),
                "{rejected_ms} ms must be rejected"
            );
        }

        for accepted_ms in [1_500, 6_000] {
            let mut plan = original.clone();
            let duration_sec = f64::from(accepted_ms) / 1_000.0;
            plan.timeline[0].source_end_sec = duration_sec;
            plan.timeline[0].output_end_sec = duration_sec;
            validate_source_bindings(&plan, &fixture.imported.package)
                .unwrap_or_else(|error| panic!("{accepted_ms} ms must be accepted: {error:#}"));
        }
    }

    /// Long narration beats remain legal by containing multiple ordered normal
    /// cuts; the per-cut duration bound must not become a per-beat bound.
    #[test]
    fn a_long_beat_can_contain_multiple_ordered_visible_cuts() {
        let fixture = fixture();
        let plan: thoth_types::main_footage::MainFootagePlanV1 =
            serde_json::from_slice(&fs::read(&fixture.plan_path).unwrap()).unwrap();
        let mut narration = fixture.narration.clone();
        narration.beats = vec![thoth_types::main_footage::NarrationBeatV1 {
            id: "beat-long".into(),
            start_sec: 0.0,
            end_sec: 10.0,
            text: "one long beat".into(),
        }];

        validate_timeline_coverage(&plan, &narration).unwrap();
        validate_source_bindings(&plan, &fixture.imported.package).unwrap();
    }

    /// Production mutation caught: trusting the plan and active pointer's
    /// mutually consistent source identity instead of recomputing the imported
    /// package fingerprint would select cuts from a different package.
    #[tokio::test]
    async fn source_fingerprint_mismatch_is_rejected_before_ffprobe() {
        let fixture = fixture();
        rewrite_plan(&fixture, |plan| {
            plan["source_package_fingerprint"] =
                Value::String(format!("sha256:{}", "f".repeat(64)));
        });

        let error = verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("a different package identity must not become verified");

        assert_eq!(
            error_code(&error),
            thoth_types::main_footage::MainFootageErrorCode::PlanVerificationFailed
        );
        assert!(fixture.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: trusting the active pointer's narration
    /// identity would allow a valid old plan to be rendered under new audio.
    #[tokio::test]
    async fn narration_fingerprint_mismatch_is_rejected_before_ffprobe() {
        let fixture = fixture();
        rewrite_plan(&fixture, |plan| {
            plan["narration_fingerprint"] = Value::String(format!("sha256:{}", "e".repeat(64)));
        });

        let error = verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("a plan for different narration must not become verified");

        assert_eq!(
            error_code(&error),
            thoth_types::main_footage::MainFootageErrorCode::PlanVerificationFailed
        );
        assert!(fixture.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: comparing only the final duration and not an
    /// integer-millisecond cursor would allow holes in the narration timeline.
    #[tokio::test]
    async fn one_millisecond_timeline_gap_is_rejected_before_ffprobe() {
        let fixture = fixture();
        rewrite_plan(&fixture, |plan| {
            plan["timeline"][1]["output_start_sec"] = json!(5.001);
        });

        let error = verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("a gap must not become verified");

        assert_eq!(
            error_code(&error),
            thoth_types::main_footage::MainFootageErrorCode::PlanVerificationFailed
        );
        assert!(fixture.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: replacing cursor equality with a one-sided
    /// gap check would allow two cuts to claim the same output millisecond.
    #[tokio::test]
    async fn one_millisecond_timeline_overlap_is_rejected_before_ffprobe() {
        let fixture = fixture();
        rewrite_plan(&fixture, |plan| {
            plan["timeline"][1]["output_start_sec"] = json!(4.999);
        });

        verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("an overlap must not become verified");
        assert!(fixture.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: validating only global coverage would allow
    /// a cut to cross the deterministic boundary between narration beats.
    #[tokio::test]
    async fn cut_crossing_a_narration_beat_is_rejected_before_ffprobe() {
        let fixture = fixture();
        rewrite_plan(&fixture, |plan| {
            plan["timeline"][0]["output_end_sec"] = json!(5.001);
            plan["timeline"][1]["output_start_sec"] = json!(5.001);
        });

        verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("a cut crossing beats must not become verified");
        assert!(fixture.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: validating only non-negative cut ranges would
    /// allow FFmpeg output to claim bytes beyond the immutable source and scene.
    #[tokio::test]
    async fn source_range_out_of_bounds_is_rejected_before_ffprobe() {
        let fixture = fixture();
        rewrite_plan(&fixture, |plan| {
            plan["timeline"][1]["source_start_sec"] = json!(19.0);
            plan["timeline"][1]["source_end_sec"] = json!(24.0);
        });

        verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("an out-of-bounds source range must not become verified");
        assert!(fixture.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: probing each source/cut while walking the
    /// plan would perform subprocess work before discovering a later missing cut.
    #[tokio::test]
    async fn missing_cut_is_rejected_before_any_ffprobe() {
        let fixture = fixture();
        fs::remove_file(fixture.root.join("cuts/v001/cut-002.mp4")).unwrap();

        verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("a missing cut must not become verified");
        assert!(fixture.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: checking only that the immutable cut exists
    /// would let replacement bytes inherit a verified plan's identity.
    #[tokio::test]
    async fn cut_checksum_mismatch_is_rejected_before_any_ffprobe() {
        let fixture = fixture();
        fs::write(
            fixture.root.join("cuts/v001/cut-002.mp4"),
            b"tampered cut bytes",
        )
        .unwrap();

        verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("tampered cut bytes must not become verified");
        assert!(fixture.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: spawning FFprobe but ignoring its duration
    /// would accept a truncated or padded materialized cut.
    #[tokio::test]
    async fn ffprobe_duration_mismatch_is_rejected() {
        let mut fixture = fixture();
        fixture
            .probe
            .results
            .get_mut("cut-002.mp4")
            .unwrap()
            .duration_sec = 5.5;

        verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("wrong FFprobe duration must not become verified");
        assert_eq!(fixture.probe.opened.lock().unwrap().len(), 3);
    }

    /// Production mutation caught: trusting persisted summary arithmetic would
    /// allow an allocator below the requested 60% floor to label itself verified.
    #[tokio::test]
    async fn actual_coverage_below_target_is_rejected_before_ffprobe() {
        let fixture = fixture();
        rewrite_plan(&fixture, |plan| {
            plan["summary"]["main_coverage_sec"] = json!(5.0);
            plan["summary"]["main_coverage_ratio"] = json!(0.5);
        });

        verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("coverage below target must not become verified");
        assert!(fixture.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: trusting persisted handle counts without
    /// checking the source/scene headroom would make the renderer seek before 0.
    #[tokio::test]
    async fn invalid_cut_handles_are_rejected_before_ffprobe() {
        let fixture = fixture();
        rewrite_plan(&fixture, |plan| {
            plan["timeline"][0]["handles"]["before_ms"] = json!(1);
        });

        verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("a handle outside the scene must not become verified");
        assert!(fixture.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: comparing reuse in floating seconds or with
    /// a strict `> 8` check would permit the same range again at 7.99 seconds.
    #[tokio::test]
    async fn identical_range_reuse_at_7_99_seconds_is_rejected_before_ffprobe() {
        let mut fixture = fixture();
        let mut narration_value: Value =
            serde_json::from_slice(&fs::read(fixture.job.narration_timeline()).unwrap()).unwrap();
        narration_value["duration_sec"] = json!(15.98);
        narration_value["beats"] = json!([
            {"id": "beat-001", "start_sec": 0.0, "end_sec": 7.99, "text": "one"},
            {"id": "beat-002", "start_sec": 7.99, "end_sec": 15.98, "text": "two"}
        ]);
        fs::write(
            fixture.job.narration_timeline(),
            serde_json::to_vec_pretty(&narration_value).unwrap(),
        )
        .unwrap();
        fixture.narration = serde_json::from_value(narration_value).unwrap();
        rewrite_plan(&fixture, |plan| {
            plan["timeline"][0]["source_end_sec"] = json!(7.99);
            plan["timeline"][0]["output_end_sec"] = json!(7.99);
            plan["timeline"][0]["handles"] = json!({"before_ms": 0, "after_ms": 0});
            plan["timeline"][1]["source_start_sec"] = json!(0.0);
            plan["timeline"][1]["source_end_sec"] = json!(7.99);
            plan["timeline"][1]["output_start_sec"] = json!(7.99);
            plan["timeline"][1]["output_end_sec"] = json!(15.98);
            plan["timeline"][1]["reuse_count"] = json!(1);
            plan["timeline"][1]["transition"] = json!({"kind": "match_cut", "duration_ms": 120});
            plan["timeline"][1]["handles"] = json!({"before_ms": 0, "after_ms": 0});
            plan["summary"]["main_coverage_sec"] = json!(15.98);
            plan["summary"]["total_duration_sec"] = json!(15.98);
        });
        for cut in ["cut-001.mp4", "cut-002.mp4"] {
            fixture.probe.results.get_mut(cut).unwrap().duration_sec = 7.99;
        }

        verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("reuse before eight seconds must not become verified");
        assert!(fixture.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: accepting the active pointer without binding
    /// its plan SHA would let resume select a self-consistent but different file.
    #[tokio::test]
    async fn active_plan_fingerprint_mismatch_is_rejected_before_ffprobe() {
        let fixture = fixture();
        let active_path = fixture.root.join("plans/active.json");
        let mut active: Value = serde_json::from_slice(&fs::read(&active_path).unwrap()).unwrap();
        active["plan_fingerprint"] = Value::String(format!("sha256:{}", "a".repeat(64)));
        fs::write(active_path, serde_json::to_vec_pretty(&active).unwrap()).unwrap();

        verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("a different active plan SHA must not become verified");
        assert!(fixture.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: replacing the Task-1 typed plan decoder with
    /// permissive JSON access would reopen transport, absolute, and traversal paths.
    #[tokio::test]
    async fn absolute_traversal_and_remote_cut_paths_are_rejected_before_ffprobe() {
        for rejected in [
            "C:/outside/cut.mp4",
            "../outside/cut.mp4",
            "https://signed.example/cut.mp4?token=secret",
        ] {
            let fixture = fixture();
            rewrite_plan(&fixture, |plan| {
                plan["timeline"][0]["cut_path"] = json!(rejected);
            });
            verify_plan_with_probe(
                &fixture.job,
                &fixture.imported,
                &fixture.narration,
                &fixture.plan_path,
                &fixture.probe,
            )
            .await
            .expect_err("non-local cut path must not become verified");
            assert!(fixture.probe.opened.lock().unwrap().is_empty());
        }
    }

    /// Production mutation caught: weakening the verified-only wire status or
    /// accepting an unknown schema would expose a partially published plan.
    #[tokio::test]
    async fn unknown_schema_and_unverified_status_are_rejected_before_ffprobe() {
        for (field, value) in [("schema_version", json!(2)), ("status", json!("pending"))] {
            let fixture = fixture();
            rewrite_plan(&fixture, |plan| plan[field] = value);
            verify_plan_with_probe(
                &fixture.job,
                &fixture.imported,
                &fixture.narration,
                &fixture.plan_path,
                &fixture.probe,
            )
            .await
            .expect_err("unknown schema/status must not become verified");
            assert!(fixture.probe.opened.lock().unwrap().is_empty());
        }
    }

    /// Production mutation caught: bypassing the Task-1 coverage decoder would
    /// permit a target below the binding 0.60 product floor.
    #[tokio::test]
    async fn target_below_point_six_is_rejected_before_ffprobe() {
        let fixture = fixture();
        rewrite_plan(&fixture, |plan| plan["main_coverage_target"] = json!(0.59));
        verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("target below 0.60 must not become verified");
        assert!(fixture.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: a permissive transition representation would
    /// let renderer-unknown kinds or durations just outside 120..=300 through.
    #[tokio::test]
    async fn forbidden_transition_and_119_or_301_ms_are_rejected_before_ffprobe() {
        for (field, value) in [
            ("kind", json!("wipe")),
            ("duration_ms", json!(119)),
            ("duration_ms", json!(301)),
        ] {
            let fixture = fixture();
            rewrite_plan(&fixture, |plan| {
                plan["timeline"][1]["transition"][field] = value;
            });
            verify_plan_with_probe(
                &fixture.job,
                &fixture.imported,
                &fixture.narration,
                &fixture.plan_path,
                &fixture.probe,
            )
            .await
            .expect_err("transition outside the whitelist/bounds must fail");
            assert!(fixture.probe.opened.lock().unwrap().is_empty());
        }
    }

    /// Production mutation caught: using only the source path/range without the
    /// typed source and scene identities would accept allocator hallucinations.
    #[tokio::test]
    async fn unknown_source_and_unknown_scene_are_rejected_before_ffprobe() {
        let unknown_source = fixture();
        rewrite_plan(&unknown_source, |plan| {
            plan["timeline"][0]["source_id"] = json!("source-missing");
        });
        verify_plan_with_probe(
            &unknown_source.job,
            &unknown_source.imported,
            &unknown_source.narration,
            &unknown_source.plan_path,
            &unknown_source.probe,
        )
        .await
        .expect_err("unknown source must fail");
        assert!(unknown_source.probe.opened.lock().unwrap().is_empty());

        let unknown_scene = fixture();
        rewrite_plan(&unknown_scene, |plan| {
            plan["timeline"][1]["source_start_sec"] = json!(9.0);
            plan["timeline"][1]["source_end_sec"] = json!(14.0);
        });
        verify_plan_with_probe(
            &unknown_scene.job,
            &unknown_scene.imported,
            &unknown_scene.narration,
            &unknown_scene.plan_path,
            &unknown_scene.probe,
        )
        .await
        .expect_err("range outside every declared scene must fail");
        assert!(unknown_scene.probe.opened.lock().unwrap().is_empty());
    }

    /// Production mutation caught: treating an FFprobe process/parse failure as
    /// missing metadata defaults would construct the opaque value without media truth.
    #[tokio::test]
    async fn ffprobe_failure_is_terminal() {
        let mut fixture = fixture();
        fixture.probe.results.remove("cut-002.mp4");
        let error = verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &fixture.probe,
        )
        .await
        .expect_err("FFprobe failure must fail the durability gate");
        assert_eq!(
            error_code(&error),
            thoth_types::main_footage::MainFootageErrorCode::PlanVerificationFailed
        );
    }

    /// A supervised FFprobe is part of the job process tree. Job cancellation
    /// must remain downcast-able instead of being relabeled as verification.
    #[tokio::test]
    async fn ffprobe_cancellation_preserves_the_typed_job_error() {
        let fixture = fixture();
        let error = verify_plan_with_probe(
            &fixture.job,
            &fixture.imported,
            &fixture.narration,
            &fixture.plan_path,
            &CancellingProbe,
        )
        .await
        .expect_err("cancelled FFprobe must stop the durability gate");

        assert!(crate::execution::is_cancelled(&error));
    }
}
