CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL CHECK (length(trim(name)) > 0),
  workspace_path TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE profiles (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description     TEXT NOT NULL DEFAULT '',
  schema_version  INTEGER NOT NULL,
  settings_json   TEXT NOT NULL,
  credential_ref  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(project_id, name)
);
CREATE INDEX idx_profiles_project ON profiles(project_id, name);

CREATE TABLE profile_revisions (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  revision        INTEGER NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  settings_json   TEXT NOT NULL,
  credential_ref  TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE(profile_id, revision)
);
CREATE INDEX idx_profile_revisions_profile ON profile_revisions(profile_id, revision DESC);
