-- DEV-CX13-F / FR-CX-23：运营标准版本表（软口径快照，不替代 profile/DNA/M9 责任方）。
-- 版本不可修改/删除；同账号 version 与 effective_from 唯一；归档只变列表可见性。
-- +goose Up
CREATE TABLE ops_standard (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  account_id uuid NOT NULL REFERENCES platform_account(id),
  version int NOT NULL CHECK (version>0),
  positioning text NOT NULL DEFAULT '',
  text_rules jsonb NOT NULL DEFAULT '[]', visual_rules jsonb NOT NULL DEFAULT '{}',
  content_hash text NOT NULL,
  effective_from date NOT NULL,
  archived_at timestamptz,
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id,version), UNIQUE (account_id,effective_from)
);
CREATE INDEX ops_standard_list ON ops_standard(account_id,version DESC);
ALTER TABLE check_run ADD COLUMN IF NOT EXISTS ops_standard_basis jsonb;

-- +goose Down
ALTER TABLE check_run DROP COLUMN IF EXISTS ops_standard_basis;
DROP TABLE ops_standard;
