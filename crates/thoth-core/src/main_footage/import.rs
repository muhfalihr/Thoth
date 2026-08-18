//! Imports a Scout-published forced source package into the job directory.
//!
//! After this runs the job owns every byte it will render from: the source
//! videos, the scene indexes, their representative frames and embeddings, and a
//! manifest addressing all of them by slash-separated paths relative to
//! `job.main_footage_dir()`. Nothing in the job-owned manifest points back at
//! Scout, so renaming or deleting the Scout package cannot break the run.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use sha2::{Digest, Sha256};

use crate::execution::JobExecutionContext;
use crate::main_footage::paths::{import_file, resolve_contained, write_immutable};
use crate::main_footage::{
    fingerprint_canonical, MainFootageDescriptor, MainFootageError, MainFootageErrorCode,
    SourcePackageV1,
};
use crate::pipeline::job::JobContext;

/// A forced source package the job now owns outright.
#[derive(Debug, Clone)]
pub struct ImportedSourcePackage {
    /// Job-owned root every path in `package` is relative to.
    pub root: PathBuf,
    /// Where the job-owned manifest was published.
    pub manifest_path: PathBuf,
    /// The verified package, with its original relative paths intact.
    pub package: SourcePackageV1,
    /// Canonical fingerprint of the imported package.
    pub fingerprint: String,
}

fn invalid(detail: &str) -> MainFootageError {
    MainFootageError::new(MainFootageErrorCode::SourcePackageInvalid, detail)
}

fn sha256_file(path: &Path) -> Result<String, MainFootageError> {
    let bytes = fs::read(path).map_err(|_| invalid("artifact_unreadable"))?;
    let mut hash = Sha256::new();
    hash.update(&bytes);
    Ok(format!("sha256:{:x}", hash.finalize()))
}

/// Copies (or hardlinks) one declared artifact from the Scout package into the
/// job root at the same relative path. Already-present artifacts are left alone
/// — every published artifact is immutable, so a repeat import is a no-op.
///
/// Cancellation is honoured *after* the artifact is atomically published, so a
/// cancelled import stops on a whole checkpoint: no partial file, and — because
/// the manifest is written last — no manifest claiming the package is complete.
fn import_artifact(
    execution: &JobExecutionContext,
    package_root: &Path,
    job_root: &Path,
    relative: &str,
) -> Result<PathBuf> {
    let relative = Path::new(relative);
    let source = resolve_contained(package_root, relative)
        .map_err(|_| invalid("declared_artifact_outside_package"))?;
    let destination = job_root.join(relative);
    let parent = destination
        .parent()
        .ok_or_else(|| invalid("artifact_path_must_be_relative"))?;
    fs::create_dir_all(parent).map_err(|_| invalid("job_root_not_writable"))?;
    // Re-derive the destination through the containment helper now that its
    // parent exists, so a symlinked directory cannot redirect the write.
    let destination = resolve_contained(job_root, relative)
        .map_err(|_| invalid("declared_artifact_outside_job_root"))?;
    if !destination.exists() {
        import_file(&source, &destination).map_err(|_| invalid("artifact_import_failed"))?;
    }
    execution.check_cancelled()?;
    Ok(destination)
}

fn verify_checksum(path: &Path, expected: &str) -> Result<(), MainFootageError> {
    if sha256_file(path)? != expected {
        return Err(invalid("artifact_checksum_mismatch"));
    }
    Ok(())
}

