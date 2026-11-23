-- +goose Up
-- REF41 A4：记忆置信、衰减与注入闸。confidence 0–1（新记忆默认 0.8）；
-- decayed_at 记录最近一次时间衰减；injection_disabled 是“不再注入”硬闸；
-- confirmed_at/confirmed_by 复用 00007 既有列。注入索引只覆盖可注入集合。

ALTER TABLE account_memory ADD COLUMN confidence numeric(3,2) NOT NULL DEFAULT 0.8
  CHECK (confidence >= 0 AND confidence <= 1);
ALTER TABLE account_memory ADD COLUMN decayed_at timestamptz;
ALTER TABLE account_memory ADD COLUMN injection_disabled boolean NOT NULL DEFAULT false;

CREATE INDEX account_memory_inject ON account_memory(account_id, status, confidence DESC, use_count DESC)
  WHERE status='active' AND NOT injection_disabled;

-- +goose Down
DROP INDEX IF EXISTS account_memory_inject;
ALTER TABLE account_memory DROP COLUMN IF EXISTS injection_disabled;
ALTER TABLE account_memory DROP COLUMN IF EXISTS decayed_at;
ALTER TABLE account_memory DROP COLUMN IF EXISTS confidence;
