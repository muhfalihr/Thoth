-- Editorial review metadata on immutable saved revisions. A decision recorded
-- here never approves a pipeline run, a Stage 1 gate, a render, or a publication.
-- Rows are append-only: the repository only ever inserts and reads them.

-- Revisions are immutable and already unique by (document_id, revision); this
-- index lets review rows reference the project as part of the same key.
CREATE UNIQUE INDEX edit_document_revisions_project_document_revision_key
    ON edit_document_revisions (project_id, document_id, revision);

CREATE TABLE studio_review_events (
    event_id TEXT PRIMARY KEY CHECK (event_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,127}$'),
    project_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    operation_id TEXT NOT NULL CHECK (operation_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,127}$'),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    event_kind TEXT NOT NULL CHECK (event_kind IN ('comment', 'decision')),
    actor_id TEXT NOT NULL CHECK (actor_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,127}$'),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'service')),
    actor_display_name TEXT CHECK (actor_display_name IS NULL OR length(actor_display_name) BETWEEN 1 AND 200),
    comment_text TEXT CHECK (comment_text IS NULL OR length(btrim(comment_text)) BETWEEN 1 AND 2000),
    frame INTEGER CHECK (frame IS NULL OR frame >= 0),
    decision TEXT CHECK (decision IS NULL OR decision IN ('approved', 'changes_requested')),
    reason TEXT CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (project_id, document_id, operation_id),
    FOREIGN KEY (project_id, document_id, revision)
        REFERENCES edit_document_revisions (project_id, document_id, revision),
    CHECK (
        (event_kind = 'comment' AND comment_text IS NOT NULL AND decision IS NULL AND reason IS NULL)
        OR (event_kind = 'decision' AND decision IS NOT NULL AND comment_text IS NULL AND frame IS NULL)
    )
);

-- Comments read oldest-first; decisions read newest-first.
CREATE INDEX studio_review_comments_idx
    ON studio_review_events (project_id, document_id, created_at, event_id)
    WHERE event_kind = 'comment';

CREATE INDEX studio_review_decisions_idx
    ON studio_review_events (project_id, document_id, created_at DESC, event_id DESC)
    WHERE event_kind = 'decision';
