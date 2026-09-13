CREATE TABLE prompt_provider_preferences (
    project_id TEXT NOT NULL,
    stage_id TEXT NOT NULL CHECK (stage_id IN ('narrative_plan', 'visual_plan', 'caption_copy')),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, stage_id)
);

CREATE TABLE prompt_layer_locks (
    project_id TEXT NOT NULL,
    stage_id TEXT NOT NULL CHECK (stage_id IN ('narrative_plan', 'visual_plan', 'caption_copy')),
    layer TEXT NOT NULL CHECK (layer IN ('template', 'project_override')),
    locked BOOLEAN NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, stage_id, layer)
);

CREATE TABLE prompt_proposals (
    proposal_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    stage_id TEXT NOT NULL CHECK (stage_id IN ('narrative_plan', 'visual_plan', 'caption_copy')),
    kind TEXT NOT NULL CHECK (kind IN ('improve', 'translate')),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'applied', 'rejected', 'superseded')),
    target_layers TEXT[] NOT NULL CHECK (
        cardinality(target_layers) BETWEEN 1 AND 2
        AND target_layers <@ ARRAY['template', 'project_override']::TEXT[]
    ),
    source_template_id TEXT NOT NULL,
    source_template_revision INTEGER NOT NULL CHECK (source_template_revision > 0),
    source_binding_revision INTEGER NOT NULL CHECK (source_binding_revision > 0),
    source_language TEXT NOT NULL CHECK (source_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
    source_template_body TEXT NOT NULL CHECK (length(btrim(source_template_body)) BETWEEN 1 AND 12000),
    source_project_override TEXT CHECK (source_project_override IS NULL OR length(source_project_override) <= 12000),
    target_language TEXT CHECK (target_language IS NULL OR target_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
    improvement_instructions TEXT CHECK (improvement_instructions IS NULL OR length(improvement_instructions) <= 2000),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    translated_template_body TEXT CHECK (translated_template_body IS NULL OR length(btrim(translated_template_body)) BETWEEN 1 AND 12000),
    translated_project_override TEXT CHECK (translated_project_override IS NULL OR length(translated_project_override) <= 12000),
    failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN ('provider_unavailable', 'provider_timeout', 'provider_rate_limited', 'invalid_provider_output', 'source_revision_changed', 'layer_locked', 'proposal_already_running', 'model_not_allowed', 'store_unavailable', 'workflow_unavailable')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    FOREIGN KEY (project_id, source_template_id, source_template_revision)
        REFERENCES prompt_template_revisions (project_id, template_id, revision),
    CHECK (
        (status IN ('queued', 'running') AND finished_at IS NULL)
        OR (status NOT IN ('queued', 'running') AND finished_at IS NOT NULL)
    )
);

CREATE INDEX prompt_proposals_project_stage_created_idx
    ON prompt_proposals (project_id, stage_id, created_at DESC, proposal_id DESC);

CREATE UNIQUE INDEX prompt_proposals_one_active_generation
    ON prompt_proposals (project_id, stage_id)
    WHERE status IN ('queued', 'running');

CREATE TABLE prompt_proposal_changes (
    proposal_id TEXT NOT NULL REFERENCES prompt_proposals (proposal_id),
    change_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    layer TEXT NOT NULL CHECK (layer IN ('template', 'project_override')),
    before_text TEXT NOT NULL CHECK (length(before_text) <= 12000),
    after_text TEXT NOT NULL CHECK (length(after_text) <= 12000),
    start_line INTEGER NOT NULL CHECK (start_line >= 0),
    end_line INTEGER NOT NULL CHECK (end_line >= start_line),
    PRIMARY KEY (proposal_id, change_id),
    UNIQUE (proposal_id, ordinal)
);

CREATE TABLE prompt_proposal_idempotency (
    project_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    proposal_id TEXT NOT NULL UNIQUE REFERENCES prompt_proposals (proposal_id),
    PRIMARY KEY (project_id, idempotency_key)
);

CREATE TABLE prompt_proposal_applications (
    proposal_id TEXT PRIMARY KEY REFERENCES prompt_proposals (proposal_id),
    project_id TEXT NOT NULL,
    stage_id TEXT NOT NULL CHECK (stage_id IN ('narrative_plan', 'visual_plan', 'caption_copy')),
    accepted_change_ids TEXT[] NOT NULL,
    approving_actor TEXT NOT NULL,
    resulting_template_id TEXT NOT NULL,
    resulting_template_revision INTEGER NOT NULL CHECK (resulting_template_revision > 0),
    resulting_binding_revision INTEGER NOT NULL CHECK (resulting_binding_revision > 0),
    ownership TEXT NOT NULL CHECK (ownership = 'ai_assisted'),
    approval_mode TEXT NOT NULL CHECK (approval_mode = 'user_approved'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
