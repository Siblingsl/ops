-- +goose Up
-- DEV-A106（13 文档）：今日智能简报——AI 解读昨日表现与今日重点，每账号每天一条。
CREATE TABLE account_daily_brief (
  account_id uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  date       date NOT NULL,
  content    jsonb NOT NULL,
  ai_call_id uuid REFERENCES ai_call(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, date)
);

-- +goose Down
DROP TABLE account_daily_brief;
