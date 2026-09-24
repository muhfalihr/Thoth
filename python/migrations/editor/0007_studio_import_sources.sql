-- Studio drafts opened from a Content Set, with the source inventory each one
-- still owes a decision for. Only a server-derived source key and bounded
-- public labels are kept: never raw source JSON, an address, or a host file.
-- Rows are append-only: the repository only ever inserts and reads them.

CREATE TABLE studio_import_drafts (
    project_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    first_revision INTEGER NOT NULL CHECK (first_revision = 1),
    source_key TEXT NOT NULL CHECK (source_key ~ '^[0-9a-f]{64}$'),
    idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
    inventory JSONB NOT NULL CHECK (jsonb_typeof(inventory) = 'array'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, document_id),
    UNIQUE (project_id, idempotency_key),
    FOREIGN KEY (project_id, document_id, first_revision)
        REFERENCES edit_document_revisions (project_id, document_id, revision)
);

-- Resume lists the newest drafts of one source first.
CREATE INDEX studio_import_drafts_source_idx
    ON studio_import_drafts (project_id, source_key, created_at DESC, document_id DESC);

-- One final decision per inventory item, bound to the revision it produced.
CREATE TABLE studio_import_decisions (
    project_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    item_id TEXT NOT NULL CHECK (item_id ~ '^[a-z][a-z0-9_]{0,63}$'),
    revision INTEGER NOT NULL CHECK (revision > 1),
    disposition TEXT NOT NULL CHECK (disposition IN ('attached', 'excluded')),
    asset_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, document_id, item_id),
    FOREIGN KEY (project_id, document_id)
        REFERENCES studio_import_drafts (project_id, document_id),
    FOREIGN KEY (project_id, document_id, revision)
        REFERENCES edit_document_revisions (project_id, document_id, revision),
    FOREIGN KEY (project_id, asset_id) REFERENCES editor_assets (project_id, asset_id),
    CHECK ((disposition = 'attached') = (asset_id IS NOT NULL))
);
