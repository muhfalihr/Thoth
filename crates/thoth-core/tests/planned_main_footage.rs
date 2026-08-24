//! Cross-runtime acceptance for the forced-URL planned main footage path.
//!
//! Scout writes the source package; Rust imports it, the Scout planner allocates cuts
//! against it, and the Rust renderer turns the verified plan into a file. Nothing in
//! either build fails when the two runtimes drift, so the drift has to be caught by
//! running the real seam over bytes Scout actually produced.
//! `tests/fixtures/scout_package/` is a whole package captured from a real
//! `buildSourcePackage` run — real ffmpeg media, real probing, real scene indexing,
//! real frame extraction, real atomic publishing — by
//! `scout/main_footage/capture_fixture.ts`. `scout/main_footage/contracts.test.ts`
//! pins the same manifest from the Scout side. Re-capture it when Scout's shape
//! changes; do not hand-edit it to make anything here pass.
//!
//! Both production-breaking defects on this feature (Ruling AU: `SourceVideoV1`
//! rejecting the `bytes`/`acquisition` members Scout writes; `9c060e4`: import
//! comparing Scout's content fingerprint to `sha256(index.json)`) were invisible to
//! every test that drove typed values or fake ports through this seam. A third,
//! `verify.rs` demanding the same impossible sha256 fixed point, was found by writing
//! the end-to-end test below and is what it fails on if it comes back.

use std::path::{Path, PathBuf};
use std::process::Command;

use thoth_core::config::FfmpegConfig;
use thoth_core::edit::ffmpeg::AudioOptions;
use thoth_core::edit::layout::OutputLayout;
use thoth_core::edit::planned::PlannedFfmpegRenderer;
use thoth_core::execution::JobExecutionContext;
use thoth_core::main_footage::{MainFootageCoordinator, MainFootagePrepareInput, import_package};
use thoth_core::pipeline::PlannedMainRenderer;
use thoth_core::pipeline::job::JobContext;
use thoth_types::main_footage::{
    MainFootageDescriptor, MainFootageMode, NarrationTimelineV1, PlanningMode, SourcePackageV1,
    fingerprint_canonical,
};

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/scout_package")
}

fn fixture_path() -> PathBuf {
    fixture_root().join("main-footage/v001/package.json")
}

fn test_only_offline_planner_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../scout/main_footage/test_support/offline_plan_cli.ts")
}

#[test]
fn a_package_scout_actually_wrote_decodes_and_fingerprints_identically_in_rust() {
    let bytes = std::fs::read(fixture_path()).expect("the captured Scout package must be readable");
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).expect("the captured Scout package must be JSON");
    let package: SourcePackageV1 = serde_json::from_value(value.clone()).unwrap_or_else(|error| {
        panic!(
            "Rust rejected a package Scout wrote — the cross-runtime contract has drifted: {error}"
        )
    });

    // Both runtimes must derive the same identity from the same bytes, or resume,
    // generation selection and plan verification all key off different values.
    let declared = package
        .fingerprint
        .as_deref()
        .expect("Scout publishes a fingerprint");
    assert_eq!(
        fingerprint_canonical(&value).expect("fingerprintable"),
        declared,
        "Rust's canonical fingerprint no longer agrees with the one Scout published"
    );

    // The parts the planner cannot work without, and the part that proves a mixed
    // carousel was really packaged rather than a hand-typed single video.
    let source = package
        .sources
        .first()
        .expect("the capture must carry a usable source");
    assert!(source.path.starts_with("sources/"));
    assert!(source.checksum.starts_with("sha256:"));
    assert!(source.technical.has_audio);
    let index = package
        .scene_indexes
        .first()
        .expect("the capture must carry a scene index");
    assert_eq!(index.source_id, source.id);
    assert!(matches!(index.planning_mode, PlanningMode::Vision));
    assert!(
        index.scenes.len() >= 2,
        "the capture must retain more than one scene, or scene selection is untested here"
    );
    assert!(
        !package.ignored.is_empty(),
        "the capture must retain the ignored non-video outcome"
    );
}

/// Scout's `SceneIndexV1.checksum` is a content fingerprint over evidence and artifact
/// bytes, never the digest of `index.json` — see
/// `scout/main_footage/scene_index.ts::computeIndexChecksum`. Both `import_package` and
/// `verify.rs` used to verify it as a file digest, which rejected every genuine package.
/// This pins the property on the real captured file so the assumption cannot come back.
#[test]
fn the_captured_index_checksum_is_not_the_digest_of_the_index_file() {
    let bytes = std::fs::read(fixture_path()).expect("readable");
    let package: SourcePackageV1 = serde_json::from_slice(&bytes).expect("decodable");
    let index = package.scene_indexes.first().expect("a scene index");
    let index_bytes = std::fs::read(fixture_root().join("main-footage/v001").join(&index.path))
        .expect("the captured index file must be readable");
    assert_ne!(
        index.checksum,
        format!(
            "sha256:{:x}",
            <sha2::Sha256 as sha2::Digest>::digest(&index_bytes)
        ),
        "a scene index checksum that equals the digest of its own file means the \
         semantics moved — the code that assumed this was the third defect on this seam"
    );
    assert!(
        index.path.ends_with("/index.json"),
        "the checksum belongs to an index file, not to the value it hashes"
    );
}

