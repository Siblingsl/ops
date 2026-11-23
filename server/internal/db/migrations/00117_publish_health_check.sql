-- +goose Up
-- REF41 P5：发布通道体检。体检是只读动作，不点发布、不改平台设置；
-- 结果只写本表与 publish_channel_state.detail.last_health，不更新 calibrated
-- （体检成功不等于发布成功）。同一迁移内含 P7 复用的 purpose='patrol'。

CREATE TABLE publish_health_check (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  account_id uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('wechat_mp','xhs','toutiao')),
  purpose text NOT NULL DEFAULT 'health' CHECK (purpose IN ('health','patrol')),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','leased','running','succeeded','failed','expired')),
  lease_token text NOT NULL DEFAULT '',
  lease_until timestamptz,
  attempt int NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  requested_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result)='object'),
  error_code text NOT NULL DEFAULT '',
  error_message text NOT NULL DEFAULT '',
  UNIQUE (account_id, platform, purpose, requested_at)
);

CREATE INDEX publish_health_open ON publish_health_check(state, requested_at)
  WHERE state IN ('queued','leased','running');

-- +goose Down
DROP INDEX IF EXISTS publish_health_open;
DROP TABLE IF EXISTS publish_health_check;
