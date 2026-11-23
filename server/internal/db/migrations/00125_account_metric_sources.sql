-- REF41 I6-A1：粉丝来源、采集时间与证据，支持桌面实时、桌面回填和导入。
-- 00049 已把来源扩展为 wechat_api/wechat_browser/xhs_browser/manual；本次在其上追加
-- desktop_live/desktop_backfill/import，保留历史浏览器来源，避免回退已有观测。
-- +goose Up
ALTER TABLE account_metric_daily DROP CONSTRAINT account_metric_daily_source_check;
ALTER TABLE account_metric_daily ADD CONSTRAINT account_metric_daily_source_check
  CHECK (source IN ('wechat_api', 'wechat_browser', 'xhs_browser', 'manual',
                    'desktop_live', 'desktop_backfill', 'import'));
ALTER TABLE account_metric_daily
  ADD COLUMN collected_at timestamptz,
  ADD COLUMN evidence     jsonb NOT NULL DEFAULT '{}'::jsonb;

-- +goose Down
-- 回退会收窄来源枚举；先移除本次新增来源的行，避免约束恢复失败。
DELETE FROM account_metric_daily WHERE source IN ('desktop_live', 'desktop_backfill', 'import');
ALTER TABLE account_metric_daily
  DROP COLUMN evidence, DROP COLUMN collected_at;
ALTER TABLE account_metric_daily DROP CONSTRAINT account_metric_daily_source_check;
ALTER TABLE account_metric_daily ADD CONSTRAINT account_metric_daily_source_check
  CHECK (source IN ('wechat_api', 'wechat_browser', 'xhs_browser', 'manual'));
