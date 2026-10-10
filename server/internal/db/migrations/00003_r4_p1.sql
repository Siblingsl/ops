-- +goose Up
-- R4 P1: prompt templates per workspace; draft sync flag on work

ALTER TABLE prompt_template ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspace(id);
ALTER TABLE prompt_template ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';
ALTER TABLE prompt_template ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Recreate PK to include workspace when present; keep global seed rows with NULL workspace for bootstrapping.
ALTER TABLE prompt_template DROP CONSTRAINT IF EXISTS prompt_template_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS prompt_template_ws_task_ver
  ON prompt_template (workspace_id, task_type, version)
  WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS prompt_template_global_task_ver
  ON prompt_template (task_type, version)
  WHERE workspace_id IS NULL;

ALTER TABLE work ADD COLUMN IF NOT EXISTS draft_maybe_published boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE work DROP COLUMN IF EXISTS draft_maybe_published;
DROP INDEX IF EXISTS prompt_template_ws_task_ver;
DROP INDEX IF EXISTS prompt_template_global_task_ver;
ALTER TABLE prompt_template DROP COLUMN IF EXISTS updated_at;
ALTER TABLE prompt_template DROP COLUMN IF EXISTS label;
ALTER TABLE prompt_template DROP COLUMN IF EXISTS workspace_id;
ALTER TABLE prompt_template ADD PRIMARY KEY (task_type, version);
