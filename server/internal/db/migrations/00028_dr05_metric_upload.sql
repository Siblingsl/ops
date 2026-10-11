-- +goose Up
-- DEV-DR05：数据截图识别。截图只用于识别，7 天后连同识别结果一起删除（14 文档 4.4）。
CREATE TABLE metric_upload (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  files        jsonb NOT NULL DEFAULT '[]',
  rows         jsonb NOT NULL DEFAULT '[]',
  ai_call_id   uuid,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX metric_upload_account ON metric_upload (account_id, created_at DESC);
CREATE INDEX metric_upload_created ON metric_upload (created_at);

-- +goose Down
DROP TABLE metric_upload;
