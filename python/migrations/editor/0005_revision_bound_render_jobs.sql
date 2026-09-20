CREATE TABLE render_jobs (
    render_job_id TEXT PRIMARY KEY CHECK (render_job_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,127}$'),
    project_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    document_revision INTEGER NOT NULL CHECK (document_revision > 0),
    dispatch_id TEXT NOT NULL CHECK (dispatch_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,127}$'),
    template_id TEXT NOT NULL CHECK (template_id = 'vertical_text_story'),
    template_version INTEGER NOT NULL CHECK (template_version = 1),
    preset_id TEXT NOT NULL CHECK (preset_id = 'standard_vertical_mp4_v1'),
    renderer_version TEXT NOT NULL CHECK (renderer_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    status TEXT NOT NULL CHECK (status IN ('preparing', 'rendering', 'finalizing', 'completed', 'failed', 'cancelled')),
    progress_percent INTEGER CHECK (progress_percent IS NULL OR (progress_percent BETWEEN 0 AND 100)),
    last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
    retry_of_job_id TEXT REFERENCES render_jobs (render_job_id),
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    cancel_requested_at TIMESTAMPTZ,
    artifacts_cleaned_at TIMESTAMPTZ,
    failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN ('render_asset_unavailable', 'render_bundle_invalid', 'render_deadline_exceeded', 'render_dispatch_failed', 'render_engine_failed', 'render_output_invalid', 'render_storage_failed', 'renderer_unavailable')),
    output_relative_path TEXT CHECK (
        output_relative_path IS NULL
        OR (
            length(output_relative_path) BETWEEN 1 AND 512
            AND output_relative_path ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
            AND output_relative_path NOT LIKE '%..%'
        )
    ),
    output_media_type TEXT CHECK (output_media_type IS NULL OR output_media_type = 'video/mp4'),
    output_size_bytes BIGINT CHECK (output_size_bytes IS NULL OR output_size_bytes > 0),
    output_checksum TEXT CHECK (output_checksum IS NULL OR output_checksum ~ '^sha256:[0-9a-f]{64}$'),
    provenance JSONB NOT NULL,
    FOREIGN KEY (document_id, document_revision)
        REFERENCES edit_document_revisions (document_id, revision),
    CHECK (retry_of_job_id IS NULL OR retry_of_job_id <> render_job_id),
    CHECK (
        (status IN ('preparing', 'rendering', 'finalizing') AND finished_at IS NULL)
        OR (status NOT IN ('preparing', 'rendering', 'finalizing') AND finished_at IS NOT NULL)
    ),
    CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
    CHECK (
        (status = 'completed' AND output_relative_path IS NOT NULL AND output_media_type IS NOT NULL AND output_size_bytes IS NOT NULL AND output_checksum IS NOT NULL)
        OR (status <> 'completed' AND output_relative_path IS NULL AND output_media_type IS NULL AND output_size_bytes IS NULL AND output_checksum IS NULL)
    ),
    CHECK (artifacts_cleaned_at IS NULL OR finished_at IS NOT NULL)
);

-- One installation renders one job at a time: a unique index over a constant
-- expression admits a single row while any active status is present.
CREATE UNIQUE INDEX render_jobs_one_active_slot
    ON render_jobs ((TRUE))
    WHERE status IN ('preparing', 'rendering', 'finalizing');

CREATE INDEX render_jobs_project_history_idx
    ON render_jobs (project_id, created_at DESC, render_job_id DESC);

CREATE TABLE render_job_idempotency (
    project_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 128),
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    render_job_id TEXT NOT NULL REFERENCES render_jobs (render_job_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, idempotency_key)
);
