ALTER TABLE jobs ADD COLUMN project_id TEXT;
ALTER TABLE jobs ADD COLUMN profile_id TEXT;
ALTER TABLE jobs ADD COLUMN profile_revision INTEGER;
ALTER TABLE jobs ADD COLUMN resolved_settings_snapshot TEXT;
ALTER TABLE jobs ADD COLUMN override_summary TEXT;

CREATE INDEX idx_jobs_project ON jobs(project_id, created_at);
