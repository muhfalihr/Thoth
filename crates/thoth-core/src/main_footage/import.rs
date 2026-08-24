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
use thoth_types::main_footage::{PlanningMode, SceneEvidenceV1, SceneIndexV1};

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

/// The scene index file as Scout actually publishes it: the typed contract plus
/// provenance fields decoders are meant to ignore, so this is deliberately not
/// `deny_unknown_fields`.
#[derive(serde::Deserialize)]
struct PublishedSceneIndex {
    source_id: String,
    planning_mode: PlanningMode,
    scenes: Vec<SceneEvidenceV1>,
}

/// Verifies the imported scene index file still describes the scenes the manifest
/// declares.
///
/// `SceneIndexV1.checksum` is **not** the digest of `index.json`. Scout computes it
/// as a content fingerprint over the source checksum, the planning mode, the
/// projected scene evidence and the *bytes* of every artifact a scene declares —
/// including the `-start.jpg`/`-end.jpg` siblings the typed contract never names
/// (`scout/main_footage/scene_index.ts::computeIndexChecksum`). It exists so a
/// rebuilt generation can be cache-validated, and it can never equal the digest of
/// the file, which does not contain those inputs. Comparing the two rejected every
/// genuine Scout package with `artifact_checksum_mismatch`.
///
/// What import has to establish is that the file this job now owns says the same
/// thing the manifest says. Both sides are compared through Rust's own serializer,
/// so a field Scout writes differently (an absent `vision_description` versus an
/// explicit null) cannot masquerade as tampering.
pub(crate) fn verify_index_contents(
    bytes: &[u8],
    declared: &SceneIndexV1,
) -> Result<(), MainFootageError> {
    let file: PublishedSceneIndex =
        serde_json::from_slice(bytes).map_err(|_| invalid("scene_index_rejected"))?;
    let same_scenes = serde_json::to_value(&file.scenes)
        .map_err(|_| invalid("scene_index_not_serializable"))?
        == serde_json::to_value(&declared.scenes)
            .map_err(|_| invalid("scene_index_not_serializable"))?;
    let same_mode = serde_json::to_value(file.planning_mode)
        .map_err(|_| invalid("scene_index_not_serializable"))?
        == serde_json::to_value(declared.planning_mode)
            .map_err(|_| invalid("scene_index_not_serializable"))?;
    if file.source_id != declared.source_id || !same_mode || !same_scenes {
        return Err(invalid("scene_index_contents_mismatch"));
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
    // Re-serialize and fingerprint before choosing the destination generation.
    // A changed Scout package is imported beside the prior immutable generation
    // rather than conflicting with or overwriting it.
    let mut owned = package.clone();
    owned.fingerprint = None;
    let decoded =
        serde_json::to_value(&owned).map_err(|_| invalid("manifest_not_serializable"))?;
    let fingerprint =
        fingerprint_canonical(&decoded).map_err(|_| invalid("fingerprint_failed"))?;
    owned.fingerprint = Some(fingerprint.clone());
    let manifest_bytes =
        serde_json::to_vec_pretty(&owned).map_err(|_| invalid("manifest_not_serializable"))?;

    let base_job_root = job.main_footage_dir();
    fs::create_dir_all(&base_job_root).map_err(|_| invalid("job_root_not_writable"))?;
    // Canonical from here on, so every path the caller later resolves against
    // `root` is comparable with what `resolve_contained` hands back.
    let base_job_root =
        fs::canonicalize(&base_job_root).map_err(|_| invalid("job_root_not_writable"))?;
    let default_manifest = job.source_package_manifest();
    let (job_root, job_manifest) = if default_manifest.exists() {
        let published =
            fs::read(&default_manifest).map_err(|_| invalid("published_manifest_unreadable"))?;
        if published == manifest_bytes {
            (base_job_root, default_manifest)
        } else {
            let generation_name = fingerprint
                .strip_prefix("sha256:")
                .unwrap_or(fingerprint.as_str());
            let generation_root = base_job_root.join("packages").join(generation_name);
            fs::create_dir_all(&generation_root)
                .map_err(|_| invalid("job_root_not_writable"))?;
            let generation_root = fs::canonicalize(&generation_root)
                .map_err(|_| invalid("job_root_not_writable"))?;
            let generation_manifest = generation_root.join("source-package.json");
            (generation_root, generation_manifest)
        }
    } else {
        (base_job_root, default_manifest)
    };

    for source in &package.sources {
        let imported = import_artifact(execution, package_root, &job_root, &source.path)?;
        verify_checksum(&imported, &source.checksum)?;
    }

    for index in &package.scene_indexes {
        let imported = import_artifact(execution, package_root, &job_root, &index.path)?;
        let bytes = fs::read(&imported).map_err(|_| invalid("artifact_unreadable"))?;
        verify_index_contents(&bytes, index)?;
        for scene in &index.scenes {
            import_artifact(execution, package_root, &job_root, &scene.representative_frame)?;
            // A `degraded` scene with no evidence at all legitimately carries no
            // embedding; import what is declared and nothing more.
            if let Some(embedding_path) = scene.embedding_path.as_deref() {
                import_artifact(execution, package_root, &job_root, embedding_path)?;
            }
        }
    }

    // Published last. Existing generation manifests are immutable and may only
    // be reused when they describe these exact package bytes.
    if job_manifest.exists() {
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
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};

    use async_trait::async_trait;
    use serde_json::{json, Value};

    use super::{ImportedSourcePackage, import_package, invalid, sha256_file};
    use crate::execution::JobExecutionContext;
    use crate::main_footage::{MainFootageDescriptor, MainFootageError, MainFootageErrorCode};
    use crate::pipeline::job::JobContext;
    use crate::pipeline::state::{MainFootageStageResult, PipelineState};
    use crate::pipeline::{PlannedMainInput, PlannedMainStagePort, run_planned_main_with};

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

    /// Stands in for `computeIndexChecksum`: a well-formed sha256 identity that is
    /// *not* the digest of any file, which is exactly what Scout declares.
    const INDEX_CONTENT_FINGERPRINT: &str =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111";

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

        let scenes = json!([{
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
        }]);
        // Scout's own published shape: the typed index plus the `analyzer_identity`
        // provenance field decoders are told to ignore. Its `checksum` is Scout's
        // content fingerprint over the source digest, the planning mode, the scene
        // projection and the *bytes* of every declared artifact — deliberately not the
        // digest of these bytes, so this fixture must not be made to look like one.
        let index_bytes = serde_json::to_vec_pretty(&json!({
            "source_id": "source-0",
            "path": "scene-index/source-0/cache-a/v002/index.json",
            "checksum": INDEX_CONTENT_FINGERPRINT,
            "planning_mode": "vision",
            "scenes": scenes,
            "analyzer_identity": "scene-index@2026-08-14"
        }))
        .unwrap();
        let index_path = package_dir.join("scene-index/source-0/cache-a/v002/index.json");
        write(&index_path, &index_bytes);
        assert_ne!(
            digest(&index_bytes),
            INDEX_CONTENT_FINGERPRINT,
            "the fixture must keep Scout's real semantics: the declared index checksum is a \
             content fingerprint, never the digest of index.json"
        );

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
                "checksum": INDEX_CONTENT_FINGERPRINT,
                "planning_mode": "vision",
                "scenes": scenes
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

    /// Republishes `index.json` from whatever the manifest now declares — what Scout
    /// does, since both are written from the same in-memory index. A test that changes
    /// the declared scenes and wants a *valid* package has to move the file too.
    fn republish_index(fixture: &Fixture) {
        let manifest: Value = serde_json::from_slice(
            &fs::read(fixture.package_dir.join("source-package.json")).unwrap(),
        )
        .unwrap();
        let index = &manifest["scene_indexes"][0];
        let mut published = index.clone();
        published["analyzer_identity"] = json!("scene-index@2026-08-14");
        write(
            &fixture
                .package_dir
                .join("scene-index/source-0/cache-a/v002/index.json"),
            &serde_json::to_vec_pretty(&published).unwrap(),
        );
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

    struct RealImportThenStop;

    #[async_trait]
    impl PlannedMainStagePort for RealImportThenStop {
        type Imported = ImportedSourcePackage;
        type Narration = ();
        type Verified = MainFootageStageResult;

        async fn import_sources(
            &self,
            job: &JobContext,
            planned: &PlannedMainInput,
            execution: &JobExecutionContext,
        ) -> anyhow::Result<Self::Imported> {
            import_package(
                &planned.content_set_path,
                &planned.descriptor,
                job,
                &planned.scout_output_root,
                execution,
            )
        }

        fn source_fingerprint<'a>(&self, imported: &'a Self::Imported) -> &'a str {
            &imported.fingerprint
        }

        fn validate_scene_index(
            &self,
            _job: &JobContext,
            _imported: &Self::Imported,
        ) -> anyhow::Result<()> {
            Err(invalid("stop_after_real_import").into())
        }

        fn load_narration(&self, _job: &JobContext) -> anyhow::Result<Option<Self::Narration>> {
            unreachable!("validation deliberately stops this adapter")
        }

        async fn generate_narration(
            &self,
            _job: &JobContext,
            _execution: &JobExecutionContext,
        ) -> anyhow::Result<Self::Narration> {
            unreachable!("validation deliberately stops this adapter")
        }

        fn narration_fingerprint<'a>(&self, _narration: &'a Self::Narration) -> &'a str {
            unreachable!("validation deliberately stops this adapter")
        }

        async fn prepare_plan(
            &self,
            _job: &JobContext,
            _planned: &PlannedMainInput,
            _imported: &Self::Imported,
            _narration: &Self::Narration,
            _execution: &JobExecutionContext,
        ) -> anyhow::Result<Self::Verified> {
            unreachable!("validation deliberately stops this adapter")
        }

        fn verified_state(&self, _verified: &Self::Verified) -> MainFootageStageResult {
            unreachable!("validation deliberately stops this adapter")
        }

        fn render_settings_fingerprint(&self) -> String {
            unreachable!("validation deliberately stops this adapter")
        }

        async fn render(
            &self,
            _job: &JobContext,
            _verified: &Self::Verified,
            _narration: &Self::Narration,
            _execution: &JobExecutionContext,
        ) -> anyhow::Result<crate::edit::service::EditResult> {
            unreachable!("validation deliberately stops this adapter")
        }
    }

    fn completed_stage(source_fingerprint: String) -> MainFootageStageResult {
        MainFootageStageResult {
            source_package_fingerprint: source_fingerprint,
            narration_fingerprint: "sha256:old-narration".into(),
            plan_fingerprint: "sha256:old-plan".into(),
            active_version: "v001".into(),
            render_settings_fingerprint: Some("sha256:old-render".into()),
            planning_mode: crate::main_footage::PlanningMode::Vision,
            coverage_target: 0.6,
            main_coverage_sec: 6.0,
            main_coverage_ratio: 1.0,
            total_duration_sec: 6.0,
            selected_cut_count: 1,
            candidate_count: 1,
            transition_distribution: BTreeMap::new(),
            warnings: Vec::new(),
            retained_bytes: 1,
            completed_at: chrono::Utc::now(),
        }
    }

    /// Every fixture in this repo is Rust-constructed, so the strict decoder has
    /// only ever been shown manifests the Rust serializer wrote. Scout writes two
    /// further members on **every** source it emits — `bytes` and `acquisition`
    /// (`scout/main_footage/source_package.ts:140-156`) — and `SourceVideoV1` is
    /// `deny_unknown_fields`. Without this case a genuine Scout package dies at
    /// import with `package_manifest_rejected` while the whole suite is green.
    #[test]
    fn import_accepts_the_source_members_scout_actually_writes() {
        let fixture = fixture();
        remanifest(&fixture, |value| {
            let source = &mut value["sources"][0];
            source["bytes"] = json!(28);
            source["acquisition"] = json!({
                "source": "yt-dlp",
                "attempts": 1,
                "elapsed_ms": 1234,
            });
        });

        let imported = run(&fixture).unwrap_or_else(|error| {
            panic!("a package in Scout's own shape must import: {error:#}")
        });
        let source = &imported.package.sources[0];
        assert_eq!(source.bytes, Some(28));
        let acquisition = source
            .acquisition
            .as_ref()
            .expect("Scout's acquisition provenance must survive the import");
        assert_eq!(acquisition.source, "yt-dlp");
        assert_eq!(acquisition.attempts, 1);
        assert_eq!(acquisition.elapsed_ms, 1234);
    }

    /// A package written before Scout emitted those members must still import —
    /// they are optional in `scout/main_footage/contracts.ts` too.
    #[test]
    fn import_accepts_a_source_without_scouts_optional_members() {
        let fixture = fixture();
        let imported = run(&fixture).unwrap();
        assert_eq!(imported.package.sources[0].bytes, None);
        assert!(imported.package.sources[0].acquisition.is_none());
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

    /// Regression, found by Task 15's offline acceptance work: `SceneIndexV1.checksum`
    /// is Scout's content fingerprint, not the digest of `index.json`, so verifying it
    /// as a file digest rejected **every** real package with `artifact_checksum_mismatch`.
    /// The whole fixture is now Scout-shaped, so the first half of this test is the
    /// happy path; the second half is what stops the replacement check from being
    /// vacuous — an index file that no longer says what the manifest says is rejected.
    #[test]
    fn a_scene_index_is_verified_against_its_declared_scenes_not_a_file_digest() {
        let genuine = fixture();
        let index_path = genuine
            .package_dir
            .join("scene-index/source-0/cache-a/v002/index.json");
        assert_ne!(
            sha256_file(&index_path).unwrap(),
            INDEX_CONTENT_FINGERPRINT,
            "fixture no longer reproduces Scout's checksum semantics"
        );
        run(&genuine).expect("a package carrying Scout's real index checksum must import");

        let tampered = fixture();
        let tampered_path = tampered
            .package_dir
            .join("scene-index/source-0/cache-a/v002/index.json");
        let mut published: Value =
            serde_json::from_slice(&fs::read(&tampered_path).unwrap()).unwrap();
        published["scenes"][0]["end_sec"] = json!(9.0);
        write(
            &tampered_path,
            &serde_json::to_vec_pretty(&published).unwrap(),
        );
        let error = run(&tampered).expect_err("a rewritten index file must not import");
        assert_eq!(
            package_error(&error).detail,
            "scene_index_contents_mismatch"
        );
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
        // Scout writes the manifest and `index.json` from the same in-memory index, so a
        // degraded index is degraded in both places.
        republish_index(&fixture);
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

    /// Re-importing the same package is a no-op rerun. A changed package receives
    /// a separate immutable generation so the prior import remains replayable.
    #[test]
    fn published_package_generations_are_reused_without_overwriting_history() {
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
        let changed = run(&fixture).unwrap();
        assert_ne!(changed.fingerprint, first.fingerprint);
        assert_ne!(changed.root, first.root);
        assert!(changed.manifest_path.is_file());
        assert_eq!(
            fs::read(&first.manifest_path).unwrap(),
            published,
            "the changed import overwrote the previous generation"
        );
        let changed_again = run(&fixture).unwrap();
        assert_eq!(changed_again.root, changed.root);
        assert_eq!(changed_again.fingerprint, changed.fingerprint);
    }

    #[tokio::test]
    async fn changed_real_import_persists_downstream_invalidation_and_retains_old_generation() {
        let fixture = fixture();
        let first = run(&fixture).unwrap();
        let old_manifest = fs::read(&first.manifest_path).unwrap();
        let job = JobContext::new_flat("forced".into(), fixture.job_base.clone()).unwrap();
        let mut state = PipelineState::new("forced".into(), "forced".into());
        state.stages.main_footage = Some(completed_stage(first.fingerprint));
        state.stages.edit = Some(crate::edit::service::EditResult {
            output_clips: Vec::new(),
            completed_at: chrono::Utc::now(),
        });
        state.save(&job.state_path()).unwrap();
        remanifest(&fixture, |value| {
            value["analysis_identity"] = json!("analysis-2026-08-15");
        });
        let planned = PlannedMainInput {
            content_set_path: fixture.content_set.clone(),
            descriptor: descriptor(),
            scout_output_root: fixture.scout_root.clone(),
        };

        run_planned_main_with(
            &job,
            &mut state,
            &planned,
            &JobExecutionContext::new(),
            &RealImportThenStop,
        )
        .await
        .unwrap_err();

        let persisted = PipelineState::load(&job.state_path()).unwrap();
        assert!(persisted.stages.main_footage.is_none());
        assert!(persisted.stages.edit.is_none());
        assert_eq!(
            fs::read(&first.manifest_path).unwrap(),
            old_manifest,
            "the previous imported generation was modified"
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
