//! Typed CLI clients for `project`, `profile`, and `configure`.
//!
//! These are thin reqwest callers to the local `thoth-server` REST API — the
//! same DTOs the dashboard sends. No TOML is authored here, and no secret value
//! is ever sent or printed: credentials are referenced by *name* only (an
//! env-var name the server resolves). The server owns validation and defaults.

use std::io::Write as _;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::cli::{ConfigureArgs, ProfileCommand, ProfileSetArgs, ProjectCommand};

/// Thin authenticated JSON client for the local server.
struct Client {
    base: String,
    key: String,
    http: reqwest::Client,
}

impl Client {
    fn from_env() -> Self {
        let base = std::env::var("THOTH_SERVER_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8787".to_owned());
        let key = std::env::var("THOTH_API_KEY").unwrap_or_else(|_| "dev-key".to_owned());
        Self {
            base: base.trim_end_matches('/').to_owned(),
            key,
            http: reqwest::Client::new(),
        }
    }

    async fn send(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        let url = format!("{}{path}", self.base);
        let mut req = self.http.request(method, &url).bearer_auth(&self.key);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await.with_context(|| {
            format!("cannot reach thoth-server at {} — is it running? (set THOTH_SERVER_URL)", self.base)
        })?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            // Surface the server's error message but never echo request bodies.
            let msg = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("error").or_else(|| v.get("message")).and_then(|m| m.as_str()).map(str::to_owned))
                .unwrap_or_else(|| status.to_string());
            bail!("{path} failed ({status}): {msg}");
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str) -> Result<Value> {
        self.send(reqwest::Method::GET, path, None).await
    }
    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.send(reqwest::Method::POST, path, Some(body)).await
    }
    async fn post_empty(&self, path: &str) -> Result<Value> {
        self.send(reqwest::Method::POST, path, None).await
    }
    async fn patch(&self, path: &str, body: Value) -> Result<Value> {
        self.send(reqwest::Method::PATCH, path, Some(body)).await
    }
}

/// Path to the file storing the active project name (`~/.thoth/active-project`).
fn active_project_file() -> Result<std::path::PathBuf> {
    let home = thoth_jobs::resolve_home(None).context("cannot resolve THOTH home")?;
    Ok(home.root().join("active-project"))
}

fn read_active_project() -> Option<String> {
    let p = active_project_file().ok()?;
    let name = std::fs::read_to_string(p).ok()?.trim().to_owned();
    (!name.is_empty()).then_some(name)
}

/// Resolve the project name to use: explicit `--project` wins, else the active
/// project set by `thoth project use`.
fn project_name(explicit: Option<String>) -> Result<String> {
    explicit.or_else(read_active_project).context(
        "no project selected — pass --project <name> or run `thoth project use <name>` first",
    )
}

async fn find_project_id(client: &Client, name: &str) -> Result<String> {
    let projects = client.get("/api/projects").await?;
    projects
        .as_array()
        .and_then(|ps| ps.iter().find(|p| p.get("name").and_then(Value::as_str) == Some(name)))
        .and_then(|p| p.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .with_context(|| format!("project '{name}' not found"))
}

async fn find_profile(client: &Client, project_id: &str, name: &str) -> Result<Value> {
    let profiles = client.get(&format!("/api/projects/{project_id}/profiles")).await?;
    profiles
        .as_array()
        .and_then(|ps| ps.iter().find(|p| p.get("name").and_then(Value::as_str) == Some(name)))
        .cloned()
        .with_context(|| format!("profile '{name}' not found in project"))
}

// ── project ────────────────────────────────────────────────────────────────

pub async fn run_project(command: ProjectCommand) -> Result<()> {
    let client = Client::from_env();
    match command {
        ProjectCommand::Create { name } => {
            let p = client.post("/api/projects", json!({ "name": name })).await?;
            println!("created project '{}' ({})", field(&p, "name"), field(&p, "id"));
        }
        ProjectCommand::List => {
            let projects = client.get("/api/projects").await?;
            let active = read_active_project();
            for p in projects.as_array().unwrap_or(&vec![]) {
                let name = field(p, "name");
                let marker = if Some(name.as_str()) == active.as_deref() { "* " } else { "  " };
                println!("{marker}{name}  ({})", field(p, "id"));
            }
        }
        ProjectCommand::Use { name } => {
            // Verify it exists before storing, so `use` can't point at a ghost.
            find_project_id(&client, &name).await?;
            let path = active_project_file()?;
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).ok();
            }
            std::fs::write(&path, &name).with_context(|| format!("cannot write {}", path.display()))?;
            println!("active project set to '{name}'");
        }
    }
    Ok(())
}

