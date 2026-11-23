-- +goose Up
-- REF41 F4：采集自学习（分阶段）。docs/41 计划 00131_parser_event.sql 已被 A7 占用
-- （00131_workflow_template.sql），00132–00138 已按 C1/C3/E2/E1/F3/F2 顺延，实际取 00139
-- （决策随实施登记）。首版只做"记录 + 建议"：失败样本结构化上报 + 规则模板配方草稿，
-- 人工 verify/activate；不自动修改 desktop/src/platform 适配器。

CREATE TABLE parser_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  account_id uuid REFERENCES platform_account(id) ON DELETE SET NULL,
  platform text NOT NULL,
  adapter_version text NOT NULL DEFAULT '',
  page_url text NOT NULL DEFAULT '',
  page_hash text NOT NULL DEFAULT '',
  field text NOT NULL DEFAULT '',
  error_code text NOT NULL CHECK (char_length(error_code) BETWEEN 1 AND 80),
  sample_asset_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parser_event_recent ON parser_event(platform, field, created_at DESC);
CREATE INDEX parser_event_dedupe ON parser_event(workspace_id, platform, field, error_code, page_hash, created_at DESC);

CREATE TABLE parser_recipe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  platform text NOT NULL,
  field text NOT NULL,
  recipe jsonb NOT NULL CHECK (jsonb_typeof(recipe)='object'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','verified','active','disabled')),
  verified_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, field)
);

-- +goose Down
DROP TABLE IF EXISTS parser_recipe;
DROP INDEX IF EXISTS parser_event_dedupe;
DROP INDEX IF EXISTS parser_event_recent;
DROP TABLE IF EXISTS parser_event;
