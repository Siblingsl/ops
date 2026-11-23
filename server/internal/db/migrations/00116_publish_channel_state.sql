-- +goose Up
-- REF41 P4（docs/41 §5.1）：发布四态与平台能力矩阵。通道校准状态按
-- account × platform × channel 唯一；calibrated 由 last_success_at 非空且
-- adapter_version 与当前适配器版本一致共同决定，版本变化自动失效。
CREATE TABLE publish_channel_state (
  account_id uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('wechat_mp','xhs','toutiao')),
  channel text NOT NULL CHECK (channel IN ('api','desktop','manual')),
  calibrated_at timestamptz,
  calibrated_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  adapter_version text NOT NULL DEFAULT '',
  last_success_at timestamptz,
  last_failure_at timestamptz,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail)='object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, platform, channel)
);
CREATE INDEX publish_channel_state_success ON publish_channel_state(last_success_at)
  WHERE last_success_at IS NOT NULL;

-- +goose Down
DROP TABLE IF EXISTS publish_channel_state;