// ── profile ──────────────────────────────────────────────────────────────

pub async fn run_profile(command: ProfileCommand) -> Result<()> {
    let client = Client::from_env();
    match command {
        ProfileCommand::Create { name, project, description } => {
            let pid = find_project_id(&client, &project_name(project)?).await?;
            let created = client
                .post(&format!("/api/projects/{pid}/profiles"), json!({ "name": name, "description": description }))
                .await?;
            println!("created profile '{}' ({})", field(&created, "name"), field(&created, "id"));
        }
        ProfileCommand::List { project } => {
            let pid = find_project_id(&client, &project_name(project)?).await?;
            let profiles = client.get(&format!("/api/projects/{pid}/profiles")).await?;
            for p in profiles.as_array().unwrap_or(&vec![]) {
                println!("{}  ({})", field(p, "name"), field(p, "id"));
            }
        }
        ProfileCommand::Show { name, project } => {
            let pid = find_project_id(&client, &project_name(project)?).await?;
            let profile = find_profile(&client, &pid, &name).await?;
            print_profile(&profile);
        }
        ProfileCommand::Duplicate { name, new_name, project } => {
            let pid = find_project_id(&client, &project_name(project)?).await?;
            let src = find_profile(&client, &pid, &name).await?;
            let src_id = field(&src, "id");
            let dup = client
                .post(&format!("/api/projects/{pid}/profiles/{src_id}/duplicate"), json!({ "name": new_name }))
                .await?;
            println!("duplicated to '{}' ({})", field(&dup, "name"), field(&dup, "id"));
        }
        ProfileCommand::Set(args) => run_profile_set(&client, args).await?,
    }
    Ok(())
}

async fn run_profile_set(client: &Client, args: ProfileSetArgs) -> Result<()> {
    let pid = find_project_id(client, &project_name(args.project.clone())?).await?;
    let profile = find_profile(client, &pid, &args.name).await?;
    let profile_id = field(&profile, "id");
    let mut settings = profile.get("settings").cloned().unwrap_or(Value::Null);

    apply_settings(&mut settings, &args);

    // ProfilePatch has deny_unknown_fields — send only known keys.
    let mut patch = json!({ "settings": settings });
    if let Some(desc) = &args.description {
        patch["description"] = json!(desc);
    }
    if let Some(cref) = &args.credential_ref {
        patch["credential_ref"] = json!(cref);
    }
    let updated = client
        .patch(&format!("/api/projects/{pid}/profiles/{profile_id}"), patch)
        .await?;
    println!("updated profile '{}'", field(&updated, "name"));
    print_profile(&updated);
    Ok(())
}

/// Overlay the provided explicit fields onto a settings JSON object. Each field
/// left `None` is skipped, so the profile's existing value is preserved.
fn apply_settings(settings: &mut Value, a: &ProfileSetArgs) {
    if let Some(v) = &a.language {
        settings["narration"]["language"] = if v.is_empty() { Value::Null } else { json!(v) };
    }
    if let Some(v) = &a.layout {
        settings["visual_edit"]["layout"] = json!(v.to_string());
    }
    if let Some(v) = &a.clip_style {
        settings["visual_edit"]["clip_style"] = json!(v.to_string());
    }
    if let Some(v) = &a.style_profile {
        settings["visual_edit"]["style_profile"] = json!(v);
    }
    if let Some(v) = &a.social {
        settings["visual_edit"]["social"] = json!(v);
    }
    if let Some(v) = a.bgm_volume {
        settings["visual_edit"]["bgm_volume"] = json!(v);
    }
    if let Some(v) = a.headline_dur {
        settings["visual_edit"]["headline_dur"] = json!(v);
    }
    if let Some(v) = &a.provider {
        settings["analysis"]["provider"] = json!(v.to_string());
    }
    if let Some(v) = &a.model {
        settings["analysis"]["model"] = json!(v.to_string());
    }
    if let Some(v) = a.max_clips {
        settings["analysis"]["max_clips"] = json!(v);
    }
    if let Some(v) = &a.keywords {
        settings["analysis"]["keywords"] = json!(v);
    }
    if let Some(v) = &a.source {
        settings["ingest_source"]["source"] = if v.is_empty() { Value::Null } else { json!(v) };
    }
    if let Some(v) = &a.content_set {
        settings["ingest_source"]["content_set"] = if v.is_empty() { Value::Null } else { json!(v) };
    }
}

