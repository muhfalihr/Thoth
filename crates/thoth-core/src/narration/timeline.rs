//! Turns a produced narration into the beat timeline the cut planner allocates
//! footage against.
//!
//! `Narration` stays the owner of the voiceover audio and its word timings; this
//! module only segments those already-stable timings and persists the result.
//! Nothing here generates a script or calls TTS.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thoth_types::main_footage::MAIN_FOOTAGE_SCHEMA_VERSION;

use crate::main_footage::paths::{resolve_contained, write_immutable};
use crate::main_footage::{
    MainFootageError, MainFootageErrorCode, NarrationBeatV1, NarrationTimelineV1, NarrationWordV1,
    fingerprint_canonical,
};
use crate::narration::Narration;
use crate::pipeline::job::JobContext;

/// How narration spans are divided into beats.
#[derive(Debug, Clone, Copy)]
pub struct BeatPolicy {
    /// Longest beat before it is divided at a word boundary.
    pub max_beat_sec: f64,
}

impl Default for BeatPolicy {
    fn default() -> Self {
        Self { max_beat_sec: 6.0 }
    }
}

fn failed(detail: &str) -> MainFootageError {
    MainFootageError::new(MainFootageErrorCode::NarrationGenerationFailed, detail)
}

fn ends_sentence(text: &str) -> bool {
    text.trim_end_matches(|c: char| c == '"' || c == '\'' || c == ')' || c == ']')
        .ends_with(['.', '!', '?', '…', '。', '？', '！'])
}

/// One spoken word with a monotonically non-decreasing time range.
struct Spoken {
    text: String,
    start_sec: f64,
    end_sec: f64,
}

/// Normalizes TTS word timings into a strictly forward-moving sequence. Aligner
/// output occasionally overlaps or regresses; beats must not.
fn spoken_words(narration: &Narration) -> Vec<Spoken> {
    let mut cursor = 0.0_f64;
    let mut words = Vec::with_capacity(narration.words.len());
    for word in &narration.words {
        let text = word.word.trim();
        if text.is_empty() {
            continue;
        }
        let start = (word.start_ms as f64 / 1000.0).max(cursor);
        let end = (word.end_ms as f64 / 1000.0).max(start);
        if end <= start {
            continue;
        }
        cursor = end;
        words.push(Spoken {
            text: text.to_string(),
            start_sec: start,
            end_sec: end,
        });
    }
    words
}

/// Sentence-punctuation groups, then any group longer than the policy divided at
/// the last word boundary that still fits (or the first boundary after it, when a
/// single word is longer than a whole beat). Returns end-exclusive word ranges.
fn group_words(words: &[Spoken], policy: BeatPolicy) -> Vec<(usize, usize)> {
    let mut sentences: Vec<(usize, usize)> = Vec::new();
    let mut start = 0usize;
    for (index, word) in words.iter().enumerate() {
        if ends_sentence(&word.text) {
            sentences.push((start, index + 1));
            start = index + 1;
        }
    }
    if start < words.len() {
        sentences.push((start, words.len()));
    }

    let limit = if policy.max_beat_sec.is_finite() && policy.max_beat_sec > 0.0 {
        policy.max_beat_sec
    } else {
        BeatPolicy::default().max_beat_sec
    };
    let mut groups = Vec::with_capacity(sentences.len());
    for (mut from, to) in sentences {
        while words[to - 1].end_sec - words[from].start_sec > limit {
            let target = words[from].start_sec + limit;
            // Last boundary that still fits; at least one word always advances.
            let mut cut = from + 1;
            for index in (from + 1)..to {
                if words[index - 1].end_sec <= target {
                    cut = index;
                } else {
                    break;
                }
            }
            groups.push((from, cut));
            from = cut;
        }
        groups.push((from, to));
    }
    groups
}

