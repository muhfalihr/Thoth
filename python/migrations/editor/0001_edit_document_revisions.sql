CREATE TABLE IF NOT EXISTS edit_document_revisions (
    project_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    document_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (document_id, revision)
);

CREATE INDEX IF NOT EXISTS edit_document_revisions_project_document_idx
    ON edit_document_revisions (project_id, document_id);
