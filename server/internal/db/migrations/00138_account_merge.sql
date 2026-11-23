-- +goose Up
-- REF41 F2：账号合并与停用影响清单。合并日志（preview/running/completed/failed、
-- moved 计数、conflicts 列表）；源账号停用不删除；合并幂等、冲突不覆盖。

CREATE TABLE account_merge_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  source_account_id uuid NOT NULL,
  target_account_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('preview','running','completed','failed')),
  moved jsonb NOT NULL DEFAULT '{}'::jsonb,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX account_merge_log_ws ON account_merge_log(workspace_id, created_at DESC);

-- +goose Down
DROP INDEX IF EXISTS account_merge_log_ws;
DROP TABLE IF EXISTS account_merge_log;
