-- +goose Up
-- V4 账号运营第一阶段（11 文档第 7 节）：运营方案（版本化）、内容大纲槽位、选题来源扩展。
CREATE TABLE account_strategy (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  version          int NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  niche            text NOT NULL DEFAULT '',
  audience         text NOT NULL DEFAULT '',
  differentiation  text NOT NULL DEFAULT '',
  persona          text NOT NULL DEFAULT '',
  pillars          jsonb NOT NULL DEFAULT '[]',
  cadence          jsonb NOT NULL DEFAULT '{}',
  stage            text NOT NULL DEFAULT 'cold_start' CHECK (stage IN ('cold_start', 'growth', 'stable')),
  goals            jsonb NOT NULL DEFAULT '[]',
  benchmarks       jsonb NOT NULL DEFAULT '[]',
  keywords         text[] NOT NULL DEFAULT '{}',
  taboo            text[] NOT NULL DEFAULT '{}',
  hot_enabled      boolean NOT NULL DEFAULT true,
  blocked_words    text[] NOT NULL DEFAULT '{}',
  daily_settings   jsonb NOT NULL DEFAULT '{}',
  ai_call_id       uuid,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, version)
);
CREATE UNIQUE INDEX account_strategy_one_active ON account_strategy(account_id) WHERE status = 'active';

CREATE TABLE account_plan_slot (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES platform_account(id) ON DELETE CASCADE,
  date        date NOT NULL,
  seq         int NOT NULL DEFAULT 0,
  pillar      text NOT NULL DEFAULT '',
  format      text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'empty' CHECK (status IN ('empty', 'suggested', 'adopted')),
  suggestion  jsonb,
  topic_id    uuid REFERENCES topic(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, date, seq)
);

ALTER TABLE topic DROP CONSTRAINT IF EXISTS topic_source_check;
ALTER TABLE topic ADD CONSTRAINT topic_source_check CHECK (source IN ('manual', 'ai', 'review', 'hot', 'inbox', 'plan', 'daily'));
ALTER TABLE topic ADD COLUMN IF NOT EXISTS hot_item_id uuid;
ALTER TABLE topic ADD COLUMN IF NOT EXISTS strategy_pillar text;

-- +goose Down
UPDATE topic SET source='ai' WHERE source IN ('plan', 'daily');
ALTER TABLE topic DROP CONSTRAINT IF EXISTS topic_source_check;
ALTER TABLE topic ADD CONSTRAINT topic_source_check CHECK (source IN ('manual', 'ai', 'review', 'hot', 'inbox'));
ALTER TABLE topic DROP COLUMN IF EXISTS strategy_pillar, DROP COLUMN IF EXISTS hot_item_id;
DROP TABLE IF EXISTS account_plan_slot;
DROP TABLE IF EXISTS account_strategy;
