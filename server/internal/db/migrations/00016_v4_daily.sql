-- +goose Up
CREATE TABLE daily_recommendation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES platform_account(id),date date NOT NULL,version int NOT NULL DEFAULT 1 CHECK(version>0),
 items jsonb NOT NULL CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items) BETWEEN 1 AND 10),ai_call_id uuid REFERENCES ai_call(id) ON DELETE SET NULL,
 generated_at timestamptz NOT NULL DEFAULT now(),trigger text NOT NULL CHECK(trigger IN ('manual','on_open','background')),UNIQUE(account_id,date,version)
);
CREATE TABLE daily_recommendation_action (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recommendation_id uuid NOT NULL REFERENCES daily_recommendation(id) ON DELETE CASCADE,item_index int NOT NULL CHECK(item_index>=0),
 action text NOT NULL CHECK(action IN ('adopted','started','replaced','dismissed')),topic_id uuid REFERENCES topic(id) ON DELETE SET NULL,work_id uuid REFERENCES work(id) ON DELETE SET NULL,
 user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(recommendation_id,item_index,action)
);
CREATE TABLE account_ops_activity(account_id uuid PRIMARY KEY REFERENCES platform_account(id),last_opened_at timestamptz NOT NULL,user_id uuid REFERENCES app_user(id));
CREATE TABLE account_daily_claim(account_id uuid REFERENCES platform_account(id),date date,manual_count int NOT NULL DEFAULT 0 CHECK(manual_count BETWEEN 0 AND 3),PRIMARY KEY(account_id,date));
-- +goose Down
DROP TABLE account_daily_claim;
DROP TABLE account_ops_activity;
DROP TABLE daily_recommendation_action;
DROP TABLE daily_recommendation;
