//! Cross-runtime acceptance for the forced-URL planned main footage path.
//!
//! Scout writes the source package; Rust decodes it with `deny_unknown_fields`. Nothing
//! in either build fails when the two drift, so the drift has to be caught by decoding
//! bytes Scout actually produced. `tests/fixtures/scout_source_package.v1.json` was
//! captured from a real `buildSourcePackage` run (real ffmpeg media, real packaging,
//! fixture scene/vision ports) rather than typed by hand, and
//! `scout/main_footage/contracts.test.ts` pins the same file from the Scout side.
//! Re-capture it when Scout's shape changes; do not hand-edit it to make this pass.

use std::path::PathBuf;

use thoth_types::main_footage::{PlanningMode, SourcePackageV1, fingerprint_canonical};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/scout_source_package.v1.json")
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
/// `scout/main_footage/scene_index.ts::computeIndexChecksum`. `import_package` used to
/// verify it as a file digest, which rejected every genuine package. This pins the
/// property on real captured bytes so the assumption cannot come back.
#[test]
fn the_captured_index_checksum_is_not_the_digest_of_any_declared_artifact() {
    let bytes = std::fs::read(fixture_path()).expect("readable");
    let package: SourcePackageV1 = serde_json::from_slice(&bytes).expect("decodable");
    let index = package.scene_indexes.first().expect("a scene index");
    let source = package.sources.first().expect("a source");
    assert_ne!(
        index.checksum, source.checksum,
        "a scene index checksum that equals a file digest means the semantics moved"
    );
    assert!(
        index.path.ends_with("/index.json"),
        "the checksum belongs to an index file, not to the value it hashes"
    );
}