// ── The import → plan → render seam ───────────────────────────────────────────────

const FFMPEG_REQUIRED: &str = "no ffmpeg binary found — set FFMPEG_PATH or put ffmpeg \
     next to the repo root (see CLAUDE.md); the end-to-end acceptance test cannot be \
     skipped silently";

fn repo_binary(name: &str) -> Option<PathBuf> {
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let mut dir = Some(Path::new(env!("CARGO_MANIFEST_DIR")));
    while let Some(current) = dir {
        let candidate = current.join(&file);
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = current.parent();
    }
    None
}

fn run_tool(binary: &Path, args: &[&str]) {
    let output = Command::new(binary)
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

fn probe_json(ffprobe: &Path, media: &Path) -> String {
    let output = Command::new(ffprobe)
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

/// The captured source is two 3 s scenes of one harbour vocabulary. Two beats that
/// speak it back give the candidate builder an `exact` tier match per beat, so cut
/// selection is decided by the fixture rather than by the shortlist ranking that a
/// live run would send to a model.
fn narration_timeline(job: &JobContext, ffmpeg: &Path) -> NarrationTimelineV1 {
    let audio = job.narration_dir().join("narration.mp3");
    std::fs::create_dir_all(job.narration_dir()).expect("narration dir");
    run_tool(
        ffmpeg,
        &[
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=220:duration=6",
            audio.to_str().unwrap(),
        ],
    );
    let checksum = format!(
        "sha256:{:x}",
        <sha2::Sha256 as sha2::Digest>::digest(std::fs::read(&audio).expect("narration audio"))
    );
    let beats = serde_json::json!([
        {"id": "beat-0001", "start_sec": 0.0, "end_sec": 3.0,
         "text": "the harbour crane swings over the dock"},
        {"id": "beat-0002", "start_sec": 3.0, "end_sec": 6.0,
         "text": "a wide panning shot of the harbour dock"}
    ]);
    let mut timeline: NarrationTimelineV1 = serde_json::from_value(serde_json::json!({
        "schema_version": 1,
        "audio_path": "narration/narration.mp3",
        "audio_checksum": checksum,
        "duration_sec": 6.0,
        "words": [
            {"text": "the harbour crane swings over the dock", "start_sec": 0.0, "end_sec": 3.0},
            {"text": "a wide panning shot of the harbour dock", "start_sec": 3.0, "end_sec": 6.0}
        ],
        "beats": beats,
    }))
    .expect("the narration fixture must satisfy the typed contract");
    // The narration projection ignores `fingerprint`, so signing after the fact
    // yields the value both runtimes recompute from the published bytes.
    timeline.fingerprint = Some(
        fingerprint_canonical(&serde_json::to_value(&timeline).expect("serializable"))
            .expect("fingerprintable"),
    );
    std::fs::write(
        job.narration_timeline(),
        serde_json::to_vec_pretty(&timeline).expect("serializable"),
    )
    .expect("the planner reads the timeline from disk");
    std::fs::remove_file(job.narration_timeline()).expect("remove legacy narration fixture");
    thoth_core::narration::timeline::write_narration_timeline(job, &timeline)
        .expect("the versioned narration must publish");
    thoth_core::narration::timeline::read_narration_timeline(job)
        .expect("the active narration pointer must be readable")
        .expect("the active narration timeline must exist")
        .1
}

/// The one test that runs the real forced-URL seam end to end: a package Scout wrote
/// goes in, a playable file comes out.
///
/// Every leg is production code. `import_package` copies and verifies the real
/// artifacts; the test-only injected Scout entry point calls the production planner
/// implementation with just its two model-facing providers substituted. It builds candidates, allocates the
/// timeline and cuts real media with ffmpeg; the durability gate re-verifies every
/// checksum and probes every cut with the real ffprobe; and the real
/// `PlannedFfmpegRenderer` encodes the result. Nothing is faked but the two ports a
/// live planner would send to a model. The assertion is on the rendered file, so
/// a fake that produced no cuts could not satisfy it.
#[tokio::test]
async fn a_captured_scout_package_imports_plans_and_renders_a_playable_file() {
    let ffmpeg = repo_binary("ffmpeg").expect(FFMPEG_REQUIRED);
    let ffprobe = repo_binary("ffprobe").expect(FFMPEG_REQUIRED);
    // SAFETY: set before anything in this test spawns a child, and read by the
    // verifier and the planner process rather than by another thread. `ffprobe_binary`
    // otherwise resolves the bundled sidecar, which this repo does not install.
    unsafe {
        std::env::set_var("THOTH_FFPROBE", &ffprobe);
        std::env::set_var("THOTH_FFMPEG", &ffmpeg);
    }

    let root = std::env::temp_dir().join(format!("mf-acceptance-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("job root");
    let job = JobContext::new_flat("acceptance".into(), root.clone()).expect("job context");
    let execution = JobExecutionContext::new();
    let narration = narration_timeline(&job, &ffmpeg);

    let descriptor = MainFootageDescriptor {
        mode: MainFootageMode::ForcedUrlPool,
        package_manifest: "main-footage/v001/package.json".to_owned(),
        external_sources_manifest: None,
        coverage_target: 0.6,
    };
    // Only the Content Set's *directory* is used, to resolve the manifest the way a
    // real run does; the fixture tree is read, never written.
    let imported = import_package(
        &fixture_root().join("content-set.json"),
        &descriptor,
        &job,
        &fixture_root(),
        &execution,
    )
    .expect("Rust must import a package Scout actually wrote");

    let verified = MainFootageCoordinator::prepare_with_test_only_planner_script(
        &job,
        MainFootagePrepareInput {
            imported: &imported,
            coverage_target: descriptor.coverage_target,
        },
        &narration,
        &execution,
        &test_only_offline_planner_script(),
    )
    .await
    .expect("the real Scout planner must produce a plan this job verifies");

    assert!(
        verified.metrics().main_coverage_ratio >= descriptor.coverage_target,
        "the verified plan must meet the coverage it was asked for: {:?}",
        verified.metrics()
    );

    let renderer = PlannedFfmpegRenderer::new(&FfmpegConfig {
        ffmpeg_path: Some(ffmpeg.to_string_lossy().into_owned()),
        nvenc: false,
        cq_value: 28,
        preset: "ultrafast".to_owned(),
        audio_bitrate: "128k".to_owned(),
    });
    let result = PlannedMainRenderer::render(
        &renderer,
        &job,
        &verified,
        &narration,
        &OutputLayout::Vertical,
        &AudioOptions::default(),
        "thoth",
        "vertical-punch",
        &execution,
    )
    .await
    .expect("the verified plan must render");

    let clip = &result.output_clips[0];
    assert!(clip.path.is_file(), "{}", clip.path.display());
    let report = probe_json(&ffprobe, &clip.path);
    let rendered = probed_duration(&report);
    assert!(
        (rendered - narration.duration_sec).abs() < 0.3,
        "the render must span the narration, not the source: {rendered:.3}s, {report}"
    );
    assert!(report.contains("\"video\""), "{report}");
    assert!(report.contains("\"audio\""), "{report}");
    assert!(
        report.contains("1080") && report.contains("1920"),
        "{report}"
    );

    let plan_v1_path = root.join("plans/v001/main-footage-plan.json");
    let timeline_v1_path = root.join("narration/v001/timeline.json");
    let audio_v1_path = root.join("narration/v001/narration.mp3");
    let plan_v1_bytes = std::fs::read(&plan_v1_path).expect("v1 plan");
    let timeline_v1_bytes = std::fs::read(&timeline_v1_path).expect("v1 timeline");
    let audio_v1_bytes = std::fs::read(&audio_v1_path).expect("v1 audio");

    let staging_audio = job.narration_mp3();
    run_tool(
        &ffmpeg,
        &[
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=6",
            staging_audio.to_str().unwrap(),
        ],
    );
    let mut narration_v2 = narration.clone();
    narration_v2.audio_path = "narration/narration.mp3".to_owned();
    narration_v2.audio_checksum = format!(
        "sha256:{:x}",
        <sha2::Sha256 as sha2::Digest>::digest(
            std::fs::read(&staging_audio).expect("changed narration audio")
        )
    );
    narration_v2.words[0].text = "updated harbour crane swings over dock".to_owned();
    narration_v2.beats[0].text = "updated harbour crane swings over dock".to_owned();
    narration_v2.fingerprint = None;
    narration_v2.fingerprint = Some(
        fingerprint_canonical(&serde_json::to_value(&narration_v2).expect("serializable"))
            .expect("fingerprintable"),
    );
    thoth_core::narration::timeline::write_narration_timeline(&job, &narration_v2)
        .expect("changed narration must publish v2");
    let narration_v2 = thoth_core::narration::timeline::read_narration_timeline(&job)
        .expect("active v2 pointer must be readable")
        .expect("active v2 timeline must exist")
        .1;

    let verified_v2 = MainFootageCoordinator::prepare_with_test_only_planner_script(
        &job,
        MainFootagePrepareInput {
            imported: &imported,
            coverage_target: descriptor.coverage_target,
        },
        &narration_v2,
        &execution,
        &test_only_offline_planner_script(),
    )
    .await
    .expect("changed narration must plan and verify v2 through Scout");

    assert_eq!(verified_v2.version(), "v002");
    assert_eq!(std::fs::read(&plan_v1_path).unwrap(), plan_v1_bytes);
    assert_eq!(std::fs::read(&timeline_v1_path).unwrap(), timeline_v1_bytes);
    assert_eq!(std::fs::read(&audio_v1_path).unwrap(), audio_v1_bytes);
    assert_eq!(narration_v2.audio_path, "narration/v002/narration.mp3");

    let _ = std::fs::remove_dir_all(&root);
}
