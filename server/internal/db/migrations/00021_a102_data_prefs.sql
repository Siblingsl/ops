-- +goose Up
-- DEV-A102（13 文档）：账号级"读者数据偏好"——来自本账号数据归因的规则结论，
-- 只收样本量达标的特征对比，供生成提示词动态注入（DEV-A103）。
CREATE TABLE account_data_preference (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  feature     text NOT NULL,
  conclusion  text NOT NULL,
  basis       text NOT NULL DEFAULT '',
  sample_size int NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, feature)
);

-- +goose Down
DROP TABLE account_data_preference;
