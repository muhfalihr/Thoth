CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  command          TEXT NOT NULL,
  url              TEXT,
  content_set      TEXT,
  params           TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'queued',
  stage            TEXT,
  pct              REAL NOT NULL DEFAULT 0,
  error            TEXT,
  output_dir       TEXT NOT NULL,
  worker_id        TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  heartbeat_at     TEXT,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_jobs_claim ON jobs(status, created_at);
CREATE INDEX idx_jobs_reap  ON jobs(status, heartbeat_at);

CREATE TABLE job_events (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id   TEXT NOT NULL REFERENCES jobs(id),
  type     TEXT NOT NULL,
  stage    TEXT,
  pct      REAL,
  message  TEXT,
  ts       TEXT NOT NULL
);
CREATE INDEX idx_events_job ON job_events(job_id, seq);