/// Segments a produced narration into contiguous beats covering `[0, duration]`.
pub fn build_narration_timeline(
    narration: &Narration,
    policy: BeatPolicy,
) -> Result<NarrationTimelineV1, MainFootageError> {
    let words = spoken_words(narration);
    if words.is_empty() {
        return Err(failed("narration_has_no_word_timings"));
    }
    let spoken_end = words[words.len() - 1].end_sec;
    let duration_sec = narration.duration_secs.max(spoken_end);
    if !duration_sec.is_finite() || duration_sec <= 0.0 {
        return Err(failed("narration_has_no_duration"));
    }

    let groups = group_words(&words, policy);
    let mut beats: Vec<NarrationBeatV1> = Vec::with_capacity(groups.len());
    for (from, to) in groups.iter().copied() {
        let start_sec = beats
            .last()
            .map_or(0.0, |beat: &NarrationBeatV1| beat.end_sec);
        let end_sec = words[to - 1].end_sec;
        let text = words[from..to]
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        if end_sec <= start_sec {
            // A degenerate group (zero-length after clamping) folds into the
            // beat before it rather than emitting an invalid range.
            if let Some(previous) = beats.last_mut() {
                previous.text.push(' ');
                previous.text.push_str(&text);
                continue;
            }
            return Err(failed("narration_timings_are_degenerate"));
        }
        beats.push(NarrationBeatV1 {
            id: format!("beat-{:03}", beats.len() + 1),
            start_sec,
            end_sec,
            text,
        });
    }
    // Beats must cover `[0, duration_sec]`. Every beat ends on a word boundary,
    // and the audio runs past the last word (trailing silence, or a
    // `duration_secs` longer than the timings), so the tail is extended here —
    // one place, after any degenerate group has folded into its predecessor and
    // could otherwise have left the timeline short.
    let last = beats
        .last_mut()
        .ok_or_else(|| failed("narration_produced_no_beats"))?;
    last.end_sec = duration_sec;

    let audio_path = narration
        .mp3
        .file_name()
        .map(|name| format!("narration/{}", name.to_string_lossy()))
        .ok_or_else(|| failed("narration_audio_has_no_filename"))?;
    let audio_checksum = sha256_file(&narration.mp3)?;

    let mut timeline = NarrationTimelineV1 {
        schema_version: MAIN_FOOTAGE_SCHEMA_VERSION,
        audio_path,
        audio_checksum,
        duration_sec,
        words: words
            .iter()
            .map(|word| NarrationWordV1 {
                text: word.text.clone(),
                start_sec: word.start_sec,
                end_sec: word.end_sec,
            })
            .collect(),
        beats,
        created_at: Some(chrono::Utc::now().to_rfc3339()),
        fingerprint: None,
    };
    // Hashes the narration audio plus the normalized word timings and text —
    // beats are derived, so re-segmenting the same narration is not a new identity.
    let value = serde_json::to_value(&timeline).map_err(|_| failed("timeline_not_serializable"))?;
    timeline.fingerprint =
        Some(fingerprint_canonical(&value).map_err(|_| failed("timeline_fingerprint_failed"))?);
    Ok(timeline)
}

