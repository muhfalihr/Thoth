CREATE TABLE editor_assets (
    project_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('video', 'image', 'audio')),
    media_type TEXT NOT NULL CHECK (media_type ~ '^[a-z]+/[a-z0-9.+-]{1,64}$'),
    artifact_location TEXT NOT NULL CHECK (
        length(artifact_location) BETWEEN 1 AND 512
        AND artifact_location ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
        AND artifact_location NOT LIKE '%..%'
    ),
    duration_in_frames INTEGER CHECK (duration_in_frames IS NULL OR duration_in_frames > 0),
    width INTEGER CHECK (width IS NULL OR width > 0),
    height INTEGER CHECK (height IS NULL OR height > 0),
    fps DOUBLE PRECISION CHECK (fps IS NULL OR (fps > 0 AND fps <= 240)),
    has_audio BOOLEAN NOT NULL,
    validation_state TEXT NOT NULL CHECK (validation_state IN ('ready', 'rejected', 'pending')),
    checksum TEXT CHECK (checksum IS NULL OR checksum ~ '^sha256:[0-9a-f]{64}$'),
    provenance TEXT NOT NULL CHECK (length(btrim(provenance)) BETWEEN 1 AND 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, asset_id),
    UNIQUE (asset_id),
    CHECK (
        (kind = 'audio' AND width IS NULL AND height IS NULL)
        OR (kind <> 'audio' AND width IS NOT NULL AND height IS NOT NULL)
    )
);

CREATE INDEX editor_assets_project_ready_created_idx
    ON editor_assets (project_id, created_at DESC, asset_id DESC)
    WHERE validation_state = 'ready';

CREATE TABLE edit_document_upgrade_idempotency (
    project_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    document_id TEXT NOT NULL,
    result_revision INTEGER NOT NULL CHECK (result_revision > 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, idempotency_key),
    FOREIGN KEY (document_id, result_revision)
        REFERENCES edit_document_revisions (document_id, revision)
);
