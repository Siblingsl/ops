-- +goose Up
ALTER TABLE metric_snapshot
  ADD COLUMN impressions bigint CHECK (impressions IS NULL OR impressions >= 0);

-- Keep the existing D7 selection and expose impressions as an independent nullable value.
CREATE OR REPLACE VIEW work_metric_d7 AS
SELECT DISTINCT ON (m.work_id)
  m.work_id, m.id AS metric_id, m.day_offset, m.source, m.captured_at,
  m.reads, m.likes, m.wows, m.favorites, m.comments, m.shares, m.follows_gained,
  CASE WHEN m.likes IS NULL AND m.wows IS NULL AND m.favorites IS NULL AND m.comments IS NULL AND m.shares IS NULL THEN NULL
    ELSE coalesce(m.likes,0)+coalesce(m.wows,0)+coalesce(m.favorites,0)+coalesce(m.comments,0)+coalesce(m.shares,0) END AS interactions,
  m.impressions
FROM metric_snapshot m
ORDER BY m.work_id,
  CASE WHEN m.day_offset <= 7 THEN 0 WHEN m.day_offset IS NULL THEN 1 ELSE 2 END,
  CASE WHEN m.day_offset <= 7 THEN -m.day_offset ELSE m.day_offset END,
  array_position(ARRAY['wechat_api','file','screenshot','paste','manual'], m.source),
  m.captured_at DESC;

-- 展现只推进指标行 revision，不进入 account preference 的输入版本。
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_snapshot_bump_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.work_id, NEW.captured_at, NEW.reads, NEW.impressions, NEW.likes, NEW.wows, NEW.favorites,
      NEW.comments, NEW.shares, NEW.follows_gained, NEW.note, NEW.source, NEW.day_offset, NEW.external_id)
     IS DISTINCT FROM
     (OLD.work_id, OLD.captured_at, OLD.reads, OLD.impressions, OLD.likes, OLD.wows, OLD.favorites,
      OLD.comments, OLD.shares, OLD.follows_gained, OLD.note, OLD.source, OLD.day_offset, OLD.external_id) THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM metric_snapshot WHERE impressions IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back Toutiao impressions while metric values exist; preserve data and roll back the application first';
  END IF;
END
$$;
-- +goose StatementEnd

DROP VIEW work_metric_d7;
CREATE VIEW work_metric_d7 AS
SELECT DISTINCT ON (m.work_id)
  m.work_id, m.id AS metric_id, m.day_offset, m.source, m.captured_at,
  m.reads, m.likes, m.wows, m.favorites, m.comments, m.shares, m.follows_gained,
  CASE WHEN m.likes IS NULL AND m.wows IS NULL AND m.favorites IS NULL AND m.comments IS NULL AND m.shares IS NULL THEN NULL
    ELSE coalesce(m.likes,0)+coalesce(m.wows,0)+coalesce(m.favorites,0)+coalesce(m.comments,0)+coalesce(m.shares,0) END AS interactions
FROM metric_snapshot m
ORDER BY m.work_id,
  CASE WHEN m.day_offset <= 7 THEN 0 WHEN m.day_offset IS NULL THEN 1 ELSE 2 END,
  CASE WHEN m.day_offset <= 7 THEN -m.day_offset ELSE m.day_offset END,
  array_position(ARRAY['wechat_api','file','screenshot','paste','manual'], m.source),
  m.captured_at DESC;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION metric_snapshot_bump_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.work_id, NEW.captured_at, NEW.reads, NEW.likes, NEW.wows, NEW.favorites,
      NEW.comments, NEW.shares, NEW.follows_gained, NEW.note, NEW.source, NEW.day_offset, NEW.external_id)
     IS DISTINCT FROM
     (OLD.work_id, OLD.captured_at, OLD.reads, OLD.likes, OLD.wows, OLD.favorites,
      OLD.comments, OLD.shares, OLD.follows_gained, OLD.note, OLD.source, OLD.day_offset, OLD.external_id) THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

ALTER TABLE metric_snapshot DROP COLUMN impressions;
