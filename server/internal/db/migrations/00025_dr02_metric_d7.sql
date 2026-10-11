-- +goose Up
-- +goose StatementBegin
CREATE FUNCTION metric_node(day_offset int) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN day_offset IS NULL OR day_offset < 1 THEN NULL
    WHEN day_offset < 3 THEN 1
    WHEN day_offset < 7 THEN 3
    WHEN day_offset < 30 THEN 7
    ELSE 30 END
$$;
-- +goose StatementEnd

-- One row per work: the day-7 figure. Falls back to the closest earlier node, then to snapshots
-- with unknown publish date, then to the earliest later node; day_offset tells which one was used.
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

-- +goose Down
DROP VIEW work_metric_d7;
DROP FUNCTION metric_node(int);
