-- I7 UTM 链接与转化归因（REF41）。
-- 规格原计划 00118；00117/00118 已被其他任务占用，按 D-208 顺延到当前最大 00126。
-- +goose Up

CREATE TABLE conversion_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  work_id uuid NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('wechat_mp','site','youtube','bilibili','x','other')),
  target_url text NOT NULL CHECK (target_url ~ '^https?://'),
  utm_source text NOT NULL CHECK (char_length(utm_source) BETWEEN 1 AND 64),
  utm_medium text NOT NULL DEFAULT 'video' CHECK (utm_medium IN ('video','article')),
  utm_campaign text NOT NULL CHECK (char_length(utm_campaign) BETWEEN 1 AND 64),
  code text NOT NULL CHECK (char_length(code) BETWEEN 8 AND 32),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code)
);

-- 同一作品同一平台只能有一个 active 链接；历史链接保留为 disabled，供审计与旧 URL 失效。
CREATE UNIQUE INDEX conversion_link_work_platform_active
  ON conversion_link (work_id, platform) WHERE status = 'active';
CREATE INDEX conversion_link_workspace_idx ON conversion_link (workspace_id, created_at DESC);

CREATE TABLE conversion_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES conversion_link(id) ON DELETE CASCADE,
  event_name text NOT NULL CHECK (event_name IN ('register','paid','lead','download','other')),
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 128),
  occurred_at timestamptz NOT NULL,
  value_cents int CHECK (value_cents IS NULL OR value_cents >= 0),
  currency text NOT NULL DEFAULT 'CNY' CHECK (char_length(currency) = 3),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  manual boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  UNIQUE (link_id, external_id)
);
CREATE INDEX conversion_event_link_idx ON conversion_event (link_id, occurred_at DESC);
CREATE INDEX conversion_event_workspace_idx ON conversion_event (workspace_id, occurred_at DESC);

CREATE TABLE conversion_ingest_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (workspace_id, name),
  UNIQUE (token_hash)
);

-- +goose Down
DROP TABLE IF EXISTS conversion_event;
DROP TABLE IF EXISTS conversion_link;
DROP TABLE IF EXISTS conversion_ingest_token;
