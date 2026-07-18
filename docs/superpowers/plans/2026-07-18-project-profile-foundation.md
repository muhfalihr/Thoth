# Project Profile Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Add \`THOTH_HOME\`, typed project profiles, revisions, and immutable job snapshots to \`thoth-jobs\`.

**Architecture:** \`thoth-jobs\` owns home resolution, settings schema, validation, and SQLite persistence. Server, worker, dashboard, and CLI consume those types rather than TOML text.

**Tech Stack:** Rust 2024, Serde, SQLx 0.8, SQLite WAL, Tokio, UUID.

## Global Constraints

- Follow red-green-refactor for every production behavior.
- Preserve dirty user files; stage only named files and never run \`git add .\`.
- Home precedence is exactly \`--home <path> > THOTH_HOME > ~/.thoth\`.
- Profiles are unique by \`(project_id, name)\`; profile/job data contains no secret value.
- A job stores a full redacted resolved snapshot that cannot change after enqueue.
- Do not add pipeline, FFmpeg, CUDA, Whisper, or GPU dependencies.

---

## File Structure

- Create \`crates/thoth-jobs/src/home.rs\`: \`ThothHome\` and owned directory layout.
- Create \`crates/thoth-jobs/src/profiles.rs\`: typed settings, resolver, records, redaction.
- Create \`crates/thoth-jobs/migrations/0002_projects_profiles.sql\`: projects, profiles, revisions.
- Create \`crates/thoth-jobs/migrations/0003_job_settings_snapshot.sql\`: job provenance.
- Modify \`crates/thoth-jobs/src/lib.rs\` and \`types.rs\`: store methods and safe DTO fields.

### Task 1: Resolve and provision Thoth home

**Files:** Create \`home.rs\`; modify \`lib.rs\`.

**Interfaces:** \`ThothHome\`, \`resolve_home(explicit: Option<&Path>)\`, \`ensure_layout(&self)\`.

- [ ] **Step 1: Write the failing tests**

~~~
#[test]
fn explicit_home_wins_over_environment() {
    let home = resolve_home_with_env(Some(Path::new("explicit")), Some(Path::new("env"))).unwrap();
    assert_eq!(home.root(), Path::new("explicit"));
}
#[test]
fn project_output_is_owned_by_home() {
    let home = ThothHome::for_test(tempdir().unwrap().path());
    home.ensure_layout().unwrap();
    assert_eq!(home.project_outputs("p1"), home.root().join("projects/p1/outputs"));
}
~~~

- [ ] **Step 2: Run RED**

Run: \`cargo test -p thoth-jobs home -- --nocapture\`

Expected: FAIL because the module and symbols do not exist.

- [ ] **Step 3: Implement the minimal module**

~~~
pub struct ThothHome { root: PathBuf }
impl ThothHome {
    pub fn root(&self) -> &Path { &self.root }
    pub fn data_dir(&self) -> PathBuf { self.root.join("data") }
    pub fn project_root(&self, id: &str) -> PathBuf { self.root.join("projects").join(id) }
    pub fn project_outputs(&self, id: &str) -> PathBuf { self.project_root(id).join("outputs") }
}
~~~

\`ensure_layout\` creates \`data\`, \`projects\`, \`cache\`, and \`logs\`. Project creation creates \`content-sets\`, \`sources\`, and \`outputs\` under its workspace. Use a test-only environment argument rather than mutating process environment concurrently.

- [ ] **Step 4: Run GREEN and commit**

Run: \`cargo test -p thoth-jobs home -- --nocapture\`

Expected: PASS.

~~~
git add crates/thoth-jobs/src/home.rs crates/thoth-jobs/src/lib.rs crates/thoth-jobs/Cargo.toml Cargo.lock
git commit -m "feat(jobs): add Thoth application home layout"
~~~

### Task 2: Add typed settings and deterministic resolution

**Files:** Create \`profiles.rs\`; modify \`lib.rs\`.

**Interfaces:** \`ProfileSettings\`, \`RunOverrides\`, \`ResolvedSettings\`, \`validate_settings\`, \`resolve_settings\`, \`redacted_settings_json\`.

- [ ] **Step 1: Write the failing tests**

~~~
#[test]
fn override_wins_without_mutating_profile() {
    let profile = ProfileSettings::with_output_format("mp4");
    let resolved = resolve_settings(&profile, &RunOverrides::output_format("webm")).unwrap();
    assert_eq!(resolved.output.format, "webm");
    assert_eq!(profile.output.format, "mp4");
}
#[test]
fn snapshot_has_reference_not_secret_value() {
    let snapshot = redacted_settings_json(&ResolvedSettings::default(), Some("openai-production"));
    assert_eq!(snapshot["credential_ref"], "openai-production");
    assert!(snapshot.get("credential_value").is_none());
}
~~~

- [ ] **Step 2: Run RED**

Run: \`cargo test -p thoth-jobs profiles -- --nocapture\`

Expected: FAIL because profile schema symbols do not exist.

- [ ] **Step 3: Implement schema version 1**

Create Serde structs for \`NarrationSettings\`, \`VisualEditSettings\`, \`AnalysisSettings\`, \`IngestSourceSettings\`, \`OutputSettings\`, and \`AdvancedSettings\`; compose them in \`ProfileSettings\`. Set \`SETTINGS_SCHEMA_VERSION = 1\`. Reject unknown fields, blank required strings, non-finite numbers, invalid enums, and managed output paths outside \`ThothHome\`. Do not add a free-form JSON map or generic override key.

- [ ] **Step 4: Run GREEN and commit**

Run: \`cargo test -p thoth-jobs profiles -- --nocapture\`

Expected: PASS.

~~~
git add crates/thoth-jobs/src/profiles.rs crates/thoth-jobs/src/lib.rs
git commit -m "feat(jobs): add typed project profile settings"
~~~

### Task 3: Persist projects, profiles, and revisions

**Files:** Create migration \`0002_projects_profiles.sql\`; modify \`lib.rs\` and \`profiles.rs\`.

**Interfaces:** \`JobStore::{create_project,list_projects,create_profile,update_profile,list_profiles,get_profile,list_profile_revisions,restore_profile_revision}\`.

- [ ] **Step 1: Write the failing store test**

~~~
#[tokio::test]
async fn same_profile_name_is_allowed_in_two_projects_and_update_creates_revision() {
    let store = fresh_store().await;
    let a = store.create_project("A").await.unwrap();
    let b = store.create_project("B").await.unwrap();
    store.create_profile(&a.id, "Default", ProfileSettings::default(), None).await.unwrap();
    store.create_profile(&b.id, "Default", ProfileSettings::default(), None).await.unwrap();
    let p = store.get_profile_by_name(&a.id, "Default").await.unwrap().unwrap();
    store.update_profile(&p.id, "Default", ProfileSettings::with_output_format("webm"), None).await.unwrap();
    assert_eq!(store.list_profile_revisions(&p.id).await.unwrap().len(), 1);
}
~~~

- [ ] **Step 2: Run RED**

Run: \`cargo test -p thoth-jobs same_profile_name_is_allowed -- --nocapture\`

Expected: FAIL because migrations and methods do not exist.

- [ ] **Step 3: Implement the transactional persistence**

Create \`projects\`, \`profiles\`, and \`profile_revisions\`; enforce \`UNIQUE(project_id, name)\`. An update writes the previous serialized state to \`profile_revisions\` and updates the current profile in one transaction. Restore reads a revision then invokes update, which creates new history.

- [ ] **Step 4: Run GREEN and commit**

Run: \`cargo test -p thoth-jobs profile -- --nocapture\`

Expected: PASS.

~~~
git add crates/thoth-jobs/migrations/0002_projects_profiles.sql crates/thoth-jobs/src/lib.rs crates/thoth-jobs/src/profiles.rs
git commit -m "feat(jobs): persist project profile revisions"
~~~

### Task 4: Snapshot resolved settings at enqueue

**Files:** Create migration \`0003_job_settings_snapshot.sql\`; modify \`lib.rs\` and \`types.rs\`.

**Interfaces:** \`EnqueueRequest { spec, project_id, profile_id, profile_revision, resolved_settings }\`; \`JobStore::enqueue_resolved\`.

- [ ] **Step 1: Write the failing test**

~~~
#[tokio::test]
async fn job_snapshot_survives_profile_edit() {
    let (store, profile) = project_with_profile("mp4").await;
    let job = store.enqueue_resolved(request_from(&profile)).await.unwrap();
    store.update_profile(&profile.id, "Default", ProfileSettings::with_output_format("webm"), None).await.unwrap();
    assert_eq!(store.get(&job.id).await.unwrap().unwrap().resolved_settings.unwrap()["output"]["format"], "mp4");
}
~~~

- [ ] **Step 2: Run RED**

Run: \`cargo test -p thoth-jobs job_snapshot_survives_profile_edit -- --nocapture\`

Expected: FAIL because \`JobRecord\` lacks a resolved snapshot.

- [ ] **Step 3: Implement atomic enqueue**

Add nullable \`project_id\`, \`profile_id\`, \`profile_revision\`, \`resolved_settings_snapshot\`, and \`override_summary\` columns for legacy-job compatibility. Serialize only redacted settings. Extend \`row_to_record\` and \`JobRecord\`; insert the queue row and provenance atomically.

- [ ] **Step 4: Run GREEN and commit**

Run: \`cargo test -p thoth-jobs --lib -- --nocapture\`

Expected: PASS, including existing queue tests.

~~~
git add crates/thoth-jobs/migrations/0003_job_settings_snapshot.sql crates/thoth-jobs/src/lib.rs crates/thoth-jobs/src/types.rs
git commit -m "feat(jobs): snapshot profile settings per job"
~~~
