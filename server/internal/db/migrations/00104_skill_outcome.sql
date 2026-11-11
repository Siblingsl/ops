-- DEEP-03 / D-179：技能效果归因旁路表。
-- 只存公共技能 ID 与聚合标记，不存个人技能正文；失败不得阻断主生成/发布链路。

-- +goose Up
CREATE TABLE skill_outcome (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  skill_id         uuid NOT NULL,
  task_type        text NOT NULL DEFAULT '',
  ai_call_id       uuid REFERENCES ai_call(id) ON DELETE SET NULL,
  work_id          uuid REFERENCES work(id) ON DELETE SET NULL,
  adopted          boolean NOT NULL DEFAULT false,
  published        boolean NOT NULL DEFAULT false,
  metric_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skill_outcome_ws_skill_task
  ON skill_outcome (workspace_id, skill_id, task_type);
CREATE INDEX skill_outcome_ai_call
  ON skill_outcome (ai_call_id) WHERE ai_call_id IS NOT NULL;
CREATE INDEX skill_outcome_work
  ON skill_outcome (work_id) WHERE work_id IS NOT NULL;
-- 同一次调用同一技能只记一行，避免重复采样。
CREATE UNIQUE INDEX skill_outcome_call_skill_unique
  ON skill_outcome (ai_call_id, skill_id) WHERE ai_call_id IS NOT NULL;

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM skill_outcome) THEN
    RAISE EXCEPTION 'skill_outcome 仍有数据，拒绝回滚；请保留表并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP TABLE skill_outcome;
