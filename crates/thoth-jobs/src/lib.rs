mod validation;
mod profiles;

pub use profiles::{
    AdvancedSettings, AnalysisSettings, IngestSourceSettings, NarrationSettings, OutputSettings,
    ProfileRecord, ProfileRevision, ProfileSettings, ProjectRecord, ResolvedSettings, RunOverrides,
    ResourceError, ResourceResult, SETTINGS_SCHEMA_VERSION, VisualEditSettings,
    redacted_settings_json, resolve_settings, validate_resolved_settings, validate_settings,
};

#[cfg(test)]
mod profiles_tests {
    use std::path::PathBuf;

    use serde_json::json;

    use crate::{
        ProfileSettings, ResolvedSettings, RunOverrides, ThothHome, redacted_settings_json,
        resolve_settings, validate_resolved_settings, validate_settings,
    };

    #[test]
    fn override_wins_without_mutating_profile() {
        let root = std::env::temp_dir().join(format!("thoth-profile-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);
        let profile = ProfileSettings::default();
        let overrides = RunOverrides {
            analysis_max_clips: Some(5),
            ..RunOverrides::default()
        };

        let resolved = resolve_settings(&profile, &overrides, &home).unwrap();

        assert_eq!(resolved.analysis.max_clips, 5);
        assert_eq!(profile.analysis.max_clips, 3);
    }

    #[test]
    fn snapshot_has_reference_not_secret_value() {
        let snapshot =
            redacted_settings_json(&ResolvedSettings::default(), Some("openai-production"));

        assert_eq!(snapshot["credential_ref"], "openai-production");
        assert!(snapshot.get("credential_value").is_none());
        assert!(!snapshot.to_string().contains("secret"));
    }

    #[test]
    fn profile_deserialization_rejects_unknown_fields() {
        let invalid = json!({
            "schema_version": 1,
            "narration": { "language": null },
            "visual_edit": {
                "layout": "vertical",
                "clip_style": "fade",
                "style_profile": "auto",
                "social": "",
                "bgm": null,
                "bgm_volume": 0.12,
                "sfx_intro": null,
                "headline_dur": 4.0
            },
            "analysis": {
                "provider": "novita",
                "model": "medium",
                "max_clips": 3,
                "keywords": []
            },
            "ingest_source": { "source": null, "content_set": null },
            "output": { "directory": null },
            "advanced": {},
            "unknown": true
        });

        assert!(serde_json::from_value::<ProfileSettings>(invalid).is_err());
    }

    #[test]
    fn profile_deserialization_applies_v1_defaults_without_accepting_unknown_fields() {
        let settings = serde_json::from_value::<ProfileSettings>(json!({})).unwrap();

        assert_eq!(settings, ProfileSettings::default());
        assert!(serde_json::from_value::<ProfileSettings>(json!({ "unknown": true })).is_err());
    }

    #[test]
    fn resolver_rejects_invalid_typed_overrides() {
        let root = std::env::temp_dir().join(format!("thoth-profile-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);
        let profile = ProfileSettings::default();
        let invalid_enum = RunOverrides {
            analysis_provider: Some("unsupported".to_owned()),
            ..RunOverrides::default()
        };
        assert!(resolve_settings(&profile, &invalid_enum, &home).is_err());

        let non_finite = RunOverrides {
            visual_edit_bgm_volume: Some(f64::NAN),
            ..RunOverrides::default()
        };
        assert!(resolve_settings(&profile, &non_finite, &home).is_err());

        let escaped_output = RunOverrides {
            output_directory: Some(Some(root.join("..").join("outside"))),
            ..RunOverrides::default()
        };
        assert!(resolve_settings(&profile, &escaped_output, &home).is_err());
    }

    #[test]
    fn resolved_settings_validation_rejects_output_outside_home() {
        let root = std::env::temp_dir().join(format!("thoth-profile-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);
        let mut resolved = ResolvedSettings::default();
        resolved.output.directory = Some(root.join("..").join("outside"));

        assert!(validate_resolved_settings(&resolved, &home).is_err());
    }

    #[test]
    fn validation_rejects_invalid_enum_and_managed_path_escape() {
        let root = std::env::temp_dir().join(format!("thoth-profile-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);
        let mut settings = ProfileSettings::default();
        settings.visual_edit.layout = "diagonal".to_owned();
        assert!(validate_settings(&settings, &home).is_err());

        settings.visual_edit.layout = "vertical".to_owned();
        settings.output.directory = Some(PathBuf::from("outside-output"));
        assert!(validate_settings(&settings, &home).is_err());
    }

    #[test]
    fn validation_rejects_blank_required_values_and_non_finite_numbers() {
        let root = std::env::temp_dir().join(format!("thoth-profile-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);
        let mut settings = ProfileSettings::default();
        settings.analysis.provider = "  ".to_owned();
        assert!(validate_settings(&settings, &home).is_err());

        settings.analysis.provider = "novita".to_owned();
        settings.visual_edit.bgm_volume = f64::NAN;
        assert!(validate_settings(&settings, &home).is_err());
    }

    #[test]
    fn validation_accepts_a_managed_output_directory() {
        let root = std::env::temp_dir().join(format!("thoth-profile-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);
        home.ensure_layout().unwrap();
        let mut settings = ProfileSettings::default();
        settings.output.directory = Some(home.project_outputs("project-1"));

        assert!(validate_settings(&settings, &home).is_ok());

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn validation_rejects_output_path_through_symlink() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("thoth-profile-{}", uuid::Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("thoth-outside-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);
        home.ensure_layout().unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let link = home.root().join("projects").join("escape");
        symlink(&outside, &link).unwrap();

        let mut settings = ProfileSettings::default();
        settings.output.directory = Some(link.join("render"));
        assert!(validate_settings(&settings, &home).is_err());

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[cfg(windows)]
    #[test]
    fn validation_rejects_output_path_through_symlink_when_supported() {
        use std::io::ErrorKind;
        use std::os::windows::fs::symlink_dir;

        let root = std::env::temp_dir().join(format!("thoth-profile-{}", uuid::Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("thoth-outside-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);
        home.ensure_layout().unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let link = home.root().join("projects").join("escape");
        if let Err(error) = symlink_dir(&outside, &link) {
            assert!(
                error.kind() == ErrorKind::PermissionDenied || error.raw_os_error() == Some(1314),
                "symlink setup failed for an unexpected reason: {error}"
            );
            let _ = std::fs::remove_dir_all(root);
            let _ = std::fs::remove_dir_all(outside);
            return;
        }

        let mut settings = ProfileSettings::default();
        settings.output.directory = Some(link.join("render"));
        assert!(validate_settings(&settings, &home).is_err());

        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }
}

#[cfg(test)]
mod home_tests {
    use std::path::Path;

    use super::home::{ThothHome, resolve_home_with_env};

    #[test]
    fn explicit_home_wins_over_environment() {
        let home =
            resolve_home_with_env(Some(Path::new("explicit")), Some(Path::new("env"))).unwrap();

        assert_eq!(home.root(), Path::new("explicit"));
    }

    #[test]
    fn project_output_is_owned_by_home() {
        let root = std::env::temp_dir().join(format!("thoth-home-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);

        home.ensure_layout().unwrap();

        assert!(home.data_dir().is_dir());
        assert!(home.root().join("projects").is_dir());
        assert!(home.root().join("cache").is_dir());
        assert!(home.root().join("logs").is_dir());
        assert_eq!(
            home.project_outputs("p1"),
            home.root().join("projects/p1/outputs")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn project_workspace_layout_is_created_under_home() {
        let root = std::env::temp_dir().join(format!("thoth-home-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);

        home.ensure_project_layout("p1").unwrap();

        let project = home.project_root("p1");
        assert!(project.join("content-sets").is_dir());
        assert!(project.join("sources").is_dir());
        assert!(project.join("outputs").is_dir());
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod profile_store_tests {
    use super::*;

    async fn fresh_profile_store() -> (JobStore, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("thoth-profile-store-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);
        home.ensure_layout().unwrap();
        let store = JobStore::connect_with_home(
            home.data_dir().join("jobs.db").to_str().unwrap(),
            home,
        )
        .await
        .unwrap();
        (store, root)
    }

    #[tokio::test]
    async fn same_profile_name_is_allowed_in_two_projects_and_update_creates_revision() {
        let (store, root) = fresh_profile_store().await;
        let a = store.create_project("A").await.unwrap();
        let b = store.create_project("B").await.unwrap();
        store
            .create_profile(&a.id, "Default", "", ProfileSettings::default(), None)
            .await
            .unwrap();
        store
            .create_profile(&b.id, "Default", "", ProfileSettings::default(), None)
            .await
            .unwrap();

        let profile = store.list_profiles(&a.id).await.unwrap().pop().unwrap();
        let mut changed = ProfileSettings::default();
        changed.analysis.max_clips = 5;
        store
            .update_profile(&profile.id, "Default", "", changed, None)
            .await
            .unwrap();

        let revisions = store.list_profile_revisions(&profile.id).await.unwrap();
        assert_eq!(revisions.len(), 1);
        assert_eq!(revisions[0].settings.analysis.max_clips, 3);
        assert!(a.workspace_path.join("content-sets").is_dir());
        assert!(b.workspace_path.join("outputs").is_dir());
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn duplicate_profile_name_in_one_project_fails() {
        let (store, root) = fresh_profile_store().await;
        let project = store.create_project("A").await.unwrap();
        store
            .create_profile(&project.id, "Default", "", ProfileSettings::default(), None)
            .await
            .unwrap();

        let result = store
            .create_profile(&project.id, "Default", "", ProfileSettings::default(), None)
            .await;

        assert!(matches!(result.unwrap_err(), ResourceError::DuplicateName));
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn projects_list_and_profiles_are_retrieved_by_their_opaque_ids() {
        let (store, root) = fresh_profile_store().await;
        let first = store.create_project("A").await.unwrap();
        let second = store.create_project("B").await.unwrap();
        let profile = store
            .create_profile(&first.id, "Default", "", ProfileSettings::default(), None)
            .await
            .unwrap();

        let projects = store.list_projects().await.unwrap();
        let fetched = store.get_profile(&profile.id).await.unwrap();

        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].id, first.id);
        assert_eq!(projects[1].id, second.id);
        assert_eq!(fetched.unwrap().project_id, first.id);
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn restoring_a_revision_creates_new_history() {
        let (store, root) = fresh_profile_store().await;
        let project = store.create_project("A").await.unwrap();
        let profile = store
            .create_profile(&project.id, "Default", "", ProfileSettings::default(), None)
            .await
            .unwrap();
        let mut changed = ProfileSettings::default();
        changed.analysis.max_clips = 5;
        store
            .update_profile(&profile.id, "Changed", "", changed, Some("named-credential"))
            .await
            .unwrap();
        let original = store.list_profile_revisions(&profile.id).await.unwrap().remove(0);

        let restored = store
            .restore_profile_revision(&profile.id, &original.id)
            .await
            .unwrap();

        assert_eq!(restored.name, "Default");
        assert_eq!(restored.settings.analysis.max_clips, 3);
        assert_eq!(restored.credential_ref, None);
        assert_eq!(store.list_profile_revisions(&profile.id).await.unwrap().len(), 2);
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn profile_description_is_persisted_revised_and_restored() {
        let (store, root) = fresh_profile_store().await;
        let project = store.create_project("A").await.unwrap();
        let profile = store
            .create_profile(
                &project.id,
                "Default",
                "Initial description",
                ProfileSettings::default(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(store.get_profile(&profile.id).await.unwrap().unwrap().description, "Initial description");

        let updated = store
            .update_profile(
                &profile.id,
                "Default",
                "Updated description",
                ProfileSettings::default(),
                None,
            )
            .await
            .unwrap();
        let original = store.list_profile_revisions(&profile.id).await.unwrap().remove(0);

        assert_eq!(updated.description, "Updated description");
        assert_eq!(original.description, "Initial description");
        let restored = store
            .restore_profile_revision(&profile.id, &original.id)
            .await
            .unwrap();
        assert_eq!(restored.description, "Initial description");
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn profile_description_is_trimmed_before_persistence() {
        let (store, root) = fresh_profile_store().await;
        let project = store.create_project("A").await.unwrap();

        let profile = store
            .create_profile(
                &project.id,
                "Default",
                "  Concise summary  ",
                ProfileSettings::default(),
                None,
            )
            .await
            .unwrap();

        assert_eq!(profile.description, "Concise summary");
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn profile_description_rejects_more_than_1024_characters() {
        let (store, root) = fresh_profile_store().await;
        let project = store.create_project("A").await.unwrap();

        let error = store
            .create_profile(
                &project.id,
                "Default",
                &"x".repeat(1025),
                ProfileSettings::default(),
                None,
            )
            .await
            .unwrap_err();

        assert!(matches!(error, ResourceError::Validation { .. }));
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn project_mutation_requires_an_explicit_home() {
        let root = std::env::temp_dir().join(format!("thoth-profile-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = JobStore::connect(root.join("jobs.db").to_str().unwrap())
            .await
            .unwrap();

        let error = store.create_project("A").await.unwrap_err();

        assert!(matches!(error, ResourceError::Storage(_)));
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn project_lookup_and_update_normalize_the_name() {
        let (store, root) = fresh_profile_store().await;
        let project = store.create_project("Original").await.unwrap();

        let updated = store.update_project(&project.id, "  Renamed  ").await.unwrap();
        let fetched = store.get_project(&project.id).await.unwrap();

        assert_eq!(updated.name, "Renamed");
        assert_eq!(fetched.name, "Renamed");
        assert_eq!(fetched.workspace_path, project.workspace_path);
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn project_update_reports_duplicate_name_without_sql_text() {
        let (store, root) = fresh_profile_store().await;
        store.create_project("Existing").await.unwrap();
        let project = store.create_project("Other").await.unwrap();

        let error = store.update_project(&project.id, "Existing").await.unwrap_err();

        assert!(matches!(error, ResourceError::DuplicateName));
        assert_eq!(error.to_string(), "resource name already exists");
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn missing_project_mutations_return_typed_not_found() {
        let (store, root) = fresh_profile_store().await;

        assert!(matches!(
            store.get_project("missing").await.unwrap_err(),
            ResourceError::NotFound
        ));
        assert!(matches!(
            store.update_project("missing", "Name").await.unwrap_err(),
            ResourceError::NotFound
        ));
        assert!(matches!(
            store.delete_project("missing").await.unwrap_err(),
            ResourceError::NotFound
        ));
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn project_delete_rejects_queued_and_running_jobs() {
        for status in ["queued", "running"] {
            let (store, root) = fresh_profile_store().await;
            let project = store.create_project("Busy").await.unwrap();
            let job_id = uuid::Uuid::new_v4().to_string();
            let ts = now();
            sqlx::query(
                "INSERT INTO jobs
                    (id, command, params, status, output_dir, created_at, updated_at, project_id)
                 VALUES (?, 'run', '{}', ?, 'out', ?, ?, ?)",
            )
            .bind(&job_id)
            .bind(status)
            .bind(&ts)
            .bind(&ts)
            .bind(&project.id)
            .execute(&store.pool)
            .await
            .unwrap();

            let error = store.delete_project(&project.id).await.unwrap_err();

            assert!(matches!(error, ResourceError::ActiveJobs));
            assert_eq!(store.get_project(&project.id).await.unwrap().id, project.id);
            drop(store);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[tokio::test]
    async fn project_delete_removes_metadata_but_preserves_workspace_and_historical_job() {
        let (store, root) = fresh_profile_store().await;
        let project = store.create_project("Finished").await.unwrap();
        let profile = store
            .create_profile(
                &project.id,
                "Default",
                "retained in job snapshot",
                ProfileSettings::default(),
                None,
            )
            .await
            .unwrap();
        store
            .update_profile(
                &profile.id,
                "Default",
                "updated",
                ProfileSettings::default(),
                None,
            )
            .await
            .unwrap();
        let job_id = uuid::Uuid::new_v4().to_string();
        let ts = now();
        sqlx::query(
            "INSERT INTO jobs
                (id, command, params, status, output_dir, created_at, updated_at,
                 project_id, profile_id, resolved_settings_snapshot)
             VALUES (?, 'run', '{}', 'succeeded', 'out', ?, ?, ?, ?, '{}')",
        )
        .bind(&job_id)
        .bind(&ts)
        .bind(&ts)
        .bind(&project.id)
        .bind(&profile.id)
        .execute(&store.pool)
        .await
        .unwrap();

        store.delete_project(&project.id).await.unwrap();

        assert!(matches!(
            store.get_project(&project.id).await.unwrap_err(),
            ResourceError::NotFound
        ));
        assert!(store.get_profile(&profile.id).await.unwrap().is_none());
        assert!(store.list_profile_revisions(&profile.id).await.unwrap().is_empty());
        assert!(project.workspace_path.is_dir(), "metadata delete must not touch files");
        let historical = store.get(&job_id).await.unwrap().unwrap();
        assert_eq!(historical.project_id.as_deref(), Some(project.id.as_str()));
        assert_eq!(historical.profile_id.as_deref(), Some(profile.id.as_str()));
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn profile_delete_is_project_scoped_and_removes_its_revisions() {
        let (store, root) = fresh_profile_store().await;
        let owner = store.create_project("Owner").await.unwrap();
        let other = store.create_project("Other").await.unwrap();
        let profile = store
            .create_profile(
                &owner.id,
                "Default",
                "",
                ProfileSettings::default(),
                None,
            )
            .await
            .unwrap();
        store
            .update_profile(
                &profile.id,
                "Default",
                "",
                ProfileSettings::default(),
                None,
            )
            .await
            .unwrap();

        assert!(matches!(
            store.delete_profile(&other.id, &profile.id).await.unwrap_err(),
            ResourceError::NotFound
        ));
        assert!(store.get_profile(&profile.id).await.unwrap().is_some());

        store.delete_profile(&owner.id, &profile.id).await.unwrap();

        assert!(store.get_profile(&profile.id).await.unwrap().is_none());
        assert!(store.list_profile_revisions(&profile.id).await.unwrap().is_empty());
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn resource_names_and_descriptions_return_typed_validation_errors() {
        let (store, root) = fresh_profile_store().await;

        assert!(matches!(
            store.create_project("   ").await.unwrap_err(),
            ResourceError::Validation { .. }
        ));
        let project = store.create_project("  Trimmed project  ").await.unwrap();
        assert_eq!(project.name, "Trimmed project");
        let profile = store
            .create_profile(
                &project.id,
                "  Trimmed profile  ",
                "  Trimmed description  ",
                ProfileSettings::default(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(profile.name, "Trimmed profile");
        assert_eq!(profile.description, "Trimmed description");

        let error = store
            .create_profile(
                &project.id,
                "Too long",
                &"x".repeat(1025),
                ProfileSettings::default(),
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(error, ResourceError::Validation { .. }));
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn v3_database_with_duplicate_and_padded_project_names_still_connects() {
        let root = std::env::temp_dir().join(format!("thoth-v3-projects-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let db = root.join("jobs.db");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::from_str(db.to_str().unwrap())
                    .unwrap()
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        let all_migrations = sqlx::migrate!();
        let v3_migrator = sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(
                all_migrations
                    .iter()
                    .filter(|migration| migration.version <= 3)
                    .cloned()
                    .collect(),
            ),
            ignore_missing: false,
            locking: true,
            no_tx: false,
        };
        v3_migrator.run(&pool).await.unwrap();
        for (id, name) in [("one", "Demo"), ("two", "Demo"), ("three", "  Demo  ")] {
            sqlx::query(
                "INSERT INTO projects (id, name, workspace_path, created_at, updated_at)
                 VALUES (?, ?, ?, '2026-07-18T00:00:00Z', '2026-07-18T00:00:00Z')",
            )
            .bind(id)
            .bind(name)
            .bind(root.join(id).to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        }
        drop(pool);

        let store = JobStore::connect(db.to_str().unwrap()).await.unwrap();

        assert_eq!(store.list_projects().await.unwrap().len(), 3);
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn create_and_update_reject_normalized_legacy_project_name_conflicts() {
        let (store, root) = fresh_profile_store().await;
        let existing = store.create_project("Existing").await.unwrap();
        sqlx::query("UPDATE projects SET name = ? WHERE id = ?")
            .bind("\tExisting\n")
            .bind(&existing.id)
            .execute(&store.pool)
            .await
            .unwrap();

        assert!(matches!(
            store.create_project(" Existing ").await.unwrap_err(),
            ResourceError::DuplicateName
        ));
        let other = store.create_project("Other").await.unwrap();
        assert!(matches!(
            store.update_project(&other.id, "Existing").await.unwrap_err(),
            ResourceError::DuplicateName
        ));
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn update_rejects_unicode_whitespace_legacy_project_name_conflict() {
        let (store, root) = fresh_profile_store().await;
        let existing = store.create_project("Existing").await.unwrap();
        sqlx::query("UPDATE projects SET name = ? WHERE id = ?")
            .bind("\u{2003}Existing\u{2003}")
            .bind(&existing.id)
            .execute(&store.pool)
            .await
            .unwrap();
        let other = store.create_project("Other").await.unwrap();

        let error = store.update_project(&other.id, " Existing ").await.unwrap_err();

        assert!(matches!(error, ResourceError::DuplicateName));
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn concurrent_project_create_has_one_deterministic_duplicate_outcome() {
        let root = std::env::temp_dir().join(format!("thoth-project-race-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);
        home.ensure_layout().unwrap();
        let db = home.data_dir().join("jobs.db");
        let first = JobStore::connect_with_home(db.to_str().unwrap(), home.clone())
            .await
            .unwrap();
        let second = JobStore::connect_with_home(db.to_str().unwrap(), home)
            .await
            .unwrap();

        let (left, right) = tokio::join!(
            first.create_project("Concurrent"),
            second.create_project("  Concurrent  ")
        );

        assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
        let error = left.err().or_else(|| right.err()).unwrap();
        assert!(matches!(error, ResourceError::DuplicateName));
        drop(first);
        drop(second);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn profile_revision_unique_failure_is_typed_as_storage() {
        let (store, root) = fresh_profile_store().await;
        let project = store.create_project("Project").await.unwrap();
        let profile = store
            .create_profile(&project.id, "Default", "", ProfileSettings::default(), None)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TRIGGER duplicate_profile_revision
             BEFORE INSERT ON profile_revisions
             BEGIN
               INSERT INTO profile_revisions
                 (id, profile_id, revision, name, description, schema_version,
                  settings_json, credential_ref, created_at)
               VALUES
                 (NEW.id || '-duplicate', NEW.profile_id, NEW.revision, NEW.name,
                  NEW.description, NEW.schema_version, NEW.settings_json,
                  NEW.credential_ref, NEW.created_at);
             END",
        )
        .execute(&store.pool)
        .await
        .unwrap();

        let error = store
            .update_profile(
                &profile.id,
                "Default",
                "",
                ProfileSettings::default(),
                None,
            )
            .await
            .unwrap_err();

        assert!(matches!(error, ResourceError::Storage(_)));
        assert!(store.list_profile_revisions(&profile.id).await.unwrap().is_empty());
        drop(store);
        let _ = std::fs::remove_dir_all(root);
    }
}

mod home;

pub mod types;
pub use home::{ThothHome, resolve_home};
pub use types::*;
pub use validation::{
    JobValidationError, PROTECTED_EXTRA_FLAGS, SCALAR_PARAM_FLAGS, scalar_param_flag,
    validate_job_spec,
};

use sqlx::Row;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{str::FromStr, time::Duration};

#[derive(Clone)]
pub struct JobStore {
    pub pool: sqlx::SqlitePool,
    home: Option<ThothHome>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn normalize_name(field: &str, value: &str) -> ResourceResult<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(ResourceError::Validation {
            message: format!("{field} must not be blank"),
        });
    }
    Ok(normalized.to_owned())
}

fn validate_name(field: &str, value: &str) -> anyhow::Result<()> {
    normalize_name(field, value)
        .map(|_| ())
        .map_err(anyhow::Error::new)
}

fn matches_normalized_name(existing: &str, normalized: &str) -> bool {
    normalize_name("stored project name", existing)
        .is_ok_and(|existing| existing == normalized)
}

fn validate_credential_ref(reference: Option<&str>) -> anyhow::Result<()> {
    if let Some(reference) = reference {
        anyhow::ensure!(
            !reference.trim().is_empty(),
            "credential reference must not be blank"
        );
    }
    Ok(())
}

fn normalize_description(value: &str) -> ResourceResult<String> {
    const MAX_DESCRIPTION_CHARS: usize = 1024;

    let normalized = value.trim();
    if normalized.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(ResourceError::Validation {
            message: format!(
                "profile description must be at most {MAX_DESCRIPTION_CHARS} characters"
            ),
        });
    }
    Ok(normalized.to_owned())
}

fn resource_storage(error: impl Into<anyhow::Error>) -> ResourceError {
    ResourceError::Storage(error.into())
}

fn resource_validation(error: impl std::fmt::Display) -> ResourceError {
    ResourceError::Validation {
        message: error.to_string(),
    }
}

fn profile_name_write_error(error: sqlx::Error) -> ResourceError {
    if let Some(database_error) = error.as_database_error() {
        if database_error.is_unique_violation() {
            return ResourceError::DuplicateName;
        }
        if database_error.is_foreign_key_violation() {
            return ResourceError::NotFound;
        }
    }
    resource_storage(error)
}

fn is_sqlite_busy(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code)
        .is_some_and(|code| code == "5" || code == "517")
}

const CANCEL_BUSY_MAX_ATTEMPTS: usize = 4;
const CANCEL_BUSY_BACKOFF: Duration = Duration::from_millis(5);

#[cfg(test)]
static CANCEL_BUSY_RETRIES: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
fn record_cancel_busy_retry() {
    CANCEL_BUSY_RETRIES.fetch_add(1, Ordering::Relaxed);
}

#[cfg(not(test))]
fn record_cancel_busy_retry() {}

#[cfg(test)]
fn reset_cancel_busy_retries() {
    CANCEL_BUSY_RETRIES.store(0, Ordering::Relaxed);
}

#[cfg(test)]
fn cancel_busy_retries() -> usize {
    CANCEL_BUSY_RETRIES.load(Ordering::Relaxed)
}

async fn backoff_after_cancel_busy(
    tx: sqlx::Transaction<'_, sqlx::Sqlite>,
    error: sqlx::Error,
    busy_attempts: &mut usize,
) -> Result<(), sqlx::Error> {
    record_cancel_busy_retry();
    let _ = tx.rollback().await;
    *busy_attempts += 1;
    if *busy_attempts >= CANCEL_BUSY_MAX_ATTEMPTS {
        return Err(error);
    }
    tokio::time::sleep(CANCEL_BUSY_BACKOFF * (*busy_attempts as u32)).await;
    Ok(())
}

impl JobStore {
    pub async fn connect(db_path: &str) -> anyhow::Result<JobStore> {
        Self::connect_inner(db_path, None).await
    }

    /// Connects a profile-aware store to a deliberately resolved application home.
    pub async fn connect_with_home(db_path: &str, home: ThothHome) -> anyhow::Result<JobStore> {
        home.ensure_layout()?;
        Self::connect_inner(db_path, Some(home)).await
    }

    async fn connect_inner(db_path: &str, home: Option<ThothHome>) -> anyhow::Result<JobStore> {
        let opts = SqliteConnectOptions::from_str(db_path)?
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new().max_connections(5).connect_with(opts).await?;
        sqlx::migrate!().run(&pool).await?;
        Ok(JobStore { pool, home })
    }

    fn require_home(&self) -> anyhow::Result<&ThothHome> {
        self.home.as_ref().ok_or_else(|| {
            anyhow::anyhow!(
                "project and profile mutations require JobStore::connect_with_home and a configured ThothHome"
            )
        })
    }

    pub async fn create_project(&self, name: &str) -> ResourceResult<ProjectRecord> {
        let name = normalize_name("project name", name)?;
        let home = self.require_home().map_err(resource_storage)?;
        let id = uuid::Uuid::new_v4().to_string();
        let workspace_path = home.project_root(&id);
        home.ensure_project_layout(&id).map_err(resource_storage)?;

        let ts = now();
        let result = async {
            let mut tx = self.pool.begin().await.map_err(resource_storage)?;
            sqlx::query("UPDATE projects SET updated_at = updated_at WHERE 0")
                .execute(&mut *tx)
                .await
                .map_err(resource_storage)?;
            let existing: Vec<(String, String)> =
                sqlx::query_as("SELECT id, name FROM projects")
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(resource_storage)?;
            let duplicate = existing
                .iter()
                .any(|(_, existing_name)| matches_normalized_name(existing_name, &name));
            if duplicate {
                tx.rollback().await.map_err(resource_storage)?;
                return Err(ResourceError::DuplicateName);
            }
            sqlx::query(
                "INSERT INTO projects (id, name, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(&name)
            .bind(workspace_path.to_string_lossy().as_ref())
            .bind(&ts)
            .bind(&ts)
            .execute(&mut *tx)
            .await
            .map_err(resource_storage)?;
            tx.commit().await.map_err(resource_storage)
        }
        .await;

        if let Err(error) = result {
            let _ = std::fs::remove_dir_all(&workspace_path);
            return Err(error);
        }

        Ok(ProjectRecord {
            id,
            name,
            workspace_path,
            created_at: ts.clone(),
            updated_at: ts,
        })
    }

    pub async fn list_projects(&self) -> ResourceResult<Vec<ProjectRecord>> {
        let rows = sqlx::query("SELECT * FROM projects ORDER BY created_at, id")
            .fetch_all(&self.pool)
            .await
            .map_err(resource_storage)?;
        rows.iter()
            .map(Self::row_to_project)
            .collect::<anyhow::Result<_>>()
            .map_err(resource_storage)
    }

    pub async fn get_project(&self, project_id: &str) -> ResourceResult<ProjectRecord> {
        let row = sqlx::query("SELECT * FROM projects WHERE id = ?")
            .bind(project_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(resource_storage)?;
        row.as_ref()
            .map(Self::row_to_project)
            .transpose()
            .map_err(resource_storage)?
            .ok_or(ResourceError::NotFound)
    }

    pub async fn update_project(
        &self,
        project_id: &str,
        name: &str,
    ) -> ResourceResult<ProjectRecord> {
        let name = normalize_name("project name", name)?;
        let ts = now();
        let mut tx = self.pool.begin().await.map_err(resource_storage)?;
        let exists = sqlx::query("UPDATE projects SET updated_at = updated_at WHERE id = ?")
            .bind(project_id)
            .execute(&mut *tx)
            .await
            .map_err(resource_storage)?
            .rows_affected();
        if exists == 0 {
            tx.rollback().await.map_err(resource_storage)?;
            return Err(ResourceError::NotFound);
        }
        let existing: Vec<(String, String)> =
            sqlx::query_as("SELECT id, name FROM projects WHERE id <> ?")
                .bind(project_id)
                .fetch_all(&mut *tx)
                .await
                .map_err(resource_storage)?;
        let duplicate = existing
            .iter()
            .any(|(_, existing_name)| matches_normalized_name(existing_name, &name));
        if duplicate {
            tx.rollback().await.map_err(resource_storage)?;
            return Err(ResourceError::DuplicateName);
        }
        let row = sqlx::query(
            "UPDATE projects SET name = ?, updated_at = ? WHERE id = ? RETURNING *",
        )
        .bind(&name)
        .bind(&ts)
        .bind(project_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(resource_storage)?;
        tx.commit().await.map_err(resource_storage)?;
        row.as_ref()
            .map(Self::row_to_project)
            .transpose()
            .map_err(resource_storage)?
            .ok_or(ResourceError::NotFound)
    }

    pub async fn delete_project(&self, project_id: &str) -> ResourceResult<()> {
        let mut tx = self.pool.begin().await.map_err(resource_storage)?;

        // The first statement obtains SQLite's write reservation before the
        // active-job guard, making the guard and metadata deletion atomic with
        // respect to other writers.
        let exists = sqlx::query("UPDATE projects SET updated_at = updated_at WHERE id = ?")
            .bind(project_id)
            .execute(&mut *tx)
            .await
            .map_err(resource_storage)?
            .rows_affected();
        if exists == 0 {
            tx.rollback().await.map_err(resource_storage)?;
            return Err(ResourceError::NotFound);
        }

        let active: i64 = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM jobs
                WHERE project_id = ? AND status IN ('queued', 'running')
            )",
        )
        .bind(project_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(resource_storage)?;
        if active != 0 {
            tx.rollback().await.map_err(resource_storage)?;
            return Err(ResourceError::ActiveJobs);
        }

        sqlx::query(
            "DELETE FROM profile_revisions
             WHERE profile_id IN (SELECT id FROM profiles WHERE project_id = ?)",
        )
        .bind(project_id)
        .execute(&mut *tx)
        .await
        .map_err(resource_storage)?;
        sqlx::query("DELETE FROM profiles WHERE project_id = ?")
            .bind(project_id)
            .execute(&mut *tx)
            .await
            .map_err(resource_storage)?;
        sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind(project_id)
            .execute(&mut *tx)
            .await
            .map_err(resource_storage)?;
        tx.commit().await.map_err(resource_storage)
    }

    pub async fn create_profile(
        &self,
        project_id: &str,
        name: &str,
        description: &str,
        settings: ProfileSettings,
        credential_ref: Option<&str>,
    ) -> ResourceResult<ProfileRecord> {
        let name = normalize_name("profile name", name)?;
        validate_credential_ref(credential_ref).map_err(resource_validation)?;
        let description = normalize_description(description)?;
        let home = self.require_home().map_err(resource_storage)?;
        validate_settings(&settings, home).map_err(resource_validation)?;

        let id = uuid::Uuid::new_v4().to_string();
        let settings_json = serde_json::to_string(&settings).map_err(resource_storage)?;
        let ts = now();
        sqlx::query(
            "INSERT INTO profiles (id, project_id, name, description, schema_version, settings_json, credential_ref, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(project_id)
        .bind(&name)
        .bind(&description)
        .bind(settings.schema_version as i64)
        .bind(&settings_json)
        .bind(credential_ref)
        .bind(&ts)
        .bind(&ts)
        .execute(&self.pool)
        .await
        .map_err(profile_name_write_error)?;

        Ok(ProfileRecord {
            id,
            project_id: project_id.to_owned(),
            name,
            description,
            settings,
            credential_ref: credential_ref.map(str::to_owned),
            created_at: ts.clone(),
            updated_at: ts,
        })
    }

    pub async fn list_profiles(&self, project_id: &str) -> ResourceResult<Vec<ProfileRecord>> {
        let rows = sqlx::query("SELECT * FROM profiles WHERE project_id = ? ORDER BY name, id")
            .bind(project_id)
            .fetch_all(&self.pool)
            .await
            .map_err(resource_storage)?;
        rows.iter()
            .map(Self::row_to_profile)
            .collect::<anyhow::Result<_>>()
            .map_err(resource_storage)
    }

    pub async fn get_profile(&self, profile_id: &str) -> ResourceResult<Option<ProfileRecord>> {
        let row = sqlx::query("SELECT * FROM profiles WHERE id = ?")
            .bind(profile_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(resource_storage)?;
        row.as_ref()
            .map(Self::row_to_profile)
            .transpose()
            .map_err(resource_storage)
    }

    pub async fn update_profile(
        &self,
        profile_id: &str,
        name: &str,
        description: &str,
        settings: ProfileSettings,
        credential_ref: Option<&str>,
    ) -> ResourceResult<ProfileRecord> {
        let name = normalize_name("profile name", name)?;
        validate_credential_ref(credential_ref).map_err(resource_validation)?;
        let description = normalize_description(description)?;
        let home = self.require_home().map_err(resource_storage)?;
        validate_settings(&settings, home).map_err(resource_validation)?;

        let settings_json = serde_json::to_string(&settings).map_err(resource_storage)?;
        let ts = now();
        let mut tx = self.pool.begin().await.map_err(resource_storage)?;
        let row = sqlx::query("SELECT * FROM profiles WHERE id = ?")
            .bind(profile_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(resource_storage)?;
        let previous = row
            .as_ref()
            .map(Self::row_to_profile)
            .transpose()
            .map_err(resource_storage)?
            .ok_or(ResourceError::NotFound)?;

        let revision_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO profile_revisions
                (id, profile_id, revision, name, description, schema_version, settings_json, credential_ref, created_at)
             VALUES
                (?, ?, (SELECT COALESCE(MAX(revision), 0) + 1 FROM profile_revisions WHERE profile_id = ?), ?, ?, ?, ?, ?, ?)",
        )
        .bind(&revision_id)
        .bind(&previous.id)
        .bind(&previous.id)
        .bind(&previous.name)
        .bind(&previous.description)
        .bind(previous.settings.schema_version as i64)
        .bind(serde_json::to_string(&previous.settings).map_err(resource_storage)?)
        .bind(&previous.credential_ref)
        .bind(&ts)
        .execute(&mut *tx)
        .await
        .map_err(resource_storage)?;

        sqlx::query(
            "UPDATE profiles
             SET name = ?, description = ?, schema_version = ?, settings_json = ?, credential_ref = ?, updated_at = ?
             WHERE id = ?",
        )
        .bind(&name)
        .bind(&description)
        .bind(settings.schema_version as i64)
        .bind(settings_json)
        .bind(credential_ref)
        .bind(&ts)
        .bind(profile_id)
        .execute(&mut *tx)
        .await
        .map_err(profile_name_write_error)?;
        tx.commit().await.map_err(resource_storage)?;

        Ok(ProfileRecord {
            id: previous.id,
            project_id: previous.project_id,
            name,
            description,
            settings,
            credential_ref: credential_ref.map(str::to_owned),
            created_at: previous.created_at,
            updated_at: ts,
        })
    }

    pub async fn list_profile_revisions(
        &self,
        profile_id: &str,
    ) -> ResourceResult<Vec<ProfileRevision>> {
        let rows = sqlx::query(
            "SELECT * FROM profile_revisions WHERE profile_id = ? ORDER BY revision DESC, id DESC",
        )
        .bind(profile_id)
        .fetch_all(&self.pool)
        .await
        .map_err(resource_storage)?;
        rows.iter()
            .map(Self::row_to_profile_revision)
            .collect::<anyhow::Result<_>>()
            .map_err(resource_storage)
    }

    pub async fn restore_profile_revision(
        &self,
        profile_id: &str,
        revision_id: &str,
    ) -> ResourceResult<ProfileRecord> {
        let row = sqlx::query(
            "SELECT * FROM profile_revisions WHERE id = ? AND profile_id = ?",
        )
        .bind(revision_id)
        .bind(profile_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(resource_storage)?;
        let revision = row
            .as_ref()
            .map(Self::row_to_profile_revision)
            .transpose()
            .map_err(resource_storage)?
            .ok_or(ResourceError::NotFound)?;
        self.update_profile(
            profile_id,
            &revision.name,
            &revision.description,
            revision.settings,
            revision.credential_ref.as_deref(),
        )
        .await
    }

    pub async fn delete_profile(
        &self,
        project_id: &str,
        profile_id: &str,
    ) -> ResourceResult<()> {
        let mut tx = self.pool.begin().await.map_err(resource_storage)?;
        let exists = sqlx::query(
            "UPDATE profiles SET updated_at = updated_at WHERE id = ? AND project_id = ?",
        )
        .bind(profile_id)
        .bind(project_id)
        .execute(&mut *tx)
        .await
        .map_err(resource_storage)?
        .rows_affected();
        if exists == 0 {
            tx.rollback().await.map_err(resource_storage)?;
            return Err(ResourceError::NotFound);
        }

        sqlx::query("DELETE FROM profile_revisions WHERE profile_id = ?")
            .bind(profile_id)
            .execute(&mut *tx)
            .await
            .map_err(resource_storage)?;
        sqlx::query("DELETE FROM profiles WHERE id = ? AND project_id = ?")
            .bind(profile_id)
            .bind(project_id)
            .execute(&mut *tx)
            .await
            .map_err(resource_storage)?;
        tx.commit().await.map_err(resource_storage)
    }

    fn row_to_project(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<ProjectRecord> {
        Ok(ProjectRecord {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            workspace_path: std::path::PathBuf::from(row.try_get::<String, _>("workspace_path")?),
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
        })
    }

    fn row_to_profile(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<ProfileRecord> {
        let settings_json: String = row.try_get("settings_json")?;
        let settings: ProfileSettings = serde_json::from_str(&settings_json)?;
        let schema_version: i64 = row.try_get("schema_version")?;
        anyhow::ensure!(
            schema_version == i64::from(settings.schema_version),
            "stored profile schema version does not match its settings"
        );
        Ok(ProfileRecord {
            id: row.try_get("id")?,
            project_id: row.try_get("project_id")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            settings,
            credential_ref: row.try_get("credential_ref")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
        })
    }

    fn row_to_profile_revision(
        row: &sqlx::sqlite::SqliteRow,
    ) -> anyhow::Result<ProfileRevision> {
        let settings_json: String = row.try_get("settings_json")?;
        let settings: ProfileSettings = serde_json::from_str(&settings_json)?;
        let schema_version: i64 = row.try_get("schema_version")?;
        anyhow::ensure!(
            schema_version == i64::from(settings.schema_version),
            "stored profile revision schema version does not match its settings"
        );
        Ok(ProfileRevision {
            id: row.try_get("id")?,
            profile_id: row.try_get("profile_id")?,
            revision: row.try_get("revision")?,
            name: row.try_get("name")?,
            description: row.try_get("description")?,
            settings,
            credential_ref: row.try_get("credential_ref")?,
            created_at: row.try_get("created_at")?,
        })
    }

    fn row_to_record(row: &sqlx::sqlite::SqliteRow) -> JobRecord {
        let params: String = row.get("params");
        let json_column = |column| {
            row.get::<Option<String>, _>(column)
                .and_then(|value| serde_json::from_str(&value).ok())
        };
        JobRecord {
            id: row.get("id"),
            spec: JobSpec {
                command: row.get("command"),
                url: row.get("url"),
                content_set: row.get("content_set"),
                params: serde_json::from_str(&params).unwrap_or(serde_json::Value::Null),
            },
            project_id: row.get("project_id"),
            profile_id: row.get("profile_id"),
            profile_revision: row.get("profile_revision"),
            resolved_settings_snapshot: json_column("resolved_settings_snapshot"),
            override_summary: json_column("override_summary"),
            status: JobStatus::from_str(&row.get::<String, _>("status")).unwrap_or(JobStatus::Failed),
            stage: row.get("stage"),
            pct: row.get::<f64, _>("pct") as f32,
            error: row.get("error"),
            output_dir: row.get("output_dir"),
            worker_id: row.get("worker_id"),
            cancel_requested: row.get::<i64, _>("cancel_requested") != 0,
            created_at: row.get("created_at"),
            started_at: row.get("started_at"),
            finished_at: row.get("finished_at"),
            heartbeat_at: row.get("heartbeat_at"),
            updated_at: row.get("updated_at"),
        }
    }

    /// Insert a queued job. The caller supplies `id` so it can derive a matching
    /// `output_dir` (the artifact route serves `output_root/<id>`) and hand the
    /// id back to the client without a round-trip.
    pub async fn enqueue(&self, id: &str, spec: &JobSpec, output_dir: &str) -> anyhow::Result<()> {
        let ts = now();
        sqlx::query(
            "INSERT INTO jobs (id, command, url, content_set, params, status, output_dir, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
        )
        .bind(id).bind(&spec.command).bind(&spec.url).bind(&spec.content_set)
        .bind(spec.params.to_string()).bind(output_dir).bind(&ts).bind(&ts)
        .execute(&self.pool).await?;
        Ok(())
    }

    /// Inserts a queued job and its immutable, redacted configuration snapshot
    /// in the same SQLite statement. It never reads the selected profile.
    pub async fn enqueue_resolved(
        &self,
        id: &str,
        request: &EnqueueRequest,
        output_dir: &str,
    ) -> anyhow::Result<()> {
        validate_name("project id", &request.project_id)?;
        if let Some(profile_id) = &request.profile_id {
            validate_name("profile id", profile_id)?;
        }
        if let Some(profile_revision) = request.profile_revision {
            anyhow::ensure!(profile_revision > 0, "profile revision must be positive");
        }
        validate_name("output directory", output_dir)?;

        let snapshot = redacted_settings_json(&request.resolved_settings, None).to_string();
        let ts = now();
        sqlx::query(
            "INSERT INTO jobs
                (id, command, url, content_set, params, status, output_dir, created_at, updated_at,
                 project_id, profile_id, profile_revision, resolved_settings_snapshot, override_summary)
             VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(&request.spec.command)
        .bind(&request.spec.url)
        .bind(&request.spec.content_set)
        .bind(request.spec.params.to_string())
        .bind(output_dir)
        .bind(&ts)
        .bind(&ts)
        .bind(&request.project_id)
        .bind(&request.profile_id)
        .bind(request.profile_revision)
        .bind(snapshot)
        .bind(request.override_summary.as_deref())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Current revision number of a live profile — one past the highest archived
    /// revision (a never-edited profile is revision 1). Recorded on a job so the
    /// snapshot can be traced back to the exact profile version that produced it.
    pub async fn current_profile_revision(&self, profile_id: &str) -> anyhow::Result<i64> {
        let next: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(revision), 0) + 1 FROM profile_revisions WHERE profile_id = ?",
        )
        .bind(profile_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(next)
    }

    pub async fn get(&self, id: &str) -> anyhow::Result<Option<JobRecord>> {
        let row = sqlx::query("SELECT * FROM jobs WHERE id = ?").bind(id)
            .fetch_optional(&self.pool).await?;
        Ok(row.map(|r| Self::row_to_record(&r)))
    }

    pub async fn list(&self) -> anyhow::Result<Vec<JobRecord>> {
        let rows = sqlx::query("SELECT * FROM jobs ORDER BY created_at DESC")
            .fetch_all(&self.pool).await?;
        Ok(rows.iter().map(Self::row_to_record).collect())
    }

    pub async fn claim_next(&self, worker_id: &str) -> anyhow::Result<Option<JobRecord>> {
        let ts = now();
        let row = sqlx::query(
            "UPDATE jobs SET status='running', worker_id=?, started_at=?, heartbeat_at=?, updated_at=?
             WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1)
             RETURNING *",
        )
        .bind(worker_id).bind(&ts).bind(&ts).bind(&ts)
        .fetch_optional(&self.pool).await?;
        Ok(row.map(|r| Self::row_to_record(&r)))
    }

    pub async fn append_event(&self, job_id: &str, kind: &str, stage: Option<&str>, pct: Option<f32>, message: Option<&str>) -> anyhow::Result<i64> {
        let seq: i64 = sqlx::query(
            "INSERT INTO job_events (job_id, type, stage, pct, message, ts) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
        )
        .bind(job_id).bind(kind).bind(stage).bind(pct.map(|p| p as f64)).bind(message).bind(now())
        .fetch_one(&self.pool).await?.get("seq");
        Ok(seq)
    }

    pub async fn update_progress(&self, id: &str, stage: &str, pct: f32) -> anyhow::Result<()> {
        sqlx::query("UPDATE jobs SET stage=?, pct=?, heartbeat_at=?, updated_at=? WHERE id=?")
            .bind(stage).bind(pct as f64).bind(now()).bind(now()).bind(id)
            .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn heartbeat(&self, id: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE jobs SET heartbeat_at=? WHERE id=?").bind(now()).bind(id)
            .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn is_cancel_requested(&self, id: &str) -> anyhow::Result<bool> {
        let v: Option<i64> = sqlx::query_scalar("SELECT cancel_requested FROM jobs WHERE id=?")
            .bind(id).fetch_optional(&self.pool).await?;
        Ok(v.unwrap_or(0) != 0)
    }

    pub async fn request_cancel(&self, id: &str) -> anyhow::Result<CancelRequestOutcome> {
        let mut busy_attempts = 0;
        loop {
            let mut tx = self.pool.begin().await?;
            let state: Option<(String, i64)> =
                sqlx::query_as("SELECT status, cancel_requested FROM jobs WHERE id=?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?;

            let Some((status, cancel_requested)) = state else {
                tx.commit().await?;
                return Ok(CancelRequestOutcome::NotFound);
            };

            if status == "running" {
                if cancel_requested != 0 {
                    tx.commit().await?;
                    return Ok(CancelRequestOutcome::AlreadyRequested);
                }
                let result = match sqlx::query(
                    "UPDATE jobs SET cancel_requested=1, updated_at=? WHERE id=? AND status='running' AND cancel_requested=0",
                )
                .bind(now())
                .bind(id)
                .execute(&mut *tx)
                .await
                {
                    Ok(result) => result,
                    Err(error) if is_sqlite_busy(&error) => {
                        backoff_after_cancel_busy(tx, error, &mut busy_attempts).await?;
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                if result.rows_affected() == 0 {
                    tx.commit().await?;
                    continue;
                }
                tx.commit().await?;
                return Ok(CancelRequestOutcome::RunningRequested);
            }

            if status != "queued" {
                tx.commit().await?;
                let status = JobStatus::from_str(&status).map_err(anyhow::Error::msg)?;
                return Ok(CancelRequestOutcome::Terminal(status));
            }

            let ts = now();
            let result = match sqlx::query(
                "UPDATE jobs SET status='cancelled', finished_at=?, updated_at=? WHERE id=? AND status='queued'",
            )
            .bind(&ts)
            .bind(&ts)
            .bind(id)
            .execute(&mut *tx)
            .await
            {
                Ok(result) => result,
                Err(error) if is_sqlite_busy(&error) => {
                    backoff_after_cancel_busy(tx, error, &mut busy_attempts).await?;
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            if result.rows_affected() == 0 {
                tx.commit().await?;
                continue;
            }
            sqlx::query(
                "INSERT INTO job_events (job_id, type, stage, pct, message, ts) VALUES (?, 'cancelled', NULL, NULL, NULL, ?)",
            )
            .bind(id)
            .bind(&ts)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(CancelRequestOutcome::QueuedCancelled);
        }
    }

    pub async fn finish_running(
        &self,
        id: &str,
        status: JobStatus,
        error: Option<&str>,
        event_kind: &str,
        message: Option<&str>,
    ) -> anyhow::Result<bool> {
        self.finish_running_transaction(id, status, error, event_kind, message, None)
            .await
    }

    async fn finish_running_transaction(
        &self,
        id: &str,
        status: JobStatus,
        error: Option<&str>,
        event_kind: &str,
        message: Option<&str>,
        stale_before: Option<&str>,
    ) -> anyhow::Result<bool> {
        anyhow::ensure!(
            status.is_terminal(),
            "finish_running requires a terminal status"
        );
        let mut tx = self.pool.begin().await?;
        let ts = now();
        let pct = if status == JobStatus::Succeeded {
            Some(1.0_f64)
        } else {
            None
        };
        let result = if let Some(cutoff) = stale_before {
            sqlx::query(
                "UPDATE jobs SET status=?, error=?, finished_at=?, updated_at=?, pct=COALESCE(?, pct)
                 WHERE id=? AND status='running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)",
            )
            .bind(status.as_str())
            .bind(error)
            .bind(&ts)
            .bind(&ts)
            .bind(pct)
            .bind(id)
            .bind(cutoff)
            .execute(&mut *tx)
            .await?
        } else {
            sqlx::query(
                "UPDATE jobs SET status=?, error=?, finished_at=?, updated_at=?, pct=COALESCE(?, pct) WHERE id=? AND status='running'",
            )
            .bind(status.as_str())
            .bind(error)
            .bind(&ts)
            .bind(&ts)
            .bind(pct)
            .bind(id)
            .execute(&mut *tx)
            .await?
        };
        if result.rows_affected() == 0 {
            tx.commit().await?;
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO job_events (job_id, type, stage, pct, message, ts) VALUES (?, ?, NULL, NULL, ?, ?)",
        )
        .bind(id)
        .bind(event_kind)
        .bind(message)
        .bind(&ts)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn events_since(&self, job_id: &str, after_seq: i64) -> anyhow::Result<Vec<JobEvent>> {
        let rows = sqlx::query("SELECT * FROM job_events WHERE job_id=? AND seq>? ORDER BY seq")
            .bind(job_id).bind(after_seq).fetch_all(&self.pool).await?;
        Ok(rows.iter().map(|r| JobEvent {
            seq: r.get("seq"),
            job_id: r.get("job_id"),
            kind: r.get("type"),
            stage: r.get("stage"),
            pct: r.get::<Option<f64>, _>("pct").map(|p| p as f32),
            message: r.get("message"),
            ts: r.get("ts"),
        }).collect())
    }

    pub async fn reap_stale(&self, older_than_secs: i64) -> anyhow::Result<Vec<String>> {
        let cutoff = (chrono::Utc::now() - chrono::Duration::seconds(older_than_secs)).to_rfc3339();
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM jobs WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)",
        ).bind(&cutoff).fetch_all(&self.pool).await?;
        let mut reaped = Vec::with_capacity(ids.len());
        for id in ids {
            let message = "worker died (stale heartbeat)";
            if self
                .finish_running_transaction(
                    &id,
                    JobStatus::Failed,
                    Some(message),
                    "error",
                    Some(message),
                    Some(&cutoff),
                )
                .await?
            {
                reaped.push(id);
            }
        }
        Ok(reaped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn connect_creates_schema() {
        let dir = std::env::temp_dir().join(format!("thoth-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");
        let store = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        // both tables exist
        let n: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('jobs','job_events')",
        ).fetch_one(&store.pool).await.unwrap();
        assert_eq!(n, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn snapshot_migration_adds_nullable_provenance_columns() {
        let (store, dir) = fresh().await;
        let columns: Vec<String> = sqlx::query("PRAGMA table_info(jobs)")
            .fetch_all(&store.pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get("name"))
            .collect();

        for expected in [
            "project_id",
            "profile_id",
            "profile_revision",
            "resolved_settings_snapshot",
            "override_summary",
        ] {
            assert!(columns.contains(&expected.to_owned()), "missing {expected}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn snapshot_migration_upgrades_a_legacy_job_without_provenance() {
        let dir = std::env::temp_dir().join(format!("thoth-legacy-job-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("jobs.db");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::from_str(db.to_str().unwrap()).unwrap().create_if_missing(true))
            .await
            .unwrap();
        let all_migrations = sqlx::migrate!();
        let legacy_migrator = sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(
                all_migrations
                    .iter()
                    .filter(|migration| migration.version < 3)
                    .cloned()
                    .collect(),
            ),
            ignore_missing: false,
            locking: true,
            no_tx: false,
        };
        legacy_migrator.run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO jobs (id, command, params, status, output_dir, created_at, updated_at)
             VALUES ('legacy-job', 'run', '{}', 'queued', 'legacy-out', '2026-07-18T00:00:00Z', '2026-07-18T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        drop(pool);

        let store = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let job = store.get("legacy-job").await.unwrap().unwrap();

        assert_eq!(job.spec.command, "run");
        assert_eq!(job.output_dir, "legacy-out");
        assert_eq!(job.project_id, None);
        assert_eq!(job.profile_id, None);
        assert_eq!(job.profile_revision, None);
        assert_eq!(job.resolved_settings_snapshot, None);
        assert_eq!(job.override_summary, None);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    async fn fresh() -> (JobStore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("thoth-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = JobStore::connect(dir.join("t.db").to_str().unwrap()).await.unwrap();
        (store, dir)
    }
    fn run_spec(url: &str) -> JobSpec {
        JobSpec { command: "run".into(), url: Some(url.into()), content_set: None, params: serde_json::json!({}) }
    }
    async fn enq(s: &JobStore, url: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        s.enqueue(&id, &run_spec(url), "out/j").await.unwrap();
        id
    }

    #[tokio::test]
    async fn enqueue_get_roundtrip() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "https://x/y").await;
        let rec = s.get(&id).await.unwrap().unwrap();
        assert_eq!(rec.status, JobStatus::Queued);
        assert_eq!(rec.spec.url.as_deref(), Some("https://x/y"));
        assert_eq!(rec.output_dir, "out/j");
        assert_eq!(rec.project_id, None);
        assert_eq!(rec.profile_id, None);
        assert_eq!(rec.profile_revision, None);
        assert_eq!(rec.resolved_settings_snapshot, None);
        assert_eq!(rec.override_summary, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn job_snapshot_survives_profile_edit() {
        let root = std::env::temp_dir().join(format!("thoth-job-snapshot-{}", uuid::Uuid::new_v4()));
        let home = ThothHome::for_test(&root);
        home.ensure_layout().unwrap();
        let store = JobStore::connect_with_home(
            home.data_dir().join("jobs.db").to_str().unwrap(),
            home.clone(),
        )
        .await
        .unwrap();
        let project = store.create_project("Snapshot").await.unwrap();
        let profile = store
            .create_profile(&project.id, "Default", "", ProfileSettings::default(), None)
            .await
            .unwrap();
        let resolved = resolve_settings(&profile.settings, &RunOverrides::default(), &home).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let output_dir = home.project_outputs(&project.id).join(&id);

        store
            .enqueue_resolved(
                &id,
                &EnqueueRequest {
                    spec: run_spec("https://x/y"),
                    project_id: project.id.clone(),
                    profile_id: Some(profile.id.clone()),
                    profile_revision: None,
                    override_summary: None,
                    resolved_settings: resolved,
                },
                output_dir.to_str().unwrap(),
            )
            .await
            .unwrap();

        let mut updated = ProfileSettings::default();
        updated.analysis.max_clips = 5;
        store
            .update_profile(&profile.id, "Default", "", updated, None)
            .await
            .unwrap();

        let job = store.get(&id).await.unwrap().unwrap();
        assert_eq!(job.project_id.as_deref(), Some(project.id.as_str()));
        assert_eq!(job.profile_id.as_deref(), Some(profile.id.as_str()));
        assert_eq!(job.profile_revision, None);
        let snapshot = job.resolved_settings_snapshot.unwrap();
        assert_eq!(snapshot["analysis"]["max_clips"], 3);
        assert!(snapshot.get("credential_value").is_none());
        assert_eq!(store.get_profile(&profile.id).await.unwrap().unwrap().settings.analysis.max_clips, 5);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn claim_is_atomic_single_winner() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        let (a, b) = tokio::join!(s.claim_next("w1"), s.claim_next("w2"));
        let claims: Vec<_> = [a.unwrap(), b.unwrap()].into_iter().flatten().collect();
        assert_eq!(claims.len(), 1, "exactly one worker claims the job");
        assert_eq!(claims[0].id, id);
        assert_eq!(claims[0].status, JobStatus::Running);
        // a second claim finds nothing
        assert!(s.claim_next("w3").await.unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn events_since_orders_and_resumes() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        let s1 = s.append_event(&id, "progress", Some("ingest"), Some(0.1), None).await.unwrap();
        let s2 = s.append_event(&id, "log", None, None, Some("hello")).await.unwrap();
        assert!(s2 > s1);
        let after_first = s.events_since(&id, s1).await.unwrap();
        assert_eq!(after_first.len(), 1);
        assert_eq!(after_first[0].seq, s2);
        assert_eq!(after_first[0].kind, "log");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancel_queued_transitions_and_emits_one_cancelled_event() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;

        let outcome = s.request_cancel(&id).await.unwrap();

        assert_eq!(outcome, CancelRequestOutcome::QueuedCancelled);
        assert_eq!(s.get(&id).await.unwrap().unwrap().status, JobStatus::Cancelled);
        let events = s.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "cancelled");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancel_terminal_returns_terminal_without_another_event() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.request_cancel(&id).await.unwrap();

        let outcome = s.request_cancel(&id).await.unwrap();

        assert_eq!(outcome, CancelRequestOutcome::Terminal(JobStatus::Cancelled));
        assert_eq!(s.events_since(&id, 0).await.unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancel_running_sets_only_cancel_requested() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.claim_next("w1").await.unwrap();

        let outcome = s.request_cancel(&id).await.unwrap();

        assert_eq!(outcome, CancelRequestOutcome::RunningRequested);
        let job = s.get(&id).await.unwrap().unwrap();
        assert_eq!(job.status, JobStatus::Running);
        assert!(job.cancel_requested);
        assert!(s.events_since(&id, 0).await.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn second_running_cancel_returns_already_requested() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.claim_next("w1").await.unwrap();
        s.request_cancel(&id).await.unwrap();

        let outcome = s.request_cancel(&id).await.unwrap();

        assert_eq!(outcome, CancelRequestOutcome::AlreadyRequested);
        assert_eq!(s.get(&id).await.unwrap().unwrap().status, JobStatus::Running);
        assert!(s.events_since(&id, 0).await.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn queued_cancel_rereads_after_losing_terminal_race() {
        reset_cancel_busy_retries();
        let dir = std::env::temp_dir().join(format!("thoth-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");
        let first = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let second = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let id = enq(&first, "u").await;

        let mut winning_tx = second.pool.begin().await.unwrap();
        let ts = now();
        sqlx::query(
            "UPDATE jobs SET status='cancelled', finished_at=?, updated_at=? WHERE id=? AND status='queued'",
        )
        .bind(&ts)
        .bind(&ts)
        .bind(&id)
        .execute(&mut *winning_tx)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO job_events (job_id, type, stage, pct, message, ts) VALUES (?, 'cancelled', NULL, NULL, NULL, ?)",
        )
        .bind(&id)
        .bind(&ts)
        .execute(&mut *winning_tx)
        .await
        .unwrap();
        let cancelling = {
            let store = first.clone();
            let id = id.clone();
            tokio::spawn(async move { store.request_cancel(&id).await })
        };
        for _ in 0..100 {
            if cancelling.is_finished() {
                break;
            }
            tokio::task::yield_now().await;
        }
        winning_tx.commit().await.unwrap();

        let outcome = cancelling.await.unwrap().unwrap();

        assert_eq!(outcome, CancelRequestOutcome::Terminal(JobStatus::Cancelled));
        let events = first.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "cancelled");
        assert!(
            cancel_busy_retries() > 0,
            "test must exercise the BUSY retry path"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn cancel_persistent_busy_returns_error_within_retry_budget() {
        let dir = std::env::temp_dir().join(format!("thoth-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");
        let holder = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let id = enq(&holder, "u").await;
        let contender_options = SqliteConnectOptions::from_str(db.to_str().unwrap())
            .unwrap()
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_millis(1));
        let contender = JobStore {
            pool: SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(contender_options)
                .await
                .unwrap(),
            home: None,
        };

        let mut write_lock = holder.pool.begin().await.unwrap();
        sqlx::query("UPDATE jobs SET updated_at=updated_at WHERE id=?")
            .bind(&id)
            .execute(&mut *write_lock)
            .await
            .unwrap();

        let started = std::time::Instant::now();
        let result =
            tokio::time::timeout(Duration::from_millis(250), contender.request_cancel(&id))
                .await
                .expect("request_cancel exceeded retry budget");

        let error = result.unwrap_err();
        assert!(error.to_string().contains("database is locked"));
        assert!(started.elapsed() < Duration::from_millis(250));
        drop(write_lock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn finish_running_succeeds_once_with_terminal_event() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.claim_next("w1").await.unwrap();

        let finished = s
            .finish_running(
                &id,
                JobStatus::Succeeded,
                None,
                "complete",
                Some("done"),
            )
            .await
            .unwrap();

        assert!(finished);
        let job = s.get(&id).await.unwrap().unwrap();
        assert_eq!(job.status, JobStatus::Succeeded);
        assert_eq!(job.pct, 1.0);
        let events = s.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "complete");
        assert_eq!(events[0].message.as_deref(), Some("done"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn finish_running_on_terminal_returns_false_without_event() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.claim_next("w1").await.unwrap();
        s.finish_running(&id, JobStatus::Succeeded, None, "complete", None)
            .await
            .unwrap();

        let finished = s
            .finish_running(
                &id,
                JobStatus::Failed,
                Some("late failure"),
                "error",
                Some("late failure"),
            )
            .await
            .unwrap();

        assert!(!finished);
        assert_eq!(s.get(&id).await.unwrap().unwrap().status, JobStatus::Succeeded);
        let events = s.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "complete");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn finish_running_rejects_non_terminal_status() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.claim_next("w1").await.unwrap();

        let result = s
            .finish_running(&id, JobStatus::Running, None, "progress", None)
            .await;

        assert!(result.is_err());
        assert_eq!(s.get(&id).await.unwrap().unwrap().status, JobStatus::Running);
        assert!(s.events_since(&id, 0).await.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn reaper_does_not_overwrite_terminal_or_duplicate_event() {
        let dir = std::env::temp_dir().join(format!("thoth-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");
        let reaper_store = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let finisher_store = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let id = enq(&reaper_store, "u").await;
        reaper_store.claim_next("w1").await.unwrap();
        sqlx::query("UPDATE jobs SET heartbeat_at=? WHERE id=?")
            .bind("2000-01-01T00:00:00+00:00")
            .bind(&id)
            .execute(&reaper_store.pool)
            .await
            .unwrap();

        // Occupy this store's pool, then use FIFO acquisition to pause the
        // reaper after its stale-id query and before its terminal update.
        let mut held = Vec::new();
        for _ in 0..5 {
            held.push(reaper_store.pool.acquire().await.unwrap());
        }
        let reaper_task = {
            let store = reaper_store.clone();
            tokio::spawn(async move { store.reap_stale(30).await })
        };
        tokio::task::yield_now().await;
        let blocker = {
            let pool = reaper_store.pool.clone();
            tokio::spawn(async move { pool.acquire().await.unwrap() })
        };
        tokio::task::yield_now().await;
        drop(held.pop());
        let blocker = blocker.await.unwrap();

        assert!(
            finisher_store
                .finish_running(&id, JobStatus::Succeeded, None, "complete", Some("done"))
                .await
                .unwrap()
        );
        drop(blocker);
        drop(held);

        let reaped_ids = reaper_task.await.unwrap().unwrap();
        assert!(reaped_ids.is_empty());
        assert_eq!(
            finisher_store.get(&id).await.unwrap().unwrap().status,
            JobStatus::Succeeded
        );
        let events = finisher_store.events_since(&id, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "complete");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn reaper_does_not_fail_job_with_refreshed_heartbeat() {
        let dir = std::env::temp_dir().join(format!("thoth-jobs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("t.db");
        let reaper_store = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let heartbeat_store = JobStore::connect(db.to_str().unwrap()).await.unwrap();
        let id = enq(&reaper_store, "u").await;
        reaper_store.claim_next("w1").await.unwrap();
        sqlx::query("UPDATE jobs SET heartbeat_at=? WHERE id=?")
            .bind("2000-01-01T00:00:00+00:00")
            .bind(&id)
            .execute(&reaper_store.pool)
            .await
            .unwrap();

        let mut held = Vec::new();
        for _ in 0..5 {
            held.push(reaper_store.pool.acquire().await.unwrap());
        }
        let reaper_task = {
            let store = reaper_store.clone();
            tokio::spawn(async move { store.reap_stale(30).await })
        };
        tokio::task::yield_now().await;
        let blocker = {
            let pool = reaper_store.pool.clone();
            tokio::spawn(async move { pool.acquire().await.unwrap() })
        };
        tokio::task::yield_now().await;
        drop(held.pop());
        let blocker = blocker.await.unwrap();

        heartbeat_store.heartbeat(&id).await.unwrap();
        drop(blocker);
        drop(held);

        let reaped_ids = reaper_task.await.unwrap().unwrap();
        assert!(reaped_ids.is_empty());
        assert_eq!(
            heartbeat_store.get(&id).await.unwrap().unwrap().status,
            JobStatus::Running
        );
        assert!(
            heartbeat_store
                .events_since(&id, 0)
                .await
                .unwrap()
                .is_empty()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn reap_marks_stale_running_failed() {
        let (s, dir) = fresh().await;
        let id = enq(&s, "u").await;
        s.claim_next("w1").await.unwrap();
        // force a stale heartbeat well in the past
        sqlx::query("UPDATE jobs SET heartbeat_at=? WHERE id=?")
            .bind("2000-01-01T00:00:00+00:00").bind(&id).execute(&s.pool).await.unwrap();
        let reaped = s.reap_stale(30).await.unwrap();
        assert_eq!(reaped, vec![id.clone()]);
        assert_eq!(s.get(&id).await.unwrap().unwrap().status, JobStatus::Failed);
        // a terminal error event was appended
        let evs = s.events_since(&id, 0).await.unwrap();
        assert!(evs.iter().any(|e| e.kind == "error"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
