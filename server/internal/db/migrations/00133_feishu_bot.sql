-- +goose Up
-- REF41 E1：飞书出站与 ChatOps。docs/41 计划 00126_feishu_bot.sql 已被 I7 占用
-- （D-208），00127–00132 已按各功能顺延，实际取 00133（决策号随实施登记）。
-- webhook/secret 走现有 secure.Box 密文列；入站只读指令，不做写操作/确认。

CREATE TABLE feishu_bot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  webhook_url_enc bytea NOT NULL,
  webhook_secret_enc bytea NOT NULL,
  events text[] NOT NULL DEFAULT '{}' CHECK (cardinality(events) BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE feishu_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES feishu_bot(id) ON DELETE CASCADE,
  chat_id text NOT NULL CHECK (char_length(chat_id) BETWEEN 1 AND 128),
  chat_type text NOT NULL CHECK (chat_type IN ('group','p2p')),
  account_id uuid REFERENCES platform_account(id) ON DELETE SET NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, chat_id)
);

CREATE INDEX feishu_binding_bot ON feishu_binding(bot_id) WHERE active;

-- +goose Down
DROP INDEX IF EXISTS feishu_binding_bot;
DROP TABLE IF EXISTS feishu_binding;
DROP TABLE IF EXISTS feishu_bot;
