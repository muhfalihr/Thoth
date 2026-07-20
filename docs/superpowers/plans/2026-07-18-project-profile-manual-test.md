# Project Profile Studio — Manual Acceptance Test

End-to-end checklist for the profile-first workflow (server + dashboard + CLI).
Run against a local `thoth-server` and `thoth worker` sharing one SQLite DB.

## Setup

```
# terminal 1 — REST/SSE API (defaults: THOTH_ADDR=127.0.0.1:8787, THOTH_API_KEY=dev-key)
cargo run -p thoth-server

# terminal 2 — warm worker (same DB file)
thoth worker --db thoth.db

# terminal 3 — dashboard dev server
bun --cwd dashboard run dev
```

CLI commands target the server via `THOTH_SERVER_URL` (default `http://127.0.0.1:8787`)
and `THOTH_API_KEY` (default `dev-key`).

## Checklist

### 1. Legacy config.toml migration (one-way, idempotent)
- [ ] With a `config.toml` containing `[styles.profiles.default]`, run `thoth configure --import`.
- [ ] Expect: "imported legacy config.toml into a new 'Imported' project" plus any
      per-key warnings for fields that did not map.
- [ ] Run it a second time → expect "nothing imported (already migrated…)". The
      one-time import is not consumed twice.
- [ ] Point it at a malformed `config.toml` → expect a loud error, and the import
      is **not** marked done (a later valid import still works).

### 2. Project + profile creation (CLI)
- [ ] `thoth project create Demo` → prints the new id.
- [ ] `thoth project use Demo` → "active project set to 'Demo'".
- [ ] `thoth profile create Vertical --description "ID vertical"` → prints the id
      (uses the active project; no `--project` needed).
- [ ] `thoth profile list` → shows `Vertical`.

### 3. Project + profile creation (dashboard)
- [ ] Open the dashboard → **Project** switcher shows `Demo`; "New project" creates another.
- [ ] **Profiles** tab → **New profile** → set name + a few fields per group → **Save profile**.
- [ ] The new profile appears in the left list and survives a page reload.

### 4. Profile edit + revisions
- [ ] Edit a saved profile's Layout/provider → **Save** → **Validate** reports valid.
- [ ] The **Revisions** panel lists the prior version; **Restore** brings it back.
- [ ] CLI parity: `thoth profile set Vertical --provider groq --max-clips 5` →
      prints the updated, redacted summary.

### 5. Run a job from a profile (dashboard)
- [ ] **Runs** tab → pick the profile → the **Effective** summary reflects its settings.
- [ ] Enter a URL (or leave blank if the profile has a source) → **Run**.
- [ ] The job appears in the job list and streams progress to completion.

### 6. Per-run override does NOT mutate the profile
- [ ] Open **Overrides for this run** → set Layout = `horizontal` → **Run**.
- [ ] The job runs with `horizontal`, but re-open the profile in **Profiles** →
      its Layout is unchanged. (Overrides are per-job only.)

### 7. Content Set → Run hand-off
- [ ] In **Content Set**, curate a set → **Send to render →**.
- [ ] The **Runs** view opens with the content-set path pre-filled; **Run** starts a job.

### 8. Old-job snapshot inspection (immutability)
- [ ] After a run, `GET /api/jobs/<id>/effective-settings` (or the dashboard job view)
      returns the settings the job actually used.
- [ ] Change the profile afterward → the finished job's effective-settings are
      **unchanged** (immutable snapshot).

### 9. Secret redaction (no credential value anywhere)
- [ ] Set a profile's credential reference to an env-var **name** (e.g. `OPENAI_API_KEY`).
- [ ] Confirm the value never appears in: `thoth profile show`, the dashboard UI,
      `GET …/effective-settings`, job events/logs, or the DB `profiles` row — only
      the reference **name** is stored/shown.
- [ ] With the referenced env var **unset**, starting a run for that profile is
      rejected ("required credential is unavailable") before any work begins.

## Gates (must all exit 0)

```
cargo test --workspace
bun --cwd dashboard test
bun --cwd dashboard run lint
bun --cwd dashboard run build
```