fn sha256_file(path: &Path) -> Result<String, MainFootageError> {
    let bytes = std::fs::read(path).map_err(|_| failed("narration_audio_unreadable"))?;
    let mut hash = Sha256::new();
    hash.update(&bytes);
    Ok(format!("sha256:{:x}", hash.finalize()))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NarrationActiveV1 {
    schema_version: u8,
    version: String,
    timeline_path: String,
    narration_fingerprint: String,
}

fn validated_fingerprint(timeline: &NarrationTimelineV1) -> Result<String, MainFootageError> {
    let value = serde_json::to_value(timeline).map_err(|_| failed("timeline_not_serializable"))?;
    let fingerprint =
        fingerprint_canonical(&value).map_err(|_| failed("timeline_fingerprint_failed"))?;
    if timeline.fingerprint.as_deref() != Some(fingerprint.as_str()) {
        return Err(failed("narration_fingerprint_mismatch"));
    }
    Ok(fingerprint)
}

fn read_timeline(path: &Path) -> Result<NarrationTimelineV1, MainFootageError> {
    let timeline: NarrationTimelineV1 = serde_json::from_slice(
        &fs::read(path).map_err(|_| failed("narration_timeline_unreadable"))?,
    )
    .map_err(|_| failed("narration_timeline_unreadable"))?;
    validated_fingerprint(&timeline)?;
    Ok(timeline)
}

fn active_path(job: &JobContext) -> PathBuf {
    job.narration_dir().join("active.json")
}

fn read_active(job: &JobContext) -> Result<Option<NarrationActiveV1>, MainFootageError> {
    let path = active_path(job);
    if !path.exists() {
        return Ok(None);
    }
    let active: NarrationActiveV1 =
        serde_json::from_slice(&fs::read(path).map_err(|_| failed("narration_active_unreadable"))?)
            .map_err(|_| failed("narration_active_unreadable"))?;
    if active.schema_version != MAIN_FOOTAGE_SCHEMA_VERSION
        || active.timeline_path != format!("narration/{}/timeline.json", active.version)
    {
        return Err(failed("narration_active_rejected"));
    }
    Ok(Some(active))
}

#[cfg(unix)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn publish_active(job: &JobContext, active: &NarrationActiveV1) -> Result<(), MainFootageError> {
    fs::create_dir_all(job.narration_dir())
        .map_err(|_| failed("narration_active_publish_failed"))?;
    let destination = active_path(job);
    let temporary = job
        .narration_dir()
        .join(format!(".active.json.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        serde_json::to_writer_pretty(&mut file, active).map_err(std::io::Error::other)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temporary, &destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| failed("narration_active_publish_failed"))
}

fn reserve_version(job: &JobContext) -> Result<(String, PathBuf), MainFootageError> {
    fs::create_dir_all(job.narration_dir())
        .map_err(|_| failed("narration_version_reserve_failed"))?;
    for number in 1_u32.. {
        let version = format!("v{number:03}");
        let directory = job.narration_dir().join(&version);
        match fs::create_dir(&directory) {
            Ok(()) => return Ok((version, directory)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(failed("narration_version_reserve_failed")),
        }
    }
    unreachable!("the narration version space is unbounded")
}

/// Loads the active immutable narration timeline, falling back to the legacy
/// unversioned timeline for jobs created before versioned narration publication.
pub fn read_narration_timeline(
    job: &JobContext,
) -> Result<Option<(PathBuf, NarrationTimelineV1)>, MainFootageError> {
    if let Some(active) = read_active(job)? {
        let root = fs::canonicalize(job.root()).map_err(|_| failed("job_root_unreadable"))?;
        let path = resolve_contained(&root, Path::new(&active.timeline_path))
            .map_err(|_| failed("narration_timeline_outside_job_root"))?;
        let timeline = read_timeline(&path)?;
        if timeline.fingerprint.as_deref() != Some(active.narration_fingerprint.as_str()) {
            return Err(failed("narration_active_fingerprint_mismatch"));
        }
        return Ok(Some((job.root().join(&active.timeline_path), timeline)));
    }

    let path = job.narration_timeline();
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some((path.clone(), read_timeline(&path)?)))
}

/// Publishes narration audio and its timeline as an immutable generation, then
/// atomically selects it. Re-publishing the active identity reuses that version.
pub fn write_narration_timeline(
    job: &JobContext,
    timeline: &NarrationTimelineV1,
) -> Result<PathBuf, MainFootageError> {
    let fingerprint = validated_fingerprint(timeline)?;
    if let Some((path, published)) = read_narration_timeline(job)? {
        if published.fingerprint.as_deref() == Some(fingerprint.as_str()) {
            return Ok(path);
        }
    }

    let root = fs::canonicalize(job.root()).map_err(|_| failed("job_root_unreadable"))?;
    let source_audio = resolve_contained(&root, Path::new(&timeline.audio_path))
        .map_err(|_| failed("narration_audio_outside_job_root"))?;
    if sha256_file(&source_audio)? != timeline.audio_checksum {
        return Err(failed("narration_audio_checksum_mismatch"));
    }
    let audio_bytes = fs::read(source_audio).map_err(|_| failed("narration_audio_unreadable"))?;
    let (version, directory) = reserve_version(job)?;
    let audio_path = directory.join("narration.mp3");
    write_immutable(&audio_path, &audio_bytes)
        .map_err(|_| failed("narration_audio_publish_failed"))?;

    let mut published = timeline.clone();
    published.audio_path = format!("narration/{version}/narration.mp3");
    let bytes =
        serde_json::to_vec_pretty(&published).map_err(|_| failed("timeline_not_serializable"))?;
    let timeline_path = directory.join("timeline.json");
    write_immutable(&timeline_path, &bytes)
        .map_err(|_| failed("narration_timeline_publish_failed"))?;
    let active_timeline_path = format!("narration/{version}/timeline.json");
    publish_active(
        job,
        &NarrationActiveV1 {
            schema_version: MAIN_FOOTAGE_SCHEMA_VERSION,
            version,
            timeline_path: active_timeline_path,
            narration_fingerprint: fingerprint,
        },
    )?;
    Ok(timeline_path)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{BeatPolicy, build_narration_timeline, write_narration_timeline};
    use crate::main_footage::{MainFootageErrorCode, NarrationTimelineV1};
    use crate::narration::Narration;
    use crate::pipeline::job::JobContext;
    use crate::transcribe::model::WordTimestamp;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("narration-timeline-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn word(text: &str, start_ms: i64, end_ms: i64) -> WordTimestamp {
        WordTimestamp {
            word: text.to_string(),
            start_ms,
            end_ms,
            probability: 1.0,
        }
    }

    /// Two short sentences followed by one long run that must be divided.
    fn narration_fixture() -> Narration {
        let dir = temp_dir();
        let mp3 = dir.join("narration.mp3");
        fs::write(&mp3, b"narration audio bytes").unwrap();

        let mut words = vec![
            word("Ini", 0, 400),
            word("kabar", 400, 900),
            word("buruk.", 900, 1500),
            word("Semua", 1500, 2000),
            word("orang", 2000, 2600),
            word("kaget.", 2600, 3200),
        ];
        // A ten-second unpunctuated run: one sentence, but longer than a beat.
        let mut cursor = 3200;
        for index in 0..20 {
            words.push(word(&format!("kata{index}"), cursor, cursor + 500));
            cursor += 500;
        }
        words.push(word("selesai.", cursor, cursor + 500));
        cursor += 500;

        Narration {
            mp3,
            words,
            duration_secs: cursor as f64 / 1000.0,
            hook: "Ini kabar buruk.".into(),
            text: "Ini kabar buruk. Semua orang kaget.".into(),
        }
    }

    #[test]
    fn words_become_stable_contiguous_beats() {
        let timeline =
            build_narration_timeline(&narration_fixture(), BeatPolicy::default()).unwrap();
        assert_eq!(timeline.beats[0].start_sec, 0.0);
        assert!(
            timeline
                .beats
                .windows(2)
                .all(|w| w[0].end_sec == w[1].start_sec)
        );
        assert_eq!(
            timeline.beats.last().unwrap().end_sec,
            timeline.duration_sec
        );
    }

    /// The audio keeps running after the final word — trailing silence, or a
    /// `duration_secs` longer than the timings. Beats must still cover
    /// `[0, duration_sec]`; a timeline that stops at the last word leaves the
    /// planner allocating against a narration shorter than the one it cuts to.
    #[test]
    fn the_last_beat_covers_the_audio_that_runs_past_the_final_word() {
        let mut narration = narration_fixture();
        let spoken_end = narration.words.last().unwrap().end_ms as f64 / 1000.0;
        narration.duration_secs = spoken_end + 3.0;

        let timeline = build_narration_timeline(&narration, BeatPolicy::default()).unwrap();
        assert_eq!(timeline.duration_sec, spoken_end + 3.0);
        assert_eq!(
            timeline.beats.last().unwrap().end_sec,
            timeline.duration_sec,
            "the last beat stops before the narration does"
        );
        assert_eq!(timeline.beats[0].start_sec, 0.0);
        assert!(
            timeline
                .beats
                .windows(2)
                .all(|w| w[0].end_sec == w[1].start_sec)
        );
    }

    #[test]
    fn beat_ids_are_sequential_and_zero_padded() {
        let timeline =
            build_narration_timeline(&narration_fixture(), BeatPolicy::default()).unwrap();
        assert!(timeline.beats.len() >= 3);
        assert_eq!(timeline.beats[0].id, "beat-001");
        assert_eq!(timeline.beats[1].id, "beat-002");
        for (index, beat) in timeline.beats.iter().enumerate() {
            assert_eq!(beat.id, format!("beat-{:03}", index + 1));
        }
    }

    #[test]
    fn sentence_punctuation_ends_a_beat() {
        let timeline =
            build_narration_timeline(&narration_fixture(), BeatPolicy::default()).unwrap();
        assert_eq!(timeline.beats[0].text, "Ini kabar buruk.");
        assert_eq!(timeline.beats[1].text, "Semua orang kaget.");
    }

    #[test]
    fn spans_longer_than_the_policy_divide_at_a_word_boundary() {
        let narration = narration_fixture();
        let policy = BeatPolicy::default();
        let timeline = build_narration_timeline(&narration, policy).unwrap();

        // Every beat fits the policy, and every boundary lands on a word edge.
        let edges: Vec<f64> = narration
            .words
            .iter()
            .map(|w| w.end_ms as f64 / 1000.0)
            .collect();
        for beat in &timeline.beats {
            assert!(
                beat.end_sec - beat.start_sec <= policy.max_beat_sec + f64::EPSILON,
                "{} ran {:.3}s, over the {}s policy",
                beat.id,
                beat.end_sec - beat.start_sec,
                policy.max_beat_sec
            );
        }
        for beat in &timeline.beats[..timeline.beats.len() - 1] {
            assert!(
                edges.iter().any(|edge| (edge - beat.end_sec).abs() < 1e-9),
                "{} ended off a word boundary",
                beat.id
            );
        }
        // The long unpunctuated run really did get divided.
        assert!(timeline.beats.len() > 3);
    }

    #[test]
    fn the_fingerprint_tracks_audio_and_words_but_not_the_beat_policy() {
        let narration = narration_fixture();
        let coarse =
            build_narration_timeline(&narration, BeatPolicy { max_beat_sec: 6.0 }).unwrap();
        let fine = build_narration_timeline(&narration, BeatPolicy { max_beat_sec: 2.0 }).unwrap();
        assert_ne!(coarse.beats.len(), fine.beats.len());
        assert_eq!(coarse.fingerprint, fine.fingerprint);

        let mut reworded = narration_fixture();
        reworded.words[0].word = "Itu".into();
        let changed = build_narration_timeline(&reworded, BeatPolicy::default()).unwrap();
        assert_ne!(coarse.fingerprint, changed.fingerprint);
    }

    #[test]
    fn a_narration_without_word_timings_is_narration_generation_failed() {
        let mut narration = narration_fixture();
        narration.words.clear();
        assert_eq!(
            build_narration_timeline(&narration, BeatPolicy::default())
                .unwrap_err()
                .code,
            MainFootageErrorCode::NarrationGenerationFailed
        );
    }

    #[test]
    fn changed_narration_activates_a_new_immutable_timeline_and_audio_version() {
        let job = JobContext::new_flat("narration".into(), temp_dir()).unwrap();
        fs::create_dir_all(job.narration_dir()).unwrap();
        fs::write(job.narration_mp3(), b"narration audio v1").unwrap();
        let mut narration = narration_fixture();
        narration.mp3 = job.narration_mp3();
        let timeline_v1 = build_narration_timeline(&narration, BeatPolicy::default()).unwrap();

        let path_v1 = write_narration_timeline(&job, &timeline_v1).unwrap();
        assert_eq!(path_v1, job.narration_dir().join("v001/timeline.json"));
        let timeline_v1_bytes = fs::read(&path_v1).unwrap();
        let audio_v1_path = job.narration_dir().join("v001/narration.mp3");
        let audio_v1_bytes = fs::read(&audio_v1_path).unwrap();
        let published_v1: NarrationTimelineV1 = serde_json::from_slice(&timeline_v1_bytes).unwrap();
        assert_eq!(published_v1.audio_path, "narration/v001/narration.mp3");
        assert_eq!(published_v1.beats.len(), timeline_v1.beats.len());
        assert_eq!(published_v1.fingerprint, timeline_v1.fingerprint);

        fs::write(job.narration_mp3(), b"narration audio v2").unwrap();
        narration.words[0].word = "Berubah".into();
        let timeline_v2 = build_narration_timeline(&narration, BeatPolicy::default()).unwrap();
        let path_v2 = write_narration_timeline(&job, &timeline_v2).unwrap();
        assert_eq!(path_v2, job.narration_dir().join("v002/timeline.json"));
        let published_v2: NarrationTimelineV1 =
            serde_json::from_slice(&fs::read(&path_v2).unwrap()).unwrap();
        assert_eq!(published_v2.audio_path, "narration/v002/narration.mp3");
        assert_eq!(
            fs::read(job.narration_dir().join("v002/narration.mp3")).unwrap(),
            b"narration audio v2"
        );

        assert_eq!(fs::read(&path_v1).unwrap(), timeline_v1_bytes);
        assert_eq!(fs::read(&audio_v1_path).unwrap(), audio_v1_bytes);
        assert_eq!(
            write_narration_timeline(&job, &timeline_v2).unwrap(),
            path_v2
        );

        let active: serde_json::Value =
            serde_json::from_slice(&fs::read(job.narration_dir().join("active.json")).unwrap())
                .unwrap();
        assert_eq!(
            active,
            serde_json::json!({
                "schema_version": 1,
                "version": "v002",
                "timeline_path": "narration/v002/timeline.json",
                "narration_fingerprint": timeline_v2.fingerprint.unwrap(),
            })
        );
    }
}
