-- +goose Up
ALTER TABLE metric_snapshot
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','paste','file','wechat_api','screenshot')),
  ADD COLUMN day_offset int,
  ADD COLUMN external_id text;

UPDATE metric_snapshot SET source='wechat_api' WHERE note LIKE '微信 datacube 同步%';
UPDATE metric_snapshot SET likes=NULL, wows=NULL, comments=NULL, follows_gained=NULL
  WHERE source='wechat_api' AND coalesce(likes,0)=0 AND coalesce(wows,0)=0 AND coalesce(comments,0)=0 AND coalesce(follows_gained,0)=0;

-- +goose StatementBegin
CREATE FUNCTION metric_day_offset(captured timestamptz, published timestamptz) RETURNS int
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN published IS NULL THEN NULL
    ELSE greatest(0, (captured AT TIME ZONE 'Asia/Shanghai')::date - (published AT TIME ZONE 'Asia/Shanghai')::date) END
$$;
-- +goose StatementEnd

UPDATE metric_snapshot m SET day_offset = metric_day_offset(m.captured_at, w.published_at)
  FROM work w WHERE w.id = m.work_id;

DELETE FROM metric_snapshot m USING metric_snapshot n
  WHERE m.work_id = n.work_id AND m.source = n.source AND m.day_offset = n.day_offset
    AND (m.captured_at, m.created_at, m.id) < (n.captured_at, n.created_at, n.id);

CREATE UNIQUE INDEX metric_snapshot_node ON metric_snapshot (work_id, source, day_offset);

-- +goose StatementBegin
CREATE FUNCTION metric_snapshot_fill_offset() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.day_offset IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT metric_day_offset(NEW.captured_at, w.published_at) INTO NEW.day_offset FROM work w WHERE w.id = NEW.work_id;
  RETURN NEW;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER metric_snapshot_offset BEFORE INSERT OR UPDATE OF captured_at ON metric_snapshot
  FOR EACH ROW EXECUTE FUNCTION metric_snapshot_fill_offset();

-- +goose Down
DROP TRIGGER metric_snapshot_offset ON metric_snapshot;
DROP FUNCTION metric_snapshot_fill_offset();
DROP INDEX metric_snapshot_node;
DROP FUNCTION metric_day_offset(timestamptz, timestamptz);
ALTER TABLE metric_snapshot DROP COLUMN external_id, DROP COLUMN day_offset, DROP COLUMN source;
