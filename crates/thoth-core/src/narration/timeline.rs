//! Turns a produced narration into the beat timeline the cut planner allocates
//! footage against.
//!
//! `Narration` stays the owner of the voiceover audio and its word timings; this
//! module only segments those already-stable timings and persists the result.
//! Nothing here generates a script or calls TTS.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use thoth_types::main_footage::MAIN_FOOTAGE_SCHEMA_VERSION;

use crate::main_footage::paths::write_immutable;
use crate::main_footage::{
    fingerprint_canonical, MainFootageError, MainFootageErrorCode, NarrationBeatV1,
    NarrationTimelineV1, NarrationWordV1,
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
    for (position, (from, to)) in groups.iter().copied().enumerate() {
        let start_sec = beats.last().map_or(0.0, |beat: &NarrationBeatV1| beat.end_sec);
        let end_sec = if position + 1 == groups.len() {
            duration_sec
        } else {
            words[to - 1].end_sec
        };
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
    if beats.is_empty() {
        return Err(failed("narration_produced_no_beats"));
    }

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
    let value =
        serde_json::to_value(&timeline).map_err(|_| failed("timeline_not_serializable"))?;
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

/// Publishes the timeline into the job, atomically and exactly once. A rerun that
/// reuses the same narration audio keeps the published timeline; one that would
/// contradict it is refused rather than silently overwriting.
pub fn write_narration_timeline(
    job: &JobContext,
    timeline: &NarrationTimelineV1,
) -> Result<PathBuf, MainFootageError> {
    let path = job.narration_timeline();
    if path.exists() {
        let published: NarrationTimelineV1 = serde_json::from_slice(
            &std::fs::read(&path).map_err(|_| failed("narration_timeline_unreadable"))?,
        )
        .map_err(|_| failed("narration_timeline_unreadable"))?;
        if published.audio_checksum != timeline.audio_checksum {
            return Err(failed("narration_timeline_already_published"));
        }
        return Ok(path);
    }
    let bytes =
        serde_json::to_vec_pretty(timeline).map_err(|_| failed("timeline_not_serializable"))?;
    write_immutable(&path, &bytes).map_err(|_| failed("narration_timeline_publish_failed"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::{build_narration_timeline, write_narration_timeline, BeatPolicy};
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
        let timeline = build_narration_timeline(&narration_fixture(), BeatPolicy::default()).unwrap();
        assert_eq!(timeline.beats[0].start_sec, 0.0);
        assert!(timeline
            .beats
            .windows(2)
            .all(|w| w[0].end_sec == w[1].start_sec));
        assert_eq!(timeline.beats.last().unwrap().end_sec, timeline.duration_sec);
    }

    #[test]
    fn beat_ids_are_sequential_and_zero_padded() {
        let timeline = build_narration_timeline(&narration_fixture(), BeatPolicy::default()).unwrap();
        assert!(timeline.beats.len() >= 3);
        assert_eq!(timeline.beats[0].id, "beat-001");
        assert_eq!(timeline.beats[1].id, "beat-002");
        for (index, beat) in timeline.beats.iter().enumerate() {
            assert_eq!(beat.id, format!("beat-{:03}", index + 1));
        }
    }

    #[test]
    fn sentence_punctuation_ends_a_beat() {
        let timeline = build_narration_timeline(&narration_fixture(), BeatPolicy::default()).unwrap();
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
        let coarse = build_narration_timeline(&narration, BeatPolicy { max_beat_sec: 6.0 }).unwrap();
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
    fn the_published_timeline_round_trips_and_is_never_overwritten() {
        let job = JobContext::new_flat("narration".into(), temp_dir()).unwrap();
        fs::create_dir_all(job.narration_dir()).unwrap();
        let timeline = build_narration_timeline(&narration_fixture(), BeatPolicy::default()).unwrap();

        let path = write_narration_timeline(&job, &timeline).unwrap();
        let published: NarrationTimelineV1 =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(published.beats.len(), timeline.beats.len());
        assert_eq!(published.fingerprint, timeline.fingerprint);

        // The same narration audio reuses the published artifact...
        assert_eq!(write_narration_timeline(&job, &timeline).unwrap(), path);
        // ...but a different narration must not silently replace it.
        let mut other = timeline.clone();
        other.audio_checksum = format!("sha256:{}", "0".repeat(64));
        assert_eq!(
            write_narration_timeline(&job, &other).unwrap_err().code,
            MainFootageErrorCode::NarrationGenerationFailed
        );
        assert_eq!(
            serde_json::from_slice::<NarrationTimelineV1>(&fs::read(&path).unwrap())
                .unwrap()
                .audio_checksum,
            timeline.audio_checksum
        );
    }
}
