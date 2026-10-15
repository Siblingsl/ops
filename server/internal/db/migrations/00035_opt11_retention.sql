-- +goose Up
CREATE TABLE ai_call_monthly_summary (
  month             date NOT NULL,
  workspace_id      uuid NOT NULL,
  account_id        uuid NOT NULL,
  task_type         text NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,
  is_eval           boolean NOT NULL DEFAULT false,
  call_count        bigint NOT NULL DEFAULT 0,
  success_count     bigint NOT NULL DEFAULT 0,
  failed_count      bigint NOT NULL DEFAULT 0,
  prompt_tokens     bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  latency_ms        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (month, workspace_id, account_id, task_type, provider, model, is_eval)
);

ALTER TABLE work_version DROP CONSTRAINT work_version_reason_check;
ALTER TABLE work_version ADD CONSTRAINT work_version_reason_check
  CHECK (reason IN ('auto', 'ai', 'manual', 'check', 'restore', 'publish'));

-- +goose Down
ALTER TABLE work_version DROP CONSTRAINT work_version_reason_check;
ALTER TABLE work_version ADD CONSTRAINT work_version_reason_check
  CHECK (reason IN ('auto', 'ai', 'manual', 'check', 'restore'));
DROP TABLE ai_call_monthly_summary;