// ── configure ────────────────────────────────────────────────────────────

pub async fn run_configure(args: ConfigureArgs) -> Result<()> {
    let client = Client::from_env();

    if args.import {
        let report = client.post_empty("/api/migrations/config-toml").await?;
        let imported = report.get("imported").and_then(Value::as_bool).unwrap_or(false);
        if imported {
            println!("imported legacy config.toml into a new 'Imported' project");
        } else {
            println!("nothing imported (already migrated, or no [styles.profiles.default])");
        }
        if let Some(warnings) = report.get("warnings").and_then(Value::as_array) {
            for w in warnings {
                if let Some(s) = w.as_str() {
                    println!("  warning: {s}");
                }
            }
        }
        return Ok(());
    }

    // Interactive wizard. Prompts default to typical Indonesian short-form values.
    let project = prompt("Project name", "Default")?;
    let pid = ensure_project(&client, &project).await?;

    let profile = prompt("Profile name", "Default")?;
    let provider = prompt("LLM provider (novita/groq/openai/claude/gemini/…)", "novita")?;
    let layout = prompt("Layout (vertical/horizontal/square)", "vertical")?;
    let language = prompt("Language code (blank = auto-detect)", "")?;

    let created = client
        .post(&format!("/api/projects/{pid}/profiles"), json!({ "name": profile }))
        .await?;
    let profile_id = field(&created, "id");
    let mut settings = created.get("settings").cloned().unwrap_or(Value::Null);
    settings["analysis"]["provider"] = json!(provider);
    settings["visual_edit"]["layout"] = json!(layout);
    settings["narration"]["language"] = if language.is_empty() { Value::Null } else { json!(language) };

    let updated = client
        .patch(&format!("/api/projects/{pid}/profiles/{profile_id}"), json!({ "settings": settings }))
        .await?;

    println!("\nconfigured (secrets are resolved server-side, never stored here):");
    print_profile(&updated);
    Ok(())
}

/// Return the id of an existing project by name, creating it if absent.
async fn ensure_project(client: &Client, name: &str) -> Result<String> {
    if let Ok(id) = find_project_id(client, name).await {
        return Ok(id);
    }
    let p = client.post("/api/projects", json!({ "name": name })).await?;
    Ok(field(&p, "id"))
}

fn prompt(label: &str, default: &str) -> Result<String> {
    print!("{label} [{default}]: ");
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    let trimmed = line.trim();
    Ok(if trimmed.is_empty() { default.to_owned() } else { trimmed.to_owned() })
}

// ── printing ───────────────────────────────────────────────────────────────

fn field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

/// Print a profile's human-relevant settings. The credential is shown as a
/// *name* only (or "(none)") — this endpoint never returns a secret value.
fn print_profile(p: &Value) {
    let name = field(p, "name");
    println!("profile: {name}");
    if let Some(desc) = p.get("description").and_then(Value::as_str) {
        if !desc.is_empty() {
            println!("  description: {desc}");
        }
    }
    let cred = p.get("credential_ref").and_then(Value::as_str).unwrap_or("(none)");
    println!("  credential-ref: {cred}");
    if let Some(s) = p.get("settings") {
        let show = |path: &[&str]| -> String {
            let mut cur = s;
            for k in path {
                match cur.get(k) {
                    Some(v) => cur = v,
                    None => return "-".to_owned(),
                }
            }
            match cur {
                Value::Null => "auto".to_owned(),
                Value::String(st) => st.clone(),
                other => other.to_string(),
            }
        };
        println!("  provider:      {}", show(&["analysis", "provider"]));
        println!("  model:         {}", show(&["analysis", "model"]));
        println!("  max-clips:     {}", show(&["analysis", "max_clips"]));
        println!("  layout:        {}", show(&["visual_edit", "layout"]));
        println!("  clip-style:    {}", show(&["visual_edit", "clip_style"]));
        println!("  style-profile: {}", show(&["visual_edit", "style_profile"]));
        println!("  language:      {}", show(&["narration", "language"]));
        println!("  source:        {}", show(&["ingest_source", "source"]));
    }
}
