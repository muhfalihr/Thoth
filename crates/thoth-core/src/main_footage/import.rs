//! Imports a Scout-published forced source package into the job directory.
//!
//! After this runs the job owns every byte it will render from: the source
//! videos, the scene indexes, their representative frames and embeddings, and a
//! manifest addressing all of them by slash-separated paths relative to
//! `job.main_footage_dir()`. Nothing in the job-owned manifest points back at
//! Scout, so renaming or deleting the Scout package cannot break the run.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::main_footage::paths::{import_file, resolve_contained, write_immutable};
use crate::main_footage::{
    fingerprint_canonical, MainFootageDescriptor, MainFootageError, MainFootageErrorCode,
    SourcePackageV1,
};
use crate::pipeline::job::JobContext;

/// Scout's package hand-off directory, relative to the process working dir.
/// Mirrors `thoth-server`'s `scout::SCOUT_OUTPUT_DIR`; thoth-core cannot depend
/// on the server crate (the dependency runs the other way).
pub const SCOUT_OUTPUT_DIR: &str = "scout/output";

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
fn import_artifact(
    package_root: &Path,
    job_root: &Path,
    relative: &str,
) -> Result<PathBuf, MainFootageError> {
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
pub fn import_package(
    content_set_path: &Path,
    descriptor: &MainFootageDescriptor,
    job: &JobContext,
    scout_output_root: &Path,
) -> Result<ImportedSourcePackage, MainFootageError> {
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
        return Err(invalid("package_outside_scout_output"));
    }

    let raw = fs::read(&manifest_path).map_err(|_| invalid("package_manifest_unreadable"))?;
    let value: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|_| invalid("package_manifest_not_json"))?;
    let package: SourcePackageV1 =
        serde_json::from_value(value.clone()).map_err(|_| invalid("package_manifest_rejected"))?;
    let fingerprint = fingerprint_canonical(&value).map_err(|_| invalid("fingerprint_failed"))?;
    if let Some(declared) = package.fingerprint.as_deref() {
        if declared != fingerprint {
            return Err(invalid("package_fingerprint_mismatch"));
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
            return Err(invalid("scene_index_missing_for_source"));
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
        let imported = import_artifact(package_root, &job_root, &source.path)?;
        verify_checksum(&imported, &source.checksum)?;
    }

    for index in &package.scene_indexes {
        let imported = import_artifact(package_root, &job_root, &index.path)?;
        verify_checksum(&imported, &index.checksum)?;
        for scene in &index.scenes {
            import_artifact(package_root, &job_root, &scene.representative_frame)?;
            // A `degraded` scene with no evidence at all legitimately carries no
            // embedding; import what is declared and nothing more.
            if let Some(embedding_path) = scene.embedding_path.as_deref() {
                import_artifact(package_root, &job_root, embedding_path)?;
            }
        }
    }

    // Published last, and re-serialized from the decoded contract so no Scout
    // location can ride along.
    let mut owned = package.clone();
    owned.fingerprint = Some(fingerprint.clone());
    let manifest_bytes =
        serde_json::to_vec_pretty(&owned).map_err(|_| invalid("manifest_not_serializable"))?;
    let job_manifest = job.source_package_manifest();
    if !job_manifest.exists() {
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
    use crate::main_footage::{MainFootageDescriptor, MainFootageErrorCode};
    use crate::pipeline::job::JobContext;

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

    fn run(fixture: &Fixture) -> Result<ImportedSourcePackage, crate::main_footage::MainFootageError>
    {
        let job = JobContext::new_flat("forced".into(), fixture.job_base.clone()).unwrap();
        import_package(
            &fixture.content_set,
            &descriptor(),
            &job,
            &fixture.scout_root,
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
        let manifest = fs::read_to_string(&imported.manifest_path).unwrap();
        assert!(
            !manifest.contains("scout"),
            "job manifest retained a Scout path: {manifest}"
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
            run(&fixture).unwrap_err().code,
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
            run(&fixture).unwrap_err().code,
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
            run(&fixture).unwrap_err().code,
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
        assert!(import_package(&fixture.content_set, &descriptor(), &job, &fixture.scout_root)
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

    #[test]
    fn a_manifest_outside_the_scout_output_root_is_rejected() {
        let fixture = fixture();
        let descriptor: MainFootageDescriptor = serde_json::from_value(json!({
            "mode": "forced_url_pool",
            "package_manifest": "main-footage/post-123/source-package.json",
            "coverage_target": 0.6
        }))
        .unwrap();
        let job = JobContext::new_flat("forced".into(), fixture.job_base.clone()).unwrap();
        // A Content Set outside the Scout output root cannot reach a package.
        let stray = fixture.scout_root.parent().unwrap().join("stray_set.json");
        fs::write(&stray, b"{}").unwrap();
        assert_eq!(
            import_package(&stray, &descriptor, &job, &fixture.scout_root)
                .unwrap_err()
                .code,
            MainFootageErrorCode::SourcePackageInvalid
        );
    }
}
