-- +goose Up
-- DEV-DR09：账号级每日粉丝数据（14 文档 4.2 第 5 条）。公众号来自 datacube 用户分析接口；
-- 没有接口的账号可由人逐日录入。单篇作品的涨粉接口不提供，不从这里硬算。
CREATE TABLE account_metric_daily (
  account_id    uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  date          date NOT NULL,
  source        text NOT NULL CHECK (source IN ('wechat_api', 'manual')),
  new_follow    int,
  cancel_follow int,
  cumulate      int,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, date, source)
);

-- +goose Down
DROP TABLE account_metric_daily;