/// Resolves, verifies, and imports the package `descriptor` points at.
///
/// The manifest is located relative to the Content Set's own directory and must
/// canonicalize inside `scout_output_root`. The job-owned manifest is published
/// last, so a run interrupted part way leaves verified artifacts on disk but no
/// manifest claiming they are complete.
///
/// Two distinct fingerprints are involved and neither substitutes for the other:
/// the *Scout* fingerprint verifies Scout's declaration against Scout's own raw
/// bytes (the package arrived intact), while the *manifest* fingerprint is
/// recomputed over the decoded contract and stored in the job-owned manifest, so
/// it is re-derivable from exactly the bytes this function publishes.
pub fn import_package(
    content_set_path: &Path,
    descriptor: &MainFootageDescriptor,
    job: &JobContext,
    scout_output_root: &Path,
    execution: &JobExecutionContext,
) -> Result<ImportedSourcePackage> {
    let content_set_parent = content_set_path
        .parent()
        .ok_or_else(|| invalid("content_set_has_no_parent"))?;
    let scout_root =
        fs::canonicalize(scout_output_root).map_err(|_| invalid("scout_output_root_missing"))?;
    let manifest_path = resolve_contained(
        content_set_parent,
        Path::new(&descriptor.package_manifest),
    )
    .map_err(|_| invalid("package_manifest_path_rejected"))?;
    if !manifest_path.starts_with(&scout_root) {
        return Err(invalid("package_outside_scout_output").into());
    }

    let raw = fs::read(&manifest_path).map_err(|_| invalid("package_manifest_unreadable"))?;
    let value: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|_| invalid("package_manifest_not_json"))?;
    let package: SourcePackageV1 =
        serde_json::from_value(value.clone()).map_err(|_| invalid("package_manifest_rejected"))?;
    // Check 1 — over Scout's raw bytes: the package arrived intact.
    let scout_fingerprint =
        fingerprint_canonical(&value).map_err(|_| invalid("fingerprint_failed"))?;
    if let Some(declared) = package.fingerprint.as_deref() {
        if declared != scout_fingerprint {
            return Err(invalid("package_fingerprint_mismatch").into());
        }
    }

    // Every usable source must carry a scene index, otherwise the planner has
    // nothing to allocate narration beats against.
    for source in &package.sources {
        if !package
            .scene_indexes
            .iter()
            .any(|index| index.source_id == source.id)
        {
            return Err(invalid("scene_index_missing_for_source").into());
        }
    }

    let package_root = manifest_path
        .parent()
        .ok_or_else(|| invalid("package_manifest_has_no_parent"))?;
    let job_root = job.main_footage_dir();
    fs::create_dir_all(&job_root).map_err(|_| invalid("job_root_not_writable"))?;
    // Canonical from here on, so every path the caller later resolves against
    // `root` is comparable with what `resolve_contained` hands back.
    let job_root = fs::canonicalize(&job_root).map_err(|_| invalid("job_root_not_writable"))?;

    for source in &package.sources {
        let imported = import_artifact(execution, package_root, &job_root, &source.path)?;
        verify_checksum(&imported, &source.checksum)?;
    }

    for index in &package.scene_indexes {
        let imported = import_artifact(execution, package_root, &job_root, &index.path)?;
        verify_checksum(&imported, &index.checksum)?;
        for scene in &index.scenes {
            import_artifact(execution, package_root, &job_root, &scene.representative_frame)?;
            // A `degraded` scene with no evidence at all legitimately carries no
            // embedding; import what is declared and nothing more.
            if let Some(embedding_path) = scene.embedding_path.as_deref() {
                import_artifact(execution, package_root, &job_root, embedding_path)?;
            }
        }
    }

    // Published last, and re-serialized from the decoded contract so no Scout
    // location can ride along.
    let mut owned = package.clone();
    owned.fingerprint = None;
    // Check 2 — over the decoded contract: whoever reads the published manifest
    // can recompute this value from those same bytes. Hashing Scout's raw JSON
    // here would not survive the round trip (an integer `duration_sec` comes back
    // out of the `f64` contract field as `12.0`).
    let decoded =
        serde_json::to_value(&owned).map_err(|_| invalid("manifest_not_serializable"))?;
    let fingerprint =
        fingerprint_canonical(&decoded).map_err(|_| invalid("fingerprint_failed"))?;
    owned.fingerprint = Some(fingerprint.clone());
    let manifest_bytes =
        serde_json::to_vec_pretty(&owned).map_err(|_| invalid("manifest_not_serializable"))?;
    let job_manifest = job.source_package_manifest();
    if job_manifest.exists() {
        // Fail closed: an identical manifest means this is an idempotent rerun,
        // anything else means the job already owns a different package and the
        // caller must not be handed this one as if it had been published.
        let published =
            fs::read(&job_manifest).map_err(|_| invalid("published_manifest_unreadable"))?;
        if published != manifest_bytes {
            return Err(invalid("published_manifest_conflicts_with_package").into());
        }
    } else {
        write_immutable(&job_manifest, &manifest_bytes)
            .map_err(|_| invalid("manifest_publish_failed"))?;
    }

    Ok(ImportedSourcePackage {
        root: job_root,
        manifest_path: job_manifest,
        package: owned,
        fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use serde_json::{json, Value};

    use super::{import_package, ImportedSourcePackage};
    use crate::execution::JobExecutionContext;
    use crate::main_footage::{MainFootageDescriptor, MainFootageError, MainFootageErrorCode};
    use crate::pipeline::job::JobContext;

    /// The typed package error behind an `anyhow` failure. `import_package`
    /// returns `anyhow` so a cancellation keeps its own `Cancelled` type instead
    /// of being relabelled as an invalid package.
    fn package_error(error: &anyhow::Error) -> &MainFootageError {
        error
            .downcast_ref::<MainFootageError>()
            .unwrap_or_else(|| panic!("expected a MainFootageError, got: {error:#}"))
    }

    struct Fixture {
        scout_root: PathBuf,
        package_dir: PathBuf,
        content_set: PathBuf,
        job_base: PathBuf,
    }

    fn digest(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut hash = Sha256::new();
        hash.update(bytes);
        format!("sha256:{:x}", hash.finalize())
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    /// A realistic Scout package: one source video, one generation-suffixed
    /// scene index, a representative frame, and an embedding.
    fn fixture() -> Fixture {
        let base = std::env::temp_dir().join(format!("mf-import-{}", uuid::Uuid::new_v4()));
        let scout_root = base.join("scout/output");
        let package_dir = scout_root.join("main-footage/post-123");
        let job_base = base.join("job");
        fs::create_dir_all(&job_base).unwrap();

        let source_bytes = b"immutable source video bytes".to_vec();
        write(&package_dir.join("sources/source-0.mp4"), &source_bytes);
        let frame = package_dir.join("scene-index/source-0/cache-a/v002/frame-000.jpg");
        write(&frame, b"frame bytes");
        let embedding = package_dir.join("scene-index/source-0/cache-a/v002/embed-000.json");
        write(&embedding, b"[0.1,0.2]");

        let index_bytes = br#"{"scenes":[{"id":"scene-0"}]}"#.to_vec();
        let index_path = package_dir.join("scene-index/source-0/cache-a/v002/index.json");
        write(&index_path, &index_bytes);

        let package = json!({
            "schema_version": 1,
            "post": {
                "id": "post-123",
                "canonical_url": "https://www.instagram.com/reel/post-123/",
                "platform": "instagram"
            },
            "analysis_identity": "analysis-2026-08-14",
            "created_at": "2026-08-14T12:00:00Z",
            "sources": [{
                "id": "source-0",
                "media_index": 0,
                "path": "sources/source-0.mp4",
                "checksum": digest(&source_bytes),
                "technical": {
                    "container": "mp4",
                    "video_codec": "h264",
                    "duration_sec": 12.5,
                    "width": 1080,
                    "height": 1920,
                    "has_audio": true
                }
            }],
            "ignored": [],
            "unavailable": [],
            "scene_indexes": [{
                "source_id": "source-0",
                "path": "scene-index/source-0/cache-a/v002/index.json",
                "checksum": digest(&index_bytes),
                "planning_mode": "vision",
                "scenes": [{
                    "id": "scene-0",
                    "start_sec": 0,
                    "end_sec": 4,
                    "representative_frame": "scene-index/source-0/cache-a/v002/frame-000.jpg",
                    "transcript_evidence": "A person addresses the camera.",
                    "vision_description": "A person in a studio.",
                    "embedding_path": "scene-index/source-0/cache-a/v002/embed-000.json",
                    "visual_metrics": {
                        "motion_score": 0.2,
                        "brightness": 0.6,
                        "scene_change_score": 0.1
                    }
                }]
            }]
        });
        write(
            &package_dir.join("source-package.json"),
            serde_json::to_string_pretty(&package).unwrap().as_bytes(),
        );

        let content_set = scout_root.join("thoth_content_set.json");
        write(&content_set, b"{}");

        Fixture {
            scout_root,
            package_dir,
            content_set,
            job_base,
        }
    }

    /// Rewrites the fixture's manifest with `mutate` applied.
    fn remanifest(fixture: &Fixture, mutate: impl FnOnce(&mut Value)) {
        let path = fixture.package_dir.join("source-package.json");
        let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        mutate(&mut value);
        fs::write(&path, serde_json::to_string_pretty(&value).unwrap()).unwrap();
    }

    fn descriptor() -> MainFootageDescriptor {
        serde_json::from_value(json!({
            "mode": "forced_url_pool",
            "package_manifest": "main-footage/post-123/source-package.json",
            "coverage_target": 0.6
        }))
        .unwrap()
    }

    fn run(fixture: &Fixture) -> anyhow::Result<ImportedSourcePackage> {
        let job = JobContext::new_flat("forced".into(), fixture.job_base.clone()).unwrap();
        import_package(
            &fixture.content_set,
            &descriptor(),
            &job,
            &fixture.scout_root,
            &JobExecutionContext::new(),
        )
    }

    #[test]
    fn valid_package_becomes_job_owned_artifacts_and_a_manifest() {
        let fixture = fixture();
        let imported = run(&fixture).unwrap();

        for relative in [
            "sources/source-0.mp4",
            "scene-index/source-0/cache-a/v002/index.json",
            "scene-index/source-0/cache-a/v002/frame-000.jpg",
            "scene-index/source-0/cache-a/v002/embed-000.json",
        ] {
            let resolved =
                crate::main_footage::resolve_contained(&imported.root, Path::new(relative))
                    .unwrap_or_else(|e| panic!("{relative} did not resolve inside the job: {e}"));
            assert!(resolved.exists(), "{relative} was not imported");
            assert!(resolved.starts_with(&imported.root));
        }

        assert!(imported.manifest_path.exists());
        // The job's manifest must not point back at Scout's tree — the whole
        // point of the import is that the job can be replayed after Scout's
        // output is gone. Checked against the fixture's *absolute* Scout root,
        // since every contract path is relative and would never contain it by
        // accident.
        let manifest = fs::read_to_string(&imported.manifest_path).unwrap();
        // Compared with separators normalised, so a leak cannot hide behind a
        // JSON-escaped backslash or a `\\?\` verbatim prefix.
        let manifest_paths = manifest.replace("\\\\", "/").replace('\\', "/");
        let scout_root = fixture.scout_root.to_string_lossy().replace('\\', "/");
        assert!(
            !manifest_paths.contains(scout_root.as_str()),
            "job manifest retained the Scout root {scout_root}: {manifest}"
        );
        assert_eq!(imported.package.fingerprint.as_deref(), Some(imported.fingerprint.as_str()));
    }

    #[test]
    fn imported_sources_outlive_the_scout_package() {
        let fixture = fixture();
        let imported = run(&fixture).unwrap();
        let source = imported.root.join("sources/source-0.mp4");
        let bytes = fs::read(&source).unwrap();

        fs::rename(
            &fixture.package_dir,
            fixture.package_dir.with_file_name("post-123-archived"),
        )
        .unwrap();

        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert!(imported.manifest_path.exists());
    }

    #[test]
    fn source_checksum_mismatch_is_source_package_invalid() {
        let fixture = fixture();
        remanifest(&fixture, |value| {
            value["sources"][0]["checksum"] = json!(format!("sha256:{}", "0".repeat(64)));
        });
        assert_eq!(
            package_error(&run(&fixture).unwrap_err()).code,
            MainFootageErrorCode::SourcePackageInvalid
        );
    }

    #[test]
    fn a_source_without_a_scene_index_is_source_package_invalid() {
        let fixture = fixture();
        remanifest(&fixture, |value| {
            value["scene_indexes"] = json!([]);
        });
        assert_eq!(
            package_error(&run(&fixture).unwrap_err()).code,
            MainFootageErrorCode::SourcePackageInvalid
        );
    }

    #[test]
    fn a_missing_scene_index_artifact_is_source_package_invalid() {
        let fixture = fixture();
        fs::remove_file(
            fixture
                .package_dir
                .join("scene-index/source-0/cache-a/v002/index.json"),
        )
        .unwrap();
        assert_eq!(
            package_error(&run(&fixture).unwrap_err()).code,
            MainFootageErrorCode::SourcePackageInvalid
        );
    }

    #[test]
    fn a_failed_import_publishes_no_manifest_but_keeps_verified_checkpoints() {
        let fixture = fixture();
        // The source verifies and is imported; the scene index artifact is gone,
        // so the import aborts before the manifest is published.
        fs::remove_file(
            fixture
                .package_dir
                .join("scene-index/source-0/cache-a/v002/index.json"),
        )
        .unwrap();
        let job = JobContext::new_flat("forced".into(), fixture.job_base.clone()).unwrap();
        assert!(import_package(
            &fixture.content_set,
            &descriptor(),
            &job,
            &fixture.scout_root,
            &JobExecutionContext::new(),
        )
        .is_err());

        assert!(
            job.main_footage_dir().join("sources/source-0.mp4").exists(),
            "an already-published checkpoint was rolled back"
        );
        assert!(
            !job.source_package_manifest().exists(),
            "an inconsistent manifest was published"
        );
        // No partial temp file was left visible either.
        let sources = fs::read_dir(job.main_footage_dir().join("sources")).unwrap();
        for entry in sources {
            let name = entry.unwrap().file_name();
            assert!(
                !name.to_string_lossy().ends_with(".tmp"),
                "a temporary import artifact leaked: {name:?}"
            );
        }
    }

    #[test]
    fn a_degraded_scene_without_an_embedding_imports_faithfully() {
        let fixture = fixture();
        remanifest(&fixture, |value| {
            value["scene_indexes"][0]["planning_mode"] = json!("degraded");
            value["scene_indexes"][0]["scenes"][0]
                .as_object_mut()
                .unwrap()
                .remove("embedding_path");
            value["scene_indexes"][0]["scenes"][0]["vision_description"] = Value::Null;
        });
        // The index checksum in the manifest still describes the on-disk index
        // file, which the mutation above did not touch.
        let imported = run(&fixture).unwrap();
        let index = &imported.package.scene_indexes[0];
        assert_eq!(index.planning_mode, crate::main_footage::PlanningMode::Degraded);
        assert!(index.scenes[0].embedding_path.is_none());
        assert!(imported
            .root
            .join("scene-index/source-0/cache-a/v002/frame-000.jpg")
            .exists());
    }

    /// The package tree lives somewhere that canonicalizes perfectly well — it
    /// simply is not under the configured Scout output root. Everything else
    /// about it is valid, so the `starts_with(scout_root)` guard is the only
    /// thing standing between the job and importing a package it was never
    /// offered.
    #[test]
    fn a_manifest_outside_the_scout_output_root_is_rejected() {
        let fixture = fixture();
        let base = fixture.scout_root.parent().unwrap().parent().unwrap();
        let elsewhere = base.join("elsewhere");
        for relative in [
            "source-package.json",
            "sources/source-0.mp4",
            "scene-index/source-0/cache-a/v002/index.json",
            "scene-index/source-0/cache-a/v002/frame-000.jpg",
            "scene-index/source-0/cache-a/v002/embed-000.json",
        ] {
            let bytes = fs::read(fixture.package_dir.join(relative)).unwrap();
            write(
                &elsewhere.join("main-footage/post-123").join(relative),
                &bytes,
            );
        }
        let content_set = elsewhere.join("thoth_content_set.json");
        write(&content_set, b"{}");

        let job = JobContext::new_flat("forced".into(), fixture.job_base.clone()).unwrap();
        let error =
            import_package(&content_set, &descriptor(), &job, &fixture.scout_root, &JobExecutionContext::new())
                .unwrap_err();
        let error = package_error(&error);
        assert_eq!(error.code, MainFootageErrorCode::SourcePackageInvalid);
        // Not `package_manifest_path_rejected`: the path resolved fine, it is the
        // containment check that must be what refuses it.
        assert_eq!(error.detail, "package_outside_scout_output");
    }

    /// Scout declares its own fingerprint over the bytes it published. A package
    /// whose declaration does not match those bytes did not arrive intact.
    #[test]
    fn a_declared_fingerprint_that_disagrees_with_scouts_bytes_is_rejected() {
        let fixture = fixture();
        remanifest(&fixture, |value| {
            value["fingerprint"] = json!(format!("sha256:{}", "0".repeat(64)));
        });
        let error = run(&fixture).unwrap_err();
        assert_eq!(package_error(&error).detail, "package_fingerprint_mismatch");
    }

    /// The fingerprint stored in the job-owned manifest must be reproducible from
    /// that manifest's own bytes — otherwise nothing downstream can ever verify
    /// the job's copy. Scout writes `duration_sec` as an integer here; the
    /// contract's `f64` returns it as `12.0`, which is exactly the divergence a
    /// fingerprint taken over Scout's raw bytes would leave behind.
    #[test]
    fn the_published_manifest_fingerprint_is_re_derivable_from_its_own_bytes() {
        let fixture = fixture();
        remanifest(&fixture, |value| {
            value["sources"][0]["technical"]["duration_sec"] = json!(12);
        });
        let imported = run(&fixture).unwrap();

        let published: Value =
            serde_json::from_slice(&fs::read(&imported.manifest_path).unwrap()).unwrap();
        assert_eq!(
            published["fingerprint"].as_str(),
            Some(imported.fingerprint.as_str())
        );
        assert_eq!(
            crate::main_footage::fingerprint_canonical(&published).unwrap(),
            imported.fingerprint,
            "the published manifest cannot reproduce the fingerprint it carries"
        );
    }

    /// Re-importing the same package is a no-op rerun; importing a *different*
    /// package into a job that already published one is a contradiction and must
    /// not be answered with a success the job cannot honour.
    #[test]
    fn a_published_manifest_is_reused_only_when_it_matches_the_package() {
        let fixture = fixture();
        let first = run(&fixture).unwrap();
        let published = fs::read(&first.manifest_path).unwrap();

        let again = run(&fixture).unwrap();
        assert_eq!(again.fingerprint, first.fingerprint);
        assert_eq!(fs::read(&again.manifest_path).unwrap(), published);

        // Same artifacts, different package identity.
        remanifest(&fixture, |value| {
            value["analysis_identity"] = json!("analysis-2026-08-15");
        });
        let error = run(&fixture).unwrap_err();
        assert_eq!(
            package_error(&error).detail,
            "published_manifest_conflicts_with_package"
        );
        assert_eq!(
            fs::read(&first.manifest_path).unwrap(),
            published,
            "the conflicting import overwrote the published manifest"
        );
    }

    /// Brief step 1's cancellation clause. The cancel is observed between
    /// artifacts, so the import stops on a completed checkpoint: the source is
    /// whole, the next artifact was never started, and no manifest was published.
    #[test]
    fn a_cancelled_import_stops_on_a_checkpoint_without_publishing_a_manifest() {
        let fixture = fixture();
        let job = JobContext::new_flat("forced".into(), fixture.job_base.clone()).unwrap();
        let execution = JobExecutionContext::new();
        execution.cancel();

        let error = import_package(
            &fixture.content_set,
            &descriptor(),
            &job,
            &fixture.scout_root,
            &execution,
        )
        .unwrap_err();

        assert!(
            crate::execution::is_cancelled(&error),
            "cancellation was relabelled as {error:#}"
        );
        let root = job.main_footage_dir();
        assert!(
            root.join("sources/source-0.mp4").exists(),
            "the completed checkpoint before the cancel was rolled back"
        );
        assert!(
            !root
                .join("scene-index/source-0/cache-a/v002/index.json")
                .exists(),
            "the import continued past the cancellation"
        );
        assert!(
            !job.source_package_manifest().exists(),
            "a cancelled import published a manifest"
        );
    }
}
