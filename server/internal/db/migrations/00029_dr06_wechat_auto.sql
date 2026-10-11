-- +goose Up
-- DEV-DR06：已有数据接口权限的公众号每天后台只读同步一次；可按账号关闭，连续 3 天失败或无权限时自动关闭（14 文档 4.2 第 4 条）。
ALTER TABLE platform_account
  ADD COLUMN metrics_wechat_auto boolean NOT NULL DEFAULT true,
  ADD COLUMN metrics_wechat_fails int NOT NULL DEFAULT 0,
  ADD COLUMN metrics_wechat_last_at timestamptz,
  ADD COLUMN metrics_wechat_note text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE platform_account
  DROP COLUMN metrics_wechat_auto,
  DROP COLUMN metrics_wechat_fails,
  DROP COLUMN metrics_wechat_last_at,
  DROP COLUMN metrics_wechat_note;
