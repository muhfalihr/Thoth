# Thoth Project Profile Studio and Application Home

*Date: 2026-07-18 · Status: approved in brainstorming, pending written-spec review*

## 1. Context

Thoth currently exposes `config.toml` as a raw textarea in the dashboard. The
server reads and overwrites that file through `/api/config`, validating only
that it is syntactically valid TOML. This gives dashboard users a fragile,
low-level configuration experience, makes CLI and dashboard behaviour diverge,
and offers no reliable record of the settings that produced an existing job.

Thoth also needs one deliberate home for data produced by the complete tool
chain: Scout data, sources, scripts, project workspaces, render output, queue
state, cache, and logs. This specification replaces raw TOML editing with
typed, project-scoped profiles and establishes that application home.

This is a local-first, single-operator design. LAN use remains an explicit
mode, not an implicit promise that every configuration endpoint is safe to
expose remotely.

## 2. Goals

- Give every Thoth project its own reusable, typed profile library.
- Make the dashboard and CLI use the same configuration schema, validation,
  persistence, and job-resolution rules.
- Keep the everyday run flow short: select a project and profile, optionally
  override a small number of values, and run.
- Retain the exact resolved settings for every job so historical work remains
  reproducible after a profile changes.
- Establish a portable, controlled application home at `~/.thoth` by default.
- Keep secrets out of profiles, database snapshots, API responses, logs, and
  the browser.
- Provide a safe, reversible migration from legacy `config.toml`.

## 3. Non-goals

- User accounts, shared profile libraries, cloud synchronization, or
  collaborative editing.
- Making a token value editable or visible in the browser.
- Supporting arbitrary, untyped configuration keys or CLI `key=value`
  mutation.
- Moving all pre-existing project source files into `~/.thoth` automatically.
- Changing the worker/server SQLite peer-process boundary established by the
  runtime-correctness work.

## 4. Decisions

### 4.1 Application home

The resolved Thoth home follows this precedence:

```text
--home <path>  >  THOTH_HOME  >  ~/.thoth
```

The application creates and owns the following directories beneath that home:

```text
~/.thoth/
  data/          SQLite database, migrations, and job metadata
  projects/      Workspace data per Thoth project
    <project-id>/
      content-sets/  Scout and curated content sets
      sources/       Thoth-managed source copies and generated scripts
      outputs/       Final artifacts grouped by job
  cache/         Regenerable local caches
  logs/          Operational logs
```

The logical project workspace is `projects/<project-id>/`. Input sources may
remain external to the application home, but their normalized paths are
validated at job creation. Thoth-managed outputs, generated scripts, content
sets, cache, and workspace files must remain within the resolved home.

### 4.2 Typed project-scoped profiles

Profiles belong to exactly one project. A profile name is unique only within
that project. A profile may contain all safe pipeline defaults, including a
default source and output policy, but no secret value. A stored credential is
only a named `credential_ref`, such as `openai-production`.

Profile settings are represented by versioned Rust types. SQLite may store the
serialized settings JSON internally, but callers never receive an unvalidated
or schema-less settings bag. The server rejects unknown fields and incompatible
schema versions.

Settings are grouped in the dashboard as:

- Narration
- Visual & Edit
- Analysis
- Ingest & Sources
- Output
- Advanced

### 4.3 Immutable job resolution

Creating a job resolves settings in this order:

```text
typed schema defaults + selected profile + typed per-run overrides
```

The server validates the result, creates the queue record, and stores the full
resolved settings snapshot together with profile ID, profile revision, and a
safe override summary. The worker consumes this immutable snapshot. Editing,
deleting, or restoring a profile therefore never alters a queued, running, or
completed job.

### 4.4 Secrets

The database and profile only contain a reference ID. Secret values live in a
local secret provider. The initial provider can resolve a configured named
environment variable, while the interface permits an OS keychain-backed
provider later. The dashboard can show whether a reference is available; it
can never request or display the value.

## 5. Domain model

```text
Project 1 ── * Profile 1 ── * ProfileRevision
   │              │
   ├── * ContentSet
   └── * Job ─── resolved_settings_snapshot
```

### 5.1 Project

`Project` contains an immutable ID, display name, workspace path, creation and
update timestamps. The workspace path is derived from the project ID under the
application home; it is not an arbitrary writable destination.

### 5.2 Profile and revision

`Profile` contains ID, project ID, name, description, settings schema version,
typed settings, optional credential reference, and timestamps. Every update
creates a `ProfileRevision` with the prior effective state and an audit
timestamp. A restore creates a new current revision rather than rewriting
history.

### 5.3 Job

In addition to existing queue state, a job records `project_id`, optional
`profile_id`, optional `profile_revision`, a full `resolved_settings_snapshot`,
and a redacted override summary. Any output path saved on the job has already
passed the home/path policy.

