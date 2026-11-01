-- DEV-CX11 / CX13：诊断与账号分析使用同一报告存储；不改写既有作品和平台镜像。
-- +goose Up
CREATE TABLE content_diagnosis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  account_id uuid NOT NULL,
  work_id uuid REFERENCES work(id),
  topic_id uuid REFERENCES topic(id),
  kind text NOT NULL CHECK (kind IN ('topic','title','account_analysis','visual_plan')),
  basis_revision int,
  basis_updated_at timestamptz,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  context_hash text NOT NULL,
  input_scope text NOT NULL CHECK (input_scope IN ('saved','unsaved')),
  score int CHECK (score BETWEEN 0 AND 100),
  rule_score int CHECK (rule_score BETWEEN 0 AND 60),
  ai_score int CHECK (ai_score BETWEEN 0 AND 45),
  ai_partial boolean NOT NULL DEFAULT false,
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  rules_version text NOT NULL,
  model text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  ai_call_id uuid REFERENCES ai_call(id),
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id,workspace_id) REFERENCES platform_account(id,workspace_id),
  CHECK ((kind='topic' AND topic_id IS NOT NULL AND work_id IS NULL AND basis_updated_at IS NOT NULL)
      OR (kind IN ('title','visual_plan') AND work_id IS NOT NULL AND topic_id IS NULL AND basis_revision IS NOT NULL)
      OR (kind='account_analysis' AND work_id IS NULL AND topic_id IS NULL)),
  CHECK ((kind IN ('topic','title') AND rule_score IS NOT NULL)
      OR (kind IN ('account_analysis','visual_plan') AND rule_score IS NULL AND ai_score IS NULL AND score IS NULL AND NOT ai_partial)),
  CHECK ((ai_partial AND ai_score IS NULL AND score IS NULL) OR NOT ai_partial)
);
CREATE INDEX content_diagnosis_work ON content_diagnosis(work_id,created_at DESC,id DESC);
CREATE INDEX content_diagnosis_topic ON content_diagnosis(topic_id,created_at DESC,id DESC);
CREATE INDEX content_diagnosis_account ON content_diagnosis(account_id,kind,created_at DESC,id DESC);

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content_diagnosis) THEN
    RAISE EXCEPTION '诊断报告仍有数据，拒绝回滚；请保留报告并前滚修复';
  END IF;
END;
$$;
-- +goose StatementEnd
DROP TABLE content_diagnosis;
