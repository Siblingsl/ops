-- +goose Up
-- REF41 I1：竞对订阅、观测与趋势。目标可开监控（6–168h 间隔），每次采集一条
-- 观测（同 note 按 seq 累计不覆盖）；趋势 x 轴是观测序号，不伪造日龄；
-- 采集失败写 failed 观测（values 空），不把失败点当 0。

ALTER TABLE benchmark_target ADD COLUMN monitor_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE benchmark_target ADD COLUMN monitor_interval_hours int NOT NULL DEFAULT 24
  CHECK (monitor_interval_hours BETWEEN 6 AND 168);
ALTER TABLE benchmark_target ADD COLUMN last_observed_at timestamptz;
ALTER TABLE benchmark_target ADD COLUMN next_observe_at timestamptz;
ALTER TABLE benchmark_target ADD COLUMN external_key text NOT NULL DEFAULT '';

ALTER TABLE benchmark_note ADD COLUMN platform text NOT NULL DEFAULT '';
ALTER TABLE benchmark_note ADD COLUMN external_id text NOT NULL DEFAULT '';
ALTER TABLE benchmark_note ADD COLUMN published_at timestamptz;
ALTER TABLE benchmark_note ADD COLUMN first_seen_at timestamptz;
ALTER TABLE benchmark_note ADD COLUMN last_seen_at timestamptz;
CREATE UNIQUE INDEX benchmark_note_external ON benchmark_note(target_id, external_id)
  WHERE external_id <> '';

CREATE TABLE benchmark_metric_observation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  target_id uuid NOT NULL REFERENCES benchmark_target(id) ON DELETE CASCADE,
  note_id uuid REFERENCES benchmark_note(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  seq int NOT NULL CHECK (seq > 0),
  interval_days numeric(6,2),
  values jsonb NOT NULL CHECK (jsonb_typeof(values)='object'),
  quality_state text NOT NULL DEFAULT 'ok' CHECK (quality_state IN ('ok','partial','failed')),
  source text NOT NULL DEFAULT 'desktop' CHECK (source IN ('desktop','manual','import')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_id, note_id, seq)
);
CREATE INDEX benchmark_obs_note ON benchmark_metric_observation(note_id, seq);

CREATE TABLE benchmark_observe_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  target_id uuid NOT NULL REFERENCES benchmark_target(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','leased','running','succeeded','failed','expired')),
  lease_token text,
  lease_until timestamptz,
  attempt int NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text NOT NULL DEFAULT '',
  UNIQUE (target_id, requested_at)
);

-- +goose Down
DROP TABLE IF EXISTS benchmark_observe_task;
DROP INDEX IF EXISTS benchmark_obs_note;
DROP TABLE IF EXISTS benchmark_metric_observation;
DROP INDEX IF EXISTS benchmark_note_external;
ALTER TABLE benchmark_note DROP COLUMN IF EXISTS last_seen_at;
ALTER TABLE benchmark_note DROP COLUMN IF EXISTS first_seen_at;
ALTER TABLE benchmark_note DROP COLUMN IF EXISTS published_at;
ALTER TABLE benchmark_note DROP COLUMN IF EXISTS external_id;
ALTER TABLE benchmark_note DROP COLUMN IF EXISTS platform;
ALTER TABLE benchmark_target DROP COLUMN IF EXISTS external_key;
ALTER TABLE benchmark_target DROP COLUMN IF EXISTS next_observe_at;
ALTER TABLE benchmark_target DROP COLUMN IF EXISTS last_observed_at;
ALTER TABLE benchmark_target DROP COLUMN IF EXISTS monitor_interval_hours;
ALTER TABLE benchmark_target DROP COLUMN IF EXISTS monitor_enabled;