## 6. API contract

Raw text endpoints are replaced by typed project and profile endpoints:

```text
GET/POST            /api/projects
GET/PATCH/DELETE    /api/projects/:projectId

GET/POST            /api/projects/:projectId/profiles
GET/PATCH/DELETE    /api/projects/:projectId/profiles/:profileId
POST                /api/projects/:projectId/profiles/:profileId/duplicate
GET                 /api/projects/:projectId/profiles/:profileId/revisions
POST                /api/projects/:projectId/profiles/:profileId/validate

POST                /api/projects/:projectId/jobs
GET                 /api/jobs/:jobId/effective-settings
```

`POST /jobs` accepts a profile ID and typed overrides. The server returns only
safe metadata and a redacted configuration summary. It rejects unknown fields,
unavailable credential references, invalid settings, and paths that violate
policy. `GET effective-settings` is an inspectable, redacted job snapshot, not
a mutable configuration endpoint.

The legacy `/api/config` is read only for migration during the compatibility
window. It is not the ongoing source of truth and is removed after one stable
release with migration documentation.

## 7. Dashboard design

The dashboard is a focused product console using the existing shadcn primitives
rather than a competing design system. Its primary navigation is:

```text
Runs | Profiles | Library | System
```

A project switcher sits in the header. The **Runs** screen is intentionally
short: choose project, choose profile, inspect the effective summary, and run.
An `Overrides for this run` drawer provides typed one-off changes without
editing the profile.

The **Profiles** screen is the Profile Studio:

```text
profile list | categorized editor | effective summary and validation
```

It supports create, duplicate, save, revision history, and restore. There is
no TOML textarea. Source and output are labeled as profile defaults so users
can distinguish them from a one-off run override.

**Library** owns content sets, Scout results, and project assets. **System**
shows the resolved Thoth home, queue/database health, and safe diagnostics; it
does not expose raw writable configuration files.

## 8. CLI design

The CLI uses the same server/domain validation as the dashboard:

```powershell
thoth project create <name>
thoth project list
thoth project use <name>

thoth profile create <name> --project <name>
thoth profile list --project <name>
thoth profile show <name> --project <name>
thoth profile duplicate <from> <to> --project <name>
thoth profile set <name> --project <name> --narration-voice <voice>
thoth configure

thoth run --project <name> --profile <name> --source <path>
thoth run --project <name> --profile <name> --override-output-format mp4
```

`thoth configure` is an optional interactive wizard that emits a normal typed
profile. There is no generic `--set key=value`; every CLI argument maps to a
known schema field. Commands that mutate settings surface validation errors
before any job is enqueued.

## 9. Migration and compatibility

1. Introduce the typed domain, persistence, and API without removing existing
   pipeline functionality.
2. Add `thoth migrate-config` and a startup prompt/path that imports a valid
   legacy `config.toml` once into project `Imported` and profile `Default`.
3. The migration is idempotent, produces a validation report, and never deletes
   the original file.
4. Replace the dashboard Config Editor and update CLI documentation during the
   compatibility window.
5. After one stable release, remove raw configuration mutation and retire the
   old endpoint.

## 10. Security and operational policy

- Default bind mode remains localhost. LAN exposure of configuration endpoints
  requires the explicit authentication policy defined by the security
  hardening project.
- Secret references, even when invalid, are redacted in logs, job events, API
  payloads, and snapshots.
- Destructive project/profile operations require confirmation. A project with
  active jobs cannot be deleted.
- Schema versions have explicit migrations. Unsupported versions fail clearly;
  no implicit downgrade or silent coercion occurs.
- Output retention/cleanup is an operations policy and must not delete a job's
  recorded snapshot or metadata.

## 11. Verification strategy

- Unit tests: home precedence, typed validation, resolver precedence, secret
  redaction, and path policy.
- Persistence tests: project scoping, profile revision history, immutable job
  snapshots, and idempotent TOML import.
- API tests: invalid payloads, unknown fields, missing credential references,
  correct snapshot creation, and auth/bind policy integration.
- CLI tests: commands and wizard produce the same typed requests as dashboard
  interactions.
- Dashboard tests: create/save/duplicate/restore profile; select profile;
  apply run override; verify the profile itself is unchanged.
- End-to-end: create project and profile, send a content set to run, change the
  profile, and prove the earlier job still renders from its original snapshot.

## 12. Delivery boundaries

This design intentionally depends on the later local/LAN security work for
final remote-access enforcement. Implementations must not claim internet-grade
configuration security before that project is complete. Formatting debt and
the existing broad Clippy warning backlog remain separate deferred work and do
not block this design's focused test gates.
