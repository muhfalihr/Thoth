CREATE TABLE IF NOT EXISTS prompt_template_revisions (
    project_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    stage_id TEXT NOT NULL CHECK (stage_id IN ('narrative_plan', 'visual_plan', 'caption_copy')),
    language TEXT NOT NULL CHECK (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
    body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 12000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, template_id, revision)
);

CREATE TABLE IF NOT EXISTS project_prompt_bindings (
    project_id TEXT NOT NULL,
    stage_id TEXT NOT NULL CHECK (stage_id IN ('narrative_plan', 'visual_plan', 'caption_copy')),
    template_id TEXT NOT NULL,
    template_revision INTEGER NOT NULL CHECK (template_revision > 0),
    project_override TEXT CHECK (project_override IS NULL OR length(project_override) <= 12000),
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, stage_id),
    FOREIGN KEY (project_id, template_id, template_revision)
        REFERENCES prompt_template_revisions (project_id, template_id, revision)
);
