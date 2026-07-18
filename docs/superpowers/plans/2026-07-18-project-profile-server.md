# Project Profile Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Expose typed project/profile/job APIs and import legacy TOML safely.

**Architecture:** \`thoth-server\` adapts \`thoth-jobs\` to HTTP and derives runtime paths from \`ThothHome\`. It does not have an alternate settings model or pipeline dependencies.

**Tech Stack:** Rust 2024, Axum 0.7, Tokio, SQLx/SQLite, Serde.

## Global Constraints

- Complete \`2026-07-18-project-profile-foundation.md\` first.
- Preserve bearer authentication and localhost-default bind behavior.
- Requests use \`#[serde(deny_unknown_fields)]\`; responses never contain secrets or SQL errors.
- TOML import is idempotent and never writes/deletes legacy files.
- Do not add \`thoth-core\`, FFmpeg, CUDA, Whisper, or GPU dependencies.

---

## File Structure

- Modify \`auth.rs\`: \`AppState\` owns \`ThothHome\`, not \`config_path\`.
- Modify \`main.rs\`: accept \`--home\`, provision layout, derive DB/output roots.
- Modify \`lib.rs\` and \`routes.rs\`: typed resources and job routes.
- Create \`migration.rs\`: TOML compatibility importer.
- Modify \`tests/routes_http.rs\`: in-process contract tests.

### Task 1: Derive server runtime state from Thoth home

**Files:** Modify \`main.rs\`, \`auth.rs\`, \`tests/routes_http.rs\`.

- [ ] **Step 1: Write the failing test**

~~~
#[test]
fn db_path_lives_in_home_data_directory() {
    let home = ThothHome::for_test(Path::new("C:/tmp/thoth"));
    assert_eq!(server_db_path(&home), Path::new("C:/tmp/thoth/data/thoth.db"));
}
~~~

- [ ] **Step 2: Run RED**

Run: \`cargo test -p thoth-server db_path_lives_in_home_data_directory -- --nocapture\`

Expected: FAIL because home helpers do not exist.

- [ ] **Step 3: Implement startup wiring**

Parse \`--home: Option<PathBuf>\`, resolve and provision it, then open \`home.data_dir()/thoth.db\`. Replace \`AppState.config_path\` with \`home\`. Preserve \`THOTH_DB\` only as a documented compatibility override.

- [ ] **Step 4: Run GREEN and commit**

Run: \`cargo test -p thoth-server --test routes_http -- --nocapture\`

Expected: PASS.

~~~
git add crates/thoth-server/src/main.rs crates/thoth-server/src/auth.rs crates/thoth-server/tests/routes_http.rs crates/thoth-server/Cargo.toml Cargo.lock
git commit -m "feat(server): derive runtime paths from Thoth home"
~~~

### Task 2: Add project/profile HTTP resources

**Files:** Modify \`lib.rs\`, \`routes.rs\`, \`tests/routes_http.rs\`.

- [ ] **Step 1: Write the failing route test**

~~~
#[tokio::test]
async fn profile_is_visible_only_in_its_project() {
    let (app, _) = build_test_app().await;
    let project = post_json(app.clone(), "/api/projects", json!({"name":"Demo"})).await;
    let profile = post_json(app.clone(), &format!("/api/projects/{}/profiles", project["id"]), json!({"name":"Default","settings":{}})).await;
    assert_eq!(get_status(app, &format!("/api/projects/{}/profiles/{}", project["id"], profile["id"])).await, StatusCode::OK);
}
~~~

- [ ] **Step 2: Run RED**

Run: \`cargo test -p thoth-server --test routes_http profile_is_visible_only_in_its_project -- --nocapture\`

Expected: FAIL with route not found.

- [ ] **Step 3: Implement resources**

Mount project list/create/detail and profile list/create/detail/update/delete, duplicate, revisions, and restore inside the bearer layer. Convert validation, uniqueness, and scope failures to stable \`422\`, \`409\`, and \`404\` JSON responses.

- [ ] **Step 4: Run GREEN and commit**

Run: \`cargo test -p thoth-server --test routes_http project -- --nocapture\`

Expected: PASS for create, scope, duplicate-name, duplicate, revision, and restore.

~~~
git add crates/thoth-server/src/lib.rs crates/thoth-server/src/routes.rs crates/thoth-server/tests/routes_http.rs
git commit -m "feat(server): add typed project profile API"
~~~

### Task 3: Enqueue from profile and expose its snapshot

**Files:** Modify \`routes.rs\`, \`tests/routes_http.rs\`.

- [ ] **Step 1: Write the failing test**

~~~
#[tokio::test]
async fn profile_job_stores_redacted_immutable_snapshot() {
    let (app, _) = project_with_profile_app("mp4").await;
    let job = post_json(app.clone(), "/api/projects/p1/jobs", json!({"profile_id":"profile-1","overrides":{"output_format":"webm"}})).await;
    let snapshot = get_json(app, &format!("/api/jobs/{}/effective-settings", job["job_id"])).await;
    assert_eq!(snapshot["settings"]["output"]["format"], "webm");
    assert!(snapshot.get("credential_value").is_none());
}
~~~

- [ ] **Step 2: Run RED**

Run: \`cargo test -p thoth-server --test routes_http profile_job_stores_redacted -- --nocapture\`

Expected: FAIL with route not found.

- [ ] **Step 3: Implement resolver endpoint**

Constrain profile lookup by project, check credential-reference availability via a local provider trait, resolve typed overrides, derive \`home.project_outputs(project_id).join(job_id)\`, and call \`enqueue_resolved\`. Keep \`/api/jobs\` temporarily as explicitly unprofiled compatibility.

- [ ] **Step 4: Run GREEN and commit**

Run: \`cargo test -p thoth-server --test routes_http -- --nocapture\`

Expected: PASS.

~~~
git add crates/thoth-server/src/routes.rs crates/thoth-server/tests/routes_http.rs
git commit -m "feat(server): enqueue jobs from profiles"
~~~

### Task 4: One-way TOML migration and raw endpoint retirement

**Files:** Create \`migration.rs\`; modify \`lib.rs\`, \`routes.rs\`, \`tests/routes_http.rs\`.

- [ ] **Step 1: Write the failing test**

~~~
#[tokio::test]
async fn import_is_idempotent_and_preserves_original_file() {
    let path = write_temp_toml("[styles.profiles.default]\nlayout = 'vertical'\n");
    assert!(import_legacy_config(&store, &path).await.unwrap().imported);
    assert!(!import_legacy_config(&store, &path).await.unwrap().imported);
    assert_eq!(std::fs::read_to_string(path).unwrap(), "[styles.profiles.default]\nlayout = 'vertical'\n");
}
~~~

- [ ] **Step 2: Run RED**

Run: \`cargo test -p thoth-server import_is_idempotent -- --nocapture\`

Expected: FAIL because importer does not exist.

- [ ] **Step 3: Implement and retire raw mutation**

Parse TOML into a dedicated compatibility type. Unsupported fields become migration warnings, never free-form settings. Store an import marker, add \`POST /api/migrations/config-toml\`, and remove \`GET/PUT /api/config\`, \`get_style_profiles\`, and their router entries.

- [ ] **Step 4: Run GREEN and commit**

Run: \`cargo test -p thoth-server --test routes_http -- --nocapture\`

Expected: PASS and \`PUT /api/config\` returns \`404\`.

~~~
git add crates/thoth-server/src/migration.rs crates/thoth-server/src/lib.rs crates/thoth-server/src/routes.rs crates/thoth-server/tests/routes_http.rs crates/thoth-server/Cargo.toml Cargo.lock
git commit -m "feat(server): migrate TOML to typed profiles"
~~~
